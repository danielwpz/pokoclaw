# Runtime Orchestration Plan

Last updated: 2026-03-25

## Purpose

This document is the implementation plan for the next major phase of Pokeclaw:
turning the current agent/runtime/security foundation into the full runtime
coordination and orchestration layer required by the current MVP product.

Important constraint:

- The goal is not to build a temporary "minimal version" and revisit the real
  product later.
- The goal is to complete the current MVP product shape directly.
- Development may still proceed in phases, but each phase must align with the
  final intended architecture rather than introducing throwaway control flows.

## Current State

The following foundations are already in place:

- `AgentLoop` supports:
  - multi-turn model execution
  - tool execution
  - steer insertion
  - compaction hooks
  - approval wait hot path
  - approval retry for `request_permissions`
- `src/runtime/*` already contains:
  - `dispatcher`
  - `session-lane`
  - `ingress`
- The permission system already supports:
  - explicit `request_permissions` for structured tools
  - `bash` `sandboxed / full_access`
  - `bash.full_access(prefix)` grants
  - approval ledger + grants
- Database foundations already exist for:
  - `agents`
  - `sessions`
  - `messages`
  - `cron_jobs`
  - `task_runs`
  - `approval_ledger`
  - `agent_permission_grants`

Important current-schema note:

- persisted `agents.kind` is still only `main | sub`
- unattended/runtime-specific identities must currently be derived from:
  - `sessions.purpose`
  - `task_runs.run_type`
  - `task_runs.execution_session_id`
- do not assume a persisted `task` agent kind exists yet unless the schema is
  intentionally expanded later

The missing piece is not raw capability. The missing piece is a coherent
runtime control plane that coordinates:

- Main Agent
- SubAgent
- TaskAgent
- cron-backed unattended runs
- approval routing
- stop / steer / pause / resume / retry
- task lifecycle and observability

## Main Design Goal

Build a formal runtime/orchestration layer that owns:

1. session/run coordination
2. agent role resolution
3. approval routing and delivery
4. task/cron execution lifecycle
5. future system controls such as `/status`, `/stop`, `/restart`

This layer should sit between:

- the low-level `AgentLoop`
- and the future messaging/channel layers

## Layer Boundaries

The boundary rule must stay explicit:

- `AgentLoop` = single-session, single-run execution engine
- `runtime/*` = session-local ingress/lane shell
- `agent/*` = role/policy/behavior definition
- `orchestration/*` = cross-session, cross-agent, product-level coordination
- `channel adapter` = channel-specific rendering, aggregation, transport

If one layer starts doing another layer's job, the architecture is drifting.

### 1. AgentLoop

`AgentLoop` remains the execution engine for a single session run.

It should continue to own:

- model turn execution
- tool execution
- steer insertion inside a run
- approval hot wait
- same-tool retry after approval
- compaction checks

It should not become responsible for:

- deciding whether an approval target is `user` or `main_agent`
- delivering approval requests to another agent
- task agent spawning
- cron scheduling
- global runtime ownership/state

Short rule:

- `AgentLoop` only answers: "how does this one session run execute?"

### 2. Runtime ingress / dispatcher / session lane

`src/runtime/*` should remain the transport-facing runtime shell.

It should own:

- one-active-run-per-session invariant
- start-vs-steer decision
- approval decision ingress
- future session-local stop/cancel routing

It should not become the place for product-level orchestration rules.

Short rule:

- `runtime/*` only answers: "how does external input safely enter one session?"

### 3. Orchestration / Agent Manager

This is the new main layer to build.

It should own:

- mapping `session -> conversation -> branch -> owner agent -> runtime role`
- task run and cron run coordination
- approval routing
- delegated approval delivery to Main Agent
- future live-state / status aggregation
- future spawn/stop/restart coordination

It should also own:

- deciding which logical conversation/branch should receive a task result,
  delegated approval request, or cron notification
- producing outbound delivery payloads as:
  - raw runtime event
  - plus necessary business context
  - plus already-decided logical delivery target

