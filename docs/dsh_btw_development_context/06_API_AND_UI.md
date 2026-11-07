# 06 · API Contract, Web/CLI Routing and Interaction Model

## Design principle

One Host business implementation for `/btw`, Web Panel, and future CLI adapter. **Do not** implement separate BTW business semantics in the browser. Session and Topic are explicit on every request, Host checks authorization, no BTW answer becomes main Agent model input.

## Proposed service methods (conceptual signatures)

| Method | Input | Output | Semantics |
|---|---|---|---|
| `btw.ask` | `{sessionId, topicId?, question, requestId, expectedRevision?}` | `{topicId, turnId, status:'running', revision}` | Persist-first admission. `topicId` omitted: new; provided: follow-up. |
| `btw.list` | `{sessionId, cursor?, limit?}` | ordered `TopicSummary[]` and page cursor | Read-only, no Agent resume. |
| `btw.get` | `{sessionId, topicId}` | complete Topic incl. all Turns | Read-only, no Agent resume. |
| `btw.watch` | `{sessionId}` + AbortSignal | stream `snapshot`, `delta`, `settled`, `error` | Independent subscriber. Client disconnect stops watch only. |
| `btw.cancel` | `{sessionId, topicId, turnId}` | `{cancelled:boolean, revision?}` | Cancels only in-process side LLM. |
| `btw.history` optional | `{sessionId}` | no-op/open in local UI only | Bare `/btw` opens Client panel, no Host mutation necessary. |
| `btw.delete` future | `{sessionId, topicId, expectedRevision}` | acknowledged deletion | Reserve, don't implement unless explicitly scoped. |

**Actual DSH integration:** Feature-owned Host class extending `TypertRemoteService`, methods annotated using `@Remote(...)`, registered in Host Loader/typert; generated `ctx.remote.btw` Client bindings. All Session-targeted methods must declare/check Session resources (and call `this.ctx.remoteAccess.allows` for per-item list filtering if needed). Verify generated `typert.resources` inference from the first `request.sessionId` field; prefer explicit `resources` when uncertain.

`@Remote({mode:'stream'})` yields frames; do not implement custom WebSockets when the official Remote stream is sufficient. Feature-specific data must be JSON-safe and schema validated. Do not hand-write a fake generated Remote declaration.

## Proposed wire types

```ts
interface BtwAskRequest { sessionId: string; topicId?: string; question: string; requestId: string; expectedRevision?: number }
interface BtwAskReceipt { sessionId: string; topicId: string; turnId: string; status: 'running'; revision: number }
type BtwFrame =
  | { type: 'snapshot'; sessionId: string; revision: number; topics: BtwTopicSummary[]; active?: BtwActiveSnapshot }
  | { type: 'delta'; sessionId: string; topicId: string; turnId: string; revision: number; offset: number; text: string }
  | { type: 'settled'; sessionId: string; topicId: string; turnId: string; revision: number; topic: BtwTopic }
  | { type: 'error'; sessionId: string; topicId?: string; message: string; code: string }
```

`revision` is monotone in the Session's **in-memory stream hub**, while Topic `revision` is durable per Topic. Do **not** confuse these clocks; use distinct names (`feedRevision`, `topicRevision`) in actual implementation. `offset` supports idempotent delta composition and dedup. Web reconstructs answer from snapshot + incremental suffix; resubscribe after reconnect rather than accepting gaps.

## `ask` vs `watch`

`ask()` must settle quickly after a persist-first `running` checkpoint and scheduling a detached side operation. It must NOT hold the command RPC until LLM completion. Detached task is Host-owned, must have cleanup and tracked disposal. A caller-cancelled `ask` **before admission** prevents dispatch; a cancelled `ask` **after durable admission** does not implicitly abort the side operation, unless the API explicitly defines that behavior. Independent `cancel()` owns cancellation after admission.

`watch()` sends a consistent snapshot immediately and then incremental frames. It is client-specific and aborts on disconnect, without cancelling the Host's side operation. Protect against snapshot/listen gaps: set up watcher before reading snapshot under in-process sequence fence or buffer concurrently emitted frames until snapshot is delivered.

## Web input routing

Two user gestures:

1. Bare `/btw`: open BTW history/panel for the current Session. Use `ctx.commandUi.register` client-only contribution or `ctx.commandUi.decorate` on an existing Host command **if one is actually registered**. Do not assume a Host BTW command exists.
2. `/btw <question>`: intercept whole leading line and attachments in Web input trigger **before** default `session.prompt`; route to `remote.btw.ask` and consume the entry. On rejection, preserve draft; on success, clear only BTW-submitted text and show BTW panel.

Public DSH `ctx.inputTriggers.registerSource` supports `InputTriggerSource.matchEnter(session,line,signal,envelope)` and `onPick`; use the `CommandClaim` and submission contract after inspecting the exact local version. Avoid colliding with built-in UI Commands source and duplicate slash-candidate names. `commandUi.register` supports **bare action** but not arbitrary command args by itself. CLI/TUI likely has different command ingestion: wire it to the same Host Coordinator, document if interim `ctx.commands.register` introduces `command/run`/`command/done` log-only entries.

Do not tunnel BTW questions through a normal `user` message, or `agent.followup`, `steer`, `inject`, Session RPC prompt, or ordinary chat composer default sink. If the current UI platform cannot intercept `/btw question` without a Host Command, prefer an explicit BTW panel and document the remaining integration gap rather than claim full parity.

## Web BTW panel behavior

- Session-scoped left sidebar or popup; never render as a main Chat assistant message.
- Two-pane history/topics and selected Topic details where layout allows; responsive narrow viewport can switch single panes.
- New Question button, separate input, Q/A markdown rendering, streaming cursor, Cancel (request), Copy, Follow-up action under completed/cancelled/error topics as allowed.
- Bare `/btw` opens Topic list and selects newest. After finishing a new answer, `f` on suitable keyboard surface opens Follow composer; `f` or Enter on selected history Topic opens Follow composer, subject to focus safety and local keybinding rules.
- Input rejection preserves draft; repeated Enter while request pending does not duplicate.
- Closing panel leaves BTW request running. Reopening shows current streaming answer (or persisted completed history) via Remote snapshot.
- Changing current Session changes UI scope and subscription; late frames carry source session ID and cannot render in new Session.
- `Cancelled`, `Error`, `Interrupted` are distinct statuses; history retains partial answer; no automatic reattempt.
- Multi-Tab support: Host singleflight; each tab gets the same current record, and stale UI buttons never authorize another request.

## Security/Privacy

The Host must authorize `sessionId` on all methods, not only through UI visibility. For nested read results, filter to same Session and per-resource grants. OMP focused subagent isolation is a later phase: DSH uses different regular/subagent session addresses and owner grants. Do not silently inherit parent permission to child.

BTW requests may include sensitive tool outputs and logged messages; do not send them to a provider different from the configured primary route without explicit choice, and do not automatically export sidecar answers when exporting/sharing main transcript.

## Session-level UI state

The UI may track selected topic and draft in Client ephemeral state; these are presentation details. Topic content/status/revision and active request ownership always come from Host. No Browser localStorage as canonical BTW history. Avoid a Client SessionProjection for storage unless the data is **actually sourced from the main Session log** (it is not).
