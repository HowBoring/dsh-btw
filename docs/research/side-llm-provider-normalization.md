# BTW independent side LLM calls and provider-safe normalization

Ticket: dsh-btw #3 — "Verify independent side LLM calls and provider-safe normalization".

Status: research complete on installed DSH **0.2.1-rc.5**. No production runner was implemented;
all claims below are from the installed package sources plus an offline wire-level proof
(`proof/proof.mjs`, 28 checks) and a `tsc` type proof. Commands and observed output are in
`proof/COMMANDS.md`.

Installed checkout used for every citation:

```
/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/
```

Short form below: `$DSH` = that directory, so `$DSH/node_modules/@deepseek-ai/dsh-llm/lib/index.js`.
The source of truth is the compiled `lib/index.js` and `lib/types/*.d.ts` that rc.5 actually runs,
not the TypeScript in the context package.

---

## 1. Verdicts (what the implementation tickets can rely on)

1. **`ctx.llm.prepareCall()` exists and is the right seam.** It returns a frozen, route-resolved,
   one-shot call. Use `prepareCall` → `prepared.stream(options)`; there is no `complete()` sibling.
2. **`purpose: 'btw'` is not typed and must not be shipped.** `purpose` is a closed literal union
   (`'compaction' | 'session-title'`); module augmentation fails with TS2717, and a cast would be a
   type lie. Runtime ignores unknown purposes except the DeepSeek compaction header. **Leave
   `purpose` undefined** and record `btw` in BTW's own audit/topic log.
3. **Omit `sessionId` for side calls.** Passing the main session id (a) makes
   `dsh-session-checkpoint-policy` flush the main session before dispatch, (b) makes
   `dsh-session-log-deepseek` upload the main log and append a delivery-accepted event to it, and
   (c) shares provider affinity/cache keys. Provider conversation continuation does not exist on
   either adapter, so no identity is needed.
4. **Direct side streams are single-attempt.** `dsh-llm-retry` only listens on
   `agent/request-error`; it never wraps `llm/stream`. The side runner must implement its own
   bounded retry with a **fresh `prepareCall` per attempt**.
5. **DeepSeek rejects any unpaired/open tool call** with four exact `INVALID_REQUEST` errors.
   pi-ai's adapter does not validate pairing, but the pi-ai library injects synthetic
   `isError: true` `"No result provided"` tool results. Neither is an acceptable substitute for
   normalization: **drop the whole open batch and describe it in text**.
6. **Strip reasoning from the copied history.** DeepSeek replays `thinking` only with a valid
   same-model signature (otherwise unsigned); pi-ai replays thinking only for the same
   api/provider/model/baseUrl and *drops it entirely* otherwise, while the anthropic route turns
   unsigned thinking into **visible text**. Visible-only history is the portable choice.
7. **Compaction output is balanced by construction; live cuts are not.** `dsh-compaction-basic`
   appends a checkpoint user message with a `surfaceOp: replace` and retains a tool-pair-balanced
   tail. A live cut can still end after an assistant tool call with no results, and
   `assistant/attempt` is log-only and never visible — so "retry" adds no partial assistant
   message to clean up.

---

## 2. The call API in rc.5

### 2.1 Signatures

`$DSH/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:407`:

```ts
prepareCall(
  config: LlmCallConfig,
  signal?: AbortSignal,
  configure?: ConfigureCall,
): Promise<PreparedLlmCall>
```

`PreparedLlmCall` — same file, lines 93–116:

```ts
readonly config: LlmCallConfig;
readonly retryPolicy: ResolvedRetryPolicy;   // informational snapshot, never applied to stream()
readonly context?: LlmModelContext;
readonly inputModalities?: ...;
readonly systemPromptUpdate?: ...;
readonly toolUpdate?: ...;
readonly adapterDefaults: LlmCallConfigAdapterDefaults;
stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
```

`LlmRuntime.stream(options: GenerateOptions): AsyncIterable<StreamChunk>` — line 433. There is no
`complete()`; the runtime is streaming-only and callers assemble.

`LlmCallConfig` (call-config.d.ts:11–26) is `{ provider, model }` plus
`LlmCallControls = { reasoningEffort?, temperature?, maxTokens?, stop? }`.
`ConfigureCall` (call-config.d.ts:36) is synchronous and pure:

```ts
(controls: Readonly<LlmCallControls>, model: Readonly<LlmResolvedModelInfo>) => LlmCallControls
```

It may not change provider/model. `prepareCall` deep-clones and freezes the controls and model
before invoking it (`$DSH/node_modules/@deepseek-ai/dsh-llm/lib/index.js:2220-2244`), so the
callback cannot mutate the route.

