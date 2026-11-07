# Wayfinder ticket #2: live ReAct observation and coherent ContextCut on rc.5

## Resolution

**Verified on the installed `0.2.1-rc.5`: a plugin can build a synchronous, immutable, Host-admission ContextCut from public APIs. No core modification is required for observation.** The necessary combination is:

- `llm/stream` + `isAgentLoopRequest(options)` for the exact, frozen main request;
- `session/event` + `Session.deriveMessages()` for committed Surface history and cursors;
- `agent/assistant-stream` + a per-Attempt `BlockAssembler` for transient Assistant content;
- `BlockAssembler.interruptedBlocks()` for safe in-flight/interrupted text and reasoning;
- owner-context `agent/disposed` and `session/disposed` listeners for cleanup.

This is not one pre-built ContextCut API. The plugin must synchronously correlate those sources, detach/freeze the result, normalize open ToolCalls, and suppress the live prefix as soon as its durable Assistant settlement commits. Late mounting is supported only with explicit degradation; missed requests and frames are not replayed.

Research assets:

- [Executable public-API proof](proofs/live-context-rc5.mjs)
- [Recorded passing output](proofs/live-context-rc5-output.json)

The proof is deliberately deterministic and uses the real rc.5 Cordis services and `ReactLoopAgent`, not a reimplementation of the loop.

## Verified public contracts

### 1. Main-request admission

`llm/stream` is a waterfall with signature:

```ts
(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
```

For a loop-built request, `isAgentLoopRequest(options)` is true and the request/messages are frozen. `GenerateOptions` exposes the actual `provider`, `model`, `messages`, `toolHistory`, optional `tools`, `sessionId`, controls, and main `AbortSignal`. Capture only facts; call `next()` and never mutate the request or retain its signal for a side call.

The marker is object identity in a module-local `WeakSet`: cloning a request produces ordinary data and returns false. It is not a durable or serializable property. Filter on both the marker and exact target `sessionId`.

Sources:

