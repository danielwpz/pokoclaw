# Architecture

Pokoclaw is a personal AI assistant. This document explains the key design decisions behind its technical architecture — aimed at developers who want to understand *why* it is built this way, not just *what* it does.

---

**Pokoclaw is a system where the agent is not the control plane.**

## TL;DR

Pokoclaw is built around a **semantic event stream**. The Runtime emits structured events, Orchestration routes them across sessions and tasks, and Channel adapters render them into user-facing surfaces. The Main Agent stays responsive by delegating long-running work to SubAgents and TaskAgents. Trust boundaries are enforced by the host runtime, not by the model. State lives across `config.toml`, `secrets.toml`, SQLite, and editable Markdown memory layers.

```
User / Channel
      ↕
Channel Adapter          ← renders events into platform UI
      ↕                  ← platform actions / ingress commands
Orchestration            ← session routing, task fork, context projection
      ↕                  ← semantic event stream
Runtime                  ← turn execution, tool calls, permission checks
      ↕
Tools / Sandbox / Storage
```

---

## 1. Three Layers, Not Two

Many two-layer systems find that the channel adapter bleeds assumptions into the runtime — the event model inherits the shape of the first channel, and the permission model becomes channel-shaped. Adding a second channel means untangling both layers at once.

Pokoclaw draws three lines instead of two:

**Runtime** — pure agent logic. It produces semantic events only: `assistant_message_start`, `assistant_message_delta`, `assistant_message_end`, `tool_call_start`, `tool_call_end`, `compaction_start`, `compaction_end`, `approval_requested`, `approval_resolved`, `turn_start`, `turn_end`, `run_error`. It has no concept of a channel, a card, a patch, or a typing indicator.

**Orchestration** — session management, context projection, and background task dispatch. This layer decides *which* session receives *which* events, and forks sessions when cron or TaskAgents need to run in the background. It is channel-agnostic.

**Channel** — the adapter layer. It subscribes to runtime events and translates them into platform actions: streaming rendering, approval cards, typing indicators, patch updates. It maps user interactions back into ingress commands. The channel layer never mutates runtime state.

The contract between layers is the event stream, not shared state or shared assumptions. If you wanted to build a second channel adapter, you would only touch the channel layer. The runtime and orchestration layers would not change.

**Runtime responsibilities:**
- Executes a single agent run
- Emits semantic events
- Evaluates tool calls and permission boundaries
- Has no knowledge of channel topology or session routing

**Orchestration responsibilities:**
- Owns session lifecycle
- Routes events to sessions
- Handles session fork
- Schedules background execution
- Does not generate agent output

**Channel responsibilities:**
- Translates events into platform-native UI
- Translates user actions into ingress commands
- Never mutates runtime state

The event stream is the source of truth for execution, not derived logs. Every downstream consumer — channel rendering, logging, debugging, replay — subscribes to the same stream. There is no separate "execution record" that diverges from the event history.

**Trade-off:** Splitting the channel from the runtime means investing in an event protocol upfront, and debugging across layer boundaries adds a step. That cost is worth paying because it makes the channel replaceable, enables replay, and makes observability a structural property rather than a feature you bolt on later.

---

## 2. The Agent Is Never the Boss

A core product property of Pokoclaw is that the Main Agent — the permanent entry point the user talks to — should always be responsive. This sounds obvious but has deep architectural consequences.

In a single-loop system, a heavy request blocks the main conversation loop. The agent is thinking, the user is waiting, and any new message either gets queued or interrupts a run that may not be safe to interrupt. The user experience degrades in proportion to the complexity of what they ask for.

The key architectural shift: in many AI assistant systems, the agent loop *is* the system — it owns execution, control flow, and context simultaneously. Pokoclaw separates these. The agent is not the control plane; the system is. The Orchestration layer owns routing, scheduling, and lifecycle. The Runtime executes. The Channel renders. The agent executes within the boundaries the system sets.

Pokoclaw separates *responsiveness* from *capability* by giving the Main Agent two tools that other roles do not have: **delegation** and **deferred execution**.