### 2.2 One-shot dispatch and why retries must re-prepare

`$DSH/node_modules/@deepseek-ai/dsh-llm/lib/index.js:2245-2262`:

```js
if (dispatched) throw new LlmError("a prepared LLM call can only be dispatched once", "INVALID_PREPARED_CALL");
if (!callConfigEquals(options, resolvedConfig)) {
  throw new LlmError("prepared LLM call config changed before adapter dispatch", "INVALID_PREPARED_CALL");
}
```

Consequences:

- A prepared call is a single-use object. A retry attempt **must** call `prepareCall` again
  (this also refreshes the provider route/snapshot; both adapters capture the route at prepare time:
  `$DSH/.../dsh-llm-deepseek/lib/index.js:2129`, `$DSH/.../dsh-llm-pi-ai/lib/index.js:1927-1933`).
- The options passed to `stream()` must compare equal to `prepared.config` on
  provider/model/controls. Always build them as `{ ...prepared.config, messages, system, signal }`.
  Do not change `maxTokens`, `temperature`, `stop`, or `reasoningEffort` after preparing.

### 2.3 Providing purpose, identity, model route, tools, system prompt

`GenerateOptions` — `$DSH/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts:506-552`:

- `provider`, `model` — route; resolved by `prepareCall` and frozen.
- `messages: RequestMessage[]` — `Message | RequestUserInput`. `RequestUserInput`
  (types.d.ts:485-490) is the identity-free form:
  `{ role: 'user'; content; id?: never; source?: never }`.
- `system?: string` — sent separately; adapters fold it into the provider system prompt.
- `tools?: ToolSchema[]`, `toolHistory?: ToolHistory` — omit both for a side answer that must not
  execute tools. With `toolHistory` omitted, `projectToolUpdates` drops developer messages and
  strips `deferLoading` flags (`$DSH/.../dsh-llm/lib/index.js:786-840`).
- `signal?: AbortSignal` — per-dispatch cancellation. Pass the side deadline's signal here.
- `sessionId?: Branded<'SessionId'>` — **do not set** (see §4).
- `purpose?: 'compaction' | 'session-title'` — **do not set** (see §3).

The tool declarations are only the declarations; no tool runs in the LLM layer. Execution is an
agent-loop concern. A side call with `tools` omitted cannot request tools in a schema-valid way, and
any tool-call blocks the model emits anyway are terminated as `finish: {kind:'tool-calls'}` and must
not be executed by BTW (see §9).

### 2.4 Independent AbortSignal and per-call timeout

`@deepseek-ai/dsh-timeout` (`$DSH/node_modules/@deepseek-ai/dsh-timeout/lib/types/index.d.ts`):

```ts
deadline(upstream: AbortSignal | undefined, timeoutMs: number, code: string): Deadline
// Deadline = { readonly signal: AbortSignal; [Symbol.dispose](): void }
idleWatchdog(upstream: AbortSignal | undefined, timeoutMs: number, code: string): IdleWatchdog
```

`deadline()` aborts on upstream abort **or** its own timeout, with `TimeoutReason(code, timeoutMs)`.
The canonical one-shot pattern is `$DSH/node_modules/@deepseek-ai/dsh-session-title-llm/lib/index.js:160-220`:

```js
const callDeadline = deadline(request.signal, config.timeoutMs, SESSION_TITLE_TIMEOUT_CODE);
const call = await ctx.llm.prepareCall({ ...route, maxTokens }, callDeadline.signal, configure);
const options = deepFreeze({
  ...call.config, messages, system, sessionId: request.session.id,
  purpose: "session-title", signal: callDeadline.signal,
});
for await (const chunk of call.stream(options)) {
  callDeadline.signal.throwIfAborted();
  assembler.push(chunk);
}
callDeadline.signal.throwIfAborted();
```

