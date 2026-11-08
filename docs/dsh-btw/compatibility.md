# Compatibility and limits

## Target runtime

| Item | Value |
|---|---|
| Installed DSH | **0.2.1-rc.5** (npm package at the active Node `node_modules/@deepseek-ai/dsh`) |
| Node | build targets **Node 22**; verified with **v26.7.0** |
| Peer package versions | all `@deepseek-ai/dsh-*` peers pinned to `0.2.1-rc.5`; `@deepseek-ai/cordis` `^4.0.5` |
| React / zod | React 19, zod 4.4.3 |
| Pinned upstream commit | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` (package version 0.2.2-rc.1) — **referenced only**, newer than the target |
| rc.2 | **unsupported**; only source-level comparisons were made, never a runtime run |

## Single Host writer

The Topic store uses `layout: 'per-record'` in the JSON storage backend
(`src/repository.ts:9-16`). One record per topic is written atomically, but the JSON
backend has **no cross-process lock or CAS**. A resolved `table.update` serializes
only within one Domain instance.

Consequence: exactly **one Host process** may write the BTW domain. Two Hosts sharing
one `DSH_HOME` can overwrite each other's topics (last completion wins). This is a
deployment restriction, not a detected defect. `revision` + `expectedRevision`
(`src/service.ts:190-199`) are an in-process compare-and-swap, not a distributed one.

Key encoding avoids path ambiguity: `topicKey` is base64url of
`"<sessionId>\u0000<topicId>"` (`src/repository.ts:21-23`), which satisfies the
per-record key grammar.

## Cold history vs. cold ask

- `btw.list`, `btw.get`, and `btw.watch` read the open Domain directly
  (`src/service.ts:380-429`). They work for a Session whose Agent is not loaded and
  do **not** wake it.
- `btw.ask` requires the live Agent: `ensureAgent` looks up
  `ctx.agents.get(sessionId)` and fails `btw/context-unavailable` when absent
  (`src/service.ts:138-140`). Admission must observe the live main request and
  in-flight stream, which a cold Session cannot supply.

## No CLI/TUI no-log route

Only the Web client contributes `/btw`:

- bare `/btw`: `ctx.commandUi.register` action that opens the sidebar tab
  (`src/client/index.tsx:51-66`);
- `/btw <question>`: `ctx.inputTriggers.registerSource` claim
  (`src/client/index.tsx:68-106`).

No Host command is registered. Host `commands.execute` appends durable
`command/run` / `command/done` Session events, which would violate the no-main-log
requirement. A future terminal frontend must call the feature Remote directly; that
route does not exist today.

## Client Remote is hand-authored

`scripts/generate-typert.mjs` calls `WorkspaceTypertGenerator.generate(undefined,
['host'])` and writes only the **Host** target's artifacts for this package. It does
not emit the browser contribution, and it is not wired into `npm run build`.

The browser-side contribution is written by hand in `src/client/remote.ts` against
the public `createTypertRemoteInfo` contract, with the same method descriptors the
generator would emit. Host dispatch still uses the runtime `@Remote` decorators on
`BtwService`. The package therefore does **not** export `./typert` or `./remote`;
`lib/client.js` mounts the contribution directly via `ctx.remote.$mount(remote)`
(`src/client/index.tsx:18-20`).

## Side-call identity and protocol facts

| Rule | Why |
|---|---|
| `purpose` is omitted | rc.5 types it as the closed union `'compaction' \| 'session-title'`; `'btw'` cannot be added by declaration merging (TS2717) and a cast would lie |
| `sessionId` omitted | avoids the main Session checkpoint flush, DeepSeek session-log upload + `delivery-accepted` append, and provider affinity/cache entanglement; neither adapter supports conversation continuation |
| reasoning stripped | DeepSeek replays `thinking` only with a valid same-model signature; pi-ai drops or (on anthropic) can surface unsigned thinking as **visible text** |
| no tools / `toolHistory` | BTW answers are text-only and must not execute anything |
| tool history flattened to text | an open/unpaired batch is rejected by DeepSeek (four `INVALID_REQUEST` shapes) and silently patched with a synthetic "No result provided" error by pi-ai; BTW emits a plain-text note instead of a fabricated result |
| `maxTokens` capped at 4096 | explicit output bound; the runtime does not enforce context/token limits |
| retries owned by the runner | `dsh-llm-retry` only wraps `agent/request-error`, not direct `ctx.llm` streams |

## Degraded-context markers

`contextCut.degraded` is a list of safe, user-facing reasons. The panel shows them
next to the turn status.

| Marker | Meaning / source |
|---|---|
| `late-mount` | main request facts were not observed; route copied from `agent.options` (`src/service.ts:145-155`) |
| `missing-main-request` | no `llm/stream` facts were captured for this Session (`src/live.ts:104-105`) |
| `missing-attempt-prefix` | the live attempt was observed mid-stream or with a gap; no trustworthy in-flight prefix (`src/live.ts:108-116`) |
| `context-truncated` | the quoted main transcript exceeded 48,000 chars and was tail-truncated (`src/normalize.ts:89-93`) |
| `history-partial` | included topic history contains a non-`complete` turn with non-empty text (`src/normalize.ts:108-122`) |

Markers persist on the turn's `contextCut`; they are informational and do not block
the answer.

## Explicit non-goals (not implemented)

- BTW → main Agent inject / steer / branch / fork.
- Subagent-scoped BTW.
- Multi-process (multi-Host) BTW writers or lease/CAS.
- Topic delete/rename/search, export, or cross-Session history.
- Side tool execution or replay of main tool calls.
- An interactive CLI/TUI composer route.

## Compatibility risks not covered by the target run

The pinned upstream commit changes model-selection internals, a generic
`LlmRequestPurposeMap` for `purpose`, tool-scheduler placement, and Session
write-lifecycle hardening. None of those are relied on by this implementation, and
the installed rc.5 API is the only one compiled and exercised.