When the Main Agent receives a complex request, it can delegate to a **SubAgent** — a task-specific persistent agent that owns its own channel thread. SubAgents live in their own conversation context and accumulate their own memory. The Main Agent returns to listening immediately. A SubAgent gets its own thread so work is cleanly isolated, steering is unambiguous, the Main Agent's context stays clean, and it is easy to observe what is happening in each SubAgent separately.

When a request is long-running or needs to happen without the user present, the Main Agent can spawn a **TaskAgent** — a background execution unit with no persistent channel thread. It runs to completion or to the next blocking decision, then surfaces results via task cards in the originating conversation. TaskAgents are destroyed when their task ends.

The three roles:

| Role | Lifespan | Channel | Persistent memory |
|------|----------|---------|-------------------|
| **Main Agent** | Permanent | 1v1 DM, always listening | Shared Layer 2 |
| **SubAgent** | Until task area closed | Own group thread | Private Layer 3 |
| **TaskAgent** | Until task completes | Via task cards | None. Run context comes from a forked session snapshot |

### System invariants

These are rules that cannot be violated by any future change:

- The agent is never the control plane
- No execution blocks the Main Agent
- No background task runs without a fully materialized context
- All external effects pass through runtime-enforced permissions

An ordinary thread creates a new conversation branch with inherited context. A task thread routes back to the source session and becomes a steering input — the user can reply to interrupt or redirect. The system handles the distinction; the agent just works.

**Trade-off:** Managing the lifecycle of SubAgents and TaskAgents adds complexity to both the system and the user's mental model. The benefit is that the Main Agent is never blocked, background work gets real context, and the user can always reach the Main Agent regardless of what else is running.

---

## 3. Trust Is Layered, Not Binary

Many AI assistant systems treat trust as binary: the agent either has full tool access or runs sandboxed. Pokoclaw uses a layered model. The meaning of "trusted" depends on what you are talking about.

**The agent is untrusted by default for all external effects.** Every tool call and bash command executes in a constrained context. The agent can try anything, but the execution environment enforces boundaries before anything dangerous happens.

**The host runtime is trusted.** The distinction is between the *agent's outputs* — model responses, tool calls, reasoning chains — and the *infrastructure* that executes them. Agents produce strings; those strings go through a permission check before they become actions.

**Permissions are not properties of the agent. They are properties of the execution environment.** The agent cannot grant itself access; the environment enforces boundaries regardless of what the agent's reasoning suggests. This shift — from trust-as-prompt-discipline to trust-as-runtime-enforcement — is the architectural difference that makes the security model auditable.

This leads to three concrete patterns:

**Explicit permission escalation.** When a tool call hits a permission boundary, it returns a `permission_block`. The agent then explicitly calls `request_permissions`, which surfaces a visible approval to the user. Permission requests are part of the conversation transcript. The user always knows when the agent is asking for more access.

**Two-tier bash execution.** Bash commands run sandboxed by default — OS-level isolation, workspace directory readable/writable, system config directory hard-denied, no Docker dependency. Full access requires explicit user approval with a prefix-scoped grant. Single simple commands can get reusable prefixes. Compound commands involving `&&`, `|`, or heredoc always require a fresh one-shot approval. The agent cannot silently escalate.

**Delegated approval.** When a TaskAgent or unattended task run needs approval, the system first tries the normal visible user approval flow. If the user does not respond before the approval timeout, the runtime can fall back to Main Agent delegated review in a dedicated approval session. After two consecutive user-approval timeouts within the same task execution session, later approvals in that same session route directly to delegated review by default. The delegated approval session uses a restricted tool set — read-only investigation tools plus a dedicated `review_permission_request` tool. This session is for evaluation only; it does not continue executing the task itself.

Delegated approval operates within a policy ceiling defined in `config.toml`. Sensitive permission types — dangerous bash prefixes, access to specific paths, operations above a configured risk threshold — are marked as `always_require_human`. These never flow through delegated approval; they always surface to the user directly. The Main Agent's approval authority is scoped by policy, not unbounded. Decisions are written to an approval ledger in SQLite. The ledger is an audit record, not an authorization source; the source of truth for what is permitted is the policy configuration plus the human-decided boundary.

