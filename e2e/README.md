# Live e2e harness

Not part of `npm test`. This harness runs inside a real DSH Host on a test
profile and needs a provider credential with network access. It exercises the
same path a user takes: a main Agent starts a ReAct turn, a BTW question is
admitted mid-stream, the answer is followed up after the main turn advances,
and the main transcript is checked for leakage.

`btw-probe.mjs` is a Cordis plugin:

- imports `btw`, `agents`, and `llm`;
- logs every `llm/stream` call so the run proves main vs side request shape;
- creates an Agent on `kimi-coding/k3.1-pro`, sends a prompt, waits for text;
- calls `btw.watch` + `btw.ask`, waits for the turn to settle, then follows up
  with `expectedRevision`;
- re-sends the same `requestId` to assert idempotency;
- asserts the main `deriveMessages()` never contains the side answer.

## Setup

```sh
npm run build
```

Create a throwaway profile (see `docs/dsh-btw/install.md` for the bundle
wiring), then insert the probe into the profile patch:

```yaml
- id: btw-probe
  kind: plugin
  module: file:///absolute/path/to/e2e/btw-probe.mjs
```

Run it with the installed Host:

```sh
export DSH_HOME=$PWD/.tmp/e2e-home
export DSH_LLM_ENTRY="file://$HOME/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js"
dsh --profile <profile> --port 3091 --no-open
```

`DSH_LLM_ENTRY` only supplies `createUserMessage`; point it at the `dsh-llm`
entry of your installed DSH.

## Expected observations

The probe prints lines prefixed `PROBE`. A passing run contains:

```text
PROBE mainStatus running {"provider":"kimi-coding","model":"k3.1-pro"}
PROBE-LLM {"provider":"kimi-coding","model":"k3.1-pro","sessionId":"…","tools":16}
PROBE mainStreamStarted true
PROBE-LLM {"provider":"kimi-coding","model":"k3.1-pro"}
PROBE turn1 {"status":"complete","degraded":[],"eventSeq":…}
PROBE frames1 ["snapshot","topic","delta",…,"settled"]
PROBE mainMessages1 {"before":…,"afterFirst":…,"leaked":false}
PROBE turn2 {"status":"complete","turns":2,"revision":…}
PROBE duplicate {…} sameTurn true
PROBE finalLeak false
```

The second `PROBE-LLM` line is the side call: no `sessionId`, no `purpose`, no
`tools`. The two cuts have different `eventSeq` values.