It must not:

- render final human-facing channel messages
- decide Feishu card shapes, thread usage, patch strategy, or markdown/text
  formatting

Short rule:

- `orchestration/*` answers: "which agent/run/session/channel target should this business event go to?"

### 4. Messaging / Channel

Still deferred until later tasks.

This layer will:

- translate runtime events to UI
- translate user/channel callbacks to ingress commands

It must not own approval state machines or orchestration logic.

More precisely:

- channel adapter receives:
  - raw runtime event
  - orchestration context
  - logical delivery target
- then decides:
  - whether to display it
  - how to aggregate it
  - whether to send a new message, patch a card, reply in a thread, or degrade
    to plain text

Short rule:

- `channel adapter` answers: "how should this event be presented on this platform?"

### 5. Async transport boundary

This boundary must be fixed from the start:

- `channel -> ingress` is asynchronous
- `agent/runtime -> channel` is asynchronous
- channel transport must not sit on the critical path of session execution

More concretely:

- adapter should acknowledge platform callbacks quickly, then submit an ingress
  command asynchronously
- runtime/orchestration should emit outbound delivery payloads asynchronously;
  a run must not wait for Feishu/Slack/etc. transport success before it can
  complete
- runs may still pause on business state (approval, cancel, stop), but not on
  channel rendering or transport delivery

Short rule:

- business state may block a run; channel transport must not

Additional rule for IM product flows:

- Main Agent tool calls must not stay open across an arbitrary user-confirmation
  wait
- if a product action needs a card/button/text confirmation from the user, the
  tool should usually persist a pending request and return immediately
- later confirmation continues orchestration asynchronously instead of resuming
  the old Main Agent tool call

## Product Behaviors This Layer Must Support

### A. Main Agent chat

- Receives normal user messages
- Runs directly in its own session
- Structured tool approval target is usually `user`
- Bash full-access approval target is usually `user`
- Does not receive delegated approval requests inline in its main chat session

### B. SubAgent chat

- Has its own persistent conversation/session context
- Uses the same runtime engine as Main Agent
- Structured tool approval target is currently still `user`
- Bash full-access approval target is currently still `user`
- May create TaskAgent runs later
- Its creation path is two-stage:
  - Main Agent submits a pending SubAgent creation request
  - later user confirmation triggers the actual conversation-surface
    provisioning flow
- Main Agent responsiveness is more important than keeping the original
  `create_subagent` tool call open

### C. TaskAgent

- Background execution unit
- No standalone chat surface in the first runtime implementation
- Owns a distinct execution session and task_run row
- Uses its owner agent's effective permission baseline plus granted scopes
- When it needs additional approval during unattended execution:
  - target must be `main_agent`

### D. Cron run

- A scheduled trigger that creates a new background task run
- Reuses the same TaskAgent execution backbone
- If new approval is needed during unattended execution:
  - target must be `main_agent`

## Approval Model Target State

The system should support one approval model with two routing targets:

- `user`
- `main_agent`

Both should use the same:

- `approval_ledger`
- grant storage
- request serialization
- expiry handling
- audit model

Differences should only exist in delivery/routing.

### User-targeted approval

Current flow already exists:

1. tool triggers approval-required
2. approval record is created
3. run pauses on hot wait
4. external approval decision comes back via ingress
5. run resumes

### Main-agent-targeted approval

Required product flow:

1. unattended TaskAgent/Cron run triggers approval-required
2. approval record is created with `approval_target = main_agent`
3. original run pauses on hot wait
4. orchestration layer creates or reuses a dedicated Main Agent approval session
5. Main Agent reviews the request there with a restricted tool set
6. Main Agent decides approve/deny and includes a short reason
7. orchestration layer converts that into approval resolution
8. original run resumes

Important constraints:

- delegated approval must not be injected into the user-facing Main Agent chat session
- approval results should not be appended back into the main chat transcript
- approval audit lives in database state, not in the main chat history
- the approval session should default to a small fixed tool allowlist:
  - read-only investigation tools
  - dedicated approval review tool
  - no default bash/write/edit access
