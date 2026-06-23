# AGENTS.md

## Toolchain prerequisites

The `yarn` commands below rely on **Yarn 4.5.3**, pinned via the
`packageManager` field in `package.json`. Yarn 4 is provided by **corepack**,
which is bundled with Node.js (not installed separately).

> ⚠️ **Use Node 26.** This repo does **not** work with the Node 25 that is the
> `nvm` default on this machine — that build ships Yarn **1.22.22** and **no
> `corepack` binary**, so every `yarn` command aborts with:
> `error This project's package.json defines "packageManager": "yarn@4.5.3".
> However the current global version of Yarn is 1.22.22.`
> Node **26.3.0** ships Yarn **4.5.3** + corepack **0.35.0** out of the box, so
> no extra setup is needed once it is active.

### Exact steps (copy-paste, works in non-interactive agent shells)

`nvm` is **not** loaded automatically in non-interactive shells — it must be
sourced first, otherwise you get `nvm: command not found`:

```bash
# 1. Load nvm (required once per shell — it is NOT on PATH by default here)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# 2. Switch to Node 26 (→ node v26.3.0, yarn 4.5.3, corepack 0.35.0)
nvm use 26

# 3. Sanity check — all three should now be the right versions
node -v && yarn --version && corepack --version
```

If you still see the `packageManager` mismatch error after this, the shell fell
back to Node 25 — re-run `nvm use 26` (or prefix each command with
`nvm exec 26 yarn ...`). Do **not** run `corepack enable` / `npm i -g corepack`;
the Node 26 install already provides it.

### Typecheck (no dedicated script)

There is no `typecheck` script — run the TypeScript compiler directly in the
`web-app` workspace:

```bash
yarn workspace @janhq/web-app exec tsc -b
```

## Verification commands

Run these before considering work done.

```bash
# Rust (desktop crate, default features) — compile + unit tests
cargo build --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features test-tauri -- --test-threads=1

# Web app — lint + typecheck + unit tests
yarn lint
yarn test:web          # vitest for @janhq/web-app

# Build the standalone web UI (served by the Rust web server)
yarn build:core
yarn build:webui       # cross-env IS_WEB_APP=true vite build
```

See `CONTRIBUTING.md` for the full test matrix (`make test`).

### Known pre-existing web test failures (do NOT investigate these)

`yarn test:web` has a stable set of failures on the clean `HEAD` tree that are
**environmental, not caused by your changes**. They were verified pre-existing
by stashing the changes and re-running — the failing set was identical. Do not
waste time stash-and-retesting to "confirm"; diff your failure list against
this instead.

**Baseline on clean tree (Node 26.3.0, vitest 3.2.4):**
```
Test Files  17 failed | 190 passed (207)
Tests       147 failed | 2438 passed (2585)
```
If your totals match (or your new failures are a strict subset after excluding
new tests you added), your changes are clean. The web-app Rust build, lint,
and typecheck gates are unaffected and have **zero** pre-existing failures.

**Root causes (all 3 are test-setup issues, not product bugs):**

1. **`localStorage` is `undefined` in the jsdom env (15 files, ~140 tests).**
   These test files call `localStorage.clear()` / `setItem` / `getItem` in a
   `beforeEach` or the test body, but `web-app/src/test/setup.ts` does not
   install a `localStorage` polyfill and the configured jsdom version does not
   expose it as a working global. Symptom:
   `TypeError: Cannot read properties of undefined (reading 'clear'|'setItem'|'getItem')`.
   A real fix would be to add a `localStorage` stub to `src/test/setup.ts`, but
   that is out of scope for most tasks.

2. **`src/utils/__tests__/formatDate.test.ts`** — a timezone/locale-dependent
   date assertion: `expected 'Dec 31, 1899, 7:00 PM' to match /Jan.*1.*1900/i`.
   Fails on non-UTC machines; passes in CI's UTC env.

3. **`src/services/models/__tests__/default.test.ts`** — a `localStorage`
   fallback assertion that goes down the wrong branch because of cause #1.

**Affected files (all 17):**
```
web-app/src/containers/__tests__/SetupScreen.test.tsx
web-app/src/hooks/__tests__/useAgentMode.test.ts
web-app/src/hooks/__tests__/useAssistant.coverage.test.ts
web-app/src/hooks/__tests__/useClaudeCodeModel.test.ts
web-app/src/hooks/__tests__/useDownloadStore.test.ts
web-app/src/hooks/__tests__/useLocalApiServer.coverage.test.ts
web-app/src/hooks/__tests__/useModelProvider.coverage.test.ts
web-app/src/hooks/__tests__/useModelProvider.test.ts
web-app/src/hooks/__tests__/useThreads.test.ts
web-app/src/hooks/__tests__/useToolAvailable.coverage.test.ts
web-app/src/services/models/__tests__/default.test.ts
web-app/src/services/projects/__tests__/default.coverage.test.ts
web-app/src/services/projects/__tests__/default.test.ts
web-app/src/services/__tests__/index.coverage.test.ts
web-app/src/services/window/__tests__/tauri.test.ts
web-app/src/utils/__tests__/formatDate.test.ts
web-app/src/utils/__tests__/getModelToStart.test.ts
```

**Fast path to verify *your* change:** run only the test file(s) covering your
edited code, e.g.:
```bash
NODE_OPTIONS=--max-old-space-size=4096 yarn exec vitest run \
  --project @janhq/web-app \
  src/hooks/__tests__/useRemoteFiles.test.ts src/containers/__tests__/ChatInput.test.tsx
```
(node: `--cwd` is not a valid vitest flag here — the monorepo uses the root
vitest with `--project @janhq/web-app` and positional path filters.)

## Web interface (phone access)

The desktop app can additionally serve a web UI over the LAN. Configure it in
**Settings → Web Server**: set a password, pick host `0.0.0.0`, Start. Then:

```bash
yarn build:webui                     # builds web-app/dist (IS_WEB_APP=true)
```

Open `http://<this-computer-LAN-IP>:8181` on the phone and sign in.

Architecture: a second hyper server (`src-tauri/src/core/web_server/`) runs
inside the Tauri process. It serves the static web UI build + `POST /api/invoke`
(a JSON dispatch mirroring Tauri's `invoke()`) reusing the existing
threads / providers / filesystem command implementations. A single password
gates `/api/*` via a signed session cookie. Inference is **proxied server-side**
through `POST /api/proxy`: the web UI forwards provider requests (with
`X-Jan-Provider` + `X-Jan-Target-Url` headers) and the server applies the
provider's stored key chain + streams the response back, so API keys never
reach the browser and the llama.cpp / OpenAI-compatible server need not allow
CORS. Provider/model settings are **shared** with the desktop via the backend's
persisted `<jan_data_folder>/providers.json`
(`src-tauri/src/core/server/provider_store.rs`); the desktop writes through
(`web-app/src/lib/provider-backend-sync.ts`) and the web UI reads/writes via
`listProviderConfigs`/`registerProviderConfig` (keys redacted on the web path).