**Trade-off:** Explicit permission checks and approval sessions add latency and friction to some tool calls. The alternative — silent escalation or hidden approval — makes security invisible and unauditable. Pokoclaw accepts the friction because it makes the trust model something you can reason about and audit.

---

## 4. Storage Follows Access Control

Pokoclaw has three storage layers. The layering is not organizational — it maps to access control boundaries.

| Layer | Location | Who can access | What lives here |
|-------|----------|---------------|-----------------|
| `config.toml` | `~/.pokoclaw/system/` | User / CLI only | Global defaults, hard limits, system policy |
| `secrets.toml` | `~/.pokoclaw/system/` | Host runtime only | API keys, tokens, credentials |
| **SQLite** | `~/.pokoclaw/system/pokoclaw.db` | Host runtime | Sessions, task runs, approval ledger, cron state, runtime snapshots |
| Memory files | `~/.pokoclaw/workspace/` | User + agents | Layered Markdown memory (see below) |

Agents receive `*_ref` fields in structured config (e.g., `api_key_ref = "env:ANTHROPIC_API_KEY"`). The host runtime resolves the actual value at use time. Agents never see raw secrets. Spawned processes also have environment variables filtered as a defense-in-depth measure.

Memory is in Markdown files — readable and editable by both users and agents directly, not just by code:

- **Layer 1 (`SOUL.md`)** — global static identity. Name, persona, values. Shared by all agents.
- **Layer 2 (`MEMORY.md`)** — shared working memory and Main Agent's long-term memory.
- **Layer 3** — per-SubAgent private memory at `workspace/subagents/<id>/MEMORY.md`.

**Why Markdown?** Because it is human-inspectable and directly editable. Users can read what the agent has memorized, fix it if the agent got something wrong, and add entries without touching code or a database. This is a deliberate choice for transparency, not a concession due to simplicity.

Markdown is not used as a high-write datastore. Operational state — session data, task runs, approval records — lives in SQLite. Memory files are low-frequency artifacts, rewritten deliberately by controlled flows (like Worn-in consolidation). They are not treated as high-throughput state stores.

**Trade-off:** Markdown does not give you ACID transactions or structured queries. Concurrent edits require a simple file lock or single-writer convention. The benefit — inspectability, direct editability, no opaque embedding-only retrieval — is worth it for a personal assistant where the user is an active participant in the memory system.

---

## 5. Background Work Needs Real Context

When a cron job fires or the Main Agent spawns a TaskAgent, the system performs a **session fork**: it materializes a snapshot of the owner's current effective context into a new independent session.

This is not a reference or a pointer — it is the full context at that moment:
- The compacted summary from the parent session
- The uncompacted message suffix
- Kickoff guidance explaining what triggered this background task
- A summary of the most recent related run, if one exists

The forked session then evolves independently. The Main Agent's context continues to compact and accumulate new messages while the background task runs. When the task completes, results surface via task cards in the originating conversation. The user can reply in that thread to steer or interrupt. The forking is invisible to the user.

Without real context materialization, background tasks run blind: they get either stale context from when the user submitted the task, or a bare prompt with no memory of the preceding conversation. Forking the effective context solves both problems.

**Trade-off:** Full context materialization at fork time means background tasks carry some memory overhead and the fork snapshot reflects context state at that instant. If the parent session compacts aggressively while a background task is running, the fork is unaffected — it already has what it needs. The tradeoff is memory and snapshot cost vs. background tasks that actually know what they were doing.

---

## 6. Self-Harness: The System That Improves Itself

Most AI assistants improve only when the user explicitly says "remember this." Pokoclaw has a self-harness system — the self-improvement subsystem — that observes how the user actually works, identifies friction, and closes the feedback loop automatically. Configuration lives under the `self-harness` namespace and runs on a configurable cron schedule.

The first concrete implementation under self-harness is **Meditation** — the daily reflective analysis job. It has one mechanism at this stage: **Worn-in**.

