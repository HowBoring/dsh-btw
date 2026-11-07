# 01 · OMP Feature Baseline (Verified Source Behavior)

Pinned: `can1357/oh-my-pi@f2b795ba747b23d42052184d822b41e3d01357cc` (2026-11-07).

## Source of truth

- `docs/slash-command-internals.md` lines 316–415 — official `/btw` UX, history, follow-up, isolation, identity and per-topic locking.
- `packages/coding-agent/src/session/agent-session.ts` around lines 13169–13400 — `runEphemeralTurn`, current-message snapshot and partial Assistant construction.
- `packages/coding-agent/src/session/btw-turn.ts` lines 21–119 — `beginBtwTurn`, `runBtwTurn`, per-topic Q/A replay and transport epoch.
- `packages/coding-agent/src/session/btw-history.ts` lines 18–259 — store schema, path-scoped records, lease, revision, atomic file write and crash recovery.
- `packages/coding-agent/src/modes/controllers/btw-controller.ts` around 542–875 — `startFollowUp`, busy gate, history UI coordination, cancellation, persist before dispatch, output streaming.
- `packages/coding-agent/src/modes/rpc/rpc-btw.ts` — `btw`, `btw_cancel`, `get_btw_history`; `btw_delta`/`btw_record` messages.
- `packages/tui/src/overlays/btw-history-panel.ts` — history list, selected detail, `f`/Enter follow-up composer, Escape, Copy.
- `packages/coding-agent/src/prompts/system/btw-user.md` — concise side response, no tools, optional inject text format.

All links are pinned in `references/source_manifest.json`.

## Verified capability matrix

| Behavior | OMP implementation | DSH target interpretation |
|---|---|---|
| `/btw question` | Side model request using viewed Session context even when main is running | BtwService calls own LLM request, no main turn. |
| Bare `/btw` | Open session's BTW history with newest selection | Separate Session-scoped panel/history. |
| `f` (inline) or `f`/Enter (history) | Follow up on selected topic | Call `ask` with `topicId`, never new main user turn. |
| Follow-up context | Historical Q/A in same topic + **new current main snapshot** | Recapture every question. |
| Stream partial | Include streaming Assistant's currently received text; preserve certain thinking blocks | Best-effort protocol-safe live text; reasoning only if route valid. |
| Tool behavior | Prompts no tools; filters tool-call blocks, never executes | No tools executed; tool schema handling is provider-specific. |
| History | Per-topic JSON sidecars under Session artifacts; not main chat | DSH storage domain with session-keyed topics. |
| Context cache | Main prompt/system/tool prefix and cache key retained where possible; topic-specific transport lineage | Retain if legal; never reuse main provider session-state identity incorrectly. |
| One active BTW | Refuses other new/follow requests while one runs | Single-flight per Session V1. |
| Cancel | Independent; partial text kept; terminal status | Separate controller, no Agent.cancel. |
| Resume | `running` on recovery becomes `interrupted` | Repair orphan records at Host startup. |
| Subagent | Focused child history scoped separately | Phase 2 after session address/permissions review. |
| Inject and branch | Opt-in explicit user action | Not normal BTW Follow; defer. |

## Record model

OMP `BtwHistoryRecord` extends `BtwHistoryTurn` with id, initial leafId, optional UI title, and followUps[]. A turn has `question`, optional images, `answer`, `status`, timestamps, optional error. The history list title remains the initial question; details show chronological Q/A. Saved history is visible text, not opaque provider reasoning/replay signature. Cancelled partial text may be in-memory and terminal-persisted; a sudden crash during streaming does not guarantee every token was checkpointed.

## Session boundary and files

Root session artifacts: `btw-history/entry-<id>.json` and optional `.title` sidecar. Focused subagent records: `btw-history/sessions/<session-id>/`. `--no-session` means memory-only. Ordinary transcript export/share intentionally excludes the sidecar.

`BtwHistoryStore.open` loads validated JSON records and displays lingering `running` as `interrupted` (without rewriting raw data during read). `upsert` acquires OS file lock per Topic, compares stored SHA256 revision while holding it, atomically replaces JSON and releases lock after terminal state. A stale follow-up writer is refused before LLM dispatch. Follow-up startup is persist-first; cancellation during initial checkpoint still lands cancelled terminal state without calling model.

## Distinctions not to miss

- **Follow ≠ inject.** Follow is a BTW topic follow-up. Inject sends a user-authorized steering prompt into main Agent and is separate.
- **New BTW ≠ Follow.** A new topic does not inherit prior topics; follow-up inherits ONLY selected topic's turns.
- **Topic context ≠ static fork.** The main session context is recaptured on EACH follow-up.
- **Side request ≠ subagent.** It is a non-tool one-shot model request, not a new Agent Session.
- **History persistence ≠ main transcript persistence.** Sidecar is isolated; normal export does not include it.

## Tests to port as behavioral references (not copy source)

Look at `packages/coding-agent/test/btw-follow-up.test.ts`, `btw-history.test.ts`, `btw-session-lifecycle.test.ts`, `rpc-btw.test.ts`, and `packages/tui/test/btw-history-panel-cursor.test.ts` for edge cases and sequencing. Implement independent DSH-native tests.
