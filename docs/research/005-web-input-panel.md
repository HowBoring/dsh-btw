# Wayfinder #5 — Web `/btw` interception and Session-scoped panel seams

- **Status:** complete
- **Date:** 2026-11-07
- **Ticket:** [HowBoring/dsh-btw#5](https://github.com/HowBoring/dsh-btw/issues/5)

## Verdict

**The installed Web Client supports the required no-main-prompt route; no incompatibility or core change was found.**

- Bare `/btw` can be a Client-only `ctx.commandUi.register` action. It opens the panel and consumes the bare token without submitting a prompt.
- `/btw <question>` needs a separate `/` `ctx.inputTriggers.registerSource` source. It returns a `CommandClaim`; the claim's `submit` calls the feature-owned generated Remote with the current `sessionId`. The submit machine emits `begin-submit`, not `default-sink`, and successful settlement emits `commit-draft`.
- A Session-scoped right-sidebar tab is the best supported panel seat: register its type with `ctx.sidebarRightTabs.register`, then register the body in keyed Slot `sidebar.right.pane.tab` under the type's `id`.
- A plugin can ship and mount its own generated Remote contribution with `ctx.remote.$mount`; editing the core `api-remotes` assembly is not required.
- There is **no shipped CLI/TUI no-log slash-command route** for BTW. Host command execution always writes `command/run` and `command/done`. A future terminal frontend must call the feature Remote directly rather than use `commands.execute`.

The focused proof is [btw-routing.test.mjs](proofs/btw-routing.test.mjs). It uses the real installed rc.5 routing classes, not a reimplementation of their registry or state machine.

## Baselines and compatibility

Two upstream baselines matter:

| Baseline | Identity | How it was used |
| --- | --- | --- |
| Installed target | `dsh --version` → `0.2.1-rc.5`; Node `v26.7.0` | Browser artifacts executed by the proof; installed declarations inspected for Slots and Remote APIs |
| Exact rc.5 source | tag `dsh-v0.2.1-rc.5`, commit `b830ec950faba0a46dda564be3e2d854afed94f1` | The preserved `machine.ts` and `facade.ts` snapshots byte-match this tag |
| Requested comparison pin | [`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159), package version `0.2.2-rc.1` | Primary-source API, Slot, Remote, lifecycle, and CLI evidence below |

Cached rc.5-to-pin diffs show only locale-list changes in the input-trigger and command index files. The conversation machine/facade have ordinary-send buffering and quote changes, but the adjudication, claim, default-sink, settlement, and release branches used here remain present. The proof deliberately runs against **rc.5**, so the positive interception result does not depend on the newer pin.

## 1. Actual Enter routing

The rc.5 `SubmitMachine` sends a non-empty leading-`/` draft through `adjudicate` ([machine.ts L137-L150][rc5-machine]). A winning `{claim}` produces `begin-submit`; `'handled'` and other defined outcomes produce no default sink; only `undefined` produces `default-sink` ([machine.ts L154-L175][rc5-machine]). The facade executes those effects distinctly and passes the full trimmed draft plus `{attachments: number}` to the controller ([facade.ts L691-L714][rc5-facade], [facade.ts L863-L880][rc5-facade]).

The default conversation sink is therefore bypassed before it can call `session.prompt` or `conversation.sendSession`; that sink is the only ordinary prompt path in the input hub ([hub.ts L263-L281][pinned-hub]). The proof observes a default-sink call only for the near-name control `/btwow not BTW`.

### `registerSource` contract

`ctx.inputTriggers.registerSource(source)` is root-scoped. It rejects a duplicate `(trigger, name)`, warms existing Session controllers, and returns an unregister disposer. Each retained Session binding gets a controller, disposed with that binding ([input service L55-L76][input-service], [L88-L112][input-service]).

For Enter, sources are polled in **registration order**, after a cheap trigger-prefix check; the first non-`undefined` outcome wins ([controller L386-L396][input-controller]). The `order` option sorts trigger menus, not this Enter roster. Source callbacks receive a projection containing `sessionId`; `matchEnter` also receives the line, attempt `AbortSignal`, and attachment count.

Consequences for BTW:

1. Register the built-in command source first (the normal composition already does), then the BTW source.
2. The command source handles exact bare `/btw`; its Client-only action declines argued input, allowing the BTW source to claim `/btw <question>`.
3. Return `undefined` for `/btwow`, unrelated input, and other non-matches. Do not throw for a line BTW does not own.
4. If BTW owns the line but cannot accept its envelope, **throw**. That produces a notice and retains the draft; returning `undefined` would silently fall through to the ordinary prompt.
5. `matchClaim` only reconstructs a persisted leading command chip. It must not open a panel or call `btw.ask`; the proof verifies both remain untouched during `resolveClaim`.

### Claim and attachment semantics

For argued input, return a claim equivalent to:

- `name: 'btw'`
- `token: '/btw '`
- `submit(args, actx, attachments)`: call `remote.btw.ask` with `sessionId: actx.sessionId` and the token-free `args`; return a `SubmitOutcome`.

The machine strips the command token before `submit` ([machine.ts L18-L28][rc5-machine]). On success it commits the submitted draft while retaining a pure typed-during-flight suffix; on failure it keeps the claim/draft for correction ([machine.ts L184-L201][rc5-machine], [facade.ts L717-L729][rc5-facade]).

`matchEnter` exposes only the attachment **count**. To accept attachments, set `claim.attachments = true`; the facade then serializes and passes the real `SubmitAttachment[]` to `submit`, releasing them only after success ([facade.ts L884-L889][rc5-facade]). Otherwise reject a matching attachment-carrying argued line by throwing, as the proof does. Bare actions are different: rc.5 invokes a `commandUi` action even when attachments are present, without passing or serializing them to that action ([command service L332-L340][command-service]). Do not mistake a bare panel-opening action for an attachment-consuming command.

## 2. `commandUi` and collision rules

`ctx.commandUi.register` owns a Client contribution. An action's bare invocation runs locally, emits the scoped consume-token event, and returns `'handled'`; argued input returns `undefined` for that contribution ([command service L319-L365][command-service]). This is why it solves bare `/btw` but cannot implement `/btw <question>` alone.

`ctx.commandUi.decorate` requires an existing Host command and replaces only its bare UI invocation. The Host descriptor still owns argued `leadingInput`, whose claim submits through Host `commands.execute` ([command service L319-L404][command-service]). Decoration is therefore **not** a no-log implementation of argued BTW.

Collision behavior is intentionally loud:

- Duplicate Client contribution names and duplicate source `(trigger, name)` pairs throw at registration.
- Building the command catalog throws when a Client contribution and Host command share a name ([command service L224-L249][command-service]).
- An existing Host `leadingInput` can win argued input before a later custom source. Do not assume `/btw` is unowned; preflight the Host catalog. If a Host collision exists, choose one owner/name rather than masking it and leaving catalog construction broken.

The proof executes the duplicate, Host-name collision, and decoration cases. It also verifies `decorate` handles `/host` while `/host still host-owned` remains a Host claim.

## 3. Supported Session-scoped panel

Use the right sidebar's public two-stage extension path:

1. `ctx.effect(() => ctx.sidebarRightTabs.register({ id, kind: 'btw', title, ... }))`, using a package-unique `id`.
2. `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, BtwPanel))`.

The registry explicitly defines this split between static type and keyed body ([tab registry L1-L22][tab-registry], [L93-L139][tab-registry], [L237-L253][tab-registry]). A keyed Slot registration requires `key`; list Slots instead require `id` and optional `order` ([Slot contract L788-L872][slot-contract]). Open the panel for the route's actual Session with `sidebarRight.openTabIn(sessionId, 'btw')`, rather than trusting whichever Session happens to be foreground when an async action completes.

`sidebar.right.pane.tab` is `kind: 'keyed', scope: 'session'`; its injected `hooks.tabInfo` exposes visibility, navigation, actions, and the tab occurrence signal. Standard Session props supply `sessionId` ([sidebar Slots L41-L78][sidebar-slots], [L184-L220][sidebar-slots]). `rightbar.session` is the framework's single owner seat, not a second panel extension point. `conversation.view` is a supported Session-scoped list with owner-provided conversation/view actions, but the right-sidebar tab better matches a dedicated BTW history panel.

Omit `keepMounted` initially (default `false`). Unmounting a hidden panel should dispose its watch; the detached Host worker continues, and reopening obtains a fresh snapshot. Setting `keepMounted: true` deliberately retains the body through hiding, Session switches, and docking ([tab registry L103-L108][tab-registry]), which increases cleanup obligations.

## 4. Generated Remote pattern

Copy the first-party cot-translation package pattern, not a hand-written WebSocket or fake generated declaration:

- Host: a feature class extends `TypertRemoteService`; business methods use `@Remote`, with a final `AbortSignal` ([cot Host index L29-L64][cot-host]).
- Package: export `./client`, `./remote`, and `./typert`, and ship the generated `typert.remote-client` artifacts ([cot package.json L16-L50][cot-package], [L91-L100][cot-package]).
- Client: import the package's own `/remote` contribution and pass it to the mount function from `apply` ([cot Client index L1-L21][cot-client-index]).
- Mount: `await ctx.remote.$mount(contribution)`, then inject the typed `remote.<namespace>` consumer. On setup failure roll back; on disposal remove UI before unmounting Remote ([cot mount L114-L129][cot-mount]). The same example binds Slot `sessionId` into each Remote request ([cot mount L86-L104][cot-mount]).

The gateway generates only decorated methods; stream methods use `@Remote({ mode: 'stream' })` and yield `RemoteStreamHandle`s ([API gateway L9-L18][api-gateway], [L58-L62][api-gateway]). Built Browser clients require the generated strict codecs; the source fallback is Host-only ([API gateway L138-L160][api-gateway]).

For BTW, `ask` should return an admission receipt and leave the worker detached. `watch` is an independent subscription; disposing it must not cancel the worker. Explicit `btw.cancel` remains a separate authorized Remote operation.

## 5. Session switch, disposal, and reconnect

Do not equate a foreground Session switch with disposal:

- Input controllers and composer shells die with their retained Session scope, and `SubmitMachine.release` aborts in-flight work and drops stale outcomes ([input service L88-L112][input-service], [machine.ts L219-L228][rc5-machine], [hub.ts L155-L176][pinned-hub]).
- Sidebar Session views can retain background tabs across selection changes ([session views L27-L43][session-views], [L59-L73][session-views]).
- `tab.signal` aborts when the tab record disappears or the plugin unloads—**not on hide or Session switch** ([sidebar Slots L196-L207][sidebar-slots]).

Therefore key all panel and stream state by `sessionId` (and topic/turn/request identity), dispose component watches on unmount or identity change, and ignore frames whose identity or revision does not match. Never let a late A frame update B. Plugin teardown must also dispose the input source, command contribution, tab type/body registrations, and Remote mount.

A raw generated stream is not a gap-free reconnect protocol. `remote.$stream` retries a physical generation only for `RemoteStreamCarrierError`, annotates the generation, and aborts replaced generations ([Remote stream L31-L84][remote-stream], [L95-L157][remote-stream]). Use `RemoteSnapshotStream` or the same discipline: each new generation starts with an authoritative snapshot/cursor, replaces the baseline atomically, then applies revision-checked deltas. The remote-access package demonstrates this exact `$stream` + `RemoteSnapshotStream` composition and effect-owned disposal ([remote-access mount L120-L170][remote-access-mount]). If a cursor cannot resume without loss, resubscribe from a fresh BTW snapshot rather than accepting a gap.

## 6. CLI/TUI result and constraint

The shipped CLI documents Web, one-shot headless, SDK JSON-RPC, and ACP entry modes, not an interactive TUI composer ([apps/cli README L5-L20][cli-readme]). The archived removal note says `packages/ui/tui` was deleted without a compatibility alias ([TUI removal note L14-L20][tui-removal], [L36-L40][tui-removal]).

The public Host `commands.execute` route appends `command/run` before the handler and `command/done` afterward; these are durable log-only Session events ([commands index L332-L390][host-commands]). SDK command tests confirm exactly those events ([SDK commands spec L90-L132][sdk-commands]). Thus neither a Host command nor SDK slash-command execution satisfies BTW's no-main-log requirement.

**Resolution:** ship the Web interception/typed Remote route and document the CLI/TUI gap. Do not add a logged Host-command POC. A future terminal surface can use the generated feature Remote directly, but that is a new frontend route, not an existing no-log `/btw` command.

## 7. Commands and observed results

All commands ran in `research/web-input` at repository root unless noted.

```text
$ node --version
v26.7.0
$ dsh --version
0.2.1-rc.5
$ git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness.git '*0.2.1-rc.5*'
b830ec950faba0a46dda564be3e2d854afed94f1  refs/tags/dsh-v0.2.1-rc.5
```

The preserved rc.5 snapshots were checked against freshly fetched tag sources:

```text
$ cmp .tmp-web-input/rc5-machine.ts .tmp-web-input/rc5-packages__client__ui-conversation__src__client__input__machine.ts
$ cmp .tmp-web-input/rc5-facade.ts .tmp-web-input/rc5-packages__client__ui-conversation__src__client__input__facade.ts
PASS: rc.5 machine and facade snapshots byte-match tag dsh-v0.2.1-rc.5
```

Final proof run:

```text
$ BTW_MACHINE_PATH="$PWD/.tmp-web-input/rc5-machine.ts" node docs/research/proofs/btw-routing.test.mjs
PASS: real rc.5 registry/controller/command runtime + SubmitMachine; bare and argued /btw bypass default sink
```

To recreate only the required untracked source snapshot on a clean checkout:

```sh
mkdir -p .tmp-web-input
gh api -H 'Accept: application/vnd.github.raw+json' \
  'repos/deepseek-ai/deepseek-harness/contents/packages/client/ui-conversation/src/client/input/machine.ts?ref=b830ec950faba0a46dda564be3e2d854afed94f1' \
  > .tmp-web-input/rc5-machine.ts
