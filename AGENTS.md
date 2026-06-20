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
