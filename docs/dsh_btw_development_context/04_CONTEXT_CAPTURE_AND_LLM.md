# 04 · Critical Design: Live Context Capture + Auxiliary LLM

## Why a plain `session.deriveMessages()` is inadequate

DSH commits `assistant/message` and `tool/result` in an event-sourced Session. During main ReAct streaming, the user-visible Assistant prefix is still **transient** (`agent/assistant-stream`). During tools, one assistant may have issued multiple calls while only some tool results have committed. A raw derived message list may be stale or violate an adapter's call/result pairing requirements. `/btw` promises the latest **observable** context, not just last completed Turn.

## Sources

1. `session/event`: committed events and exact seq order.
2. `agent/assistant-stream`: process-local `start`, `chunk`, `end` frames, `attemptId`, `revision`, `turn`, `step`, chunk ordinal.
3. `llm/stream`: main-Agent request metadata (`isAgentLoopRequest`), exact route, model, provider-facing current history/tool schemas, immutable request identity.
4. Current Agent status and possibly current pending tool IDs derived from committed `tool/call` and `tool/result` events.

Optional: Session Controller's reconnect stream baseline can seed a late subscriber **if public Host service allows**; do not reach into private internals.

## Capture algorithm (design pseudocode, NOT API-exact)

```text
on btw.ask (Host, before first await):
  verify sessionId identity and authorization admission information
  reserve per-Session BTW requestId + single-flight slot synchronously
  session = find attached live Session (V1 active Session only)
  cutSeq = current committed log cursor
  mainMessages = derive detached history as-of cutSeq
  modelFacts = mirror.lastAgentLoopRequestSnapshot(sessionId)
  attempt = mirror.currentAttemptSnapshot(sessionId)
  toolFacts = derive committed tool calls/results as-of cutSeq
  cut = { sessionId, cutSeq, attemptId?, attemptRevision?, chunkIndex? }
  snapshot = structuredClone({ cut, mainMessages, modelFacts, attempt, toolFacts })
  freeze(snapshot) // no mutable references to live Main Agent or AbortSignal

await repository.persistRunning(...)
sideMessages = normalize(snapshot, existingTopicTurns, question)
await runner.callLLM(sideMessages, own AbortController.signal)
```

At Host-admission capture, all synchronous reads should belong to one JavaScript turn. If any source already requires an asynchronous call, do not claim identical instant consistency; encode status as degraded/late and test race handling.

## LiveAttemptMirror rules

- Key by Session object/generation, not just a recycled string ID; remove on `agent/disposed` / `session/disposed` and gate by active attached object identity.
- On `start`: reset attempt buffer, remember Attempt ID, turn/step, publication revision.
- On `chunk`: accept only expected Attempt ID and next index/revision; feed DSH `BlockAssembler`; bound memory and bytes. A revision gap **invalidates** partial data rather than silently assembling corrupted text.
- On `end`: clear live attempt. Durable `assistant/message` or `assistant/attempt` becomes authoritative. Never append ended live chunks twice.
- On Session reset/reload: clear stale snapshot and distinguish no active stream from missing observation coverage.
- Do not persist model hidden tokens, raw secrets or tooling payloads into BTW history. Side request necessarily handles sensitive main context; enforce the same access boundary as Session read.

## Normalization by ReAct phase

| Phase | Input material | Provider-safe side handling |
|---|---|---|
| Idle / fully settled Step | Committed derived messages | Copy compatible history + BTW question. |
| Model request preparation | Last committed history; new input may not be admitted | Explicitly expose availability/cut status. Do not infer future prompt. |
| Model streaming text | Last committed history + in-flight visible text | Append **ephemeral-only** assistant partial if provider supports, or summarize it as side-only context text. |
| Model streaming reasoning | Reasoning deltas may be present | Only preserve reasoning when provider route's replay protocol accepts them; default strip/describe visible text only. |
| Model streaming tool-call args | Incomplete JSON tool call | NEVER append as valid Tool Call; optionally describe tool name/status without raw args. |
| Tool batch partial | Completed tool results + outstanding calls | Construct matched prefix and a side-only status description of open tool IDs, no false Tool Results. |
| Auto retry/backoff | Failed attempt may have transient output and retry pending | Do not treat failed text as committed; label attempt provisional. |
| Compaction / session event rewrite | Derived history may change as current projection commits | Snapshot one complete coherent cut, respect Surface projection; no mixing of different cuts. |

