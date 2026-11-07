# 08 · Test Plan, Fixtures, Failure Matrix, Acceptance Gates

## Testing approach

Use DSH's existing Vitest testkits and mock LLM adapters. Build *deterministic* main-Agent runs with staged stream chunks and tool completions; intercept the Side Request and assert actual `GenerateOptions`/messages, not only UI text. Use fake storage backend for unit tests, temporary real JSON/SQLite domain for integration, mock typed Remote/Client transport for UI and concurrency. No live credentials required for baseline CI.

For every test, assert: **(A)** the main Agent is not modified; **(B)** BTW request has a coherent valid context cut; **(C)** side response follows lifecycle and its own scoped history.

## Unit · ContextCapture / Normalizer

| ID | Input / trigger | Expected result |
|---|---|---|
| CTX-001 | Agent idle, committed history | Exact committed messages and latest model choice; no phantom partial. |
| CTX-002 | Main streaming text deltas 1–2, BTW triggered before delta 3 | Side snapshot has deltas 1–2 only; no delta 3. |
| CTX-003 | Main streaming reasoning and text | Provider-safe treatment; does not create invalid reasoning replay metadata. |
| CTX-004 | Stream Attempt interrupted, new Attempt begins | Mirror resets and uses only active attempt; no duplicates. |
| CTX-005 | Wrong/out-of-order chunk index/revision | Invalidates partial stream and reports degraded coverage; never corrupts context. |
| CTX-006 | Tools A complete, B running in same batch | Side request valid; A result retained, B described pending without fake result. |
| CTX-007 | Incomplete tool-call arguments while streaming | No malformed tool_call sent to provider. |
| CTX-008 | Main Session receives new event immediately after capture | Side snapshot unaffected; `cutSeq` stable. |
| CTX-009 | Main Session compacts/replaces Surface near capture | Coherent single cut; doesn't mix pre/post compact messages. |
| CTX-010 | Main model/provider switched after snapshot | Side follows captured route or explicit unsupported result; no silent drift. |
| CTX-011 | Side request appears on `llm/stream` waterfall | `isAgentLoopRequest` rejects it from main-request capture. |
| CTX-012 | No currently observed live attempt (late plugin mount) | No invented partial; explicit fallback quality indicator. |
| CTX-013 | Overlong context / history | Bounded strategy is deterministic and preserves tool call/result protocol. |
| CTX-014 | Additional unsupported content blocks | Fail clearly or omit only according to explicit, tested compatibility policy. |

## Unit · BTW business logic

| ID | Scenario | Expected result |
|---|---|---|
| BIZ-001 | New ask | Topic and Turn created, status `running`, persistent receipt before LLM call. |
| BIZ-002 | Follow-up | Same Topic, appended Turn; Q1/A1 replayed as separate messages; Q2 uses new main cut. |
| BIZ-003 | Different Topic B exists | Topic A follow excludes Topic B Q/A. |
| BIZ-004 | Same requestId arrives twice during admission | Exactly one LLM dispatch and one Turn; both receipts identical. |
| BIZ-005 | Two simultaneous BTW asks in same Session | One accepted, other busy, no auto-queue/cancel. |
| BIZ-006 | Two Sessions ask simultaneously | Isolated state and possible concurrent execution under global cap. |
| BIZ-007 | Cancel during startup storage write | Persist cancelled; never call model. |
| BIZ-008 | Cancel during streamed answer | Abort only Side Request; keep partial text and terminal status. |
| BIZ-009 | Provider failure at start / mid-stream | `error` recorded; partial retained as per policy; main Agent continues. |
| BIZ-010 | Failed/cancelled follow then next follow | Prior history preserved; new provider lineage epoch if configured. |
| BIZ-011 | LLM produces tool-call block | No tools run, no result forged; outcome classified as unsupported. |
| BIZ-012 | `ask()` response after persistence | Receipt means admitted, not answered; `watch` receives later deltas. |
| BIZ-013 | Server exit/unload | Abort and drain/reconcile outstanding writes; no orphan in-memory process. |
| BIZ-014 | Load old `running` after process restart | Becomes `interrupted`, no automatic paid re-execution. |
| BIZ-015 | Terminal storage write uncertain | Do not publish `complete`; refuse duplicate follow until re-read. |

## Integration · DSH event and LLM

