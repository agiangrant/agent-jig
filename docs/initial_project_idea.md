# Jig — Specification

*A pace-controlled, narrated, interruptible interface for supervised AI coding.*

> **Working name only.** "Jig" is a placeholder — a centrifugal jig is the original feedback device that regulates the speed of a fast machine, which is roughly the whole thesis. Rename at will. It slots beside Coulter, Rigor, and the PR digest in the knowledge-condensing system.

**Status:** design complete, unbuilt. One central hypothesis is unproven and only the chair will settle it (see §11).

---

## 1. Thesis

Generation got cheap. Everything downstream of generation — trusting code, comprehending it, exercising judgment over it, and allocating attention across parallel streams — became the scarce resource. Tooling investment has gone almost entirely to the generation side; every documented pain point is on the consumption side. That asymmetry is the opportunity, and Jig lives squarely on the consumption side.

The specific problem: an agent is a fast producer and a human is a slow consumer, and there is currently no flow control between them. The human either drops frames — skims, loses the thread, rubber-stamps — or blocks entirely, reading everything at the end, decontextualized and exhausted, after the agent has already built nine things on a foundation the human would have rejected at minute two. Both failure modes degrade quality and, counterintuitively, velocity: the comprehension debt comes due at the worst possible time, in review or in production.

The systems framing is backpressure. Jig inserts a buffered channel with a variable drain rate between the agent and the human. The human sets the rate. Comprehension becomes continuous rather than interrupted, and the debt is paid down at a pace the human chooses rather than all at once at the end. The same argument as streaming replication over batch reconciliation.

This is deliberately countercultural — it slows the agent on purpose, against the prevailing "more throughput" current. That is the point. The pitch is not "go faster." It is "stop paying the comprehension debt at the moment it is most expensive."

## 2. The core idea

Gate the *information flow*, not the clock. Pomodoro gates time; Jig gates how fast the agent's work is revealed and how fast the agent is permitted to proceed. A single control — a speed dial — sets the drain rate of the buffer:

- **Real-time:** the dial is wide open, the gate is a no-op, the agent runs unthrottled. Use for small, low-risk edits you're comfortable with.
- **Slowed:** the agent's next edit blocks until you've caught up. Use for large or unfamiliar work, so you can read as the agent codes and understand where it's going before it gets there.

The dial is a trust dial with teeth. It does not merely delay the *display* of work (that would buy comprehension but fake your agency — see Non-goals); it applies backpressure to the agent itself, which is what makes correction land before consequences pile up.

## 3. Non-goals

Scope discipline is load-bearing here. Jig is **not**:

- **A faster agent.** It does the opposite, by design. Speed gains are not the value proposition.
- **A DVR.** Display-only delay — replaying the edit stream while the agent races ahead — is explicitly rejected. You would comprehend minute two while the agent is at minute nine, having already built on decisions you haven't seen. Comprehension without agency is theater. The gate must apply to the agent, not just the screen.
- **A diff viewer.** The intent-grouped view (§6.2) is one projection of the system, not the product.
- **A linter / CI replacement.** It operates *during* generation, upstream of where CI sits.
- **A generation tool.** It assumes some other agent (Claude Code via the SDK) is doing the writing. Jig is the place where the human meets that work.
- **A general productivity timer.** The unit of control is decisions presented for ratification, not minutes.

## 4. Architecture: one event log, three projections

The quiet architectural fact that makes this buildable: **the throttle buffer, the diff view, and the steering channel are the same data structure rendered three ways.** There is one intent-annotated, ordered event log of the agent's tool calls. Everything else is a projection of it.

```
                    ┌─────────────────────────────┐
   Claude Code  ──▶ │  EVENT LOG (ordered, gated) │ ◀── steering directives
   (Agent SDK)      │  intent-annotated tool calls │     (anchored to edit IDs)
   PreToolUse hook  └─────────────────────────────┘
                          │          │          │
                    ┌─────┘     ┌────┘     └─────┐
                  OBSERVE    UNDERSTAND        STEER
              paced buffer   narration +     sidecar +
              + backpressure intent-grouped  anchored
                             diff view       directives
```

You are not building three products. You are building one event log and three views over it. Each layer is independently useful and they de-risk in order (§10).

The three layers map directly onto the supervision loop: **observe → understand → steer.**

---

## 5. Layer 1 — Observe (the paced buffer)