For BTW: pass a **BTW-owned** task signal (not the main turn's signal) as the deadline's upstream,
omit `sessionId` and `purpose`, and keep the deadline's signal on both `prepareCall` and `stream`.
`callDeadline.signal` combines them; dispose the deadline when the attempt ends. Do not create a new
main-turn controller and do not reuse `request.signal` from the main turn.

Also relevant: adapters add their own idle watchdog (DeepSeek `MESSAGES_IDLE`, pi-ai `PI_AI_IDLE`
from `streamIdleTimeoutMs`), so a stalled provider stream terminates even without your timer.

### 2.5 Token bounds

There is no runtime token/context enforcement in `LlmRuntime`; `normalizeModelInfo` only validates
returned metadata (`$DSH/.../dsh-llm/lib/index.js:2119-2145`). The model's own limit surfaces as a
provider `CONTEXT_WINDOW_EXCEEDED` error. Therefore the side runner must:

- set `maxTokens` explicitly in the `LlmCallConfig` (it becomes `max_tokens` for DeepSeek and
  `max_completion_tokens` for the OpenAI-compatible pi-ai route), and
- bound the normalized input by bytes/messages before calling (the session-title plugin bounds bytes
  itself at `dsh-session-title-llm/lib/index.js:170-172`).

---

## 3. `purpose`: typed where, and why `'btw'` cannot be added

Exact declaration — `$DSH/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts:547`:

```ts
purpose?: 'compaction' | 'session-title';
```

Doc comment (types.d.ts:542-547): "Provider-neutral classification for an auxiliary model call.
Adapters may map the purpose to model-hidden transport metadata. Ordinary conversation requests
leave it unset."

The DeepSeek extension seam repeats the same closed union:
`$DSH/node_modules/@deepseek-ai/dsh-deepseek-llm-api-extensions/lib/types/types.d.ts:19`.

**There is no augmentable map.** No `LlmRequestPurposeMap`, no `interface` keyed by purpose exists in
rc.5 (verified by grep and by the type proof). `GenerateOptions` is a plain interface with a literal
union property, so `declare module` augmentation must redeclare the exact same type:

```
augment.ts(5,5): error TS2717: Subsequent property declarations must have the same type.
  Property 'purpose' must be of type '"compaction" | "session-title" | undefined',
  but here has type '"compaction" | "session-title" | "btw" | undefined'.
augment.ts(9,80): error TS2322: Type '"btw"' is not assignable to type
  '"compaction" | "session-title" | undefined'.
```

Minimal counter-check (`test.ts`): `purpose: 'compaction'` compiles; `purpose: 'btw'` is a type
error (consumed with `@ts-expect-error`). See `proof/COMMANDS.md` for the exact `tsc` invocations.

### Runtime/telemetry side effects of purpose

- DeepSeek is the only consumer. `$DSH/.../dsh-llm-deepseek/lib/index.js:2211` forwards `purpose`
  into the request-extension `prepare()` request; line 2242 sets
  `x-deepseek-harness-compact: 1` **only** for `purpose === 'compaction'`. No other body/header
  change.
- pi-ai never reads `purpose` (no reference in `$DSH/.../dsh-llm-pi-ai/lib/index.js`).
- Installed DeepSeek extensions do not branch on purpose:
  `dsh-session-log-deepseek` (`dsh_session_log`) and `dsh-plugin-package-inventory-deepseek`
  (`dsh_plugin_packages`) have no `purpose` hits.
- No telemetry/accounting/audit keyed on purpose exists in rc.5. The `'session-title'` precedent is
  explicitly attribution-only: "supplies attribution only. The request has no agent-loop identity
  and does not enter conversation history" (`dsh-session-title-llm/README.md:75`).

**Policy: do not set `purpose` for BTW; do not add a cast.** If a transport label is ever required,
that is an upstream DSH union change, not augmentation. BTW attribution belongs in BTW's own
audit/topic event.

The context package's claim is therefore **FALSE on rc.5**:

- `docs/dsh_btw_development_context/02_DSH_SOURCE_MAP_AND_COMPATIBILITY.md:17` —
  "Declare auxiliary 'btw' via type augmentation if supported, set purpose on side request."
- `docs/dsh_btw_development_context/04_CONTEXT_CAPTURE_AND_LLM.md:65` — "`purpose: 'btw'` as a
  type-augmented auxiliary request purpose."

The rest of the context package's conservative guidance (separate/omitted identity, no assumed
retry, no unpaired tools) matches the source.

---

## 4. Session identity, checkpoint, and upload interference

### 4.1 What the main loop sends

`$DSH/.../dsh-agent-loop/lib/index.js:1270-1287` builds the main request as:

```js
markAgentLoopRequest(Object.freeze({
  ...header.config,
  messages: session.deriveMessages(),
  toolHistory: session.toolHistory(),
  tools,
  sessionId: this.session.id,
  signal,
}))
```

`isAgentLoopRequest` is a process-local marker. `dsh-session-title` ignores non-loop requests
(`$DSH/.../dsh-session-title/lib/index.js:418-420`), so even a side call with the main id cannot
trigger title generation.

### 4.2 If you pass the main `sessionId`

`$DSH/.../dsh-session-checkpoint-policy/lib/index.js:61-64`:

```js
ctx.on("llm/stream", (options, next) => {
  if (options.sessionId === void 0) return next();
  const session = ctx.sessions.get(options.sessionId);
  return session === void 0 ? next() : afterCheckpoint(ctx, session, next);
});
```

