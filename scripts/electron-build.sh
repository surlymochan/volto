#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s --dir|--dmg\n' "$0"
}

if [ "$#" -ne 1 ] || { [ "$1" != '--dir' ] && [ "$1" != '--dmg' ]; }; then
  usage >&2
  exit 1
fi
mode=$1

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf 'Node >= 24 and npm are required.\n' >&2
  exit 1
fi
node_version=$(node --version)
if [[ ! $node_version =~ ^v([0-9]+)\. ]] || [ "${BASH_REMATCH[1]}" -lt 24 ]; then
  printf 'Node >= 24 is required.\n' >&2
  exit 1
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [ ! -f "$repo_root/client-ui/electron/main.js" ]; then
  printf 'Missing Electron entry point: client-ui/electron/main.js\n' >&2
  exit 1
fi

builder_args=(--projectDir "$repo_root" --config "$repo_root/client-ui/electron/builder.config.json")
if [ "$mode" = '--dir' ]; then
  builder_args+=(--mac --arm64 --dir)
else
  builder_args+=(--mac dmg --arm64)
fi

if [ -n "${VOLTO_MAC_IDENTITY:-}" ]; then
  builder_args+=("--config.mac.identity=$VOLTO_MAC_IDENTITY")
else
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi
if [ "${VOLTO_NOTARIZE:-0}" = 1 ]; then
  if [ -z "${VOLTO_MAC_IDENTITY:-}" ] || [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
    printf 'Notarization requires VOLTO_MAC_IDENTITY, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID.\n' >&2
    exit 1
  fi
  builder_args+=(--config.mac.notarize=true)
elif [ "${VOLTO_NOTARIZE:-0}" != 0 ]; then
  printf 'VOLTO_NOTARIZE must be 0 or 1.\n' >&2
  exit 1
fi

build_tmp=$(mktemp -d /tmp/volto-electron-build.XXXXXX)
trap 'rm -rf "$build_tmp"' EXIT
npm install --prefix "$build_tmp" --no-save electron electron-builder
electron_version=$(node -p 'require(process.argv[1]).version' "$build_tmp/node_modules/electron/package.json")
builder_args+=("--config.electronVersion=$electron_version")
"$build_tmp/node_modules/.bin/electron-builder" "${builder_args[@]}"

if [ -z "${VOLTO_MAC_IDENTITY:-}" ]; then
  printf 'For the first open of an unsigned app, right-click the app, choose Open, and confirm in Gatekeeper.\n'
fi
