#!/usr/bin/env bash
# Build the Jan .deb installer (Linux only).
#
# Output: src-tauri/target/release/bundle/deb/Jan_<version>_<arch>.deb
#
# Uses Tauri's built-in `deb` bundler ONLY. AppImage (and its linuxdeploy /
# appimagetool downloads) is skipped, so this is faster and lighter than
# `yarn build:tauri:linux`.
#
# Smart skips: every stage is skipped if its output already exists, so re-running
# is cheap. Pass --force to rebuild everything.
#
# Usage:
#   src-tauri/build-utils/buildDeb.sh [--clean] [--force] [--skip-install] [-h|--help]
#
# Flags:
#   --clean         Remove the previous .deb output directory first.
#   --force         Re-download binaries & rebuild jan-cli/core/icons.
#   --skip-install  Assume JS dependencies are already installed.
#
# Prerequisites:
#   - Node.js + Yarn 4 (Berry). Enable first, e.g.:
#         nvm use node && corepack enable
#   - Rust toolchain (rustup).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

CLEAN=0
FORCE=0
SKIP_INSTALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)        CLEAN=1 ;;
    --force)        FORCE=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

C="\033[1;36m"; G="\033[1;32m"; Y="\033[1;33m"; R="\033[1;31m"; N="\033[0m"
say()  { printf "${C}==>%s %s${N}\n" "$(date +%H:%M:%S)" "$*"; }
ok()   { printf "${G}  ok %s${N}\n" "$*"; }
warn() { printf "${Y}  !  %s${N}\n" "$*"; }
die()  { printf "${R}  x  %s${N}\n" "$*" >&2; exit 1; }

command -v node  >/dev/null || die "node not found. Run: nvm use node"
command -v yarn  >/dev/null || die "yarn not found. Run: nvm use node && corepack enable"
command -v cargo >/dev/null || die "cargo not found. Install Rust via https://rustup.rs"
if ! yarn --version 2>/dev/null | grep -qE '^[2-4]\.'; then
  warn "Yarn $(yarn --version) detected; this repo needs Yarn 4 (Berry). Run: corepack enable"
fi

# need <path>  -> true (needs building) when --force OR path is missing
need() { [[ $FORCE -eq 1 ]] || [[ ! -e "$1" ]]; }

# 1. JS dependencies
if [[ $SKIP_INSTALL -eq 0 && ! -d node_modules ]]; then
  say "Installing JS dependencies (yarn install)..."
  yarn install
else
  ok "node_modules present (skip yarn install)"
fi

# 2. Core library (web-app imports @janhq/core)
if need core/dist; then
  say "Building @janhq/core..."
  yarn build:core
else
  ok "core/dist present"
fi

# 3. Bundled extensions (pre-install/*.tgz are shipped inside the deb)
if [[ $FORCE -eq 1 ]] || ! ls pre-install/*.tgz >/dev/null 2>&1; then
  say "Building extensions..."
  yarn build:extensions
else
  ok "pre-install/*.tgz present"
fi

# 4. App icons
if need src-tauri/icons/128x128.png; then
  say "Generating icons..."
  yarn build:icon
else
  ok "icons present"
fi

# 5. Copy LICENSE + extension tarballs into src-tauri/resources
say "Copying assets (LICENSE + pre-install tgz)..."
yarn copy:assets:tauri

# 6. Runtime binaries (bun, uv, sqlite-vec)
if need src-tauri/resources/bin/bun; then
  say "Downloading runtime binaries (bun, uv, sqlite-vec)..."
  yarn download:bin
else
  ok "resources/bin/bun present"
fi

# 7. jan-cli (bundled as a deb resource)
if need src-tauri/resources/bin/jan-cli; then
  say "Building jan-cli..."
  make build-cli
else
  ok "jan-cli present"
fi

# 8. Optional clean of previous deb output
DEB_DIR="src-tauri/target/release/bundle/deb"
if [[ $CLEAN -eq 1 && -d "$DEB_DIR" ]]; then
  say "Removing previous deb output..."
  rm -rf "$DEB_DIR"
fi

# 9. Tauri build (deb only)
say "Building .deb (tauri build --bundles deb)..."
NO_STRIP=1 yarn tauri build --bundles deb

# 10. Report
DEB="$(find "$DEB_DIR" -maxdepth 1 -name '*.deb' -print -quit 2>/dev/null || true)"
[[ -n "$DEB" ]] || die "No .deb produced in $DEB_DIR"
ok "Built: $DEB"
printf "\nInstall with:\n  sudo apt install ./%s\n" "$DEB"
