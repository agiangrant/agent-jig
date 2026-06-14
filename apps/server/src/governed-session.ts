import { type RunningSession, type RunSessionDeps, runGovernedSession } from "@governor/agent-host";
import type {
  ChangeView,
  ClientToServer,
  DialMode,
  GovernorEvent,
  Session,
} from "@governor/contracts";
import { groupByIntent, isWriteClass, Pacer } from "@governor/core";
import type { Narrator } from "@governor/narrator";
import { Sidecar } from "@governor/sidecar";
import type { Storage } from "@governor/store";
import type { StructuralAnalyzer } from "@governor/structural";
import { Worktree } from "@governor/worktree";
import type { WebSocket } from "ws";
import { Broadcaster } from "./broadcaster.ts";
import { buildChangeView } from "./changeView.ts";

export interface GovernedSessionDeps {
  session: Session;
  mode?: DialMode;
  store: Storage;
  analyzer: StructuralAnalyzer | null;
  narrator: Narrator | null;
  queryImpl?: RunSessionDeps["queryImpl"];
}

/** A compact transcript of the agent's activity, for the sidecar's context. */
function buildTranscript(events: GovernorEvent[]): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "reasoning") {
      lines.push(`AGENT THOUGHT: ${((e.payload ?? {}) as { text?: string }).text ?? ""}`);
    } else if (e.type === "tool_call" && e.toolName) {
      const path = ((e.payload ?? {}) as { file_path?: string }).file_path;
      lines.push(`AGENT TOOL: ${e.toolName}${path ? ` ${path}` : ""}`);
    } else if (e.type === "directive") {
      lines.push(`DEVELOPER STEERED: ${((e.payload ?? {}) as { text?: string }).text ?? ""}`);
    }
  }
  const text = lines.join("\n");
  return text.length > 6000 ? text.slice(-6000) : text;
}

/**
 * One governed agent session: its own pacer, agent host, sidecar, worktree, and
 * broadcaster. Clients attach over a per-session websocket; control messages are
 * scoped to this session by the connection. The store, analyzer, and narrator
 * are shared across sessions by the manager.
 */
export class GovernedSession {
  readonly id: string;
  private readonly repoPath: string;
  private readonly store: Storage;
  private readonly analyzer: StructuralAnalyzer | null;
  private readonly pacer: Pacer;
  private readonly broadcaster = new Broadcaster();
  private readonly running: RunningSession;
  private readonly sidecar: Sidecar;
  private readonly narrator: Narrator | null;
  /** Generated intent labels, keyed by group id (first edit). */
  private readonly intentLabels = new Map<string, string>();
  private readonly intentPending = new Set<string>();

  constructor(deps: GovernedSessionDeps) {
    this.id = deps.session.id;
    this.repoPath = deps.session.repoPath;
    this.store = deps.store;
    this.analyzer = deps.analyzer;
    this.narrator = deps.narrator;
    this.pacer = new Pacer(deps.mode ?? deps.store.getConfig().defaultMode);

    const narrator = deps.narrator;
    const onEvent = (event: GovernorEvent) => {
      this.broadcaster.broadcast({ type: "event", event });
      if (event.type === "reasoning" || event.type === "tool_call") this.broadcastChangeView();
      // A rejection removes an edit from the change view — rebuild so it drops out.
      else if (event.type === "ack" && event.gateState === "rejected") this.broadcastChangeView();
      if (narrator !== null) this.narrate(narrator, event);
    };

    this.pacer.onQueueChange = (pending) =>
      this.broadcaster.broadcast({ type: "queue_state", pending });
    this.pacer.onModeChange = (mode) => {
      this.store.appendEvent({ sessionId: this.id, type: "dial_change", payload: { mode } });
      this.broadcaster.broadcast({ type: "dial_state", mode });
    };

    this.running = runGovernedSession({
      session: deps.session,
      prompt: deps.session.taskPrompt,
      pacer: this.pacer,
      store: this.store,
      worktree: new Worktree(this.repoPath),
      onEvent,
      queryImpl: deps.queryImpl,
    });

    this.sidecar = new Sidecar({ repoPath: this.repoPath, queryImpl: deps.queryImpl });
  }

  meta(): Session {
    return this.store.getSession(this.id) ?? this.fallbackMeta();
  }

  /** Snapshot current state to a freshly-connected client, then keep it updated. */
  addClient(ws: WebSocket): void {
    this.broadcaster.send(ws, { type: "session_state", session: this.meta() });
    this.broadcaster.send(ws, { type: "dial_state", mode: this.pacer.mode });
    this.broadcaster.send(ws, { type: "queue_state", pending: this.pacer.queue });
    for (const event of this.store.listEvents(this.id)) {
      this.broadcaster.send(ws, { type: "event", event });
    }
    this.broadcaster.send(ws, { type: "change_view", view: this.changeView() });
    this.broadcaster.add(ws);
  }

  handle(msg: ClientToServer): void {
    if (msg.type === "set_dial") this.pacer.setMode(msg.mode);
    else if (msg.type === "ack_edit") this.pacer.ack(msg.editId);
    else if (msg.type === "reject_edit") this.rejectEdit(msg.editId, msg.reason);
    else if (msg.type === "send_directive") this.sendDirective(msg.text, msg.anchorEditId);
    else if (msg.type === "sidecar_message") this.askSidecar(msg.text);
  }

