# 03 · Architecture and Component Responsibilities

## Architecture thesis

Provide two independent planes in one feature:

1. **Observation plane**: fold committed main Session state and maintain bounded process-local `LiveAttemptMirror`, build an immutable valid context snapshot at host admission.
2. **Side conversation plane**: durably admit BTW Topic/Turn, call LLM separately, stream to Web/CLI, persist terminal state, allow Follow and Session history. This must never enter primary Agent Inbox.

Suggested logical split (actual package paths decided after inspecting local repo conventions):

```text
packages/<feature>/dsh-btw/               Host business feature
  src/{index,service,context-capture,normalizer,runner,history,contracts,types}.ts
  tests/{capture,normalization,service,storage,remote,concurrency}.spec.ts
packages/client/ui-btw/                  Client/browser feature
  src/client/{index,view,controller,composer,history}.tsx
  tests/{navigation,follow,cancel,stream}.client.spec.tsx
```

Do not mechanically create these paths without inspecting local package catalog and build conventions. For third-party implementation, choose publishable Host/Client entrypoints consistent with the target DSH build.

## Component contract

| Component | Owns | Does NOT own |
|---|---|---|
| `LiveContextMirror` | Synchronous metadata mirror and current LLM Attempt fragments keyed by real Session ID | Durable main Session history, provider execution |
| `BtwSnapshotBuilder` | Synchronous observation cut and detached copies; seq/attempt/chunk watermarks | Async storage or network calls before capture |
| `SideContextNormalizer` | Provider-valid history, partial text and open tools explanation; truncation policy | Writing to main Session or synthetic successful Tool Results |
| `BtwTopicRepository` | Topic/Turn storage and versions via `storage-domain` | Agent Loop log or provider request |
| `BtwCoordinator` | Admission, idempotency, one active BTW per Session, cancellation, epochs, lifecycle | Main Agent `runMaintenance`, `followup`, tools |
| `EphemeralBtwRunner` | Independent `ctx.llm.prepareCall` + streaming and no-tool finalizer | `ctx.tools.execute` or main Agent status |
| `BtwRemote` | List/get/ask/watch/cancel, Session authorization and serialization | Business rules or ad-hoc login policy |
| `BtwWebController` | Session-local panel, open selected topic, draft, UI subscription and copy | Host data authority |
| `BtwInputRoute` | `/btw` bare history, `/btw question` side submission; must avoid main send | Host history persistence |

## Service interaction

```text
    User gesture /btw Q   Browser BTW Panel
             |                  |
             +------ BTW Remote ask ------+
                                         |
         BtwCoordinator (host authorization + singleflight)
                                         |
            +------- [sync capture snapshot] <--- Session Event Log
            |                            \<--- LiveAttemptMirror
            |                                         ^
            |                         llm/stream & agent/assistant-stream
            |
            +------- [durable admit running topic/turn] --> Storage Domain
            |
            +------- [detached EphemeralBtwRunner] --> ctx.llm.prepareCall --> side provider
                                                          |
                             Stream hub <--------- text delta/settlement
                                |                          |
                        Web BTW panel              Storage Domain terminal
```

## Main vs Side identity

- **MainSessionId**: scope of user authorization, committed events, current model and tool state. Never cross-rewrite.
- **TopicId**: stable logical BTW conversation identity and history key scoped by MainSessionId.
- **TurnId**: one BTW Q/A within Topic.
- **RequestId**: client idempotency key (scope to Session); same key cannot cause two calls.
- **ExecutionEpoch**: process-local current invocation discriminator. Late frames from cancelled/superseded execution must be ignored.
- **ContextCut**: immutable observation coordinates (Session seq + live Attempt identity/revision/index), not a durable main turn fork.
- **Provider side lineage**: separate from main conversation; may be stable per Topic across successful serialized follow-ups if adapter supports. Never share active provider conversation state unsafely with the main Agent.

## Concurrency and checkpoints

Admission path must capture Host snapshot **before first awaited operation**, check permission and active gate, then persist starting Turn, then dispatch LLM. Lock the admission by Session synchronously before first await. If storage fails, mark admission failed and do **not** request LLM. If user cancels while startup commit is pending, terminalize as `cancelled` and never dispatch. A failed or aborted request leaves its own Topic history and releases active gate only after it is no longer eligible to issue extra deltas/commit.

Remote `ask` acknowledgement means `running` is durably accepted; it is not model completion. Streaming monitor gets baseline and revisioned delta feed. Terminal persistent checkpoint precedes authoritative `settled` event. Client reconnection obtains current view + updates from an ordered bridge; do not lose deltas across baseline-to-subscription race.

## Architecture boundaries

- This feature must not enable general model execution capabilities to subagents, unsafe Tools, or model-written commands.
- Do not use main Session `command/run` logs as BTW history database. Host `/btw` command is acceptable only as interim CLI proof and must be documented as log-only leakage.
- `session/list`/`btw.list` read path must not resume Agent. `ask` on inactive/cold Session may be unsupported V1 with explicit error; do not silently wake and run main.
- Runers/observers must cleanly dispose on plugin unload and not keep stale live data of replaced Session instances.

## Failures and observable states

1. `invalid-input` / `unauthorized` / `busy` / `no-model` / `context-unavailable` / `context-too-large`: fail before durable turn creation where possible.
2. `storage-admission-failed`: fail closed, no LLM call.
3. `provider-error` / `provider-timeout`: mark BTW `error`, no main Agent failure.
4. `cancelled`: terminate side attempt only, retain partial text.
5. `host-crash` / recovery: mark orphan `running` as `interrupted` without reattempting.
6. `storage-terminal-unknown`: reconcile from backend before another follow-up; never pretend completed.
7. `session-disposed` or `model-switched`: snapshot already admitted remains logically scoped to original Session; no leak into a newer selected Session, optionally abort based on explicit policy.

## Related diagrams

- `diagrams/01_components.puml`
- `diagrams/02_new_btw_sequence.puml`
- `diagrams/03_followup_sequence.puml`
- `diagrams/04_topic_state_machine.puml`
- `diagrams/05_domain_classes.puml`
