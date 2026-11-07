# Validate pinned OMP Topic and lifecycle semantics

Research ticket: HowBoring/dsh-btw#6  
Pinned evidence: `can1357/oh-my-pi@f2b795ba747b23d42052184d822b41e3d01357cc`  
Method: static inspection of the pinned implementation, official documentation, and behavioral tests. The OMP suite was not executed. OMP supplies behavioral evidence, not DSH APIs.

## Resolution

The supplied DSH context package is substantially consistent with OMP. Three differences must remain explicit:

1. **DSH's admission snapshot is earlier and stronger.** OMP builds the main-context message snapshot after asynchronous preparation and the initial persistence step; DSH requires an immutable Host-admission cut before the first `await`.
2. **OMP recovery starts as a read-time projection.** Opening a store presents persisted `running` records as `interrupted` without rewriting their bytes. A lease and raw-byte revision prevent a recovered view from stealing a live writer.
3. **DSH's terminal ordering is stronger.** OMP RPC can emit a terminal record before the terminal checkpoint is durable; DSH must persist terminal state before publishing authoritative settled state.

OMP's file locks, leases, RPC envelopes, provider cache keys, and TUI keybindings are implementation choices, not interfaces to copy into DSH.

## Behavioral checklist

- [x] **Follow context is selected-Topic Q/A plus fresh main context — adopt.** OMP prepends the current main context, including visible in-progress main output, then replays only the selected Topic chronologically: every prior question is a separate user message and every nonempty answer is a separate assistant message, followed by the new question. Empty answers have no assistant message; cancelled/error partial answers are retained. Unrelated Topics are excluded and the main journal/context/leaf remains unchanged. ([btw-turn.ts:60-119][turn-run]; [btw-follow-up.test.ts:685-799][follow-selection])

- [x] **The main snapshot is fresh per Follow, but not an admission-time snapshot — strengthen for DSH.** OMP captures the model identity/session generation, asynchronously prepares images and side history, and only then clones `this.messages` and the current visible streaming message into the side request. The initial BTW checkpoint has already run before this call. DSH must instead capture the exact main-context cut synchronously at Host admission, before history I/O, model resolution, or any other `await`, and run all later work from that immutable snapshot. ([agent-session.ts:13169-13225][agent-admission]; [agent-session.ts:13380-13453][agent-build]; [btw-controller.ts:638-648][controller-dispatch])

- [x] **Execution is independent and side-only — adopt behavior, not runtime API.** OMP uses a distinct provider session, an independent combined abort signal, and a stable per-Topic conversation lineage after successful turns; a non-complete turn advances the lineage for the next Follow. It neither executes nor persists side tool calls and removes tool-call blocks from returned text. Sharing a prompt-cache key is only an optimization. DSH should preserve isolation, no-tools execution, explicit BTW cancellation, and stale-lineage fencing without treating provider identifiers as DSH state or cancelling the main Agent. ([btw-turn.ts:21-44][turn-begin]; [agent-session.ts:13169-13356][agent-admission]; [btw-follow-up.test.ts:685-762][follow-selection])

- [x] **Only one BTW may be starting/running; there is no queue or implicit preemption — adopt per DSH Session.** OMP rejects overlapping new/follow requests while allowing BTW concurrently with main streaming. After cancellation, a new Follow may start while the old transport unwinds, but status/epoch checks suppress all stale deltas/results and the new Follow uses a fresh lineage. DSH must retain its Session-wide active gate and requestId idempotency; logical cancellation may release the slot only when late output can no longer mutate state or commit. ([btw-controller.ts:552-591][controller-start]; [rpc-btw.ts:68-122][rpc-start]; [btw-follow-up.test.ts:801-907][follow-overlap]; [rpc-btw.test.ts:144-200][rpc-behavior])

- [x] **Admission persists `running` before model dispatch — adopt.** OMP creates the Topic/Turn, durably checkpoints the running record, and only then schedules the side LLM. Cancellation while waiting for earlier flush/admission work saves no not-yet-created Turn; cancellation after the running checkpoint records `cancelled` and prevents dispatch. DSH should define the same pre-/post-admission race explicitly, with `requestId` and cancel-before-start covering an early retry/cancel race. ([btw-controller.ts:638-680][controller-dispatch]; [rpc-btw.ts:68-105][rpc-start]; [btw-follow-up.test.ts:485-566][follow-start-race])

