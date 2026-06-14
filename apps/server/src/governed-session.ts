import { randomUUID } from "node:crypto";
import { type RunningSession, type RunSessionDeps, runGovernedSession } from "@governor/agent-host";
import type {
  ChangeView,
  ClientToServer,
  DialMode,
  GovernorEvent,
  PendingQuestion,
  Question,
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
import { buildChangeView, visibleEvents } from "./changeView.ts";

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
  /** The agent's open question (if any) and the resolver that answers it. */
  private question: PendingQuestion | null = null;
  private answerQuestion: ((message: string) => void) | null = null;

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
      askQuestion: (input) => this.askHuman(input),
    });

    this.sidecar = new Sidecar({ repoPath: this.repoPath, queryImpl: deps.queryImpl });
    this.initTitle(deps.session.taskPrompt);
  }

  /**
   * Give the session a short title for the tab/header. Set a heuristic one at
   * once (so nothing ever shows a raw prompt), then upgrade to an LLM title when
   * a narrator is configured, broadcasting the refreshed session state.
   */
  private initTitle(prompt: string): void {
    this.store.setSessionTitle(this.id, heuristicTitle(prompt));
    const narrator = this.narrator;
    if (narrator === null) return;
    void narrator.title(prompt).then((title) => {
      if (title) {
        this.store.setSessionTitle(this.id, title);
        this.broadcaster.broadcast({ type: "session_state", session: this.meta() });
      }
    });
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
    this.broadcaster.send(ws, { type: "question_state", question: this.question });
    this.broadcaster.add(ws);
  }

  handle(msg: ClientToServer): void {
    if (msg.type === "set_dial") this.pacer.setMode(msg.mode);
    else if (msg.type === "ack_edit") this.pacer.ack(msg.editId);
    else if (msg.type === "reject_edit") this.rejectEdit(msg.editId, msg.reason);
    else if (msg.type === "send_directive") this.sendDirective(msg.text, msg.anchorEditId);
    else if (msg.type === "sidecar_message") this.askSidecar(msg.text);
    else if (msg.type === "answer_question") this.resolveQuestion(msg.questionId, msg.answers);
  }

  /**
   * The agent called AskUserQuestion. Surface it to the human and block until they
   * answer; resolve with the formatted answer, which the gate hands back to the
   * agent as the deny message (its only channel for returning a tool result).
   */
  private askHuman(input: Record<string, unknown>): Promise<string> {
    const questions = parseQuestions(input);
    const pending: PendingQuestion = { id: randomUUID(), questions };
    this.question = pending;
    this.broadcaster.broadcast({ type: "question_state", question: pending });
    return new Promise<string>((resolve) => {
      this.answerQuestion = resolve;
    });
  }

  private resolveQuestion(questionId: string, answers: Record<string, string>): void {
    if (this.question === null || this.question.id !== questionId) return;
    const resolve = this.answerQuestion;
    const message = formatAnswers(this.question, answers);
    // Log the human's answer so it shows in history and feeds the sidecar.
    const event = this.store.appendEvent({
      sessionId: this.id,
      type: "directive",
      payload: { text: message },
    });
    this.broadcaster.broadcast({ type: "event", event });
    this.question = null;
    this.answerQuestion = null;
    this.broadcaster.broadcast({ type: "question_state", question: null });
    resolve?.(message);
  }

  async close(): Promise<void> {
    // Unblock a pending question so the agent's canUseTool await doesn't hang.
    this.answerQuestion?.("The developer ended the session without answering.");
    this.answerQuestion = null;
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
    const reasonById = new Map(groupByIntent(visibleEvents(events)).map((g) => [g.id, g.reason]));
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
      title: null,
      status: "running",
      startedAt: 0,
      endedAt: null,
    };
  }
}

/** First line of the prompt, capped — a stand-in title until the LLM titles it. */
function heuristicTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0]?.trim() ?? "";
  const base = firstLine || prompt.trim();
  if (base.length === 0) return "Untitled session";
  return base.length <= 56 ? base : `${base.slice(0, 55).trimEnd()}…`;
}

/** Defensively turn the agent's AskUserQuestion input into our Question shape. */
function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
  return raw.map((q) => {
    const o = (q ?? {}) as {
      question?: string;
      header?: string;
      multiSelect?: boolean;
      options?: { label?: string; description?: string; preview?: string }[];
    };
    return {
      header: o.header ?? "",
      question: o.question ?? "",
      multiSelect: Boolean(o.multiSelect),
      options: (o.options ?? []).map((opt) => ({
        label: opt.label ?? "",
        description: opt.description ?? "",
        preview: opt.preview,
      })),
    };
  });
}

/** The message handed back to the agent as the answer to its question. */
function formatAnswers(pending: PendingQuestion, answers: Record<string, string>): string {
  const lines = pending.questions.map((q) => {
    const a = answers[q.question]?.trim();
    return `- ${q.header || q.question}: ${a && a.length > 0 ? a : "(no answer)"}`;
  });
  const plural = pending.questions.length > 1 ? "s" : "";
  return `The developer answered your question${plural}:\n${lines.join("\n")}`;
}