- rc.5 declaration: `/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:28-46`
- rc.5 implementation: `/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js:357-388,2393-2398`
- pinned [`packages/llm/llm/src/call-config.ts:12-13,79-96`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/src/call-config.ts#L12-L96)
- pinned [`packages/core/agent-loop/src/agent.ts:726-743`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts#L726-L743)

`session.requestHeader()` / `requestContext()` are not substitutes for the full request: they do not contain the exact derived message array, `toolHistory`, signal, or every request field. A listener that missed `llm/stream` must mark request facts degraded until a later main request.

### 2. Committed history and cursor

`session/event` is a post-commit, fire-and-forget emit `(session, event)`. The event is already in the log when listeners run. Listener failures are contained. In the proof, every callback observed:

```text
session.seq === event.seq + 1
```

`Session.seq` is the **next event offset / log length**, not the last event's sequence. Therefore record both:

- `eventSeq`: the triggering committed event's inclusive `seq`, when called from `session/event`;
- `cutOffset`: `session.seq`, the exclusive offset at the synchronous cut.

Do not use `eventAt()`, `snapshotEvents()`, or `ownEvents()` for new BTW code: all three are public but deprecated with “new calls are prohibited.” They are unnecessary for this design.

`Session.deriveMessages()` is synchronous and derives only the current ordered Surface. A replacement/compaction removes shadowed nodes and advances `surface.contentGeneration`. It returns a fresh array; the message objects are shared and deeply frozen. A ContextCut should clone and recursively freeze the array/messages (and cloned Surface cursor) so its ownership and immutability do not depend on that implementation detail.

Sources:

- rc.5 declaration: `/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:135-355`
- rc.5 implementation: `/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js:1517-1598,1672-1687`
- pinned [`packages/core/session/src/index.ts:43-76`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/index.ts#L43-L76)
- pinned [`Session.seq` and deprecated readers](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/index.ts#L704-L762)
- pinned [`Session.commit`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/index.ts#L886-L912)
- pinned [`Session.deriveMessages`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/index.ts#L981-L1019)

### 3. Live Attempt identity, frames, and safe content

`agent/assistant-stream` is an Agent-scoped emit with payload `{ agent, frame }`:

- `start`: `attemptId`, `revision`, `turn`, `step`;
- `chunk`: the same identity, monotonically increasing `revision`, dense zero-based `index`, `time`, and `chunk`;
- `end`: final `revision`, `index === chunk count`, and either `outcome: { kind: 'committed', eventType, seq }` or `{ kind: 'abandoned' }`.

`attemptId` is `${sessionId}:${attempt}` and is unique only within one attached Agent lifecycle. `revision` is monotone within that lifecycle and restarts at 1 for a replacement. Key in-flight state by the exact Agent plus `attemptId`; do not treat either revision or attempt number as globally unique across resume/compaction replacement.

Create one `BlockAssembler` at `start`, feed every `chunk`, and retain its latest `interruptedBlocks()`. That method keeps closed/open non-whitespace text and reasoning and drops every ToolCall and open unknown block. In contrast, `blocks()` synthesizes an open ToolCall from partial deltas and is unsafe for an in-flight side-call prefix.

Sources:

- rc.5 declarations: `/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:107-137,212-243`
- rc.5 Attempt implementation: `/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:378-446`
- rc.5 assembler: `/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js:954-1122`
- pinned [`AssistantStreamFrame`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent/src/runtime-types.ts#L154-L188)
- pinned [`AssistantStreamAttempt`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/assistant-stream.ts#L17-L140)
- pinned [`BlockAssembler.interruptedBlocks`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/src/assembler.ts#L152-L179)

## Exact ordering proved on rc.5

For one ordinary successful Attempt:

```text
llm/stream(request)
agent/assistant-stream:start
agent/assistant-stream:chunk(index=0..n-1)*
session/event(assistant/message)       # durable append is already committed
agent/assistant-stream:end(committed, eventType=assistant/message, seq)
```

For a failed request accepted for retry:

```text
session/event(assistant/attempt)
agent/assistant-stream:end(committed, eventType=assistant/attempt)
agent/request-error                    # awaited waterfall; proof returns {kind:'retry'}
llm/stream(next request)
agent/assistant-stream:start           # new attemptId, larger lifecycle revision
```

`assistant/attempt` does not enter `deriveMessages()`. The proof streamed `bad`, retried, and verified that `bad` appeared neither in committed model history nor in the next main request. Only the successful `ok` Assistant message entered history.

For cancellation/disposal after visible text:

```text
session/event(assistant/message, interrupted=true)
agent/assistant-stream:end(committed)
agent/disposed
session/disposed
```

If no safe content exists, cancellation settles `assistant/attempt` instead. If the durable append itself fails, `AssistantStreamAttempt` emits `end(abandoned)`; never assume every `end` has a durable seq.

The AgentLoop creates the LLM stream before `live.start()`, then feeds chunks in iteration order. The proof observed the waterfall before `start`. Settlement calls `append` before publishing a committed `end`.

Sources: rc.5 `/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:1043-1171`; pinned [`agent.ts:479-606`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts#L479-L606).

### Open ToolCalls are a real intermediate state

The successful `assistant/message` commits before tool dispatch. Each `tool/call` commits when started; `tool/result` commits later. While the proof's tool was pending, the derived tail was:

```text
assistant(content=[text('before'), tool-call(call-1)])
```

with no ToolResult. Parallel result commits are model-ordered, so a later completed call can also remain uncommitted behind an earlier pending call. Sources: rc.5 `/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:506-707`.

For side-call admission, clone the committed history and remove unresolved ToolCall blocks (the proof retains the tail's safe text). If an Assistant message becomes empty, omit it. Do not emit a bare unmatched ToolCall, invent a ToolResult, execute a side tool, or write synthetic events to the main Session. Provider-specific reasoning/replay validation remains a separate admission concern.

## Recommended ContextCut construction

At each admission trigger, complete all of the following in one synchronous section before the first `await`:

1. Read the exact target Session and `session.deriveMessages()`.
2. Read `session.seq` and `session.surface` (`nodes`, `replaceGeneration`, `contentGeneration`). In a `session/event` callback also retain `event.seq`.
3. Clone/freeze committed history and cursor facts. Normalize unresolved ToolCalls for the side-provider request.
4. If a current Attempt was observed from its `start`, clone/freeze `assembler.interruptedBlocks()` with `attemptId`, latest `revision`, and latest zero-based `chunkIndex`. Otherwise omit live content and mark degradation.
5. Attach the latest captured main-request facts, or an explicit degraded reason if `llm/stream` was missed.
6. On `session/event(assistant/message|assistant/attempt)` for the current turn/step, clear/suppress that Attempt's live prefix **before taking the cut**. The committed end frame has not arrived yet; failing to do this duplicates content. Use the end outcome's `eventType`/`seq` as a cross-check, not as the first durable notification.
7. Clear all per-Agent mirrors on disposal. Register cleanup on the plugin/owner context: AgentLoop emits `agent/disposed` after driver quiescence and scoped-registration unwind, so an Agent-scoped listener is not the reliable owner of its own teardown.

A useful proof-shaped record is:

```ts
{
  sessionId,
  eventSeq?,                 // inclusive committed event seq
  cutOffset,                 // exclusive Session.seq
  surface: { nodes, replaceGeneration, contentGeneration },
  requestFacts?,             // captured at llm/stream, never reconstructed
  attemptId?, attemptRevision?, chunkIndex?,
  history,                   // detached + frozen current Surface derivation
  liveContent?,              // interruptedBlocks only; absent after settlement
  degraded?: string[],
}
```

The proof's `snapshotCut()` is a test fixture, not the production type or implementation.

## Degraded late-mount semantics

No inspected observation event replays missed data. The proof mounted listeners after `llm/stream`, `start`, and chunk `a` had passed:

- late `llm/stream` calls: `0`;
- late stream frames: only chunk `b` and `end`;
- late `session/event`: only `assistant/message`, `step/end`, `turn/end`;
- an assembler started at the late chunk contained only `b`, while disposal committed the full interrupted text `ab`.

Therefore, if mounting while an Attempt is already in flight:

- `session.deriveMessages()` still recovers the **current committed** Surface history;
- omit the unknown in-flight Assistant prefix; do not assemble a supposedly complete prefix from later chunks;
- set explicit reasons such as `late-mount`, `missing-main-request`, and `missing-attempt-prefix`;
- do not claim full fidelity until a later Attempt for which the plugin observed both its main request and `start` (and every chunk).

If settlement has already committed, current history includes the full Assistant message, but the missed exact main-request facts remain unrecovered. A persisted/session reconnect baseline for transient frames was not found in these public interfaces.

## Compatibility facts

- Installed package: `/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/package.json`, version `0.2.1-rc.5`; it is an npm installation, not a git checkout.
- Live Cordis inspection confirmed the rc.5 modes/signatures for `llm/stream`, `session/event`, `agent/assistant-stream`, `agent/disposed`, and `session/disposed` used above.
- Pinned `deepseek-ai/deepseek-harness@fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` identifies package version `0.2.2-rc.1`. Its public observation semantics match the rc.5 findings. Its tool scheduler has internal refactoring; BTW must not depend on those internals.
- Source comparison against tag `dsh-v0.2.1-rc.2` found byte-identical `packages/core/agent-loop/src/assistant-stream.ts`, `packages/llm/llm/src/call-config.ts`, and `packages/llm/llm/src/assembler.ts` between rc.2 and the pinned commit. The `AssistantStreamFrame` contract is also unchanged. The runtime-types differences concern model selection and pre-step/request middleware, including the later `Agent.model` API; this research does not rely on `Agent.model`.
- rc.2 was **not executed**. These source facts narrow compatibility risk but do not claim rc.2 runtime support. The target verified here is rc.5 only.

## Verification

From the assigned worktree:

```sh
node -p "require('/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/package.json').version"
# 0.2.1-rc.5

node --check docs/dsh-btw/proofs/live-context-rc5.mjs
node docs/dsh-btw/proofs/live-context-rc5.mjs
```

Final result: **exit 0**, JSON `"ok": true`. The proof covers:

- `interruptedBlocks()` versus `blocks()` for an open ToolCall;
- exact main-request marker, identity loss after clone, frozen options, provider/model/session/message facts;
- start/chunk/end identity, lifecycle revisions, dense indices, terminal chunk counts;
- session commit before committed stream end;
- failed Attempt exclusion from history and the retry request;
- immutable cuts across later appends and Surface replacement/compaction;
- protected system-head preservation during replacement;
- pending ToolCall history and non-fabricated text-only normalization;
- late-listener information loss and explicit degraded behavior;
- safe interrupted settlement and `agent/disposed` → `session/disposed` cleanup order.

See [live-context-rc5-output.json](proofs/live-context-rc5-output.json) for the recorded result.

## Limitations and unresolved questions

- The tests use an in-memory Session, deterministic adapter, and one real AgentLoop. No network/provider adapter, persistence backend, reconnect, multi-Host behavior, or production side LLM request was exercised.
- Compaction was exercised through the public Surface `replace` event contract, not through a production compaction plugin. A replacement Agent's revision/Attempt reset is established by the public contract/source, not by an end-to-end compaction run.
- Provider-specific admission of reasoning, replay metadata, normalized open-tool history, and cache behavior remains unresolved and must be tested before side calls are enabled for that provider.
- Product policy must decide how degraded late-mount cuts are displayed and when the degraded state clears. The safe default is to omit unrecoverable fields rather than estimate them.
- `GenerateOptions.purpose` admits only `'compaction' | 'session-title'` in the inspected base declaration; a future `'btw'` side-call purpose requires module augmentation and provider/middleware verification. That is outside this observation proof.

## Tracker scope

Research only: no production implementation, no DSH core changes, no PR, and no edit to map issue #1.