- [x] **Streaming is in-memory until a lifecycle checkpoint; explicit cancellation retains partial output — adopt with DSH disconnect rules.** Deltas update the live answer, while running checkpoints are lifecycle boundaries rather than per-token writes. Cancel marks the Turn `cancelled`, aborts only the side call, persists the partial answer, and ignores late output; errors likewise retain streamed text without persisting opaque provider payloads. A crash can lose uncheckpointed deltas. OMP RPC treats client EOF as cancellation, but DSH explicitly must not cancel on browser disconnect, panel close, or history close; explicit Session close still cancels and drains. ([btw-controller.ts:415-424][controller-cancel]; [btw-controller.ts:815-875][controller-finish]; [btw-follow-up.test.ts:764-852][follow-partial]; [rpc-btw.test.ts:255-315][rpc-eof])

- [x] **OMP publishes some terminal outcomes before durability — do not port this ordering.** RPC `#finish` clears its running slot and emits terminal `btw_record` before the upsert; a later checkpoint failure is only a notice/error after the terminal response. The TUI also updates visible terminal state before initiating its checkpoint. DSH must make the terminal checkpoint succeed before authoritative settled state/events and must not report success when persistence failed. Session/navigation transitions remain blocked or fail rather than silently abandoning unsaved BTW state. ([rpc-btw.ts:239-257][rpc-finish]; [rpc-btw.test.ts:202-253][rpc-persistence-failure]; [btw-controller.ts:815-875][controller-finish])

- [x] **Revision and lease checks protect admission and writes — adopt the intent only.** OMP snapshots a record before queued writes, takes a per-Topic OS file lock, compares the raw SHA-256 revision under that lock, atomically replaces the file, and publishes memory only after success. A lease is retained while the latest Turn is running and released at terminal state. Stale/deleted/colliding records conflict; write failures are sticky until explicit retry against the original revision, never silently rebased. DSH V1 should use Domain `expectedRevision`, the Session active gate, and requestId dedupe before the LLM, with its single-Host-writer invariant stated explicitly. An in-process Domain update is not cross-process mutual exclusion; multi-writer fencing is future work. ([btw-history.ts:182-240][history-write]; [btw-history.test.ts:36-183][history-conflicts]; [btw-history.test.ts:311-538][history-failures])

- [x] **Recovery never auto-resubmits work — adopt, preserving the projection nuance.** OMP opens stored `running` records as `interrupted` in the read view while leaving raw bytes and their revision unchanged. A still-held lease blocks another opener from stealing the Topic; after a real crash, a Follow can use the original raw revision once the lock is gone. Main-session delete/resume/extension paths cancel and drain BTW writes, and late old answers cannot resurrect old history. DSH should mark only ownerless running work interrupted, never replay it, and may durably repair it during single-writer startup; cold recovery must not mistake a live writer for an orphan. ([btw-history.ts:139-167][history-open]; [btw-history.test.ts:223-295][history-recovery]; [btw-session-lifecycle.test.ts:196-340][session-lifecycle])

- [x] **History is a private, Session-scoped read/follow surface — adopt behavior, redesign the UI natively.** OMP lists newest first and initially selects the newest; it shows the original question, chronological turns, `running`/`complete`/`cancelled`/`error`/`interrupted` statuses, partial answers, and error/interrupted notes. Follow targets the selected eligible Topic; repeated Enter submits once and a rejected draft remains. Copy uses the latest nonempty answer. Sidecars stay out of the main journal and ordinary export; OMP's no-session mode uses separate in-memory history. DSH should provide equivalent Web history/detail/copy/follow behavior and status vocabulary, but use typed authorized Remote cold reads, avoid waking/queuing an Agent for list/get, and treat panel close as non-cancelling; OMP keybindings and storage layout are not requirements. ([btw-history.ts:251-256][history-order]; [btw-history-panel.ts:260-265][panel-default]; [btw-history-panel.ts:410-459][panel-submit]; [btw-history-panel.ts:761-857][panel-render]; [btw-history-panel.ts:899-925][panel-copy]; [slash-command-internals.md:442-460][sidecar-privacy])

