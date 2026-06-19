# AGENTS.md

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