`afterCheckpoint` (lines 26-32) awaits `ctx.sessions.flush(session)` before `yield* next()`. So the
main session is flushed and the side request is fail-closed coupled to the main session's checkpoint
health: a stuck flush delays the side call, and a failed flush fails it.

`$DSH/.../dsh-session-log-deepseek/lib/index.js:139-190` then:

```js
if (request.sessionId === void 0) return void 0;
const session = ctx.sessions.get(brandString(request.sessionId));
if (session === void 0) return void 0;
```

and uploads the contiguous event suffix after the accepted watermark (default `maxBytes` 8 MiB).
`accept()` (line 185) appends `session-log-deepseek/delivery-accepted` to the **same** session log.
That is a write to the main session caused by a side request — concrete interference.

The DeepSeek transport also sets (lines 2234-2243):

- `x-deepseek-harness-user-id` always,
- `x-deepseek-harness-session-id: <id>` only when `sessionId` is set,
- `x-deepseek-harness-compact: 1` only for `purpose === 'compaction'`.

### 4.3 If you omit `sessionId`

Both interceptors short-circuit: the checkpoint listener returns `next()` without touching
`sessions.get`, and the session-log extension returns `undefined` without a live Session. The proof
verifies exactly this: with no `sessionId`, `flushCalls === []`, no
`x-deepseek-harness-session-id` header, and `prepare()` returned `undefined` without calling
`sessions.get`.

### 4.4 pi-ai identity is affinity/cache, not conversation

The DSH pi-ai adapter passes `sessionId: String(options.sessionId)` into
`models.streamSimple` (`$DSH/.../dsh-llm-pi-ai/lib/index.js:1937-1960`). pi-ai uses it only for
transport affinity/cache hints:

- `x-session-affinity` (or provider-specific) when `compat.sendSessionAffinityHeaders`
  (`$DSH/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:819-822`);
- `x-session-id` / `session_id` / `x-client-request-id` on OpenAI-compatible routes under the same
  flag (`.../dist/api/openai-completions.js:544-553`);
- `prompt_cache_key` only for `api.openai.com` or long cache retention
  (`.../dist/api/openai-completions.js:578-583`); default retention is `short`
  (`resolveCacheRetention`, lines 22-30);
- `x-opencode-session` only for OpenCode routes (`.../dist/utils/identity.js:90-92`).

There is no provider-side conversation id or continuation on either adapter: DeepSeek Messages is
stateless, and pi-ai sends a fresh full message array. Reusing an id therefore buys nothing for BTW
and costs affinity/cache entanglement.

**Policy:** omit `sessionId`. If BTW wants a stable per-topic tag for its own logs, use a BTW-owned
string in BTW's events, not in the LLM request. A BTW-owned id passed as `sessionId` would be a
`sessions.get` miss (harmless) but would still become a provider affinity header — do not do it.

---

## 5. Streaming protocol

`StreamChunk` — `$DSH/.../dsh-llm/lib/types/types.d.ts:434-464`:

| chunk | fields |
|---|---|
| `block-start` | `index`, `blockType` |
| `text-delta` | `index`, `text` |
| `reasoning-delta` | `index`, `text` |
| `tool-call-delta` | `index`, `id`, `name?`, `argumentsDelta` (raw JSON string) |
| `block-end` | `index`, `block` |
| `usage` | `usage: TokenUsage` |
| `finish` | `reason: FinishReason`, `replayState?` |

`FinishReasonMap` (types.d.ts:131-149): `stop | tool-calls | max-tokens | aborted {failure} |
error {failure}`. `TokenUsage` (160-174) is disjoint: `inputTokens`, `outputTokens`, `totalTokens?`,
`cacheReadTokens?`, `cacheWriteTokens?`, `reasoningTokens?`.

- Every dispatched stream ends in exactly one terminal `finish` **unless the consumer abandons
  iteration**. `adapterFailureChunk` normalizes thrown adapter errors
  (`$DSH/.../dsh-llm/lib/index.js:2402-2410`): abort → `{kind:'aborted', failure}`, anything else →
  `{kind:'error', failure}`.
