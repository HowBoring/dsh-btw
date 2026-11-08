# Verification evidence

This page separates what was **run and observed** from what is only implemented or
reasoned about. Commands that predate this documentation are labelled "verified by
Lead run"; no command below was re-run while writing these docs (the task forbade
builds/network).

## Static checks

| Command | Result | Evidence |
|---|---|---|
| `npm run build` | pass | `packages/dsh-btw/lib/` contains `index.js`, `index.d.ts`, `types.js`, `types.d.ts`, `client.js`; `lib/client.js` begins with `window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-btw", ... })` |
| `npm run typecheck` | pass (host + client) | `tsc -p tsconfig.host.json --noEmit && tsc -p tsconfig.client.json --noEmit` (`packages/dsh-btw/package.json`) |
| `npm test` | pass — `tests 28, pass 28, fail 0` (~196 ms) | `node --test packages/dsh-btw/test/*.test.mjs`; files: `live`, `normalize`, `runner`, `repository`, `hub`, `service` |

The suite is deterministic and offline. It covers live-prefix capture and attempt
invalidation, provider-safe normalization (no fabricated tool result, matched
batches only, truncation keeps newest), a synthetic `btw-<turnId>` identity and no
`purpose`/`tools` on side calls, independent-side abort, retry policy, repository
keys/CAS/schema, hub
fan-out through `watch`, and service admission/follow/duplicate-`requestId`/
cancel-before-dispatch/recovery/put-failure paths. `BtwHub` is not part of the
package export surface, so its behavior is exercised through `BtwService.watch`.

## Manual end-to-end scenario (live credentials)

Not part of `npm test`. It needs a working provider credential (`KIMI_CODING_API_KEY`
in the test profile) and network access.

Profile: `.tmp/dsh-home/profiles/btwtest`. Start command:

```sh
DSH_HOME=$PWD/.tmp/dsh-home dsh --profile btwtest --port 3091 --no-open
```

Observed startup line:

```text
dsh web: http://127.0.0.1:3091/?token=<redacted>
```

The profile's `cordis.patch.yml` inserts the probe `.tmp/btw-probe.mjs` as
`btw-probe`. The probe creates a real Agent on `kimi-coding/k3.1-pro`, submits a
200-word essay prompt, waits for main streaming to start, then calls
`btw.watch` + `btw.ask`, follows up, and checks the main transcript.

Observed log lines (`.tmp/btwtest12.log`):

```text
PROBE mainStatus running {"provider":"kimi-coding","model":"k3.1-pro"}
PROBE-LLM {"provider":"kimi-coding","model":"k3.1-pro","sessionId":"session-022dac7d-b4a6-4730-a95f-b750bbd3222d","tools":10}
PROBE mainStreamStarted true
PROBE textChunksBeforeAsk 67 true
PROBE receipt {"topicId":"177f2c5f-08e2-4c07-a1a0-aeedb90fc92f","turnId":"880a873f-2061-4771-b414-211c82d41a01","status":"running","revision":1} ms 12
PROBE-LLM {"provider":"kimi-coding","model":"k3.1-pro"}
PROBE turn1 {"status":"complete","answer":"BTW-SIDE-OK","degraded":[],"eventSeq":15,"chunkIndex":0}
PROBE frames1 ["snapshot","topic","delta","delta","delta","delta","delta","delta","topic","settled"]
PROBE mainMessages1 {"before":3,"afterFirst":4,"leaked":false}
PROBE mainAdvance {"afterAdvance":4,"status":"idle"}
PROBE followReceipt {"topicId":"177f2c5f-08e2-4c07-a1a0-aeedb90fc92f","turnId":"65738853-dc3c-4ede-bdf0-69442b8a7043","status":"running","revision":3}
PROBE-LLM {"provider":"kimi-coding","model":"k3.1-pro"}
PROBE turn2 {"status":"complete","answer":"The essay had 200 words.","degraded":[],"eventSeq":18,"turns":2,"revision":4}
PROBE frames2 ["snapshot","topic","delta","delta","delta","delta","delta","delta","delta","topic","settled"]
PROBE duplicate {"topicId":"177f2c5f-08e2-4c07-a1a0-aeedb90fc92f","turnId":"65738853-dc3c-4ede-bdf0-69442b8a7043","status":"complete","revision":4} sameTurn true
PROBE finalLeak false
```

What these lines establish:

| Claim | Evidence |
|---|---|
| BTW works while the main Agent is `running` | `PROBE mainStatus running`, `mainStreamStarted true` before `ask` |
| Main request is a real Agent call with tools | main `PROBE-LLM` has `sessionId` and `"tools":10` |
| Side request carries no identity/purpose/tools | side `PROBE-LLM` is only `{"provider":"kimi-coding","model":"k3.1-pro"}` |
| Admission is fast and detached | receipt returned in `ms 12` with `status:"running"` |
| Answer streams and settles | `delta` frames, then `topic`, then `settled` |
| Fresh context at each turn | turn 1 `eventSeq:15`, turn 2 `eventSeq:18` (different cuts) |
| Follow-up reuses the topic | same `topicId`, `turns:2`, `revision:4` |
| Duplicate `requestId` is idempotent | same `turnId`, `sameTurn true` |
| BTW never enters main history | `leaked:false`, `finalLeak false`; main message count only grew by the main turn |

