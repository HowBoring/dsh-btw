# Pinned upstream source evidence

The JSON source manifest records the two pinned repository commits and individual files, with relevant symbols and line references. **These are references, not vendored upstream source.** They may change after the pinned commits; resolve the local checkout and verify before implementing. Do not import from OMP directly.

## OMP behavior

- Source: `/btw` product behavior, topic Follow, history sidecar, subprocess isolation — `docs/slash-command-internals.md`.
- Runtime: `AgentSession.runEphemeralTurn`, live partial assistant snapshot builder — `packages/coding-agent/src/session/agent-session.ts`.
- Follow: `beginBtwTurn`, `runBtwTurn` — `packages/coding-agent/src/session/btw-turn.ts`.
- Durable records: `BtwHistoryStore` — `packages/coding-agent/src/session/btw-history.ts`.
- UI/interaction: `BtwController`, `BtwHistoryPanel`.
- RPC: `RpcBtwController`, official RPC guide.

## DSH code seams

- Context and stream: `agent/assistant-stream`, `llm/stream`, `isAgentLoopRequest`, `BlockAssembler`.
- One-shot model: `LlmRuntime.prepareCall` and `stream` as used by `session-title-llm`.
- Durable side data: `storage-domain` (`DomainFacility`, `KvTable`) and `storage-json` limitations.
- Remote and UI: `@Remote` typed generated API, Session resource authorization, `ui-input-trigger` `matchEnter`, `ui-commands` bare actions, Slot contributions.

Pinned at 2026-11-07. Compare target DSH version, specifically if still on 0.2.1-rc.2.
