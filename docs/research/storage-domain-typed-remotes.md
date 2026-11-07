# Wayfinder #4: Storage Domain, typed Remotes, authorization, and cold lifecycle

- **Ticket:** [HowBoring/dsh-btw#4](https://github.com/HowBoring/dsh-btw/issues/4)
- **Verified runtime:** installed `@deepseek-ai/dsh` **0.2.1-rc.5**, Node **v26.7.0**.
- **Primary source for the runtime:** [`dsh-v0.2.1-rc.5`](https://github.com/deepseek-ai/deepseek-harness/tree/b830ec950faba0a46dda564be3e2d854afed94f1), commit `b830ec950faba0a46dda564be3e2d854afed94f1`.
- **Requested comparison pin:** `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`.
- **Executable evidence:** [research/storage-remote.proof.mjs](../../research/storage-remote.proof.mjs), retained and expanded from the prior agent's untracked proof.
- **Date:** 2026-11-07.

## Resolution

**Verified, with application-owned policy; no DSH core change is required by this ticket.** A Session-keyed, per-record Topic store can provide durable ordered writes and cold `list`/`get`; generated strict Remotes can expose `ask`/`list`/`get`/`watch`/`cancel`; and Gateway policies can authorize the Session before business code or Agent/Session lookup.

DSH does **not** by itself provide BTW admission idempotency, crash recovery of `running` Topics, cross-process writer exclusion, or gap detection for Topic revisions. BTW must own those policies. In particular:

1. use exactly one Host writer and the per-record JSON layout;
2. persist `running` before starting model work, deduplicate by persisted `requestId` plus the in-flight admission promise, and make cancellation explicit;
3. treat uncertain storage outcomes and malformed/unreadable records as degraded, fail closed, and recover `running` records under a new owner generation;
4. declare the Session resource on every method and never use an Agent/Session lookup parameter for cold reads;
5. detach admitted work from reader cancellation, and use subscribe-before-snapshot plus per-Topic revision checks and reconnect snapshots.

The pinned comparison source is newer than the installed runtime. It adds `unknown-state` Domain quarantine and crash-atomic per-record `deleteMany`; those are **not** assumed in the rc.5 design below ([pinned Domain][pin-domain], [pinned JSON batch delete][pin-json-delete]).

## 1. Storage layout and writer limits

### Verified contracts

- `defineDomain` defaults to `layout: 'single'`; BTW must explicitly select `layout: 'per-record'`. The default single layout rewrites the whole unit, while per-record puts and deletes touch one record document ([Domain spec][domain-spec], [JSON backend contract][json-readme]).
- Per-record JSON is stored at `<root>/<unit>/<table>/<key>.json`, with document body `{ "version": 1, "record": ... }`. Keys must match `^[a-zA-Z0-9_-]+$`; a colon is rejected ([key/path constraint][json-key], [per-record write][json-per-record]).
- A put uses a mode-`0600` temporary file, file `fsync`, atomic rename, and a parent-directory `fsync` on POSIX. A resolved put is crash-durable under the backend's documented filesystem assumptions ([atomic write][json-atomic], [backend durability][json-readme]).
- The JSON backend has **no cross-process lock**. Concurrent processes are last-completion-wins, so a per-process Domain queue is not distributed mutual exclusion. BTW must have one Host writer; multiple Host replicas or external writers are unsupported ([backend concurrency][json-readme]).
- In rc.5, per-record delete is a plain `rm(..., { force: true })`, without the pinned version's crash-atomic batch-delete protocol. Backup names have minute resolution, so another backup of the same key in the same minute can replace the prior backup ([per-record delete and backup][json-delete-backup]).

The proof used readable safe fixture keys and observed only:

```text
<tmp>/btw_proof/topics/session-1_topic-1.json
<tmp>/btw_proof/topics/session-2_topic-1.json
```

Production IDs need a collision-free encoding inside the safe alphabet, for example base64url of the UTF-8 JSON tuple `[sessionId, topicId]`; simple concatenation with `:` is invalid, and delimiter concatenation without an unambiguous encoding risks collisions.

## 2. Update ordering, effects, revision checks, and idempotency

`Domain.update()` executes its transform at its serialized queue slot, not when the call is first made. For a successful put/update, the order is:

```text
await backend durability -> replace in-memory value -> emit domain/changed
```

An ordinary transform/backend rejection before publication leaves memory unchanged. Returned records are live values, not defensive copies; callers must treat them as immutable ([Domain write queue and publication][domain-update]).

Consequences for BTW:

- Check `expectedRevision` **inside** the `update()` transform and increment the stored revision in the returned record. This gives compare-and-swap semantics only within the single Domain writer, not across processes.
- Subscribe to `domain/changed` for live notification only after the write is durable. The event is not a persisted cursor or replayable journal.
- DSH has no request idempotency key. `ask` must first dedupe the Host's in-flight `requestId -> Promise<receipt>`, then inspect the persisted Topic receipt. A retry after an unknown Client outcome must return the existing receipt rather than start a second worker.
- Persist `status: 'running'`, `requestId`, `revision`, and the new `ownerGeneration` before invoking the LLM. Only a resolved durable admission may start work. The model request itself is not made exactly-once by this protocol; after a crash its outcome is unknown and must not be silently repeated.

The proof's two concurrent updates observed revisions `[1, 2]`, finished at revision `3` with answer `ab`, and left the other Topic file byte-for-byte unchanged. A stale expected revision `2` against actual revision `3` rejected at the queued transform and did not publish the write. At `domain/changed`, the on-disk record already had revision `3`.

## 3. Recovery and the required degraded policy

There are two materially different invalid-record paths:

1. With default `invalidRecords`, a parsed document whose record fails the Domain schema rejects open with `invalid-record`. `invalidRecords: 'backup-and-skip'` instead moves it aside and loads it as absent; upstream explicitly intends that option for disposable derived data, not authoritative BTW Topics ([Domain spec][domain-spec], [Domain open validation][domain-open]).
2. The rc.5 per-record backend returns **absent** for malformed JSON, an unaccepted document version, or a read error before Domain schema validation. Therefore even strict Domain open can succeed with a damaged Topic silently missing ([per-record read][json-read]).

An I/O failure after rename can also leave the durable document changed even though memory was not published. The backend contract says that when an I/O result is uncertain, the caller must close/reopen and re-read before retrying ([backend unknown outcomes][json-recovery]). The proof exercised the ordinary pre-publication case—memory and restored disk stayed at revision `3`—not a power-loss or post-rename failure.

**Required BTW fail-closed policy:**

- Omit `invalidRecords: 'backup-and-skip'` for authoritative Topics.
- While the single writer is stopped, preflight every per-record document for readability, JSON syntax, accepted envelope version, and Topic schema. Quarantine the store and refuse BTW reads/writes if any check fails; never interpret a damaged document as permission to create a fresh Topic.
- After any uncertain storage result, close the Domain, reopen it, and reconcile the requested `requestId`/revision from disk. Do not immediately retry a blind write. Remain degraded if the outcome cannot be established.
- On a new Host owner generation, revision-condition every persisted `running` Topic to `interrupted` (or an explicit, separately audited retry policy) before admitting new work. Recovery must go through the same single-writer queue.
- Surface an incomplete/degraded cold list rather than a successful but incomplete list. Backups are operator recovery artifacts, not automatic history truncation.

## 4. Cold `list`/`get` without Agent activation

Opening a Domain loads its snapshot into memory; table `entries()`/`get()` then need no Session or Agent service. The proof closed and reopened the JSON store, listed Session 1's Topic and read revision `3` with both `ctx.sessions` and `ctx.agents` absent.

The Remote DTO must carry `sessionId` as ordinary JSON data. Do **not** declare an `Agent` or `Session` lookup parameter for these methods: the standard Session Controller lookup reuses a live Agent or resumes a cold one ([Gateway lookup semantics][gateway-runtime]). A Typert resource reader is only an authorization identity reader and does not perform that lookup.

For non-owner calls, Gateway decides authorization before resolving lookups or entering business code, so denial also does not activate an Agent ([Gateway invocation order][gateway-runtime]). The proof's denied-call business counter stayed at zero.

## 5. Generated `@Remote` / Typert contract

Only methods marked `@Remote`/`@RemoteScope` are exposed. `TypertRemoteService` binds the Cordis service key and namespace. A final Host `signal: AbortSignal` becomes cancellation metadata and an optional Client argument, not a wire argument; `@Remote({ mode: 'stream' })` produces a `RemoteStreamHandle` ([Remote programming model][gateway-model]).

The verified minimal BTW shape is:

```ts
ask(request: BtwAskRequest, signal: AbortSignal): Promise<BtwReceipt>
list(request: BtwSessionSelector): Promise<readonly BtwTopic[]>
get(request: BtwTopicSelector): Promise<BtwTopic | null>
watch(request: BtwTopicSelector, signal: AbortSignal): AsyncIterable<BtwFrame>
cancel(request: BtwTopicSelector): Promise<BtwCancelResult>
```

`BtwSessionSelector` contains `sessionId`; `BtwTopicSelector` adds `topicId`; `BtwAskRequest` adds `requestId` and `question`. `BtwFrame` is a full-Topic `snapshot` or `delta`, each carrying its revision. The receipt carries `topicId`, `revision`, `status`, and whether an existing idempotent admission was returned. These are Host business signatures: generated unary Client calls use the `RemoteResult<T>` envelope, while `watch` returns `RemoteStreamHandle` ([Client contract][gateway-client-contract]).

The strict generator emitted all five required artifacts:

```text
typert.host.js                  typert.host.d.ts
typert.remote-client.js         typert.remote-client.d.ts
typert.remote-client.d.ts.map
```

Packages must export `./typert` and `./remote` and publish those files. SRC decorators are a Host-only development fallback; the Client requires generated strict codecs ([strict generation][gateway-generation], [SRC limitation][gateway-src]). The proof imported the generated Client contribution and verified strict result codecs for all five methods, unary `ask`/`list`/`get`/`cancel`, stream `watch` with `{ parameter: 'signal' }`, one `request` wire argument per method, malformed `get` result rejection, `RemoteStreamHandle` declarations, and a declaration map back to Host source.

## 6. Explicit Session authorization and per-peer isolation

Register the Session resource (`sessionId` is the Session Controller's released default field), but also declare an explicit reader on every BTW method so the contract cannot silently become global when signatures change ([Session resource registration][session-resource], [Gateway resource resolution][gateway-access]):

```ts
@Remote({ resources: { session: (request: BtwSessionSelector) => request.sessionId } })
```

Use a non-empty Session ID in the strict DTO. Explicit readers replace default readers for that resource kind; a call with no resources becomes `global`, so a missing identity must never be allowed to slip through ([resource resolution][gateway-access]).

`RemoteAccessService` evaluates the action `<namespace>/<method>` against **every** resolved resource. Owner is a bypass; non-owner policy absence or policy failure denies. A global grant does not imply a Session grant. Call `remoteAccess.invalidate()` after grants, revocations, mode changes, or expiry ([authorization decision][remote-access]).

For `list` and each emitted `watch` item, call `this.ctx.remoteAccess.allows({ kind: 'session', id })` inside the Remote invocation. It re-reads bindings and has no call arguments; argument-dependent conditions therefore cannot authorize list/snapshot filtering. Outside a Remote invocation `allows()` returns true, so it must not be used as a general-purpose authorization API ([filter semantics][remote-access]).

The public Gateway proof mounted real Peer, Typert Registry, Remote Access, and Gateway services with no Agent services. It verified:

- Peer A only reached Session 1 and Peer B only Session 2; cross-Session calls were denied.
- A global-only Peer was denied; owner bypass succeeded.
- Revocation followed by `invalidate()` denied the next call.
- Denied `get` and `watch` never entered the fixture business methods.

For immediate revocation of an already-open watch, dispose that Peer/watch as well as invalidating; invalidation alone is not a worker-cancellation mechanism. Subsequent `allows()` checks see changed bindings ([filter semantics][remote-access], [Peer disposal][peer]).

## 7. Disconnect versus admitted work and explicit cancellation

A physical stream-socket close stops active logical streams; a stream `cancel` frame stops only that stream. Gateway joins the stream signal to the Peer lifetime and, on abort, closes the iterator ([socket cancellation][stream-server], [Gateway stream teardown][gateway-stream]). The generated Client's `dispose()`/early iterator return sends stream cancellation and quietly ends Client iteration ([Client stream][client-stream]).

That cancellation belongs to the **watch reader**, not automatically to separately admitted BTW work. After durable admission, the worker must not adopt the `ask` or `watch` transport signal. It needs a Host-owned cancellation controller reached only by the explicit `cancel` Remote or Host shutdown. If the Client loses the `ask` response after admission, persisted `requestId` recovery returns the receipt.

The proof aborted a pending watch and observed `gateway/cancelled` plus the generator's `finally`, while the detached admitted operation subsequently completed. A separate explicit `cancel` call incremented the business cancellation counter once. Peer disposal ended another watch and rejected later calls as disposed. The proof used direct public Gateway abort/Peer disposal; physical socket-close behavior is source-verified above, not a network integration test.

## 8. Gap-free snapshot/delta handling

`domain/changed` and `RemoteSnapshotStream` are useful primitives, but neither supplies Topic revision gap detection. `RemoteSnapshotStream` requires exactly one opening snapshot per physical generation before deltas, atomically calls `replace(snapshot)` then `update(delta)`, and retains the old published snapshot across reconnect ([snapshot stream][snapshot-stream]).

BTW's Host watcher must:

1. synchronously subscribe before taking the opening `get`/`list`, buffering subsequent Domain events;
2. publish the snapshot, then drain buffered full-record deltas in per-Topic revision order;
3. ignore an already-applied duplicate, require the next new revision to be exactly `published + 1`, and on a gap/protocol error stop and obtain a fresh snapshot rather than skipping;
4. on every reconnect, subscribe and snapshot again before releasing new deltas; do not replay `domain/changed` as if it were a durable journal.

The proof subscribed before reading revision `1`, delivered live revisions `[2, 3]`, deliberately omitted revision `4` on the next generation, and recovered to revision `4` through a fresh generation-2 snapshot. `RemoteSnapshotStream` performed two snapshot replacements. `RemoteJournalStream` is not a substitute unless BTW adds a real durable cursor journal.

## 9. Unload and disposal

`Domain.close()` rejects new writes, drains the queued write chain and backend unit, and makes later reads throw. The proof's in-flight `close-drained` write survived close/reopen; later writes rejected and reads threw ([Domain close][domain-close]).

Unloading a generated Client contribution removes its descriptors/methods, aborts in-flight calls, and makes stale handles reject ([Client unload contract][gateway-runtime], [contribution disposal][client-unload]). This does not drain arbitrary Host model work. BTW must register its worker registry and Domain in Host effect lifetimes: stop admissions, explicitly cancel or drain owned workers, persist the resulting terminal/interrupted state, then close the Domain. Domain close alone only drains storage writes.

## 10. Commands and actual results

Environment/source identity:

```console
$ node --version
v26.7.0
$ node -p "require('/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/package.json').version"
0.2.1-rc.5
$ git -C /tmp/dsh-wayfinder-4-rc5 rev-parse HEAD
b830ec950faba0a46dda564be3e2d854afed94f1
$ git -C /tmp/dsh-wayfinder-4 rev-parse HEAD
fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159
```

The exact generator was installed only in a temporary directory; no repository dependency or production file was added:

```console
$ npm install --prefix /tmp/dsh-wayfinder-4-codegen --no-audit --no-fund @deepseek-ai/dsh-typert-generator@0.2.1-rc.5
added 9 packages in 4s
```

Final proof command:

```console
$ DSH_ROOT=/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh \
  DSH_SOURCE=/tmp/dsh-wayfinder-4-rc5 \
  CODEGEN_ROOT=/tmp/dsh-wayfinder-4-codegen \
  node research/storage-remote.proof.mjs
```

It exited `0` with `"ok": true`. Principal result fields were:

| Result | Observed value |
|---|---|
| Per-record files | `session-1_topic-1.json`, `session-2_topic-1.json` |
| Serialized update | seen `[1,2]`; final revision `3`; answer `ab`; unrelated file unchanged |
| Unsafe key | `session-1:topic-2` rejected; no in-memory record |
| Change observation | `put`, revision `3`; disk already revision `3` |
| Cold reopen | 2 entries; Session 1 list length 1; get revision `3`; no Agent/Session services |
| Revision precondition | stale expected `2`, actual `3`; rejected at queued slot |
| Pre-publication failure | memory and restored disk remained revision `3`, answer `ab` |
| Snapshot/delta | opening `1`, live `[2,3]`, two replacements, reconnect final `4` |
| Close | `close-drained` persisted; subsequent write rejected/read threw `closed` |
| Backup-and-skip probe | bad record loaded absent; `session-1_topic-1.json.bak.202611071743` created |
| Strict invalid schema | open rejected with `error.code === 'invalid-record'` |
| Malformed JSON | strict open succeeded with that record absent (requires the degraded policy above) |
| Authorization | global != Session; A/B isolation; owner bypass; denied business entries `0` |
| Disconnect | watch closed; admitted detached work completed; explicit cancel count `1` |
| Peer/revocation | Peer disposal rejected later calls; invalidation enforced revocation |
| Custom codegen | all five artifacts; strict unary/stream methods and cancellation; strict malformed-result rejection |

The proof uses temporary roots and cleans them. It does not simulate power loss, multi-process writers, an actual WebSocket disconnect, or implement the production BTW admission/recovery policy; those boundaries are stated rather than claimed as tested.

## Primary-source references

[domain-spec]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/storage/storage-domain/src/spec.ts#L34-L71
[domain-update]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/storage/storage-domain/src/domain.ts#L263-L345
[domain-close]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/storage/storage-domain/src/domain.ts#L148-L244
[domain-open]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/storage/storage-domain/src/index.ts#L84-L174
[json-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/storage/storage-json/README.md#L54-L88
[json-recovery]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/storage/storage-json/README.md#L138-L145
[json-key]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/storage/storage-json/src/per-record-unit.ts#L39-L40
[json-per-record]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/storage/storage-json/src/per-record-unit.ts#L217-L229
[json-read]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/storage/storage-json/src/per-record-unit.ts#L164-L187
[json-delete-backup]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/storage/storage-json/src/per-record-unit.ts#L217-L245
[json-atomic]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/storage/storage-json/src/atomic.ts#L24-L50
[gateway-model]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/docs/api-gateway.md#L7-L62
[gateway-client-contract]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/api/gateway/README.md#L56-L64
[gateway-generation]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/docs/api-gateway.md#L100-L122
[gateway-runtime]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/docs/api-gateway.md#L124-L134
[gateway-src]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/docs/api-gateway.md#L136-L142
[gateway-access]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/api/gateway/src/access.ts#L35-L80
[session-resource]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/api/session-controller/src/index.ts#L152-L168
[remote-access]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/api/remote-access/src/index.ts#L145-L243
[stream-server]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/api/gateway/src/stream-server.ts#L175-L204
[gateway-stream]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/api/gateway/src/index.ts#L1268-L1350
[client-stream]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/api/gateway/src/client/index.ts#L549-L628
[snapshot-stream]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/api/gateway/src/client/snapshot-stream.ts#L25-L93
[client-unload]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/api/gateway/src/client/index.ts#L254-L279
[peer]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/connection/src/peer.ts#L34-L51
[pin-domain]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/storage/storage-domain/src/domain.ts#L88-L98
[pin-json-delete]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/storage/storage-json/src/per-record-unit.ts#L217-L237
