# 02 · DSH Interfaces, Integration Points and Version Compatibility

Pinned DSH: `deepseek-ai/deepseek-harness@fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` (2026-11-04). Compare released `dsh-v0.2.1-rc.2` with the checkout's actual version. Ref links in `references/source_manifest.json`.

## Confirmed public seams

| Interface | Location | Meaning and correct BTW use |
|---|---|---|
| `Session.deriveMessages()` / append-only Session log | `packages/core/session/src/` | Reconstruct committed model context; never append BTW Q/A here. |
| `session/event` | `packages/core/session/src/index.ts` | Observe committed tool/assistant/turn events; filter exact Session. |
| `agent/assistant-stream` | `packages/core/agent/src/runtime-types.ts` (~399 master/~363 rc2) | Process-local start/chunk/end with Attempt id, turn, step, revision; basis for Live Mirror. |
| `AssistantStreamAttempt` | `packages/core/agent-loop/src/assistant-stream.ts` | Emits the stream frames; `BlockAssembler` is the reusable parsing vocabulary. |
| `BlockAssembler.interruptedBlocks()` | `packages/llm/llm/src/assembler.ts` | Safe partial text/reasoning extraction; excludes incomplete tool calls. |
| `llm/stream` | `packages/llm/llm/src/index.ts` (~75) | Observe the frozen actual Agent-loop request and current model configuration. Do not mutate it. |
| `isAgentLoopRequest(request)` | `packages/llm/llm/src/call-config.ts` | Distinguish actual Agent Loop calls from auxiliary `llm/stream` consumers. |
| `ctx.llm.prepareCall()` + `PreparedLlmCall.stream()` | `packages/llm/llm/src/index.ts` | New separate one-shot LLM request. Does NOT automatically use `dsh-llm-retry` Agent request-error listener. |
| `GenerateOptions.purpose` | `packages/llm/llm/src/types.ts` | Declare auxiliary `'btw'` via type augmentation if supported, set purpose on side request. |
| `dsh-storage-domain` | `packages/storage/storage-domain/src/{index,domain,spec}.ts` | Durable schema-validated host-side BTW topic records; `put/update/delete/entries`. |
| `dsh-storage-json` | `packages/storage/storage-json/README.md` | Base bundle JSON backend; per-record layout recommended for Topic writes; **no cross-process locks**. |
| `@Remote` / `@Remote({mode:'stream'})` | `docs/api-gateway.md` | Own feature Remote namespace with typed generated Client bindings. |
| `dsh-api-remote-access` | `packages/api/remote-access/README.md` | Authorize each Session read/write/stream for non-owner Peers; never trust UI-only gating. |
| `ctx.commands.register` | `packages/interaction/commands/src/index.ts` | Host command emits `command/run` and `command/done`; useful POC, but pollutes main Session **log-only**, not model-visible. |
| `ctx.commandUi.register`/`decorate` | `packages/client/ui-commands/src/client/contract.ts` | Bare `/btw` UI action; client-owned contribution not necessarily covers `/btw arbitrary question`. |
| `ctx.inputTriggers.registerSource` | `packages/client/ui-input-trigger/src/client/{contract,index}.ts`, `src/types.ts` | Support custom leading-token `matchEnter`/`matchSpace` claim. Verify full-line routing and attachment policy. |
| UI Slot Registry | `packages/client/ui-conversation`, `ui-renderer`, `ui-chat` | Mount BTW Session-specific panel through a supported Slot; avoid modifying core Chat component when possible. |

## Known caveats

**C1. Request reconstruction:** DSH Session is event-sourced and current model request may have in-flight user messages, tools and stream state. Do not assume `Session.deriveMessages()` alone makes a protocol-valid auxiliary call at every ReAct phase. Explicitly normalize open tool calls.

