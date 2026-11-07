# Implementation Prompt — dsh-btw (English, copy/paste into local coding Agent)

> NOTE: This is a task specification for an Agent WITH ACCESS TO THE LOCAL DSH REPOSITORY. The present context package is not executable. Resolve local code and API mismatches before implementation. This prompt is structured for writing-for-agents and can be fed after the package has been added to the Agent's accessible workspace.

## Objective

Implement a production-quality, **OMP-style `/btw` ephemeral side-conversation feature** for DeepSeek Harness (DSH), including **in-flight ReAct context**, **topic-specific follow-up**, **session-level durable history**, **streaming UI**, and **side-request cancellation**. Favor **plugin-first** composition; do not alter the core Agent Loop unless a specific incompatibility is proved and approved. Deliver tested Host and Web plugins and usage documentation.

Read ALL files in this context package, prioritizing:

- `README.md`, `00_PRODUCT_SCOPE.md`, `01_OMP_SOURCE_BEHAVIOR.md`
- `02_DSH_SOURCE_MAP_AND_COMPATIBILITY.md`, `03_ARCHITECTURE.md`, `04_CONTEXT_CAPTURE_AND_LLM.md`
- `05_STORAGE_AND_LIFECYCLE.md`, `06_API_AND_UI.md`, `07_ADR.md`, `08_TEST_MATRIX.md`
- `09_IMPLEMENTATION_ROADMAP.md`, `diagrams/*.puml`, `references/source_manifest.json`

The main domain requirement is **"an OMP-like side question that sees the main Agent's latest observable context even while the main ReAct Loop is running"**. A BTW follow-up must retain the selected BTW Topic's previous Q/A **and** recapture the main Session's context anew at each request. BTW history belongs to one Session, is durable, and does not enter main model-visible chat history.

## Non-negotiable constraints

1. Normal BTW MUST NOT invoke `agent.followup`, `steer`, `inject`, `cancel`, `whenIdle`, or tool execution on the main Agent; do not block it. The user-authorized **send BTW answer to main Agent** feature is explicitly out of scope.
2. BTW questions/answers MUST NOT become main Session model-visible messages or accidentally reach `session.prompt`. Do not use `command/run` and `command/done` as the feature's persistence database.
3. A new BTW and every Follow MUST perform a synchronous, coherent Host-admission snapshot of committed Session history plus safely captured in-flight Agent/LLM content. Never take a late snapshot after awaiting storage, model metadata or history I/O without explicitly reporting degraded semantics.
4. Side model calls have their own prepared adapter call, purpose (`btw`), safe identity, AbortSignal and bounded retries. Do NOT assume `dsh-llm-retry` middleware applies to direct side calls.
5. **Never execute side model tool calls.** Handle partial/unpaired main tool calls in provider-safe side normalization. No fabricated successful tool outcomes.
6. Use DSH's `storage-domain` for Session-keyed topic records when supported. `list/get` must not create or resume the main Agent. Treat default `storage-json` as single-writer only; do not claim cross-process CAS.
7. Persist a `running` BTW turn before model dispatch. Distinguish durable admission receipt from streamed completion. Browser disconnect does not cancel an admitted BTW; explicit BTW Cancel does.
8. Implement idempotency using `requestId`, single-flight per Session, revisions and execution epochs. On host recovery turn old `running` into `interrupted`, with no automatic model replay.
9. Host Remote permissions must check each Session target; Web state is not a security authority. No BTW data leaks across Session switches or peer permissions.
10. Prefer one feature-owned Remote API plus a Web BTW panel. Bare `/btw` opens history; `/btw <question>` must be intercepted and must not become a main prompt. Validate the actual `ui-input-trigger` semantics in local DSH before choosing client routing.
11. Follow OMP's **Topic** semantics: selected Topic only; prior Q/A are separate messages, not a giant injected prompt; every follow-up uses new current main context. One active BTW per Session V1, no implicit queueing or cancellation.
12. Align with target repo's package conventions, generated Typert Remotes, typechecks, tests, scopes, lifecycle and `AGENTS.md`. Avoid invasive hacks, private runtime introspection and duplicated core adapters.

## Investigation first (M0; mandatory)

Before editing source:

- Print `git rev-parse HEAD`, package versions/profile and DSH branch. Compare to `deepseek-ai/deepseek-harness@fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` and `dsh-v0.2.1-rc.2` if relevant.
- Verify `agent/assistant-stream`, `llm/stream`, `isAgentLoopRequest`, `BlockAssembler.interruptedBlocks`, Session derived history, `ctx.llm.prepareCall`, and exact side request config. Confirm source event ordering and whether request histories can contain open ToolCalls.
- Verify `dsh-storage-domain` + actual backend and per-record layout support, storage writer limits and Domain effects.
- Verify generated `@Remote` service pattern, `api-remote-access` resource declarations, Session cold-read constraints, Client Slot registration, `ctx.inputTriggers.registerSource` and `ctx.commandUi.register/decorate`.
- Study OMP pinned behavior in the references; do not copy source wholesale or treat OMP's runtime interfaces as DSH interfaces.
- Write an explicit compatibility note and a short implementation design mapping to existing DSH facilities, *then implement*. Identify unknowns and run a focused proof test instead of guessing.

## Execution plan