- [x] **Inject and branch are separate operations, not Follow features — keep out of DSH V1.** OMP Follow never modifies the main transcript. Inject explicitly adds a user/main-context message under separate idle/steering rules; branch promotion is a separate, narrowly eligible completed-single-Turn operation requiring an unchanged Session/leaf and idle main run. Neither should be implied by asking, following, cancelling, or opening history in DSH. ([slash-command-internals.md:355-381][inject-docs]; [slash-command-internals.md:464-469][branch-docs]; [btw-controller.ts:152-170][branch-controller])

## Minimum DSH regression probes

1. Advance main context between turns; verify `Main(context-n) + selected Q/A + new Q`, separate roles, cancelled-partial replay, no unrelated Topic, and no main journal/context/leaf mutation.
2. Race new/follow/cancel against starting, running, and terminal persistence; verify one admission, durable-running-before-LLM, no dispatch after startup cancel, requestId dedupe, and stale-output fencing.
3. Stream then cancel/error/disconnect; verify independent side cancellation, retained partial text, no tool execution, and DSH browser/panel disconnect continuing the run.
4. Inject stale revisions and write failures; verify no LLM on failed/stale admission, no silent rebase, and no authoritative settled state before terminal durability.
5. Reopen persisted running state with absent versus live ownership; verify interrupted recovery without automatic replay or theft, then a successful recovered Follow.
6. Cold-read history newest-first without waking an Agent; verify selected-Topic Follow, chronological detail/status/partials, latest-nonempty copy, retained rejected draft, and no inject/branch side effect.

[turn-run]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/session/btw-turn.ts#L60-L119
[turn-begin]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/session/btw-turn.ts#L21-L44
[agent-admission]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/session/agent-session.ts#L13169-L13225
[agent-build]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/session/agent-session.ts#L13380-L13453
[controller-start]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/modes/controllers/btw-controller.ts#L552-L591
[controller-dispatch]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/modes/controllers/btw-controller.ts#L638-L680
[controller-cancel]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/modes/controllers/btw-controller.ts#L415-L424
[controller-finish]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/modes/controllers/btw-controller.ts#L815-L875
[branch-controller]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/modes/controllers/btw-controller.ts#L152-L170
[history-open]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/session/btw-history.ts#L139-L167
[history-write]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/session/btw-history.ts#L182-L240
[history-order]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/session/btw-history.ts#L251-L256
[rpc-start]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/modes/rpc/rpc-btw.ts#L68-L122
[rpc-finish]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/src/modes/rpc/rpc-btw.ts#L239-L257
[follow-selection]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/test/btw-follow-up.test.ts#L685-L799
[follow-overlap]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/test/btw-follow-up.test.ts#L801-L907
[follow-start-race]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/test/btw-follow-up.test.ts#L485-L566
[follow-partial]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/test/btw-follow-up.test.ts#L764-L852
[history-conflicts]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/test/btw-history.test.ts#L36-L183
[history-failures]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/test/btw-history.test.ts#L311-L538
[history-recovery]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/test/btw-history.test.ts#L223-L295
[session-lifecycle]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/test/btw-session-lifecycle.test.ts#L196-L340
[rpc-behavior]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/test/rpc-btw.test.ts#L144-L200
[rpc-eof]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/test/rpc-btw.test.ts#L255-L315
[rpc-persistence-failure]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/coding-agent/test/rpc-btw.test.ts#L202-L253
[panel-default]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/tui/src/overlays/btw-history-panel.ts#L260-L265
[panel-submit]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/tui/src/overlays/btw-history-panel.ts#L410-L459
[panel-render]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/tui/src/overlays/btw-history-panel.ts#L761-L857
[panel-copy]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/packages/tui/src/overlays/btw-history-panel.ts#L899-L925
[sidecar-privacy]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/docs/slash-command-internals.md#L442-L460
[inject-docs]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/docs/slash-command-internals.md#L355-L381
[branch-docs]: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/docs/slash-command-internals.md#L464-L469
