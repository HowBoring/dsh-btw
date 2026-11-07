# One representative end-to-end scenario

Goal: prove **Follow uses a fresh main Session cut** and BTW never interferes with primary ReAct.

## T0

User sends to main Agent: "Implement metadata filtering; run the tests". Main Agent reads `filter.py`, then asks LLM to propose a fix.

## T1 — partial Assistant stream

- Committed Session: original prompt + read-file result.
- Current Attempt `A`: text deltas 1 and 2 say "I will update the resolver…"; delta 3 has not arrived.
- User submits `/btw Why this resolver?` in Web. Host captures `ContextCut={eventSeq: S, attemptId: A, chunkIndex: 2}` and creates Topic `topic-a`, Turn 1 `running`.
- LLM Side Request receives committed read-file result and safe partial text. It does **not** receive delta 3 or any future result.
- Primary LLM continues, then main tools execute. BTW A1 says why the resolver design was chosen; stores Turn 1 `complete`.

## T2 — new main work

Main Agent runs `run_tests`, which fails. New committed ToolResult says a field type mismatch occurred. User opens `/btw` History, selects Topic A, presses `f`, submits "Does the current test failure invalidate that choice?".

- Host captures **new** ContextCut `eventSeq: S+n`, includes the failed test result.
- Side request contains current main context at T2 plus separate `(BTW Q1, BTW A1)` messages and BTW Q2.
- It must not contain any questions from independent Topic B.
- Turn 2 appends to Topic A, and after answer is durable its status is `complete`.

## T3 — cancellation, refresh and restore

Start Topic B. While Side Request streams two deltas, user closes the Web panel. The Host side request continues. User reopens the panel and sees the same live B answer via `watch` baseline. User clicks Cancel: only the B Side Request aborts. Main Agent continues.

Refresh the browser. Session-scoped history contains Topic A with both turns and Topic B as cancelled with partial answer. No BTW Q/A appears in `mainSession.deriveMessages()` or main tool events. On Host restart, any orphaned `running` turns from the old generation become `interrupted`.

## Assertions

- Main task request transcript (source messages and tools) identical with/without BTW under deterministic fixtures.
- Host `ask` only returns after starting record durably written and before full answer completion.
- Exactly one LLM dispatch for an idempotency `requestId` even when UI retries twice.
- Side `ctx.llm.stream` call carries distinct BTW purpose/identity and independent signal.
- Current main ToolCall/ToolResult constraints remain valid for each provider adapter.
