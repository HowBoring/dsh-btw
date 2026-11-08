# Install and wire BTW into a profile

Package: `@deepseek-ai/dsh-btw` (version `0.1.0` in this repo). It ships a **Host
plugin** and a **browser module**; both are produced by the build into `lib/`.

## Package exports

| Subpath | Artifact | Purpose |
|---|---|---|
| `.` | `lib/index.js`, `lib/index.d.ts` | Host plugin; default export is `BtwService` (`src/service.ts`) |
| `./client` | `lib/client.js` | Browser module, wrapped in `window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-btw", ... })` |
| `./types` | `lib/types.js`, `lib/types.d.ts` | Wire contract types plus `btwTopicSchema` |
| `./package.json` | `package.json` | Manifest, used by the loader |

`./client` has no `types` condition; the browser build is JavaScript only.

## Bundle patch and profile composition

`package.json` declares:

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-api-remotes",
      "@deepseek-ai/dsh-client-ui-renderer",
      "@deepseek-ai/dsh-client-ui-session",
      "@deepseek-ai/dsh-client-ui-sidebar-right",
      "@deepseek-ai/dsh-client-ui-commands",
      "@deepseek-ai/dsh-client-ui-input-trigger"
    ],
    "platform": "web"
  }
}
```

`cordis.patch.yml` is the whole bundle patch:

```yaml
- insert:
    - id: btw
      name: '@deepseek-ai/dsh-btw'
```

So mounting the bundle inserts one plugin named `btw`, loading `lib/index.js`. The
`dsh.client` block declares the browser-module dependencies and restricts the client
to the **web** platform; the Web client loader resolves `lib/client.js`, which mounts
the Remote contribution, the right-sidebar tab, the `/btw` command, and the input
trigger.

## Listing the bundle in a profile

A profile is a directory under `$DSH_HOME/profiles/<name>` with a `package.json`
(and its installed dependencies), a `cordis.patch.yml`, and usually a
`pnpm-lock.yaml`. List BTW **after** the base and web-app bundles, and give it a
`link:` dependency so local builds are used:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-btw"
      ]
    }
  },
  "dependencies": {
    "@deepseek-ai/dsh-btw": "link:/absolute/path/to/dsh-btw/packages/dsh-btw"
  }
}
```

The verified test profile is at `.tmp/dsh-home/profiles/btwtest`; its `package.json`
contains exactly this shape (with additional bundles) and the link dependency.

Composition order at startup: each bundle's patch, then the profile's
`cordis.patch.yml`, then `--patch` overlays. The profile's own patch is the place for
config overrides, not for re-inserting BTW.

## Build and typecheck

Run from the repository root:

```sh
npm run build       # -> tsdown host, tsdown client, scripts/wrap-client.mjs
npm run typecheck   # -> tsc -p tsconfig.host.json --noEmit
                    #    tsc -p tsconfig.client.json --noEmit
```

Equivalent package-level scripts: `npm run build -w @deepseek-ai/dsh-btw` and
`npm run typecheck -w @deepseek-ai/dsh-btw`.

`scripts/wrap-client.mjs` wraps `lib/client.js` once; re-running it is a no-op when
the file already starts with `window.__ModuleLoader__`. `scripts/generate-typert.mjs`
is **not** part of `npm run build`; it generates Host Typert artifacts only (see
`compatibility.md`).

## Verified test profile

```sh
DSH_HOME=$PWD/.tmp/dsh-home dsh --profile btwtest --port 3091 --no-open
```

Observed startup line: `dsh web: http://127.0.0.1:3091/?token=...`. The profile lives
at `.tmp/dsh-home/profiles/btwtest`; its `cordis.patch.yml` also inserts the manual
e2e probe `btw-probe` from `.tmp/btw-probe.mjs`.

## Restart requirement

The Host reads bundle patches and plugin code at process start, and the browser
loader caches the client module. After changing `packages/dsh-btw` (or the profile
`package.json` / bundles list):

1. `npm run build`
2. restart the profile process (`dsh --profile ...`)
3. refresh the Web page

Changing only the profile's `cordis.patch.yml` still needs a restart. Client-plugin
HMR applies only when `pnpm run dev:web` is running from the DSH checkout; a normal
workflow is rebuild + restart + refresh.