- `BlockAssembler` (`$DSH/.../dsh-llm/lib/index.js`):
  - `push(chunk)` accumulates text/reasoning/tool-call blocks and usage;
  - `blocks()` returns all blocks, including an open tool call with its partial arguments string;
  - `interruptedBlocks()` (1088-1103) returns only text and reasoning blocks with non-whitespace
    content — it deliberately **omits tool calls** ("retaining one would require a fabricated
    result") and **retains reasoning**, so filter reasoning yourself if the UI must not show it;
  - `finish` getter (1118-1122) returns `{kind:'stop'}` when no finish chunk arrived. This is a
    trap: track your own `sawFinish` before trusting `assembler.finish`;
  - `message(source)` (1117) returns `createAssistantMessage({ content: this.blocks(), source })`.
- To detect a partial/interrupted stream: `sawFinish === false`, or the last chunk is not a
  `finish`, or `finish.reason.kind` is `aborted`/`error`. A `stop`-reason stream can still be an
  interrupted *answer* if the side timeout aborts between chunks — check
  `deadline.signal.aborted` after the loop.
- Tool calls: a stream that ends with `tool-calls` means the model wants a tool. The side runner
  must not execute it; treat it as an unsupported result (retry with a stricter prompt, or render
  "the model requested a tool, which BTW does not run").

---

## 6. Retry: no automatic middleware on direct calls

`$DSH/.../dsh-llm-retry/lib/index.js` injects `["agents", "sessionProjections"]` and registers a
single listener at line 175:

```js
ctx.on("agent/request-error", (payload, next) => ...)
```

It retries at the durable agent-step boundary, re-running the step from committed history. Its
README states: "direct `ctx.llm.stream()` calls remain single-attempt … a raw stream cannot separate
already-emitted chunks durably"; "Agent turns are the only retry boundary". There is no middleware
around `ctx.waterfall(this, "llm/stream", ...)` (`$DSH/.../dsh-llm/lib/index.js:2388-2397`).

Defaults when the agent loop does invoke it: 5 retries, retryable codes `EMPTY_RESPONSE`,
`RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, initial 500 ms, max 10,000 ms, jitter 0.1; `always`
mode is unbounded.

**Proof:** with `dsh-llm-retry` mounted and fetch returning HTTP 500, one direct prepared stream made
exactly **1** network call and finished `{kind:'error', failure.code:'SERVER'}`, while the prepared
call reported `retryPolicy.maxRetries === 5`. An explicit loop of 3 fresh `prepareCall` attempts made
exactly 3 calls. So the retry must live in the BTW runner.

One caveat: each `prepareCall` may call the adapter's `connection()`/`current()` and thereby
re-resolve auth/route. That is desirable on retry, but it means a retry is not a replay of the same
HTTP request object; it is a fresh logical request.

---

## 7. Provider-safe normalization for side history (ContextCut)

Input: the committed messages of the source session up to the capture cut (`session.deriveMessages()`
semantics; only committed `user/message`, `system/message`, `developer/message`,
`assistant/message`, `tool/result` are visible — `$DSH/.../dsh-session/lib/index.js:217-230`), plus
the BTW question and system prompt. `assistant/attempt` is log-only and never in this array.

Normalize by these rules, in order:

1. **Cut at a committed boundary.** Never include an in-flight assistant stream. If the capture
   happens while a turn is running, use only messages committed before the in-flight step.
2. **Drop `system` and `developer` messages** from the copied history. Put the BTW system prompt in
   `options.system`. In-history system updates impose a preceding user/tool-result constraint on
   DeepSeek and are unnecessary for a side answer.
3. **Drop all `reasoning` blocks.** Do not replay thinking. This removes the DeepSeek
   signature problem, the pi-ai cross-model-drop problem, and the pi-ai anthropic
   unsigned-thinking→visible-text leak in one move. (Optional exception in §8.)
4. **Drop `tool-addition` / `tool-removal` blocks.** They only make sense with a live tool history;
   the side call has none.
5. **Pair tool calls and results; keep the greatest balanced prefix.**
   - Walk assistant messages in order. For each assistant message containing tool calls, collect the
     call ids; collect the ids of tool results in the immediately following user-role run
     (DSH represents tool results as `role: 'tool'`, which DeepSeek serializes as a user message).
   - If every call id has exactly one result, keep the assistant message (with its text and
     tool-call blocks) and the results. This is the only fully portable pair form.
   - If any call is unanswered, **drop the whole assistant message and all results for that batch**,
     and replace it with a plain text note in the following user message, e.g.
     `"Earlier the assistant requested tool <name>; its result was not committed."` Do **not** invent
     a successful `ToolResult` and do **not** fabricate `isError: true` output and claim it came from
     the tool.
   - DeepSeek requires *all* calls of a batch to be answered in the immediately following user
     message: partial batches are the `"tool calls need immediate results"` error, not a valid form.
   - An orphan tool result (result with no preceding open call) must be dropped; DeepSeek raises
     `"tool result has no matching call"`.
   - Consecutive tool results after one assistant batch are fine; keep their order.
6. **Drop empty messages.** DeepSeek skips empty assistant/user messages, but constructors/other
   providers are happier without them. Never send an assistant message with empty content.
7. **End with the BTW user message.** If the cut ends with an assistant message, append the BTW
   request as a new user message. If the cut ends with tool results, the BTW question follows them
   in the same user-role run (DeepSeek will merge; keep tool_result blocks first — the adapter
   reorders them itself at `dsh-llm-deepseek/lib/index.js:1715`).
8. **No tools.** Omit `tools` and `toolHistory`; the side answer must be text. If a schema is
   unavoidable, pass only read-only declarations and still never execute a returned call.
9. **Bound the result** (messages count + bytes + `maxTokens`) before `prepareCall`.

Why not let the provider do it:

- DeepSeek's validator is strict and rejects four shapes (exact strings below).
- pi-ai's adapter performs no pairing validation at all (`assertSupportedHistory`,
  `$DSH/.../dsh-llm-pi-ai/lib/index.js:1213-1295`, checks only developer tool-change placement,
  image placement, and system text), and the pi-ai library's `transformMessages`
  (`$DSH/node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js:139-158`) silently
  injects synthetic `{ role:'toolResult', content:[{type:'text', text:'No result provided'}],
  isError:true, timestamp:0 }` entries for open calls when a later message exists. That is
  provider-valid but is still a fabricated error result the model did not observe; if the open call
  is the **last** message there is no later message to trigger this and the provider sees an
  unanswered call. Normalize instead.

### DeepSeek pairing errors (all `INVALID_REQUEST`)

`$DSH/.../dsh-llm-deepseek/lib/index.js:1710-1717`:

| condition | exact message |
|---|---|
| duplicate call id within one assistant message | `DeepSeek Messages duplicate tool call id` |
| tool result without a preceding open call | `DeepSeek Messages tool result has no matching call` |
| a batch not fully answered in the next user message | `DeepSeek Messages tool calls need immediate results` |
| history ends with an unanswered call | `DeepSeek Messages history ends with unresolved tools` |

Verified by the proof: the raw `partialToolBatch` throws the third message with **zero** fetch calls;
the orphan-result case throws the second; every normalized case reaches the wire.

---

## 8. Reasoning replay

DeepSeek (`$DSH/.../dsh-llm-deepseek/lib/index.js:1515-1548`):

- `readReplay` uses `message.source.replayState` only when `source.kind === 'model'`, the envelope is
  `{ kind:'deepseek-messages', version:1, model }`, `response.model === message.source.model`, the
  block count matches the content count, and each block type matches (`text`, `reasoning`,
  `tool-call`).
- A signature is accepted **only on a reasoning block** and must be a string.
- `validateReplay` returns blocks only when `response.model === model` (the target). Otherwise it
  returns `undefined` *without* degrading, so serialization emits `{ type:'thinking', thinking }`
  with **no signature**.

pi-ai (`$DSH/.../dsh-llm-pi-ai/lib/index.js:145-256`):

- Replay restores `thinkingSignature` only when the envelope's `provider`/`model` match the message
  source and the `api`/version are valid.
- Otherwise it degrades to `foreignAssistant`: reasoning becomes unsigned `thinking`.
- At the pi-ai library boundary, `transformMessages` keeps thinking only when
  `isSameModel(message, model)` (same api, provider, model, baseUrl) — otherwise the block is
  **dropped entirely** (`.../dist/api/transform-messages.js:82-92`).
- On the anthropic route, a `thinking` block with no signature is serialized as a **visible text
  block** unless `compat.allowEmptySignature` (`.../dist/api/anthropic-messages.js:~560-620`). That is
  a privacy/behavior surprise, not just a fidelity loss.

**Policy:** strip reasoning from side history. If a future ticket wants replay, restrict it to the
same provider+model+baseUrl and require a validated replay envelope; otherwise never send reasoning.

---

## 9. Compacted and partial histories

What committed history can contain (`$DSH/.../dsh-session/lib/index.js:217-230, 1672-1687`):

- `user/message`, `system/message`, `developer/message`, `assistant/message`, `tool/result` are
  model-visible; `assistant/attempt`, `request/header`, `compaction/summary` are not.
- Empty assistant messages (`content.length === 0`) are projected as `null`.
- Surface `replace` ops (compaction) swap a hidden span for a checkpoint message. Shadowed events
  remain in the log but are not visible, so a side capture using `deriveMessages()` never sees them.
- `dsh-compaction-basic` (`$DSH/.../dsh-compaction-basic/lib/index.js:316-330, 631-665`) appends
  `compaction/summary` then a `user/message` checkpoint with
  `surfaceOp: { op:'replace', startSeq, endSeq }`. Tail retention refuses to split a pair
  (`toolPairingBalancedBefore`, `$DSH/.../dsh-compaction/lib/index.js:80-104`; region validation at
  `dsh-compaction-basic/lib/index.js:557`). Result: system + textual checkpoint + balanced tail.
- A **live** cut can still be unbalanced: committed assistant tool calls whose results are not yet
  appended. Recovery synthesizes `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` results
  (checkpoint-policy README:97,116), but that happens at recovery, not at capture. So the normalizer
  must handle the unbalanced case itself.
- Failed/interrupted attempts leave no partial assistant message in history — only
  `assistant/attempt` (log-only). "Interrupted retry attempts" therefore need no special case beyond
  §7's pairing rule.

---

## 10. Decision-ready policy

### 10.1 Side-call configuration (normative)

```ts
const callDeadline = deadline(btwTaskSignal, cfg.timeoutMs, 'BTW_SIDE_TIMEOUT');
try {
  const call = await ctx.llm.prepareCall(
    { provider: cfg.provider, model: cfg.model, maxTokens: cfg.maxOutputTokens },
    callDeadline.signal,
    (controls) => ({ ...controls, ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}) }),
  );
  const options = deepFreeze({
    ...call.config,
    messages: normalizedHistory,     // §7 rules
    system: cfg.system,              // BTW prompt, not in-history system messages
    signal: callDeadline.signal,
    // no sessionId, no purpose, no tools, no toolHistory, no stop
  });
  const assembler = new BlockAssembler();
  let sawFinish = false;
  for await (const chunk of call.stream(options)) {
    callDeadline.signal.throwIfAborted();
    assembler.push(chunk);
    if (chunk.type === 'finish') sawFinish = true;
  }
  callDeadline.signal.throwIfAborted();
  // sawFinish && assembler.finish.reason.kind === 'stop' → usable
} finally {
  callDeadline[Symbol.dispose]();
}
```

Notes:

- `stop` is not portable: pi-ai throws `UNSUPPORTED_OPTION` ("pi-ai does not support stop
  sequences") if `options.stop !== undefined`.
- Text-only models: images are converted to text placeholders by `LlmRuntime`
  (`$DSH/.../dsh-llm/lib/index.js:2330-2350`). Do not rely on image fidelity in a side call.
- Use `assembler.interruptedBlocks()` only for partial rendering; it intentionally excludes tool
  calls and includes reasoning.

### 10.2 Identity

- `sessionId`: **omitted**.
- `purpose`: **omitted**; record `btw` in BTW's audit/topic event instead.
- Signal: BTW-owned deadline; never the main turn's signal.
- No `dsh_session_log`, no `x-deepseek-harness-session-id`, no checkpoint flush caused by BTW.

### 10.3 No-retry assumption

Direct side streams are **not** covered by `dsh-llm-retry`. The BTW runner owns retries:

- max 2 retries (3 attempts) by default; configurable;
- fresh `prepareCall` per attempt;
- retry only `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, and only before
  emitting any user-visible content (or discard the partial output and restart the render);