**Recommended safe fallback** for an unmatched tool suffix: do not send raw unmatched history to provider. Use the greatest valid paired historical prefix and a plain-text `Side observation (uncommitted; do not treat as tool result)` summary (names/status/available committed results), then the BTW question. This may sacrifice exact history fidelity but preserves correctness and avoids invented successes. Test against actual DeepSeek and pi-ai adapters. Do not silently omit relevant completed tool results.

## One-shot call design

- `purpose: 'btw'` as a type-augmented auxiliary request purpose. It must NOT carry the Agent Loop request identity.
- Use same active provider/model and compatible effort/controls when available. Prepare a separate `ctx.llm.prepareCall` binding. Do not reuse `request.signal`, stale adapter object, or main running iterator.
- Independent `AbortController`; bounded timeout, token and context budgets. Abort only side transport and stop delivering deltas, never `agent.cancel()`.
- Maintain **provider-neutral** context and rely on adapter translation. Validate tool history and provider-specific requirements. Do not invent `toolChoice` fields outside DSH type contract.
- To avoid executing tools, no `ctx.tools.execute` invocation exists in this code path. Prompt explicitly requests no tools; if output includes `tool-call`, treat as unsupported side output / fail or filter according to chosen ADR and tests. Whether tools Schema is included for KV cache is an adapter/route-specific policy.
- Select side `GenerateOptions.sessionId` carefully: reuse main ID **only if verified safe** for all request interceptors, provider state, log upload, and replay. Preferred conservative implementation: separate side identity or omitted `sessionId`, `purpose:'btw'`, tested with route adapter and checkpoint policy.
- `dsh-llm-retry` applies to `agent/request-error` from Agent Loop; it does **not** automatically retry direct side `ctx.llm.stream()` attempts. Implement bounded side-only retry after terminal retryable failures. Do not repeat non-idempotent operations (there are no side tools).

## System/side prompt policy

Keep primary system instructions and tool history required for context parity when valid, but add small distinct instruction (in System/Developer slot where provider allows):

> You are answering a separate, read-only question about a concurrently running coding task. Use the snapshot provided, state uncertainty where tools are still running, do not call or suggest executing tools in this response, and do not assume your answer alters the main Agent.

The current question and all prior Topic follow-up questions are identity-free ephemeral inputs, never admitted into main Session. Topic history is replayed as separate user/assistant messages in order (not merged into a single string).

## KV-cache and provider session lineage

OMP optimizes cache reuse by retaining static system/tool prefix and stable cache key. DSH support varies across adapters and request purpose; target correctness before cache hits. Maintain a **separate provider conversation lineage** per BTW Topic if supported. On failed/cancelled/interrupted side request, rotate lineage generation; do not reuse ambiguous remote provider state. Cache metrics are optimization evidence, not product guarantees.

## What must be tested before declaring parity

1. Side request at first 1–2 main text deltas: includes exactly these deltas, not later ones.
2. Side request during parallel tool A complete, B running: valid provider request, no fabricated `tool_result(B)`.
3. Main streaming and side stream concurrently: no cross-contamination in `isAgentLoopRequest` filters or Attempt IDs.
4. Side cancellation leaves main request signal active; main finishes normally.
5. Main model changes just after capture: admitted side call uses captured model policy or fails explicitly, never switches silently.
6. Main Session event writes after snapshot: captured side history immutable.
7. Size cap: fail/error or clearly marked truncation, never silent corruption of tool pairs.