**Goal:** make the rate at which agent work arrives match the rate at which a human can absorb it, with real backpressure on the agent.

### Mechanism
- A `PreToolUse` hook on `Edit` / `Write` blocks on a semaphore the UI controls. The UI acknowledges an edit; the hook releases the next one. At real-time the semaphore is open and the hook is a no-op.
- The agent's outbound tool calls land in the event log as they happen. The drain rate determines how fast subsequent write-class tool calls are permitted.

### The unit of pacing
The unit is the **tool call** (one edit, one file creation), not the token. Token-by-token playback is theater — you'd be watching typing, not thinking. Each released edit is rendered as a diff hunk with a one-line intent annotation. The variable you are actually controlling is *decisions per minute presented for ratification*, not pixels per second.

### Blast-radius-aware defaults
The dial should not be purely manual, or it will end up permanently parked at real-time because adjusting it is friction. Default the rate from the risk of the target:
- New test file, scratch file, docs → near real-time.
- Auth module, migration, billing, anything matching a configured high-risk glob → auto-downshift.

This is the same risk-weighting the PR digest already does, applied upstream during generation rather than after. Manual override always wins.

### Two principles that prevent the layer from feeling bad
- **Backpressure on writes, not on thought.** A blocked agent may still read, plan, and run tests against already-released edits. Only *new writes* wait. Otherwise you've just made the agent idle, which is wasteful and makes the human feel like a bottleneck. (This is also correct M:N scheduling instinct.)
- **A calm queue, not an impatient spinner.** Pending edits render as a scrubbable timeline the human can see and reason about — not a spinner tapping its foot. The psychological difference between "a queue I'm working through" and "something waiting on me" is the difference between the feature surviving and getting cranked to real-time on day two.

### Surface
Claude Code hook (outbound) + local web UI over websockets + the event log/queue. The PR digest's SQLite-backed artifact store is a natural home for the log.

---

## 6. Layer 2 — Understand

Two coupled features that spend the time the buffer creates: spoken narration and a comprehension-first diff view.

### 6.1 TTS narration

**Goal:** recover what actually mattered about pair programming — the driver narrating intent while the navigator watches the code form. That running commentary is what made unfamiliar patterns legible and juniors level up. It died because it cost two salaries per keyboard; an agent narrating its own work costs nothing extra and never tires of explaining.

**Why audio, specifically.** Mayer's multimedia-learning research (the modality principle) found people learn better from visuals plus *spoken* narration than visuals plus on-screen text, because text and diagrams compete for the same visual channel while audio rides a separate one. Today every agent explanation arrives as more text next to the code text, so reading the explanation means not reading the code. Spoken narration is the only explanation format that doesn't tax the channel you're using to read diffs. This is the real argument, not "it's a nice option."

**Coupling to the throttle.** The slower the dial, the more room for explanation; at real-time, narration drops to terse change-log mutters or goes silent. The throttle creates the temporal space and the narration spends it. This is why it's one product, not two features: slow mode without narration risks being paint-drying; narration without slow mode has no room to breathe.

**Register (this makes or breaks it).** Level-aware, like a good pairing partner:
- Silent through boilerplate.
- A sentence for routine work.
- Genuinely discursive only when something is non-obvious — an unfamiliar pattern, a tradeoff, a deviation from how the codebase usually does things.
- "Why" beats "what" almost always; the *what* is on screen.

The interesting trigger is unfamiliarity — and unfamiliar *to whom*. If the system knows which patterns this developer has seen before (Coulter-adjacent knowledge), narration depth personalizes: explain the visitor pattern to the engineer who's never touched one, skip it for the one who wrote three this week. That is mentoring, mechanically — calibrated explanation at the moment of encounter, in context, optional.

**Quality is carrying everything.** "Now I'm adding error handling" is noise. "I'm wrapping this in a retry because this API rate-limits aggressively and the existing client swallows 429s" is the product. This is a prompting-and-context problem more than a TTS problem: the narrator needs the agent's actual reasoning, not just the diff. **This is the first technical risk to derisk** (§11).

**Implementation notes.**
- Narration script generation runs *ahead* of the display stream (it reads the queue), so audio doesn't lag the diff. Robotic narration four seconds behind the hunk is worse than silence.
- A transcript renders alongside, always — for the audio-averse and for searchability.
- One-keystroke off switch. Audio is the most intrusive channel and the fastest route to uninstall. Default off; earn its way on, ideally by being magical the first time someone hits an unfamiliar pattern and asks "explain this."

