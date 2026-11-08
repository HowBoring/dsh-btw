# BTW — side questions for a running Session

BTW is an ephemeral, read-only side conversation attached to one DeepSeek Harness
Session. It answers questions about what the main Agent is doing **without touching
the main conversation**: no user message, no assistant message, no tool call, and no
BTW text ever enters the main model-visible history.

- **Bare `/btw`** opens the Session-scoped BTW tab in the right sidebar; it shows the
  topic history for the current Session.
- **`/btw <question>`** is claimed by the Web client input pipeline before the
  default composer sink. It is *not* sent as a main prompt, not queued, and not
  steered into the running Agent.
- **Follow-up** (the panel input) appends to the selected topic. The request carries
  only that topic's prior Q/A plus a **fresh** capture of the main Session at
  admission time. Other topics are excluded. A new `/btw <question>` from the
  composer always starts a new topic.
- **Streaming / Stop / Copy**: answers stream into the panel; Stop cancels only the
  BTW turn and keeps the partial answer; Copy copies the persisted answer text.
- **History** survives page refresh and Session switching because it is durable
  Host-side storage, re-read on every panel mount.
- **One active BTW turn per Session.** A second `ask` while one is running is refused
  with `btw/busy` (duplicate `requestId` returns the existing receipt instead).

## Quick start

```sh
# 1. Build the plugin (host + browser bundle)
npm run build

# 2. Add the bundle to a profile (see install.md), then restart that profile
DSH_HOME=$PWD/.tmp/dsh-home dsh --profile btwtest --port 3091 --no-open

# 3. In the Web UI, for the Session you are watching:
#    /btw                      -> open the BTW tab
#    /btw what is it doing?    -> ask immediately, even mid-stream
```

The tab is keyed to the Session it was opened for. Switching Sessions switches the
panel's subscription; a late answer for Session A cannot render under Session B.

## What the panel shows

| Control | Behavior |
|---|---|
| Topic list | Most recently updated first; click to select |
| Question / answer | Chronological turns for the selected topic, status label, degraded-context note |
| **Stop** | Calls `btw.cancel` for the running turn; partial text is retained and the turn settles `cancelled` |
| **Copy** | Copies the durable answer of a completed/partial turn (live deltas before settlement are not copied) |
| **Follow up** | Sends into the selected topic; recaptures main context |
| **New topic** | Clears the selection so the next ask creates a separate topic |

Statuses are `running`, `complete`, `cancelled`, `error`, `interrupted`. `interrupted`
also covers a Host restart while a turn was running: the record is repaired on the
next startup and is never replayed automatically.

## What BTW is not

- Not a main-Agent input: no `agent.inject`, `agent.steer`, `agent.followup`,
  branch/fork, or subagent.
- Not a tool surface: the side request declares no tools and executes nothing.
- Not part of the Session transcript: BTW records live in a feature storage domain
  (`btw_topics`), not in `session/event`, so they are absent from `deriveMessages()`,
  transcript export, and the next main model request.
- Not a CLI/TUI command: no no-log Host command is registered (see `compatibility.md`).
- Not multi-writer: one Host process may write the BTW domain (see `compatibility.md`).

## Scope and privacy

Every Remote method declares the Session resource, so reading BTW history requires
the same Session access as reading the Session itself. BTW answers may quote main
Session content (including tool output and paths); treat them with the same
sensitivity. They are stored per Session and per topic, not exported with the main
transcript.

## Further reading

- `install.md` — package exports, bundle/profile wiring, build commands.
- `compatibility.md` — exact supported runtime and known limits.
- `provider-policy.md` — normative rules for the side LLM call.
- `verification.md` — what was actually run and observed.
- `troubleshooting.md` — error codes and storage layout.