The receipt/revision numbers are durable-record facts, not timing guarantees.

## Offline / source proofs (referenced, not re-run here)

- Live context capture on rc.5: `../dsh-btw-research/live-context/` — public
  `llm/stream`, `session/event`, `agent/assistant-stream` observation and degraded
  late-mount behavior.
- Storage Domain, typed Remotes, authorization, cold reads:
  `../dsh-btw-research/storage-remote/` — per-record files, in-process revision
  updates, cold `list`/`get`, watch/disconnect semantics.
- Web input and panel seams: `../dsh-btw-research/web-input/` — argued `/btw` claim
  bypassing the default sink, sidebar tab registration, no CLI no-log route.
- Side-LLM protocol: `.tmp/side-llm-deliverables/docs/research/side-llm-provider-normalization.md`
  — 28-check offline wire proof for prepare/stream, abort isolation, one-shot calls,
  no inherited retry, and normalization. (Live testing later proved that a synthetic
  per-turn `sessionId` is required by opencode-go; see below.)

## Live-profile regression: opencode-go requires a session header

After installing into the live `web` profile, the first real asks failed with
`side provider returned an error`. Widening the stored error to include
`LlmFailure` produced the provider answer:

```text
side provider returned an error: INVALID_REQUEST (HTTP 400):
{"type":"MissingSessionID","message":"Request is missing x-opencode-session ..."}
```

The `opencode-go` / `deepseek-v4.1-flash` route (the live profile default) maps
`GenerateOptions.sessionId` to `x-opencode-session`; omitting it is a 400. The fix
is a per-turn synthetic identity, `btw-<turnId>`: it satisfies the header without
ever naming the main Session, and both `dsh-session-checkpoint-policy` and
`dsh-session-log-deepseek` no-op because `ctx.sessions.get(id)` returns undefined.
Re-running the late-mount probe on `opencode-go/deepseek-v4.1-flash` then returned
`LATE-SIDE-OK` with `missing-main-request, late-mount`. Regression tests now assert
the synthetic identity and that it differs from the main Session id.

## Real-browser end-to-end (2026-11-08)

Run through headless Chrome against `http://127.0.0.1:3092` with the `btwtest`
profile and live `kimi-coding/k3.1-pro`. This verified the actual Client bundle,
Slots, input-trigger claim, Remote transport, streaming, cancel and history.

| Scenario | Observed |
|---|---|
| Client plugin loads | no `importErrors`; boot banner absent; `sidebar.right.pane.tab` renders |
| Bare `/btw` in the composer | opens the BTW tab; composer clears; panel shows `BTW side questions`; no main prompt was created |
| `/btw <question>` during a main stream | composer cleared, panel opened, `answering…` then `complete`; answer reasoned over the captured main context |
| Follow-up from the panel | second turn replayed the selected topic and answered from the **newer** main paragraph (`eventSeq` advanced 18 → 22 in the persisted cut) |
| History after page reload | both topics restored newest-first; selected topic's turns rendered |
| Session switch | new Session showed `No side conversation yet`; the prior Session's topics were absent; cold-live ask degraded to `missing-main-request, late-mount` and answered from an empty snapshot |
| Stop | a 300-word side request settled `cancelled` with no partial answer and no main interruption |
| Host restart / cold read | after restarting the server (all Agents gone) the panel listed and rendered a persisted topic with no main prompt sent in that Session |
| Leakage | no BTW question text in any `.tmp/dsh-home/storages/session_projcache/sessions/*.json`; main transcript unchanged |

Two Client defects were found and fixed by this run:

1. `lib/client.js` required `@deepseek-ai/dsh-typert-protocol`, which is not in the
   browser module table. The contribution now imports the self-contained
   `@deepseek-ai/dsh-typert-protocol/remote-info` entry, which the client bundle
   inlines (the same shape official generated client bundles use).
2. The `/btw <question>` claim handler read `ctx.remote.btw` outside the inject
   scope and threw `cannot get property "remote.btw" without inject`. It now uses
   the injected `btw` captured inside `ctx.inject(['remote.btw'], ...)`.

## What is not yet verified

- **Two-tab (multi-client) streaming.** One browser client was exercised; the Host
  hub supports multiple subscribers, but a second tab watching the same Session was
  not run.
- **Provider matrix breadth.** End-to-end used only `kimi-coding/k3.1-pro` (pi-ai).
  DeepSeek and other providers are source-verified only; no live request was made.
- **Host restart recovery.** Startup repairs persisted `running` turns to
  `interrupted`; the service test covers it with a seeded record, not a real crash.
- **Copy button.** Clipboard write needs a user gesture/permission; not exercised in
  headless mode.
- **Multi-Host writers.** Explicitly unsupported; not tested (and must not be used).