### Worn-in: Reducing Friction Automatically

Worn-in is the friction-learning pipeline. The friction signals it monitors are not technical errors — the user did not say "this is wrong." They stopped responding, rephrased, repeated themselves, or abandoned a branch. These signals are embedded in normal conversation flow and are normally invisible to the system.

The worn-in pipeline:

1. **Harvest** — extract raw friction signals from the database: user stops and interrupts, repeated corrections, tool failure bursts, slow progress, abandoned branches.
2. **Triage** — filter out noise. Not every pause or correction is a signal worth acting on.
3. **Synthesis** — generate a daily `workspace/meditation/<YYYY-MM-DD>.md`. Human-readable. Anyone can open it and see what the system noticed today.
4. **Consolidation** — the consequential step. Review the day's patterns, cross-reference with the last 7 days of notes, and automatically promote stable conclusions into formal memory. Rewrite the canonical state of the affected memory files — not appends. Merge duplicates, absorb outdated entries, improve phrasing over time.

The name worn-in comes from the physical intuition: a new pair of leather shoes is stiff and uncomfortable at first, but becomes comfortable after wearing them in. The friction between user and agent decreases with use — not because the user explicitly taught it, but because the system watched and noticed.

**Guardrails.** Worn-in promotion is conservative by design:
- Only stable, repeated patterns are promoted. One-off frustration is noise, not signal.
- Consolidation rewrites are scoped to specific canonical memory files. It cannot arbitrarily mutate any workspace file.
- Every rewrite is diffable and reversible. The user can review and revert.
- The daily `meditation/<date>.md` is always human-readable. The system explains what it noticed.
- Worn-in can be disabled or scoped via `self-harness.meditation.enabled` and `self-harness.meditation.cron`.

Worn-in is orthogonal to the skill system. Worn-in learns from *runtime friction*; skills encode *reusable procedures*. They address different improvement vectors and live in different places.

**Trade-off:** Automatic memory rewriting carries real risk — the agent could promote a wrong lesson and gradually drift memory in a bad direction. The guardrails above mitigate this: conservative promotion, scoped file targets, diffable rewrites, and user-visible daily notes. The alternative — only improving when the user explicitly instructs — means the system never learns from the friction signals it cannot see.

---

## What Pokoclaw Is Not

Pokoclaw is intentionally not the following:

- **A single-loop chatbot with tools.** It has a multi-role agent model, a layered architecture, and a self-harness system.
- **An agent that runs without constraints.** Trust boundaries are enforced by the host runtime, not by the model's self-discipline.
- **A background scheduler that runs blind prompts.** TaskAgents fork the full effective context; they are not given bare prompts with no conversation history.
- **A memory system that relies on opaque embeddings only.** Memory is in Markdown files, readable and editable by the user.
- **A system that trusts the agent with secrets.** Agents receive `*_ref` fields. The host runtime resolves actual values. Agents cannot exfiltrate secrets they never received.
- **A system that improves only on request.** The self-harness subsystem observes friction signals automatically and closes the feedback loop without being asked.

---

## Summary: The Architectural Shift

Most agent systems are built around an **agent loop**:

- execution, control, context, and permissions are coupled inside the loop
- the agent is both the executor and the control plane
- the system evolves within a continuous, stateful process

Pokoclaw separates these concerns:

| | In many agent-loop systems | In Pokoclaw |
|---|---|---|
| **Control** | The agent loop is the control plane | Orchestration owns routing, scheduling, lifecycle |
| **Context** | Continuous, shared, global | Scoped per role; forked for background work |
| **Trust** | Embedded in execution path or prompt | Enforced by the host runtime, outside the loop |
| **Channels** | Tightly coupled to runtime | Decoupled via event stream adapter |
| **Improvement** | On explicit request only | Automatic friction feedback loop |

The shift:

```
many agent-loop systems:   agent → system
Pokoclaw:                  system → agents
```

The agent executes within boundaries set by the system. The system owns the control plane. This is not a structural optimization — it is an architectural commitment that makes the other properties (observability, auditability, isolation, self-improvement) possible.
