# dsh-btw — Development Context Package

> **Status: design + execution context, NOT an implemented/installable plugin.**
>
> Created: **2026-11-07**. Language: Chinese design documentation + English agent instructions.
>
> **Pinned upstream references:** OMP `can1357/oh-my-pi@f2b795ba747b23d42052184d822b41e3d01357cc` (2026-11-07); DSH `deepseek-ai/deepseek-harness@fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` (2026-11-04, merged release 0.2.2-rc.1). Compare target installation `dsh-v0.2.1-rc.2` if applicable. Recheck local checkout before implementation.

## Mission

Build an **OMP-style `/btw` ephemeral side conversation** for DeepSeek Harness that can answer while the primary ReAct Loop is running. Each side question draws from the **latest observable host context at admission** (committed Session history + correctly captured in-flight assistant stream + safe activity facts), calls the LLM independently, and **never changes or blocks the main Agent**. Provide **topic-scoped follow-ups** whose context refreshes on each question, **Session-scoped durable history**, streaming, cancellation, and a Web BTW panel.

## Load order (recommended)

1. `00_PRODUCT_SCOPE.md` — requirements, exclusions and correctness criteria.
2. `01_OMP_SOURCE_BEHAVIOR.md` — verified OMP product semantics, code references, differences from typical chat.
3. `02_DSH_SOURCE_MAP_AND_COMPATIBILITY.md` — known DSH seams and version limitations.
4. `03_ARCHITECTURE.md` — Host/Client design, concurrency model and data flow.
5. `04_CONTEXT_CAPTURE_AND_LLM.md` — critical mid-ReAct live snapshot and model protocol requirements.
6. `05_STORAGE_AND_LIFECYCLE.md` — topic/follow-up persistence, revision and crash recovery.
7. `06_API_AND_UI.md` — typed conceptual contracts, Browser/CLI behavior and Remote streaming.
8. `07_ADR.md` — design choices and rejected alternatives.
9. `08_TEST_MATRIX.md` — detailed tests, mock harness and acceptance gates.
10. `09_IMPLEMENTATION_ROADMAP.md` — staged development with review checkpoints.
11. `AGENT_IMPLEMENTATION_PROMPT.md` — complete English writing-for-agent implementation prompt.
12. `diagrams/*.puml` — five editable PlantUML diagrams.
13. `examples/types.reference.ts` — **illustrative types only**, not compiled plugin code.
14. `references/source_manifest.json` — pinned upstream source map and commit references.

## Nonnegotiable invariants

- `btw.ask` and `btw.follow` MUST NOT call `agent.followup`, `agent.steer`, `agent.inject`, `ctx.tools.execute`, or `agent.cancel` on the primary Agent. The optional future **user-authorized BTW → main steering** is a **different operation**.
- BTW input/output MUST NOT become Session model-visible `user/message` / `assistant/message` or Tool events. Neither BTW chat records nor full side prompts should be silently included in normal Session transcript exports/share.
- A side question MAY execute while main Agent is `running` and MUST NOT await `agent.whenIdle()`; no `runMaintenance()` lock on the running Agent.
- A follow-up always captures `MainContext(t_now)` anew, then appends only the selected topic's prior Q/A, followed by the current Q.
- No invented tool results, no replay or execution of tools in the side turn. Never pass unpaired tool calls to a provider unmodified.
- Snapshot is fixed **at Host admission**, before async disk/model operations. Record event seq and in-flight attempt/index; discard mutable references. A client click time is NOT a synchronized Host snapshot time.
- Startup and completion are distinct: persist `running` before LLM dispatch, then stream live deltas, finally persist terminal status. Browser disconnect does not cancel an admitted request by default.
- Session ID is the authority scope of reads/writes; all Remote endpoints MUST be checked by Host permissions and avoid accidentally resuming cold Agents on history reads.
- Explicit `requestId` + per-Session active-turn gate + revision/epoch checks avoid duplicate submissions, stale updates, and double settlement.

## Deliverables for implementation Agent

The implementation Agent should produce actual `dsh-btw` Host plugin, `dsh-client-ui-btw` Client plugin, documented registration/composition, tests, and a compatibility note for the **installed DSH version**. The package itself contains no working runtime code.

## Risk status (read before implementation)

| Topic | Status | Design rule |
|---|---|---|
| Live Assistant stream | Public DSH event exists in rc.2 and current master | Maintain bounded process-local Attempt mirror. |
| Tool-batch partial state | Needs explicit handling | Construct **side-only protocol-valid** snapshot, never synthetic success. |
| Reused model config | Public LLM request observation exists | Capture only immutable settings; reprepare separate call, separate signal. |
| Side LLM auto retry | `dsh-llm-retry` is Agent request-error middleware | Direct `ctx.llm` calls do not inherit it; design bounded side-specific retry. |
| Session-level history | `dsh-storage-domain` available | Choose `per-record` domain or SQLite for topic updates; no Session model events. |
| Cross-process writes | Default DSH JSON storage lacks per-topic OS lock/CAS | V1 **single Host writer**. Multi-Host lease/CAS is an explicit future requirement. |
| Web `/btw <question>` | Client command menu supports bare action, custom input claims exist | Avoid sending command to main prompt and avoid unwanted Host command log; inspect exact input trigger contract. |
| Persisted live partials | Process local by default | Terminal checkpoint durable; interrupted state reconstructed on startup. |

## References

See `references/source_manifest.json` for file-level links pinned to the exact upstream SHAs. Main DSH docs: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/api-gateway.md ; OMP feature spec: https://github.com/can1357/oh-my-pi/blob/f2b795ba747b23d42052184d822b41e3d01357cc/docs/slash-command-internals.md#L316-L415 .