- the approval session should use a dedicated prompt branch:
  - this session is for delegated approval review, not task execution
  - it should instruct the Main Agent to investigate only with the read-only allowlist when needed
  - it should require a short reason on both approve and deny
- approval session reuse should be scoped to one unattended run:
  - within the same source execution session / task run, reuse the same approval session
  - for a later new task run, fork a fresh approval session from the latest Main Agent chat context
  - if an approval session is older than the max age window, force a fresh fork even for the same run
- each new approval request should include a bounded summary of recent approval decisions for the same unattended run
- approval grants use the system default TTL in the first version; the agent
  does not choose `expiresAt` or duration yet

This is the first major orchestration feature to implement.

## Key Architectural Rule

Do not hardcode approval routing inside `AgentLoop`.

Current code still has a temporary hardcoded path:

- `requestApproval()` in `src/agent/loop.ts` creates approval records with
  `approvalTarget: "user"`

This must be replaced by an orchestration-owned routing decision.

## Phase Plan

### Phase 1: Approval routing extraction

Introduce a formal approval routing layer.

Suggested file:

- `src/runtime/approval-routing.ts`

Responsibilities:

- decide approval target based on runtime context
- expose a single function used by loop/orchestration

Target routing rules:

- Main Agent chat session -> `user`
- SubAgent chat session -> `user`
- TaskAgent run -> `main_agent`
- cron-backed unattended run -> `main_agent`

This should be implemented as a proper runtime/orchestration policy decision,
not a scattered inline conditional.

### Phase 2: Runtime role and live-state model

Introduce runtime-level state resolution.

Suggested files:

- `src/runtime/live-state.ts`
- `src/orchestration/agent-manager.ts`

Responsibilities:

- resolve runtime identity from session/task metadata
- determine whether a given session belongs to:
  - Main Agent
  - SubAgent
  - TaskAgent execution
  - cron execution
- expose stable queries for:
  - active run state
  - owner agent identity
  - parent run linkage
  - pending approvals

This layer should become the future basis for `/status`, observability, and
cross-session coordination.

### Phase 3: TaskAgent execution backbone

Bring `task_runs` into real use.

Suggested files:

- `src/orchestration/task-runner.ts`
- `src/tasks/session-factory.ts`
- `src/tasks/task-runs.ts`

Responsibilities:

- create task_run rows
- create execution sessions for background runs
- attach:
  - `owner_agent_id`
  - `initiator_session_id`
  - `parent_run_id`
  - `conversation_id`
  - `branch_id`
- track task run status transitions
- allow pause/resume under approval waits
- allow later stop/cancel propagation

This is not optional future polish. It is required to support:

- delegated approval
- unattended execution
- cron

### Phase 4: Main Agent delegated approval path

Implement the real `main_agent` approval flow.

Suggested file:

- `src/orchestration/approval-orchestrator.ts`

Responsibilities:

- when approval target is `main_agent`:
  - persist request
  - route request into a dedicated Main Agent approval session
  - later resolve that request from Main Agent action inside that approval session
  - resume waiting task run

First implementation rule:

- do not block on UI/channel design
- use runtime/session primitives first
- later messaging/channel tasks can wrap the same flow with cards/buttons

### Phase 5: Unified ingress/control entrypoints

Expand runtime ingress beyond plain user messages and direct approval responses.

Suggested long-term commands:

- submit user message
- submit approval decision
- submit delegated approval request delivery
- submit task spawn
- submit subagent creation request
- submit subagent creation decision
- submit stop command
- submit system control command

The important rule is:

- external callers should submit semantic commands
- they should not manually decide lane behavior or mutate session state directly

For `create_subagent`, the control split must stay explicit:

- request submission persists a pending creation request and returns immediately
- channel/adapters decide how to present the confirmation UI
- a later approve/deny signal updates the request state
- only after approval does orchestration call the platform-agnostic
  SubAgent-surface provisioner