BTW_MACHINE_PATH="$PWD/.tmp-web-input/rc5-machine.ts" node docs/research/proofs/btw-routing.test.mjs
```

The proof covers bare consumption (including the action's attachment behavior), argued whole-line submission and draft commit, near-name fallback, argued attachment refusal/draft retention, side-effect-free `matchClaim`, duplicate registrations, Host-name collision, decoration scope, and stale-release abort. It stubs only the Remote call, rendering primitives, snapshot store, and default sink. It does **not** execute a Host command, send a real prompt, call an LLM, or build the production panel.

Live Client `Service`/`Slots` inspection was attempted, but no connected page answered before the 10-second timeout. Slot and lifecycle conclusions above therefore come from installed declarations plus pinned source, not a claimed visual/browser demonstration.

## Source index

[rc5-machine]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/ui-conversation/src/client/input/machine.ts#L18-L28
[rc5-facade]: https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/ui-conversation/src/client/input/facade.ts#L691-L714
[pinned-hub]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/ui-conversation/src/client/input/hub.ts#L263-L281
[input-service]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/ui-input-trigger/src/client/service.ts#L55-L76
[input-controller]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/ui-input-trigger/src/client/controller.ts#L386-L396
[command-service]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/ui-commands/src/client/service.ts#L319-L365
[tab-registry]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/ui-sidebar-right/src/client/tab-registry.ts#L93-L139
[slot-contract]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/ui-slots/src/index.ts#L788-L872
[sidebar-slots]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/ui-sidebar-right/src/client/contract/slots.ts#L41-L78
[cot-host]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/client-ui-cot-translation/src/index.ts#L29-L64
[cot-package]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/client-ui-cot-translation/package.json#L16-L50
[cot-client-index]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/client-ui-cot-translation/src/client/index.ts#L1-L21
[cot-mount]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/client-ui-cot-translation/src/client/mount.ts#L114-L129
[api-gateway]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/api-gateway.md#L9-L18
[session-views]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/ui-sidebar-right/src/client/session-views.ts#L27-L43
[remote-stream]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/gateway/src/client/remote-stream.ts#L31-L84
[remote-access-mount]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/remote-access/src/client/mount.ts#L120-L170
[cli-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/cli/README.md#L5-L20
[tui-removal]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/.agents/notes/archived/simplification/2026-08-04-remove-tui-package.md#L14-L20
[host-commands]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/interaction/commands/src/index.ts#L332-L390
[sdk-commands]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/server/tests/commands.spec.ts#L90-L132
