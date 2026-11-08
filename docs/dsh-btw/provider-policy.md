# Side-call provider policy (normative)

This is the policy the BTW runner must satisfy for every side request. The current
implementation is `src/runner.ts` plus `src/normalize.ts`; deviations are called out
explicitly.

## Call shape

```ts
const deadline = AbortSignal.timeout(90_000)
const signal = AbortSignal.any([turnSignal, deadline])   // one budget per turn

for (let attempt = 0; attempt < 3; attempt += 1) {
  const prepared = await ctx.llm.prepareCall({ provider, model, maxTokens, ...controls }, signal)
  const stream = prepared.stream({
    ...prepared.config,
    messages: normalized.messages,
    system: normalized.system,
    signal,
  })
  // consume text-delta / finish
}
```

Rules:

1. **Prepare, then stream.** `prepareCall(config, signal)` resolves and freezes the
   route; `prepared.stream({...prepared.config, messages, system, signal})` dispatches
   it. Never mutate provider/model/controls between the two.
2. **Fresh prepare per attempt.** A prepared call is one-shot; a second `stream()`
   throws `INVALID_PREPARED_CALL`. Do not reuse `prepared` across retries.
3. **Own deadline, own signal.** The side call never uses the main turn's signal.
   The implementation fuses the BTW turn's `AbortController` signal with a **90 s**
   deadline (`src/runner.ts:57-58`). Note: the deadline is created once, so 90 s is
   the total budget across all attempts, not per attempt.
4. **Token bounds.** `maxTokens = min(facts.maxTokens ?? 4096, 4096)`
   (`src/runner.ts:63-69`). Input is bounded separately by the normalizer.
5. **At most 3 attempts** (2 retries).
6. **No identity, no purpose, no tools.** Do not pass `sessionId`, `purpose`,
   `tools`, `toolHistory`, or `stop` to the side request. The implementation passes
   only the prepared config plus `messages`, `system`, and `signal`.
7. **Controls copied from the main request.** `provider`, `model`,
   `reasoningEffort`, `temperature`, and `maxTokens` come from the observed main
   `llm/stream` facts. The late-mount fallback (`agent.options`) copies
   `provider`, `model`, `reasoningEffort`, and `maxTokens` only.

## Retry classification

Retry only when the prepared call's resolved policy marks the failure retryable.
rc.5's default retry set is:

`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`

and `mode: 'always'` makes every code retryable. The runner reads
`prepared.retryPolicy` (`src/runner.ts:28-31,105-114`); it does not maintain a
separate hard-coded allowlist, so a custom resolved policy can widen or narrow the
set.

Never retry:

- `ABORTED`, `INVALID_REQUEST`, `UNSUPPORTED_*`, `CONTEXT_WINDOW_EXCEEDED`,
  `INVALID_PREPARED_CALL`;
- any attempt that already streamed text to the reader — retrying would duplicate the
  visible answer. The implementation settles that attempt as `error` with the
  partial text (`src/runner.ts:99-107`);
- a `prepareCall` failure: the code path has no policy yet and breaks out
  (`src/runner.ts:71-77`).

`EMPTY_RESPONSE` is synthesized when a stream ends with neither a `finish` chunk nor
any text (`src/runner.ts:97`). Backoff uses the policy's `initialDelayMs`,
`maxDelayMs`, and `jitterRatio` with `base = min(maxDelay, initial * 2^attempt)`.
Cancellation is checked before each attempt and during backoff; an aborted turn ends
as `cancelled`, not `error`.

## Identity table

| Field | Value | Reason |
|---|---|---|
| `provider` / `model` | copied from main request facts | same route as the observed main call |
| `sessionId` | **omitted** | avoids checkpoint flush, main log upload/accept append, affinity/cache entanglement; no conversation continuation exists |
| `purpose` | **omitted** | rc.5 union is closed; `'btw'` is not typeable |
| `tools` / `toolHistory` | **omitted** | text-only side answer; nothing may execute |
| `signal` | BTW-owned deadline fused with the turn signal | independent cancellation and timeout |

## Normalization rules

Input is the committed `session.deriveMessages()` snapshot plus the topic history and
the current question (`src/normalize.ts:36-132`).

1. Flatten **all** history into one plain-text transcript inside a single user
   message, labelled `[user]`, `[assistant]`, `[tool result: <name>]`.
2. Drop `system` and `developer` messages; the system prompt is sent out-of-band, with
   the BTW read-only addendum appended.
3. Drop reasoning: only `text` blocks are read. Images and files are not forwarded.
4. Open/unpaired tool calls become a text line
   (`[tool call not executed in this side view: <name>] ...`); no result is invented,
   and no tool-call block or schema reaches the provider (`src/normalize.ts:77-83`).
5. Tool results are flattened to text; their call name is resolved from the preceding
   assistant message, falling back to `tool`.
6. In-flight assistant text captured at admission is appended as
   `[assistant, still streaming at capture]` (`src/normalize.ts:85-87`).
7. Prior turns from **only the selected topic** are replayed as user/assistant
   messages, skipping empty answers; a non-`complete` included turn adds
   `history-partial`.
8. Bound the transcript to the last 48,000 characters and add `context-truncated`.
9. End with the current question as a user message.

Because the whole history is text, provider tool-pairing validation never sees an
unpaired call. This is deliberately stricter than "keep the balanced prefix": it
trades some structural fidelity for a request shape both adapters accept.

## DeepSeek vs pi-ai

| Aspect | DeepSeek (`dsh-llm-deepseek`) | pi-ai (`dsh-llm-pi-ai`) |
|---|---|---|
| Unpaired/open tool batch | Rejects with `INVALID_REQUEST`: duplicate id, result without call, batch without immediate results, or history ending unresolved | Adapter does not validate; library injects synthetic `isError: true` "No result provided" when a later message exists, and an unanswered final call can reach the provider |
| Orphan tool result | Rejects "tool result has no matching call" | Passed through; provider may reject |
| Reasoning replay | `thinking` + signature only for the same model with a valid `deepseek-messages` v1 replay; foreign model degrades to unsigned `thinking` | Replays only for the same api/provider/model/baseUrl; otherwise dropped entirely; on the anthropic route unsigned thinking can become **visible text** |
| `stop` sequences | Supported (`stop_sequences`) | **Unsupported** — throws `UNSUPPORTED_OPTION` |
| Max-tokens field | `max_tokens` | `max_completion_tokens` (unless compat overrides) |
| `sessionId` set | Adds `x-deepseek-harness-session-id`, flushes the Session before dispatch, uploads the log and appends `delivery-accepted` | Adds affinity headers / `prompt_cache_key` only for openai.com or long retention; no continuation |
| Abort | Caller signal + idle watchdog `MESSAGES_IDLE` | `idleWatchdog` `PI_AI_IDLE`; SDK `maxRetries: 0` |

Both routes are used through the same runner; normalization is the intersection that
keeps both valid. The only provider actually exercised end-to-end is
`kimi-coding` / `k3.1-pro` via pi-ai (see `verification.md`).

## Explicitly UNVERIFIED

These are not established by the rc.5 source review or the offline proof:

- Live DeepSeek acceptance of a normalized (text-only, unsigned/no reasoning)
  request — no DeepSeek network call was made.
- Provider-specific HTTP behavior for an unanswered final tool call (the normalizer
  avoids producing one).
- DeepSeek prompt-cache keying and hit behavior; only usage counters are reported.
- Exact wire acceptance across other providers/models and API versions.
- The anthropic unsigned-thinking → visible-text path; source-verified only.
- Breadth of the provider matrix: one pi-ai route was exercised, not a matrix.