### 6.2 The intent-grouped change view

**The observation:** the unified diff format was never designed for human comprehension. It was designed circa late-'70s/early-'80s as a *transmission* format — the minimal line-based delta `patch` needs to reconstruct a file over a slow link. Line-orientation is a storage-and-transport choice that leaked into the UI layer and calcified. Every diff viewer since is polish on a format optimized for a machine consumer. We are reading the wire protocol.

**Why it's expensive now.** A 1976 transmission format was a tolerable reading format right up until humans stopped writing most of the code and review volume jumped (~47% more PRs per developer, per Faros telemetry). Eye-tracking studies of review show readers spend large fractions of their time reconstructing context the diff doesn't provide; defect-detection drops on "tangled" changes that mix intents — yet diffs present everything in file order, which is essentially random with respect to intent.

**Why prior attempts stopped short.** Difftastic and SemanticDiff parse to an AST and diff structure instead of lines, which kills false positives (reformats, reorders shown as noise). But nobody attacked *narrative order*: a changeset is a story with a thesis, supporting changes, and mechanical consequences, and the line diff flattens that into alphabetized shrapnel the reader must re-derive. That re-derivation is the review fatigue.

**Jig's unfair advantage.** Every prior effort had to *reverse-engineer* intent from the final patch — genuinely hard. Jig doesn't. It sits on the live tool-call stream: the actual order edits were made, which edits belong to which stated goal, and the narrator's "why." The intent structure GitHub would need a research team to infer, Jig gets for free from the buffer. It **preserves** the story rather than reconstructing it.

**The presentation:**
- **Intent groups replace file order.** Reading order is explanation order: thesis (core change) → supporting → mechanical consequences. This alone removes most re-derivation.
- **Mechanical repetition collapses to a claim plus exceptions.** "12 identical call-site updates" is one fact, not twelve diffs. AST-level sameness verification (tree-sitter) confirms the transform is truly identical and surfaces only deviations. This kills the vigilance-decrement waste — scrolling near-identical hunks at full attention because one of them *might* differ, with no machine assist on which.
- **Outliers are flagged as judgment sites, not errors.** When one of the twelve deviates (e.g. a charge endpoint that adds `maxAttempts` and an idempotency key because blind-retrying a charge risks double-billing), that's the agent exercising *good* judgment. Flagging it as a defect would train the user to ignore the flag. Flagging it as "a decision was made here, your look has highest expected value here" is the honest framing. Sometimes you approve, sometimes you steer.
- **Highlight the delta from the *pattern*, not just from the old code.** Standard diffs know only before/after. With the sibling transform as a third reference point, the view marks precisely the lines where an outlier departs from what its siblings did. The eye goes straight to the deviation; matching parts recede.
- **Edit IDs make steering addressable.** "Re: edit #3" works because the view preserves the stream's identity (§7).

**Escape hatch, non-negotiable.** Raw unified diff is always one keystroke away. Engineers trust line diffs the way pilots trust steam gauges; the moment the semantic view hides something that mattered (a whitespace change that broke a YAML file), trust in the whole abstraction dies if there's no path to ground truth. Grouped view is the default lens, never the only one.

---

## 7. Layer 3 — Steer (full-duplex correction)

**Goal:** close the loop. Watch → pace → hear reasoning → *talk back and have it matter*. The hard, valuable case is an utterance like: *"Where did you get this list of categories? It's not consistent with another file we have."*

### The routing insight
That utterance is two things wearing one sentence. It starts as a **provenance question** (answerable from the transcript — the agent got the list from the spec, or invented it) and may escalate into a **correction** (go reconcile with the other file). They route differently, and the architecture falls out of the distinction.

**Do not pipe every utterance into the main agent's loop.** Half of what a navigator says is for their own understanding, not steering input. Injecting all of it costs the agent momentum and burns context on conversational back-and-forth that mostly doesn't change the work.

### Sidecar conversation model
The narrator, promoted to interlocutor. It has *read* access to the live transcript, the repo, and the edit buffer. It answers provenance questions directly with zero disruption to the agent: *"It pulled them from the enum in `billing/types.ts` — it hasn't seen the file you're thinking of."* The main agent never knows the question was asked.

