# Troubleshooting

## Error codes

| Code | When | What to do |
|---|---|---|
| `btw/context-unavailable` | `ask` on a Session whose Agent is not live in this Host process (`src/service.ts:138-140`) | Open/resume the Session in the **same** Host first. `list`/`get`/`watch` still work cold; only `ask` needs the live Agent |
| `btw/busy` | A BTW turn is already active in this Session, or the selected topic has a `running` turn (`src/service.ts:184,200-202`) | Stop the running turn (panel **Stop** / `btw.cancel`) or wait for it to settle. Duplicate `requestId` is not "busy" — it returns the existing receipt |
| `btw/no-model` | No main request facts and `agent.options.provider/model` are unavailable (`src/service.ts:145-157`) | Ensure the Session has a resolved model route before asking |
| `btw/invalid-input` | Empty/oversized question (>8,000 chars), missing `sessionId`/`requestId`, unknown `topicId`, or a cancelled pre-admission ask | Fix the request; start a new topic if the old one is gone |
| `btw/revision-conflict` | `expectedRevision` does not match the stored topic revision | Re-read the topic and retry with the current revision |
| `btw/storage-admission-failed` | The `running` turn could not be persisted before dispatch (`src/service.ts:277-284`) | Check the BTW storage directory and Host logs (permissions, disk); do not assume the turn exists — read it back via `btw.get` before retrying |
| `btw/storage-terminal-unknown` | Declared for clients; the practical surface is a `settled` frame with error text `storage-terminal-unknown: ...` when finalization fails (`src/service.ts:367-374`) | The turn's terminal state is uncertain. Re-read `btw.get`; restart the Host if the Domain is unhealthy |

`btw/internal` means the storage Domain failed to initialize or closed
(`src/service.ts:117-123`); check startup logs for the domain open error.

## Panel is empty

- No topic exists yet for this Session: ask a question. Empty is not an error.
- The panel watches the Session that opened it. If you switched Sessions, bare
  `/btw` again to open the tab for the new Session.
- After a refresh, the panel re-subscribes and receives a fresh `snapshot`; history
  should reappear immediately. If it does not, check the Host is the one holding the
  data (`$DSH_HOME` must match) and see storage below.

## "late-mount" or missing context

`late-mount` means the plugin mounted after the main request was dispatched, so the
route was copied from `agent.options`; `missing-main-request` /
`missing-attempt-prefix` mean in-flight facts were not observed. Answers still work
but may miss in-flight partial text. The marker clears on a later turn observed from
its start. `context-truncated` means the quoted main transcript exceeded 48,000
characters (the newest tail is kept).

## Rebuild the client bundle

The Web client loads `packages/dsh-btw/lib/client.js`; source changes are not picked
up live.

```sh
npm run build -w @deepseek-ai/dsh-btw   # or: npm run build (root)
# then restart the profile process, then refresh the page
```

If the page shows an old bundle after a restart, hard-refresh the browser. The
`window.__ModuleLoader__` wrapper is applied by `scripts/wrap-client.mjs`; a raw
`var module = ...` header means the wrap step did not run — rebuild.

## Where data lives

Verified on disk at
`.tmp/dsh-home/storages/btw_topics/topics/` (with `DSH_HOME=$PWD/.tmp/dsh-home`):

```text
<DSH_HOME>/storages/btw_topics/topics/<key>.json
```

- `<key>` is base64url of `"<sessionId>\u0000<topicId>"` (`src/repository.ts:21-23`),
  e.g. a filename beginning `c2Vzc2lvbi0...` decodes to `session-...`.
- Each file is the storage envelope `{ "version": 1, "record": { ...BtwTopic } }`.
- `BtwTopic` is one JSON record per topic (`layout: 'per-record'`,
  `src/repository.ts:9-16`) containing `sessionId`, `topicId`, `title`, `revision`,
  timestamps, and the `turns[]` array with `contextCut` and status.

I verified this shape by reading an existing record: the envelope has `version: 1`
and `record.sessionId` / `record.topicId` matching the decoded filename, with turns
carrying `status` and `contextCut.degraded`.

Manual repair notes:

- Records are the only durable BTW state; there is no separate index. The file *is*
  the topic: after a Host restart, a deleted file means that topic is gone.
- Do not hand-edit while the Host is running: the JSON backend has no cross-process
  lock and the in-memory snapshot wins on the next write.
- `running` records from a dead Host are repaired to `interrupted` on the next
  startup; if a record is corrupt, omit it rather than inventing a replacement and
  check the Host log for the storage error.

## Sessions and privacy

BTW reads require the Session resource grant. If another user/peer cannot see a
Session, they also cannot read its BTW topics even when the panel renders. Owner
access bypasses the check, as in the rest of the Gateway.
