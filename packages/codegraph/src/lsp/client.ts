import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// A deliberately small LSP client: just the JSON-RPC framing + the handful of
// requests the impact map needs (definition, references, documentSymbol). All
// positions are LSP-native (0-based line/character in UTF-16 units); callers pass
// those directly (tree-sitter and documentSymbol both already speak UTF-16).

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface Location {
  uri: string;
  range: { start: Position; end: Position };
}
export interface Position {
  line: number;
  character: number;
}
export interface DocumentSymbol {
  name: string;
  kind: number;
  range: { start: Position; end: Position };
  selectionRange: { start: Position; end: Position };
  children?: DocumentSymbol[];
}

const REQUEST_TIMEOUT_MS = 8000;

export class LspClient {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly opened = new Set<string>();
  private initialized: Promise<void> | null = null;
  private alive = true;

  constructor(
    command: string,
    args: string[],
    private readonly rootPath: string,
    private readonly onExit?: () => void,
  ) {
    this.proc = spawn(command, args, { cwd: rootPath, stdio: "pipe" });
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on("data", () => {}); // language servers are chatty; ignore
    this.proc.on("exit", () => {
      this.alive = false;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("language server exited"));
      }
      this.pending.clear();
      this.onExit?.();
    });
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** Idempotent handshake: `initialize` → `initialized`. */
  initialize(): Promise<void> {
    this.initialized ??= (async () => {
      await this.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.rootPath).href,
        workspaceFolders: [{ uri: pathToFileURL(this.rootPath).href, name: "root" }],
        capabilities: {
          textDocument: {
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
        },
      });
      this.notify("initialized", {});
    })();
    return this.initialized;
  }

  /** Open (or refresh) a document with its *current* worktree contents. */
  didOpen(path: string, languageId: string, text: string): void {
    const uri = pathToFileURL(path).href;
    if (this.opened.has(uri)) {
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text }],
      });
      return;
    }
    this.opened.add(uri);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  async definition(path: string, pos: Position): Promise<Location[]> {
    const res = await this.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(path).href },
      position: pos,
    });
    return normalizeLocations(res);
  }

  async references(path: string, pos: Position): Promise<Location[]> {
    const res = await this.request("textDocument/references", {
      textDocument: { uri: pathToFileURL(path).href },
      position: pos,
      context: { includeDeclaration: false },
    });
    return normalizeLocations(res);
  }

  async documentSymbol(path: string): Promise<DocumentSymbol[]> {
    const res = await this.request("textDocument/documentSymbol", {
      textDocument: { uri: pathToFileURL(path).href },
    });
    return Array.isArray(res) ? (res as DocumentSymbol[]) : [];
  }

  dispose(): void {
    if (!this.alive) return;
    try {
      this.notify("exit", undefined);
    } catch {}
    this.proc.kill();
    this.alive = false;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error("language server not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.alive) this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match?.[1]) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1], 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return; // wait for the rest of the body
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      this.dispatch(body);
    }
  }

  private dispatch(body: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(body);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return; // a server-initiated request/notification; ignore
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(msg.error.message));
    else pending.resolve(msg.result);
  }
}

/** definition/references may return a Location, Location[], or LocationLink[]. */
function normalizeLocations(res: unknown): Location[] {
  if (!res) return [];
  const arr = Array.isArray(res) ? res : [res];
  const out: Location[] = [];
  for (const item of arr as Record<string, unknown>[]) {
    if (typeof item.uri === "string" && item.range) {
      out.push(item as unknown as Location);
    } else if (typeof item.targetUri === "string") {
      out.push({
        uri: item.targetUri as string,
        range: (item.targetSelectionRange ?? item.targetRange) as Location["range"],
      });
    }
  }
  return out;
}