### Escalation = the interesting moment
When the conversation produces a conclusion the agent *needs* — "use the categories from `config/taxonomy.json` instead" — the sidecar composes it into a precise, **anchored** directive ("re: edit #14, the categories list") and injects it. The buffer's preserved edit identity is what makes anchoring possible; the stale-context problem that kills naive mid-stream interruption ("which thing are you even objecting to?") is solved by the same queue that solves pacing. And because the throttle keeps the agent close to your objection, corrections land before consequences stack.

### Mechanics
- **Hooks give you the outbound stream** (every tool call, into the buffer, gated). **The Agent SDK's streaming input gives you the inbound channel** (directives, injected at tool-call boundaries). The sidecar arbitrates between *answering* (conversation) and *injecting* (steering).
- **Inject at the next tool-call boundary, not mid-edit**, so the agent integrates the correction at a natural seam instead of having its current operation yanked.
- (Hooks alone could contort `PreToolUse` deny-with-reason into a crude steering channel — the agent sees the reason — but it only fires when a tool call happens to be in flight and conflates "stop" with "here's information." The SDK is the clean inbound path.)

### Two firm constraints
- **Honest about answer provenance.** When the transcript contains the agent's actual reasoning, say so. When it doesn't, *"the transcript doesn't show why — want me to ask it directly?"* must be in the sidecar's vocabulary. A sidecar that confabulates a plausible rationale the agent never had is actively dangerous: you'd make keep/reject decisions on fiction. The escalation path (sidecar poses the question *to* the agent as an injected aside, relays the answer) is more expensive but real, and the user should know which kind of answer they got.
- **Conservative on auto-escalation.** The human pulls the trigger. The sidecar must not infer that grumbling implies a correction and inject directives the user didn't issue — that's a lossy game of telephone steering the codebase. Asides stay asides until the user says otherwise (a lightweight "send that to the agent?" is fine). This keeps the conversation a safe space to think aloud, not a hot mic.

### Build it with text first
Same architecture, no latency knife-edge. Voice is the polish pass once the routing logic is proven. The honest hard part of this layer is conversational turn-taking quality, not plumbing: sub-second to first response so it feels live (constrains model choice), and trustworthy transcript answers. If the sidecar is sluggish or wrong twice, people stop talking to it and you're back to a viewing tool.

---

## 8. The Coulter loop

Every pause, downshift, correction, and approval is a judgment-capture moment, and the capture has unusually clean provenance.

- A spoken exchange that runs *question → explanation → "no, that's inconsistent with how we do it" → directive → fix* is a complete convention sample with the reasoning on both sides, captured at the moment of disagreement, in full code context. **The escalation event is the capture event** — no later mining required.
- An approval like *"charges get capped attempts + idempotency keys, read-only calls keep defaults"* is a convention being born: the rule, the reasoning, the code context, and an explicit human sign-off, all at the moment of decision.
- The throttle UI and Coulter are the same thing from two angles: one controls the *rate* of judgment, the other records its *content*. If the pause button also opens an inline "actually, do it this way" that's captured as a sample, the loop between attention and taste closes. The conversation channel doesn't just steer the session — it generates the training corpus for every future session.

This is also the meaning-preservation argument made concrete. The Nature Scientific Reports finding is that *passive* reliance on AI erodes self-efficacy and the sense of meaning core to intrinsic motivation, while *active collaboration* mitigates it. Jig's throttle structurally enforces the active posture; review-and-rubber-stamp is the passive one. Jig is, among other things, a deskilling countermeasure that happens to also make the work more legible.

---

## 9. Technical stack

Consistent with local-first, composability-over-frameworks, boring-technology preferences.

- **Outbound:** Claude Code `PreToolUse` hooks on `Edit`/`Write`, blocking on a UI-controlled semaphore.
- **Inbound:** Claude Agent SDK streaming input for directive injection at tool-call boundaries. (The dashboard already hosts sessions via the SDK — this rides that decision.)
- **Event log / queue:** the existing SQLite-backed artifact store from the PR digest.
- **UI:** local web UI over websockets; the diff view, the queue timeline, and the sidecar chat are projections of the log.
- **Structural diff:** tree-sitter for AST-level sameness verification and outlier detection.
- **Narration:** a cheap model generating "why" annotations from the agent's reasoning (running ahead of the display stream); TTS layer on top, transcript always rendered.
- **Sidecar:** a fast model with read access to transcript + repo + buffer; sub-second first response for voice.