### Phase 1 — Live context capture

Create a bounded `LiveContextMirror` using public `llm/stream` and `agent/assistant-stream` hooks. Filter model calls via `isAgentLoopRequest`. Coherently capture current committed Session messages, model route/settings/tool schema and partial assistant stream **synchronously before first await**. Store an immutable `ContextCut` with Session log seq and Attempt ID/revision/index. Do not merge streams from different attempts or Sessions. Gracefully report missing live coverage on late plugin installation.

### Phase 2 — Side request normalization + execution

Implement `SideContextNormalizer`: protocol-valid history for idle, main streaming, partial tool batch, active retry, and compacted history. For open ToolCalls use matched-prefix + explicit side-only status description, not invented ToolResult success. Preserve in-flight text where safe; reasoning blocks only if provider supports valid replay. Implement `EphemeralBtwRunner` using separate `ctx.llm.prepareCall` / stream, purpose identity, own signal, no tools, bounded timeout/tokens/retry. Verify both DeepSeek and pi-ai provider protocols. Do not reuse the main request signal or dangerous session-scoped provider conversation identity.

### Phase 3 — Topic history, Follow and coordinator

Define `BtwTopic` / `BtwTurn` schema, Topic keys scoped to Session ID, monotonically increasing Topic revisions, stable request and turn IDs. Open a DSH Storage Domain with per-record layout where available. Create `BtwTopicRepository` and `BtwCoordinator`. `ask({topicId?})` creates a new Topic or follows an existing Topic. Replay ONLY selected Topic prior Q/A plus a **fresh main context**. Persist `running` before dispatch; stream into an in-memory hub; persist terminal full answer. Support cancel, duplicate request id, per-Session one active request and crash-recovered interrupted status. A failed storage write never dispatches a model request.

### Phase 4 — Typed Host Remote API

Implement `btw.ask`, `btw.list`, `btw.get`, `btw.watch`, `btw.cancel`, with a generated typed Remote contribution and Session resource authorization. Use built-in `@Remote({ mode: 'stream' })` for output frames unless a demonstrated incompatibility requires another supported protocol. `ask` returns admission receipt quickly and detaches the worker; `watch` subscription does not own/cancel worker. Make `snapshot`/`delta` subscription gap-free and revisions explicit. `list/get` work with cold Sessions without an Agent activation.

### Phase 5 — Browser experience and CLI integration

Provide a Session-scoped Web BTW Panel: newest-first topic list, selected details with chronological Q/A, follow-up composer, live stream, cancel, copy, error/cancel/interrupted status, browser refresh and Session-switch scoping. Bare `/btw` opens history. `/btw <question>` is intercepted through the actual Client input pipeline so it **cannot** reach default Session prompt. A Host `ctx.commands.register` command may be used for a CLI proof but logs `command/run`/`command/done`; distinguish this interim compromise from complete OMP isolation. If no public CLI interception interface exists, document rather than silently alter main chat. Reserve opt-in inject/branch for future release only.

### Phase 6 — Tests + review + docs

Implement the tests in `08_TEST_MATRIX.md`. In particular require mid-stream context test, concurrent tool call pairing, noninterference, separate cancel, selected-topic follow with new main context, persistent recovery, same-request-id idempotency, cross-tab stream, Session resource auth and no BTW in exported/main transcript. Use DSH repository's `AGENTS.md`/development scripts to run narrow tests and build/typecheck/codegen gates. If you modify core API, isolate it and justify with a failing public-interface proof; prefer unchanged core.

## Output artifacts

- Working Host plugin, Web plugin, registration/composition and usage examples.
- Typed Host/Client API contracts; persisted Topic schema; provider compatibility policy.
- Focused tests and e2e scenario reproducing BTW during a main ReAct Step and Follow after main advances.
- Developer guide and version compatibility notes.
- Final report: changed paths, decisions, exact verification commands/results, unresolved limitations, and whether full expected behavior passed.

## Acceptance criteria

1. BTW sees **only** the main context observable at Host capture time, including in-flight visible text if available; it cannot see future tool outputs or partial undisclosed reasoning.
2. Main Agent and BTW operate concurrently and independently. Aborting BTW never aborts main.
3. Main log and prompt history contain no BTW Q/A/Tool execution. No additional primary work occurs because BTW was asked.
4. Follow-up retains selected Topic Q/A and refreshes main context every time.
5. History persists, resumes, and is Session-scoped; `list/get` do not wake cold Agent.
6. Two simultaneous requests in one Session do not produce double dispatch; duplicate `requestId` is idempotent.
7. UI streaming, cancel, history, and re-open work after Web reconnect; Host authorization prevents cross-Session leakage.
8. No unpaired ToolCall provider errors from side snapshot; no invented tool success.
9. Multi-process writer support, focused Subagent BTW, BTW→main inject, and branch are clearly marked OUT OF SCOPE if not implemented.

## Working discipline

- Do not ask the user to manually restate requirements already provided. Inspect actual local code, choose the narrowest safe implementation, and document deviations.
- Never claim tests passed without running them or claim full OMP parity before all scoped acceptance gates pass.
- Avoid broad unrelated refactors; implement small independently testable work units.
- On ambiguity, prefer safe side-only, read-only semantics and explicit limitations over silently feeding the main Agent.