**C2. Public live data:** Stream frames have monotone revisions within an Agent lifetime, but mirror state is process-local. A late plugin install cannot recover already-streamed chunks unless a supported Host reconnect baseline is available; one can initially capture only subsequent frames and report degraded snapshot quality. Attach listeners early.

**C3. Host side one-shot request:** Do not invoke `agent.followup`/`steer`/`inject`/`runMaintenance`/`whenIdle`. Do not give a side request the current main AbortSignal. Purpose and sessionId may alter adapter and middleware behavior; inspect provider-specific rules.

**C4. Side request identity:** `sessionId` in DSH is used for routing, replay and middleware. Avoid reusing the live main Session identity blindly: it may trigger Session-log checkpoint/upload or provider session affinity. Choose a separate request identity when adapter supports it, or omit Session ID and explicitly provide auxiliary purpose; verify logging and cache effects with tests. A side request never claims to be a main Agent Loop request.

**C5. Tool schemas:** OMP preserves the static tool catalog for prompt-cache compatibility yet never dispatches tools; DSH `GenerateOptions` does not advertise a universal `toolChoice:'none'`. Do not assume adapters all accept it. Test provider history and schema interactions; reject tool-call side completion instead of executing it.

**C6. Storage ownership:** `storage-domain.update` serializes read-modify-write within a process, not across processes. `storage-json` explicitly lacks cross-process locking. One writer Host is a V1 deployment prerequisite; if multi-Host is required, add real lease/CAS at storage level or a separate OMP-like per-topic lease-backed store.

**C7. Cold reads:** History/list operations should not acquire `Agent` lookups that resume cold sessions. Use Session-scoped authorization and the BTW storage domain, returning history directly.

**C8. Streaming Remote:** A `mode:'stream'` Remote is an async iterator; follow subscribe/unsubscribe/abort semantics per API gateway. Reader disconnect is not automatically cancellation of detached worker. Snapshot then live deltas must be sequenced with no gap.

**C9. Bundle and Generator:** DSH generated Remote bindings require correct `./typert`, `./remote` and packaging, and correct plugin composition. Prefer sibling feature examples, not hand-written protocol clients. Source development may use fallback but built Client must carry strict generated codecs.

## Compatibility table

| Capability | `0.2.1-rc.2` | `0.2.2-rc.1` / pinned master | Guidance |
|---|---|---|---|
| `agent/assistant-stream` | yes | yes | Same stream Attempt implementation hash at inspected commits. |
| `llm/stream`, `prepareCall`, `purpose` | yes | yes | Verify precise TS types and call defaults. |
| `storage-domain` | yes | yes | `KvTable.update()` exists; domain update semantics evolved. |
| `@Remote({ mode:'stream' })` | yes | yes | Generated strict Client schema required. |
| `ui-commands` client registration | yes | yes | Bare-client action; arguments need separate path. |
| `ui-input-trigger` source | yes | yes | Verify line claim and no collision with Host command. |
| `Agent.model.current()` | not in rc.2 Agent interface | in current master | Do not rely on it for rc.2. Prefer capturing actual main request; fall back to logged selection with version adapter. |
| Session Projection register | rc2 historical effect/reader behavior | newer `await register` handle | BTW record persistence SHOULD use Storage Domain, not Projection. |

## Implementer's first inspection checklist

1. `git rev-parse HEAD`, package version, current provider and installed profile.
2. Inspect `packages/llm/llm/src/{index,types,assembler,call-config}.ts`, `agent/assistant-stream` shape and event order.
3. Inspect provider adapter for side request sessionId, historical tool calls, reasoning blocks and provider cache control.
4. Inspect `packages/client/ui-input-trigger/src/types.ts` and existing command source for an args-tolerant, no-main-message route.
5. Inspect Storage Domain write ordering and actual default backend config.
6. Inspect `docs/api-gateway.md`, `dsh-api-remote-access`, session resource resolution and Client Slot registration.
7. Run a small observability test before writing large business logic; report API mismatches rather than inventing internal APIs.