- do **not** retry `ABORTED`, `INVALID_REQUEST`, `UNSUPPORTED_*`, `CONTEXT_WINDOW_EXCEEDED`,
  `INVALID_PREPARED_CALL`;
- backoff 500 ms × 2^attempt, capped at 10 s, jitter 0.1; honor `Retry-After` when present;
- idempotency caveat: a provider may have accepted/billed a request that failed mid-stream; there is
  no dedupe key in rc.5. Do not retry non-idempotent "effects" — BTW side calls have none, so this
  is safe, but do not copy this policy to tool-executing calls;
- each attempt gets its own `deadline` derived from the BTW task signal; overall budget is enforced
  by the BTW task deadline, not by the LLM runtime.

### 10.4 ContextCut normalization rules (normative summary)

- Input = committed `deriveMessages()` up to the cut, plus BTW system + user question.
- Drop: system/developer messages, all reasoning, tool-addition/removal, empty messages.
- Pair: keep only fully matched assistant-tool-call batches; drop any batch with an unanswered call
  and replace it with a user-visible textual note; drop orphan results.
- Ensure tool_result blocks precede the BTW user text in the same user-role run.
- Send no tools/toolHistory; never execute a returned tool call.
- Bound messages/bytes and set `maxTokens`.

### 10.5 Provider compatibility table

