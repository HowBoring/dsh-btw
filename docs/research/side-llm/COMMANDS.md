# Commands and observed output

Environment:

- Node: v26.7.0 (`node --version`).
- Installed DSH: `/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh/`
  (`package.json` version `0.2.1-rc.5`).
- No network calls were made; the proof replaces `globalThis.fetch` with a wire-level stub.
- TypeScript 6.0.3 was used from a scratch install
  (`/home/howboring/Projects/Dsh-Extension/dsh-btw/.tmp/gen/node_modules/typescript`); any TS ≥5.5
  works. The `tsconfig` `paths` are absolute to this machine's DSH checkout — update them if the
  checkout moves; the result does not depend on the path.

## 1. Wire-level proof

Run from the repository root:

```bash
DSH_ROOT=/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh \
  node docs/research/side-llm/proof.mjs \
  > docs/research/side-llm/proof-out.json \
  2> docs/research/side-llm/proof-err.log
echo $?   # 0
```

`proof-err.log` (one `ok` line per check plus the summary):

```
ok installed purpose typing contract
ok normalization fixtures
ok interrupted assembler drops open tool calls
ok deepseek rejects raw partial tool batch
ok deepseek normalized idle
ok deepseek normalized streaming
ok deepseek normalized partialToolBatch
ok deepseek normalized matchedToolPrefix
ok deepseek normalized retry
ok deepseek normalized compaction
ok deepseek valid reasoning replay
ok deepseek degrades unusable replay without signature
ok deepseek rejects orphan tool result
ok pi-ai normalized idle
ok pi-ai normalized streaming
ok pi-ai normalized partialToolBatch
ok pi-ai normalized matchedToolPrefix
ok pi-ai normalized retry
ok pi-ai normalized compaction
ok pi-ai valid reasoning replay
ok pi-ai drops foreign replay reasoning
ok pi-ai raw partial tool batch compatibility
ok prepareCall independent identity and one-shot dispatch
ok main sessionId triggers checkpoint and provider identity
ok dsh-llm-retry does not retry direct side stream
ok explicit bounded retry needs fresh prepareCall per attempt
ok independent overall deadline aborts side fetch only
ok session-log omission versus main identity
PASS 28 checks on 0.2.1-rc.5
```

Selected evidence from `proof-out.json`:

```json
{
  "name": "deepseek rejects raw partial tool batch",
  "code": "INVALID_REQUEST",
  "message": "DeepSeek Messages tool calls need immediate results",
  "fetchCalls": 0
}
```

```json
{
  "name": "deepseek degrades unusable replay without signature",
  "assistant": {
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "foreign reasoning" },
      { "type": "text", "text": "foreign answer" }
    ]
  }
}
```

```json
{
  "name": "pi-ai drops foreign replay reasoning",
  "assistant": { "role": "assistant", "content": "committed answer" }
}
```

```json
{
  "name": "dsh-llm-retry does not retry direct side stream",
  "fetchCalls": 1,
  "finishKind": "error",
  "failureCode": "SERVER",
  "retryPolicyMaxRetries": 5
}
```

```json
{
  "name": "explicit bounded retry needs fresh prepareCall per attempt",
  "fetchCalls": 3,
  "finishKinds": ["error", "error", "error"]
}
```

```json
{
  "name": "prepareCall independent identity and one-shot dispatch",
  "sideAbortedAfterMainAbort": false,
  "secondDispatchCode": "INVALID_PREPARED_CALL",
  "flushCalls": [],
  "sessionIdHeader": null
}
```

## 2. Type proof (`purpose` cannot be augmented)

```bash
cd docs/research/side-llm/types
TSC=/home/howboring/Projects/Dsh-Extension/dsh-btw/.tmp/gen/node_modules/typescript/bin/tsc
node "$TSC" -p tsconfig.json
echo $?   # 0  (the 'btw' error is consumed by @ts-expect-error)
```

`tsconfig.json` maps `@deepseek-ai/*` to the installed package types and sets:
`target ES2022`, `module/moduleResolution NodeNext`, `strict`, `noEmit`, `skipLibCheck`,
`allowImportingTsExtensions`. No `baseUrl` (TS 6 rejects it with TS5101).

`test.ts`:

```ts
export const compaction: GenerateOptions = { ...base, purpose: 'compaction' }; // compiles
// @ts-expect-error 'btw' is not in the closed union
export const btw: GenerateOptions = { ...base, purpose: 'btw' };
```

Augmentation attempt:

```bash
node "$TSC" -p tsconfig.augment.json
echo $?   # 2
```

Observed:

```
augment.ts(5,5): error TS2717: Subsequent property declarations must have the same type.
  Property 'purpose' must be of type '"compaction" | "session-title" | undefined',
  but here has type '"compaction" | "session-title" | "btw" | undefined'.
augment.ts(9,80): error TS2322: Type '"btw"' is not assignable to type
  '"compaction" | "session-title" | undefined'.
```

`augment.ts`:

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface GenerateOptions {
    purpose?: 'compaction' | 'session-title' | 'btw';
  }
}
```

Conclusion: module augmentation cannot widen a closed union; no `as` cast is acceptable in
production code. `purpose:'btw'` would only survive at runtime because rc.5 does not validate it.

## 3. Worktree access (why this was staged under `.tmp`)

```bash
touch /home/howboring/Projects/Dsh-Extension/dsh-btw-research/side-llm/.write-probe
# touch: cannot touch '.../.write-probe': Read-only file system
# [sandbox: file access denied under workspace-write mode]
findmnt -no SOURCE,FSTYPE,OPTIONS /
# /dev/sdd ext4 ro,relatime,...
```

The session workspace is `/home/howboring/Projects/Dsh-Extension/dsh-btw`; the research worktree is
on the read-only root filesystem. Approval prompts are disabled, so the report/proof could not be
copied into the worktree or committed from that session. The staged tree
`/home/howboring/Projects/Dsh-Extension/dsh-btw/.tmp/side-llm-deliverables/` is what belongs in the
worktree (see `APPLY.md` there).

Note: `/tmp` is ephemeral per bash invocation in this harness; persistent scratch must live under
the workspace `.tmp/`.
