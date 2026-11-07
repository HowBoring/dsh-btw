# 00 · Scope, Product Specification and Correctness

## Problem statement

When a DSH coding Agent is working through a long ReAct Loop, users often need to ask a contextual side question: "Why did it choose this change?", "What has it done so far?", "What's the current build failure?" The question must be answered **immediately**, even in the middle of model streaming or concurrent tool execution. Sending it through the regular composer may steer/queue/interfere with the task; a normal stateless LLM call lacks sufficient context. We need a **side conversation** that reads the agent's latest *observable* state and remains isolated from the main conversation.

## Required user journeys

**J1 · New BTW.** While main Agent is running, user enters `/btw why is this failing?` or opens the BTW panel, submits a question. Separate answer streams live. Main Agent continues without pause, cancellation, tool dispatch, user-message admission, or main transcript pollution.

**J2 · Mid-stream.** Main Agent has already streamed text which is not committed as `assistant/message`. BTW snapshot includes the safely representable visible partial text at the Host capture cut. If no usable partial text, state so explicitly; never fabricate.

**J3 · Mid-tool batch.** The current Agent dispatched tools A and B; A finished, B is running. BTW can use A's result and mention that B remains in progress. The model-facing auxiliary request remains protocol-valid (no unpaired tool calls).

**J4 · Topic follow-up.** After BTW Q1/A1, main Agent runs more steps; user selects Topic A and asks Q2. Answer uses **fresh main context at Q2**, plus Topic A prior completed/partial Q/A history, plus Q2; other topics are excluded.

**J5 · Persistent history.** `/btw` (no args) opens history; list and details show topics (recent first), chronological turns, status (running, complete, cancelled, error, interrupted), and most recent nonempty answer. History survives browser refresh and Session resume without waking main Agent just to list records.

**J6 · Cancel.** User cancels only BTW request. The main Agent continues; partial answer remains visible; topic persists as cancelled. Closing panel and losing Web connection are distinct from cancellation.

**J7 · Concurrency/recovery.** A second BTW request in the same Session is refused while one is active (V1). Duplicate `requestId` returns prior receipt. Host restart marks abandoned `running` records `interrupted`; no automatic resubmission.

**J8 · Session switch.** Panel scopes to selected Session. A late response for Session A cannot mutate, appear under, or leak into Session B. Read and watch are resource-authorized.

**J9 · CLI compatibility.** `/btw` should work from Web and an appropriately integrated CLI/TUI entry. Distinguish a *Host Command* proof-of-concept from the final UI-route which keeps question records outside the main Session command log.

## Functional acceptance criteria

| ID | Requirement | Observable assertion |
|---|---|---|
| FR-01 | Snapshot of latest observable primary context | Captured committed seq + live attempt id/chunk index; BTW knows prior tool results and partial text. |
| FR-02 | Noninterference | Same primary steps/tool calls with/without BTW under deterministic test; no main Agent inbox mutation. |
| FR-03 | Independent LLM | Side request has independent AbortSignal and no tool execution. |
| FR-04 | Independent history | BTW records are not Session model surface and are segregated by Session ID. |
| FR-05 | Follow-up | Fresh captured main context AND exact selected topic history each turn. |
| FR-06 | Session resume | Record list/details restore; orphan `running` repaired. |
| FR-07 | UI | New question, history, details, follow, streaming, cancel, copy; no BTW answer in main Chat. |
| FR-08 | Request admission | Idempotent by `requestId`; Host admission acknowledged separately from model completion. |
| FR-09 | Security | Host checks session resource permissions for every read/mutation/watch. |
| FR-10 | Compatibility | Build/test on target DSH checkout; rc.2 versus 0.2.2-rc.1 differences documented. |

## NFR and bounds (proposed defaults, configurable)

- Exactly one running BTW per Session; cap global concurrent side requests (e.g. 4). **These are proposed values, not DSH defaults.**
- Bound side question bytes, previous BTW history bytes, raw stream buffer, reply length/output tokens, and timeouts; expose clear errors instead of silent truncation.
- Capture should be fast and synchronous relative to Agent event delivery; asynchronous model preparation and storage happen after capture.
- Durable record changes are not published as successful until backing storage acknowledges them. Append-only main Session history is never mutated by this feature.
- Use the same provider/model as the current active main request where possible, but validate availability and configuration; allow explicit side-route selection only as future enhancement.

## Out of scope for initial implementation

- OMP `/btw` → main `<inject>` steering (design a separate user-authorized operation later).
- OMP promotion to main chat branch/fork.
- Arbitrary historical time-travel BTW, `follow latest` subscription that autonomously asks new questions, automated BTW agents.
- Tool dispatch during BTW; modifying, replaying, or cancelling main tools.
- Cross-process concurrent writers (beyond one writer Host), cloud sync / shared-session export, subagent-focused BTW, automatic topic search/rename/delete. May reserve interfaces but do not claim implemented.
- General rewriting of DSH Session/Agent Loop or `dsh-llm-retry`.

## Defining *latest*

`Latest Observable Context` is the coherent read at Host admission consisting of committed Session log entries plus volatile Agent stream/tool state delivered to public hooks. It is **not** a view into undisclosed provider reasoning, uncommitted external tool output, or events arriving after the capture. The snapshot is timestamped and immutable. Every following BTW turn captures again; no topic permanently pins main history.