| Aspect | DeepSeek (dsh-llm-deepseek) | pi-ai (dsh-llm-pi-ai + pi-ai 1.4.0) |
|---|---|---|
| Idle (text-only) history | Accepted (as long as balanced) | Accepted |
| Streaming partial text in history | Not applicable: history holds only committed messages; assemble the side stream with `BlockAssembler` | Same; `transformMessages` skips assistant messages with `stopReason` error/aborted |
| Open/a partial tool batch | **Rejected**, 4 exact `INVALID_REQUEST` errors | Adapter does not validate; library injects synthetic `isError:true` "No result provided" when a later message exists; unanswered final call may reach provider → **normalize** |
| Orphan tool result | Rejected: "tool result has no matching call" | Passed through; provider may reject → **drop** |
| Interrupted retry attempt | `assistant/attempt` is log-only, never replayed | Same; pi-ai also drops error/aborted assistant messages |
| Compacted history | Balanced checkpoint + tail, accepted | Accepted |
| Reasoning replay | `thinking` + signature only for same model via valid `deepseek-messages` v1 replay; foreign model → unsigned `thinking` | Same-provider/model/baseUrl only; otherwise dropped (or unsigned thinking → visible text on anthropic) → **strip** |
| Identity (`sessionId`) | `x-deepseek-harness-session-id`; checkpoint flush; session-log upload + accept append | Affinity headers; `prompt_cache_key` only openai.com/long retention; no conversation continuation |
| Caching | Stateless Messages; cache read/write usage reported; no request-side key observed (UNVERIFIED) | `prompt_cache_key`/`cache_control` per route; retention `short` by default (`PI_CACHE_RETENTION=long` for long) |
| `stop` sequences | Supported (`stop_sequences`) | **Unsupported**, throws `UNSUPPORTED_OPTION` |
| max tokens field | `max_tokens` | `max_completion_tokens` (unless compat overrides) |
| Abort | caller signal fused with consumer controller; idle watchdog `MESSAGES_IDLE` | `idleWatchdog` `PI_AI_IDLE`; SDK `maxRetries: 0` |

