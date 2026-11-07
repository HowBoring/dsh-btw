# 09 · Execution Roadmap, Milestones, Review Gates

## M0 · Discover and freeze target interfaces

**Read local source first.** Print DSH commit/version, profile `cordis.patch.yml`, available UI and Host Loader components. Verify `agent/assistant-stream`, `llm/stream`, `isAgentLoopRequest`, `BlockAssembler`, `storageDomain`, `@Remote`, session resource auth, `ui-input-trigger` and Client Slot API. Verify codegen/generator order and selected adapters. Produce `docs/dsh-btw/local-compatibility.md` before coding. **Do not invent or monkey-patch missing APIs.**

**Gate:** a small test can read main Agent's committed history + live streaming delta and start independent `ctx.llm` call without affecting main.

## M1 · Live Context Mirror + Snapshot Builder

- Attach listeners early; select `isAgentLoopRequest` only.
- Mirror current main model/route/tools data and bounded live Attempt, handle stream epochs and missing frames.
- Capture immutable `ContextCut` before async operations.
- Unit-test stream delta timing and the mixed tool batch.

**Gate:** `CTX-*` minimal tests and `INT-001` baseline pass.

## M2 · Provider-safe Side Runner

- Build `SideContextNormalizer`, including unpaired Tool Calls, partial text/reasoning policy, and exact history cut.
- Implement side-only `ctx.llm.prepareCall`, stream assembly, no tool execution, purpose/identity, timeouts, output cap and bounded retries.
- Confirm with two adapters' mock wire tests.

**Gate:** no malformed tool protocol, no cross-cancellation, main Session never changed.

## M3 · Session-scoped Topic History + Coordinator

- Define `btw_topics` Domain schema and stable Session-Topic key; choose storage layout.
- Implement Topic repository, follow-up replay, revisions, idempotency, per-Session one-active gate, persist-first admission.
- Add detached worker and process lifecycle cleanup; repair `running` from old host as `interrupted`.

**Gate:** `BIZ-*`, `ST-*` and restart tests pass; no extra model calls for duplicate request.

## M4 · Typed Remote API + Permissions

- Implement generated `btw.ask`, `list`, `get`, `watch`, `cancel` with explicit Session access checks.
- `watch` snapshot and incremental frames must be race-free; mark separate Topic/Feed revision clocks.
- Cold `list/get` must not wake Agent; business semantics remain Host-owned.

**Gate:** Host/Client generated schema, authorization, reconnect tests pass.

## M5 · Web Client UX and command routing

- BTW History Panel with Topic list, details, follow-up, copy, cancel, streaming.
- Bare `/btw` opens history; `/btw question` routes via args-tolerant input source (or documented interim POC). Never ordinary user prompt.
- Support Session switch and stale frame protection; include fallback UI for missing live context.

**Gate:** Web e2e tests and `UI-*` core tests pass.

## M6 · Final hardening + documentation

- Run scoped typecheck/test/lint and DSH-supported build/typert generator gates. Repo's `AGENTS.md` / `docs/development.md` govern exact commands; inspect rather than invent.
- Validate Session archive/privacy and export boundaries.
- Document single-writer and cold-session limitations.
- Provide operational examples for `/btw`, Follow, History, Cancel, Resume.

**Gate:** all three release gates in `08_TEST_MATRIX.md`, no unresolved high-severity security or primary-Agent interference defect.

## Work partition suggestions

1. `capture/normalizer`: focused worker owns context correctness.
2. `storage/coordinator`: focused worker owns idempotency and durable lifecycle.
3. `remote`: focused worker owns generated typed API and permissions.
4. `ui`: focused worker owns client input route/history panel.
5. `integration`: integrator owns final behavior and cross-component tests.

Parallel development is appropriate after agreeing on `examples/types.reference.ts` and API envelopes, but **final integration must test real main/side concurrency**. Maintain one owner for each type/contract. Do not require separate subagents; one local coding Agent can implement sequentially.

## Mandatory implementation report

1. Current local branch/commit and selected target DSH version.
2. Actual changed files and why.
3. Feature summary mapped to FR-01..10.
4. Tests performed and exact command lines.
5. Demonstration of mid-stream BTW and follow with updated context.
6. Known limitations, especially multi-process writes and provider compatibility.
7. Any deviations from ADR and reason / effect.

## Definition of Done

Functional commands and UI are not enough: correct context cut, independent Agent execution, protocol validity, durable topics, follow-up current context, history restore, cancellation isolation, and Session authorization are all required. Do not report full OMP parity if Phase-2 features (Subagent BTW, inject, branch, multi-Host) are not implemented.