  async close(): Promise<void> {
    await this.running.interrupt().catch(() => {});
    await this.sidecar.close().catch(() => {});
  }

  private changeView(): ChangeView {
    const events = this.store.listEvents(this.id);
    const view = buildChangeView(events, this.analyzer);
    this.enrichIntentLabels(view, events);
    return view;
  }
  private broadcastChangeView(): void {
    this.broadcaster.broadcast({ type: "change_view", view: this.changeView() });
  }

  /**
   * Replace each group's heuristic label with a crisp LLM-generated intent
   * summary when available; trigger generation (once per group) for long
   * reasonings otherwise, re-broadcasting when each resolves. Cached by group id.
   */
  private enrichIntentLabels(view: ChangeView, events: GovernorEvent[]): void {
    const narrator = this.narrator;
    if (narrator === null) return;
    const reasonById = new Map(groupByIntent(events).map((g) => [g.id, g.reason]));
    for (const group of view) {
      const cached = this.intentLabels.get(group.id);
      if (cached) {
        group.label = cached;
        continue;
      }
      const reason = reasonById.get(group.id) ?? "";
      // A short reasoning already makes a fine label; don't spend a call on it.
      if (reason.trim().length < 24 || this.intentPending.has(group.id)) continue;
      this.intentPending.add(group.id);
      void narrator.summarize(reason).then((label) => {
        this.intentPending.delete(group.id);
        if (label) {
          this.intentLabels.set(group.id, label);
          this.broadcastChangeView();
        }
      });
    }
  }

  /** Discard a pending edit, handing the agent a reason to revise. */
  private rejectEdit(editId: string, reason: string): void {
    this.pacer.reject(editId, reason);
  }

  /**
   * Steering reroutes the agent. While an edit is pending the agent is parked
   * inside `canUseTool` awaiting the gate, so a directive injected into the input
   * stream can't reach it — steering must *reject* the pending edit(s), handing
   * the guidance back as the deny reason so the agent unblocks and reroutes. We
   * reject the named edit if one was anchored, else every pending edit (in slowed
   * mode that is the single edit the agent is blocked on). With nothing pending,
   * the agent is mid-thought: inject the directive for the next tool-call boundary.
   */
  private sendDirective(text: string, anchorEditId: string | null): void {
    let composed = text;
    if (anchorEditId !== null) {
      const call = this.store
        .listEvents(this.id)
        .find((e) => e.type === "tool_call" && e.editId === anchorEditId);
      const path = ((call?.payload ?? {}) as { file_path?: string }).file_path;
      if (path) composed = `Re: your edit to ${path} — ${text}`;
    }

    const targets =
      anchorEditId !== null && this.pacer.isPending(anchorEditId)
        ? [anchorEditId]
        : this.pacer.queue.map((p) => p.editId);

    if (targets.length > 0) {
      for (const id of targets) this.pacer.reject(id, composed);
    } else {
      this.running.sendDirective(composed);
    }

    const event = this.store.appendEvent({
      sessionId: this.id,
      type: "directive",
      editId: anchorEditId,
      payload: { text: composed },
    });
    this.broadcaster.broadcast({ type: "event", event });
  }

  private askSidecar(text: string): void {
    const events = this.store.listEvents(this.id);
    const transcript = buildTranscript(events);
    const pending = this.pacer.queue
      .map((p) => {
        const call = events.find((e) => e.type === "tool_call" && e.editId === p.editId);
        const pl = (call?.payload ?? {}) as { new_string?: string; content?: string };
        const after = (pl.new_string ?? pl.content ?? "").slice(0, 800);
        return `PENDING (awaiting the developer's ack — NOT yet on disk) ${p.path}:\n${after}`;
      })
      .join("\n\n");
    const prompt = [
      `Transcript of the agent so far:\n${transcript || "(nothing yet)"}`,
      pending ? `\nEdits in the buffer (not yet applied):\n${pending}` : "",
      `\nDeveloper's question: ${text}`,
    ].join("\n");
    void this.sidecar
      .ask(prompt)
      .then((reply) => this.broadcaster.broadcast({ type: "sidecar_reply", text: reply }));
  }

  private narrate(narrator: Narrator, event: GovernorEvent): void {
    if (event.type !== "tool_call" || event.editId === null) return;
    if (!isWriteClass(event.toolName ?? "")) return;
    const editId = event.editId;
    const p = (event.payload ?? {}) as {
      file_path?: string;
      old_string?: string;
      new_string?: string;
      content?: string;
    };
    void (async () => {
      const prior = this.store.listEvents(this.id);
      const reasoning = [...prior]
        .reverse()
        .find((e) => e.type === "reasoning" && e.seq < event.seq);
      const text = await narrator.narrate({
        toolName: event.toolName ?? "",
        path: p.file_path ?? "",
        before: p.old_string ?? "",
        after: p.new_string ?? p.content ?? "",
        reasoning: ((reasoning?.payload ?? {}) as { text?: string }).text ?? "",
      });
      if (text !== null) {
        const ev = this.store.appendEvent({
          sessionId: this.id,
          type: "narration",
          editId,
          payload: { text },
        });
        this.broadcaster.broadcast({ type: "event", event: ev });
      }
    })();
  }

  private fallbackMeta(): Session {
    return {
      id: this.id,
      repoPath: this.repoPath,
      taskPrompt: "",
      status: "running",
      startedAt: 0,
      endedAt: null,
    };
  }
}