This is intentionally different from approval pause/resume inside a background
run. Main Agent chat responsiveness wins over trying to resume the original
tool call.

## Main Questions Already Resolved

### 1. Product target

Resolved:

- build toward the full current MVP, not a detached temporary mini-version

### 2. Approval model

Resolved:

- structured tools use `request_permissions`
- `bash` full access is approved directly on `bash`
- both still use one underlying approval/grant system

### 3. Bash long-lived approval scope

Resolved:

- long-lived grant is prefix-scoped
- only a single simple command shape is eligible
- leading `KEY=value` is normalized away
- complex shell only gets one-shot approval

## Remaining Product/Architecture Questions To Confirm

These need explicit confirmation during implementation.

### Q1. How exactly should delegated approval be delivered to Main Agent?

Resolved:

- not through the user-facing Main Agent chat session
- through a dedicated Main Agent approval session
- that approval session may be forked from the main chat context, but its
  transcript remains separate and non-user-facing

### Q2. What tools should the approval session have?

Resolved:

- default to a fixed minimal allowlist
- start with read-only investigation tools plus a dedicated approval review tool
- do not give it full general-purpose tools by default

### Q3. Who chooses the approval grant duration?

Resolved:

- not the agent in the first version
- delegated approvals use the system default TTL
- later iterations may expose more choices if product pressure appears

### Q4. Should TaskAgent become a first-class runtime object now?

Recommended answer:

- yes

Rationale:

- cron and delegated approval both require it
- delaying this would create another fake temporary path

### Q5. Should SubAgent creation reuse the same pause/resume wait model as approval?

Resolved:

- no
- Main Agent `create_subagent` is a pending-request product action, not a
  long-lived paused tool wait
- users may ignore the confirmation card and continue chatting, so the Main
  Agent run must already be finished
- adapter/UI behavior after approve/deny/fail is adapter-owned, while
  orchestration only owns the request state machine and downstream actions

## Implementation Constraints

- Keep using the current SQLite schema unless a concrete gap is discovered.
- Prefer adding orchestration modules instead of growing `AgentLoop` further.
- Avoid channel/UI assumptions in orchestration code.
- Preserve single-process, in-memory lane semantics for now, but do not hardcode
  product logic into lane internals.
- Any phase-specific simplification must still match the final intended runtime
  shape.

## Testing Plan For This Phase

The next phase must add tests in parallel with implementation.

Target test areas:

- `tests/runtime/*`
  - approval routing
  - session lane interactions with delegated approvals
  - live-state resolution
- `tests/orchestration/*`
  - agent-manager role resolution
  - delegated approval delivery to Main Agent
  - task run lifecycle
- `tests/cron/*`
  - cron -> task run creation
  - unattended approval routing to Main Agent
- focused integration tests
  - TaskAgent pauses on approval
  - Main Agent approves
  - original run resumes and continues

## Near-Term Work Order

Recommended concrete implementation order:

1. approval routing extraction
2. agent/runtime role resolution
3. task run execution backbone
4. delegated approval orchestration to Main Agent
5. live-state and control entrypoints
6. cron integration on top of the same task backbone

Current next implementation order after the latest delegated-approval session work:

1. formalize `runtime/live-state` so any component can resolve:
   - session -> owner agent -> main agent
   - session -> task run
   - task run -> execution session / approval session
2. expand `agent-manager` from delegated-approval delivery helper into the
   orchestration-facing control-plane entrypoint
3. complete the `task_run` execution backbone so unattended runs have stable
   lifecycle/status/state instead of scattered helper lookups
4. keep channel transport out of this path; downstream adapters should later
   consume raw runtime events plus orchestration context asynchronously

## Non-Goals For The Immediate Next Slice

These are important, but should not block the start of orchestration work:

- final Feishu approval cards
- final status card rendering
- full background process/job UI
- skills injection into normal-turn prompt
- full memory injection

Those remain dependent on later tasks, but the runtime layer must be designed so
they can attach without refactoring core orchestration again.