MCP is not required for the core loop and shouldn't be forced into it. This composes with the existing knowledge-condensing stack (Coulter, PR digest, Rigor) rather than replacing any of it.

## 10. Build sequence (de-risking order)

Each layer is independently useful, so build in the order that retires the most risk per unit of work and gives a usable tool at every stop.

1. **Phase 1 — Observe (a weekend).** Hook + websocket UI + queue. Crude paced edit stream with a manual dial, plain diffs, no narration, no steering. Dogfood it. Within two weeks this answers the one question no amount of design settles: does paced immersion feel like flow or like watching paint dry (§11)?
2. **Phase 2 — Understand.** Add the intent-grouped diff view (preserve structure from the stream; AST collapse + outlier flagging) and then narration (text/transcript first, TTS second). Derisk the why-stream richness early — it gates everything downstream.
3. **Phase 3 — Steer.** Sidecar in text first (provenance Q&A, then human-triggered anchored directives via the SDK). Voice last, as polish, once routing and turn-taking are proven.

## 11. Open questions & risks

Stated plainly because the honest risks matter more than the pitch.

- **The central unproven bet:** that *paced* comprehension preserves immersion better than *interrupted* comprehension. It might instead feel like a slow drip of interruptions. The instinct for "yes" is that the killer in context-switching is re-orientation cost and a continuous stream never de-orients you — but this is only settled by sitting in the chair. Phase 1 exists to answer it before anything else is built.
- **Why-stream richness (first technical risk):** can enough of the agent's *why* be captured through the hook surface, or must the narrator reconstruct intent from the transcript? If the why-stream is rich, everything downstream works. If it's thin, you've built an audiobook of diffs. Derisk in Phase 1/2.
- **Bottleneck-guilt failure mode:** the moment the user feels the agent "waiting on them," there's pressure to crank the dial to real-time and the product goes vestigial. Mitigations are designed in (calm visible queue; backpressure on writes not thought) but need to be validated, not assumed.
- **Sidecar latency and trust:** voice only works sub-second; transcript answers must be trustworthy and provenance-honest. Two sluggish-or-wrong interactions and people stop talking to it.
- **Platform-squash risk:** the attention-management and even some steering surface could be absorbed by the agent platforms themselves (they have the incentive). The diff view and the Coulter-coupled judgment-capture are the most defensible parts — verification and judgment infrastructure are what the foundation labs are structurally worst at selling, since verification is adversarial to their own output. Lean there.

---

## Appendix — research grounding

Each design choice traces to a finding (sources named for follow-up, not reproduced):

- **Productivity-experience paradox** — productivity holds while flow state and cognitive load degrade under AI-assisted work; the shift to *supervisory* work is the suspected driver (longitudinal arXiv study, 2026). → the entire premise that the strain is structural, not motivational.
- **Decision fatigue at the design level** replacing detail fatigue (practitioner accounts). → why supervisory work is more draining than hard code.
- **~47% more PRs per developer, more parallel streams, orchestration/validation overhead** (Faros AI telemetry, 10k+ devs). → review/comprehension is where the hours now go; the diff format's inefficiency turned expensive here.
- **Reabsorbed-slack burnout** — saved minutes become more-work expectations, hitting AI adopters hardest (HBR embedded study). → why "more output" doesn't relieve pressure; why throttling is countercultural but correct.
- **Passive reliance erodes self-efficacy and meaning; active collaboration mitigates** (Nature Scientific Reports, 2025). → the throttle as active-posture enforcement; the deskilling-countermeasure framing.
- **Deskilling as a structural problem** — systemic conditions inhibit capacity cultivation (AI & Society, 2025). → judgment-capture as prevention of an org-level loss.
- **Modality principle** — spoken narration + visuals beats text + visuals because audio uses a separate channel (Mayer, multimedia learning). → why narration is audio, not more on-screen text.
- **Eye-tracking review studies, vigilance decrement, tangled-change defect rates.** → intent grouping, mechanical collapse, and outlier flagging.
- **Unified diff as a 1970s transmission format**; AST-diff prior art (Difftastic, SemanticDiff) that stops short of narrative order. → the comprehension-first diff view and Jig's stream-derived advantage.