---

## 11. Offline proof

Location: `docs/research/side-llm/proof.mjs`, with `proof-out.json` and `COMMANDS.md` beside it.

The script loads the installed rc.5 modules by absolute path from `DSH_ROOT`, replaces `fetch` with a
wire-level stub, and asserts 28 checks. It performs **no network** calls and changes no DSH files.

What it proves:

1. Raw partial tool batch is rejected by DeepSeek before any fetch, with
   `DeepSeek Messages tool calls need immediate results`.
2. Every normalized fixture (idle, streaming, partialToolBatch, matchedToolPrefix, retry,
   compaction) reaches the DeepSeek wire as plain text with no `tool_use`, `max_tokens: 64`, no
   tools, and no session/purpose headers.
3. The same fixtures reach the pi-ai OpenAI-compatible wire with no tool roles and no session field.
4. Aborting the main signal leaves the side signal un-aborted; aborting the side deadline aborts the
   side fetch and finishes `{kind:'aborted'}` without touching the main signal.
5. `prepared.stream()` is one-shot; a second dispatch throws `INVALID_PREPARED_CALL`.
6. A direct side stream is not retried by `dsh-llm-retry` (1 fetch for an HTTP 500), while three
   fresh `prepareCall` attempts produce exactly 3 fetches.
7. No `sessionId` → no checkpoint flush, no session-id header, and the session-log extension returns
   `undefined` without calling `sessions.get`; with the main id → flush `['main-proof']` and the
   header appears.
8. DeepSeek valid replay sends `{ type:'thinking', signature }`; an unusable/foreign replay degrades
   to `{ type:'thinking' }` with no signature; an orphan result throws.
9. pi-ai valid replay sends `reasoning_content`; foreign replay drops the reasoning entirely.

---

## 12. UNVERIFIED items

- **Provider acceptance of unsigned `thinking`**: DeepSeek serializes a foreign-model reasoning block
  as `{ type:'thinking', thinking }` with no signature; whether the live API accepts or ignores it is
  UNVERIFIED (no network calls allowed). Mitigation: the policy strips reasoning.
- **pi-ai provider-specific rejection of an unanswered final tool call**: the adapter/library shape
  is verified; the per-provider HTTP error is UNVERIFIED. Mitigation: normalize.
- **DeepSeek prompt-cache keying**: `cacheReadTokens`/`cacheWriteTokens` are reported, but no
  request-side cache key was found. How cache hits are keyed is UNVERIFIED.
- **Exact wire acceptance for every DeepSeek API version**: serializer and validator are rc.5 code;
  a live compatibility matrix is out of scope.
- **`ctx.llm` service export name**: the runtime object is `LlmRuntime` and the prepared-call seam is
  verified; the exact Cordis service key used by plugins (`ctx.llm`) is consistent with
  session-title/compaction call sites but was not independently type-probed.