| ID | Test | Expected result |
|---|---|---|
| INT-001 | Main ReactLoopAgent streaming while BTW runs | Main continues to next tool/step; no BTW `user/message` or `assistant/message`. |
| INT-002 | Compare deterministic main trace with/without BTW | Same primary tool order/results, no new primary inbox messages. |
| INT-003 | Side independently aborted | Main AbortSignal remains un-aborted and eventually completes. |
| INT-004 | Real `dsh-llm-retry` mounted for main | Main retry behavior unaffected; BTW direct call uses own finite policy. |
| INT-005 | DeepSeek adapter native-tool history | Side request accepted by adapter (or explicit provider compatibility refusal). |
| INT-006 | pi-ai adapter | Same, including tool Schema and partial content policy. |
| INT-007 | Side purpose/session id | Does not trigger main upload/checkpoint/replay misattribution. |
| INT-008 | Plugin reload after main already streaming | Partial not falsely claimed; later live frames handled. |
| INT-009 | Cold `btw.list/get` | Does not create/wake any Agent. |
| INT-010 | Session switched during side work | Answer written under original Session only, UI properly filters. |

## Remote/UI tests

| ID | Scenario | Expected result |
|---|---|---|
| UI-001 | Web `/btw question` while main busy | Intercept; no regular Session prompt; BTW panel streams. |
| UI-002 | Bare `/btw` | Opens history, selects newest (or empty state). |
| UI-003 | Select existing topic / Follow | Opens topic-specific draft; submits same `topicId`. |
| UI-004 | Follow input pending / repeated Enter | One admission; draft preserved on error. |
| UI-005 | Browser refresh / reconnect | New baseline + deltas; no duplicate/corrupted text. |
| UI-006 | Close panel mid-answer | Request continues, reopen shows partial/progress. |
| UI-007 | Cancel | Cancels BTW only, updates status; no main Esc/cancel. |
| UI-008 | Session A→B while A streams | B view never displays A frames. |
| UI-009 | Non-owner lacking Session read | `list/get/watch/ask` denied by Host. |
| UI-010 | Two tabs in same Session | One active BTW; consistent view/status across tabs. |
| UI-011 | Ordinary transcript export/share | Does not include BTW Topic history unless explicit feature export. |
| UI-012 | History long or many topics | Pagination, bounded rendering, newest-first stable ordering. |

## Storage tests

ST-001 Domain persisted topic survives Host close/reopen; ST-002 revision CAS across local asynchronous writers; ST-003 failed atomic write neither claims successful status nor starts LLM; ST-004 unknown write outcome triggers quarantine/readback; ST-005 same Session keys cannot collide with another Session; ST-006 orphan repair; ST-007 plugin unload drains writes; ST-008 per-record layout and storage backend compatibility; ST-009 explicitly verify multi-process shared JSON writes are *unsupported* rather than claim correctness; ST-010 no `session/event` side effects.

## End-to-end scripted demonstration

1. Start mock main Agent task whose first step reads file A, second step streams visible reasoning and text, and next step runs two tools concurrently.
2. Trigger Web `/btw why did you choose A?` after exactly two text deltas; capture side provider request, assert partial text and all committed history.
3. Allow main Agent to advance; BTW answer streams, main tool state unaffected.
4. Close/reopen panel; follow up on Topic A; assert new main events included AND Topic A history replayed; Topic B absent.
5. Refresh Web, resume Session, verify Topic details and statuses; cancel new BTW while main runs.
6. Assert final primary Session model-facing history has no BTW Q/A, and no side Tool Calls executed.

## Test artifacts required from implementation Agent

- Tests with exact command lines and pass/fail summary.
- Instrumentation/log sample showing `ContextCut` values and side request purpose.
- Source-level evidence that all BTW model calls bypass Agent Loop and tool executor.
- Provider compatibility matrix; known exclusions.
- A list of public DSH API deviations from this design, with how they were resolved.
- A short demonstration recording or reproducible scripted test (no secret credentials).

## Release gates

**Gate A:** `CTX-002`, `CTX-006`, `INT-001`, `INT-003`, `INT-007` pass — the feature is safe mid-ReAct.

**Gate B:** `BIZ-002`, `BIZ-004`, `BIZ-007`, `BIZ-014`, `ST-001` pass — persistent Follow semantics work.

**Gate C:** `UI-001`, `UI-003`, `UI-005`, `UI-009`, `UI-011` pass — Web integration is correct and authorized.

Never mark done based solely on mock model producing answer: invariants and lifecycle tests are the actual acceptance criteria.
