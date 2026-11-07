# 05 · Topic Storage, Follow-up, Crash Recovery and Concurrency

## Recommendation: separate `dsh-storage-domain`

Host-side BTW records should be stored in their own feature Domain, not main Session events. DSH `@deepseek-ai/dsh-storage-domain` is explicitly intended for durable non-model-visible Session sidecar and application records. Base DSH mounts `storage-json`; use `layout:'per-record'` where the checkout supports it or route to SQLite for point updates. A default single-unit file can rewrite the entire archive on each completed topic: avoid it at scale.

Suggested domain, conceptual (types in `examples/types.reference.ts`):

```text
Domain: btw_topics, version 1
  table: topics
    key: <SessionId>:<TopicId>  (safe stable encoding, no path injection)
    value: BtwTopic { sessionId, topicId, title, revision, turns[], ... }
```

Do not use a global all-session Topic list without Session-scoped access checks; `list(sessionId)` scans entries only for that authorized Session. A separate index by Session ID can be added if scale demands; keep any derived index consistent with topic mutations.

## Data invariants

- Topic `sessionId` immutable; topic belongs to exactly one main Session.
- `topicId` immutable after creation, `turnId` immutable within the Topic, `requestId` globally unique within Session idempotency window.
- Follow-up appends to selected Topic, never rewrites earlier turn text/status.
- Every Topic has one opening Turn; `turns[0].question` is default title (unless explicit UI title).
- At most one `running` Turn per Session (V1); at most one current `running` Turn per Topic.
- `revision` monotonically increments for every durable material change.
- Stored terminal statuses: `complete`, `cancelled`, `error`, `interrupted` (terminal). `running` is only for admitted not yet settled work.
- Partial response chunks may live in an in-memory stream hub and become durable at terminal; while running, persisted answer can be an empty prefix. Do not claim crash-perfect per-token history.
- A `running` row from an **old host instance** becomes `interrupted` on recovery. Do not prematurely mark a still-owned running row interrupted within the same generation.

## Durable admission protocol

```text
assert authorized Session
synchronously acquire live per-Session in-process BTW reservation
capture context snapshot before any await
idempotency check: same requestId -> same receipt, no second dispatch
validate follow target and expected revision
persist new running Turn (atomic per record; no LLM yet)
if cancelled during persist: durably terminalize cancelled; do not call model
release admission waiter / return receipt
start detached independent LLM operation
stream deltas to in-memory listeners (with bounded coalescing)
on finish: persist full final answer + terminal status
publish settled only after persist is durable
release active slot with execution epoch guard
```

**Concurrency nuance:** A client can retry the same `requestId` while the original admission is in progress. Track the in-flight request receipt Promise before first await; only one underlying write/dispatch. Reuse the same idempotent receipt after completion. `requestId` cannot be mapped to multiple Topic/Turn targets.

## Cross-process deployment

`storageDomain.table.update` sequences updates within one Domain instance. `storage-json` **has no cross-process write locking**, so two Host processes can overwrite the same Topic. `storage-sqlite` provides database transactions for individual writes but `storage-domain` does not offer a general multi-record distributed lease/CAS; don't advertise equivalence to OMP lease+revision check.

V1 **single Host writer** is a documented deployment restriction, not an unnoticed defect. Future multi-Host: implement a Topic lease with owner instance/generation, expiration and fencing token at an authoritative shared medium or implement OMP-like file-lock+revision store for a file-based deployment. Prefer one authoritative writer rather than assuming `updatedAt` protects races.

## Side lifecycle & Session lifecycle

- Closing BTW panel: **UI-only**. Running request continues, and `/btw` can reopen.
- WebSocket disconnect: **reader-only**; does not by itself abort the Side Request.
- Explicit BTW Cancel: abort own controller; persist partial text with `cancelled` status; no main Agent cancellation.
- Main Session changes: BTW record remains scoped to original Session. Late old frames identified by sessionId/topicId/turnId/epoch are rejected from other UI.
- Host/plugin unload: stop admission, abort side operations, drain in-flight final checkpoints and close Domain. If abort/flush fails, indicate storage uncertainty; avoid silent loss of committed facts.
- Host crash: on next startup, find stale `running` records whose owner generation is not current; update to `interrupted` (or project recovered view and persist repair once ownership established), don't resume LLM blindly.
- Main Session deletion/archive: define explicit retention rule. V1 may retain BTW sidecar until explicit purge, but UI must not leak inaccessible archived/deleted Session content. Do not make external transcript export/share include BTW records implicitly.
- Cold history: `list/get` should load the Domain records directly, not resolve an `Agent` that would resume the main task.

## Revision and notification

`BtwTopicRepository.update` should perform a Domain-queue atomic read-modify-write with `expectedRevision` check. It is a single-process CAS analog. Treat an unknown outcome (`unknown-state` storage failure) as requiring close/reopen + re-read before retry. On publish: use a bounded process-local observation hub with per-Session revisions. Sequence `subscribe` + `snapshot` in a race-free order; reconnect starts with the current durable record plus in-memory active partial and then diffs, without repeating historical text.

`domain/changed` announces successfully written Domain state; it does NOT itself provide an exactly-once, cross-process watch mechanism. Avoid reusing it as if it were an ordered network delivery journal.

## Content/privacy

Main Session history can include secrets, paths and tool output. A BTW answer can quote them; therefore `btw.list/get/watch/ask` must enforce the same Session resource access as reading the main session. Store BTW answers according to configured application privacy policy. Do not embed full main context or raw intermediate reasoning into Topic records by default; optional captured `ContextCut` metadata (seq, Attempt ID) is sufficient for audit.
