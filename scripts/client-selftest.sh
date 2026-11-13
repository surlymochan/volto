#!/usr/bin/env bash
# Offline tests for the client installer. All scratch files stay in the repo.
set -uo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
SCRATCH="$REPO_DIR/botd/.tmp/client-selftest.$$"
BIN="$SCRATCH/bin"
FAKE_HOME="$SCRATCH/home"
OUT="$SCRATCH/out"
LOG="$SCRATCH/launchctl.log"
checks=0
failures=0
mkdir -p -- "$BIN" "$FAKE_HOME"
cat > "$BIN/node" <<'SHIM'
#!/bin/sh
printf '%s\n' "${FAKE_NODE_VERSION:-v24.3.0}"
SHIM
cat > "$BIN/plutil" <<'SHIM'
#!/bin/sh
[ "$1" = -lint ] && [ -s "$2" ]
SHIM
cat > "$BIN/launchctl" <<'SHIM'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_LAUNCHCTL_LOG"
SHIM
chmod +x "$BIN/node" "$BIN/plutil" "$BIN/launchctl"
export PATH="$BIN:$PATH" HOME="$FAKE_HOME" FAKE_LAUNCHCTL_LOG="$LOG"
INSTALL="$SCRIPT_DIR/install-client.sh"
check() {
  local description=$1
  shift
  checks=$((checks + 1))
  if "$@"; then printf 'ok %d - %s\n' "$checks" "$description"; else
    printf 'not ok %d - %s\n' "$checks" "$description"; failures=$((failures + 1))
  fi
}
contains() { grep -F -q -- "$2" "$1"; }
missing() { [ ! -e "$1" ]; }
not_contains() { ! contains "$@"; }
run() { bash "$INSTALL" "$@" > "$OUT" 2>&1; }

check 'dry run succeeds' run --dry-run
check 'dry run lists five steps' test "$(grep -c '^\[[1-5]/5\]' "$OUT")" -eq 5
check 'dry run does not call launchctl' missing "$LOG"
check 'dry run does not create prefix' missing "$HOME/.volto-client"
mkdir -p "$SCRATCH/render"
printf 'secret-content\n' > "$SCRATCH/hosts & one.json"
check 'render-only succeeds' run --prefix "$SCRATCH/client & app" --hosts "$SCRATCH/hosts & one.json" --port 9000 --render-only "$SCRATCH/render"
PLIST="$SCRATCH/render/com.volto.client.plist"
check 'render-only does not call launchctl' missing "$LOG"
check 'rendered label' contains "$PLIST" '<string>com.volto.client</string>'
check 'absolute node path' contains "$PLIST" "$BIN/node"
entry=serve.mjs
[ ! -f "$REPO_DIR/client-ui/relay.mjs" ] || entry=relay.mjs
check 'selected entry point and escaped prefix' contains "$PLIST" "client &amp; app/$entry"
check 'port is passed' contains "$PLIST" '<string>--port</string><string>9000</string>'
check 'keep alive enabled' contains "$PLIST" '<key>KeepAlive</key><true/>'
check 'throttle configured' contains "$PLIST" '<key>ThrottleInterval</key><integer>10</integer>'
check 'logs use user library' contains "$PLIST" "$HOME/Library/Logs/volto/client.log"
check 'hosts path is escaped' contains "$PLIST" 'hosts &amp; one.json'
check 'hosts contents are absent' not_contains "$PLIST" 'secret-content'
check 'render-only does not copy files' missing "$SCRATCH/client & app"
check 'install succeeds' run --prefix "$SCRATCH/installed"
INSTALLED="$HOME/Library/LaunchAgents/com.volto.client.plist"
check 'installed plist exists' test -f "$INSTALLED"
check 'hosts environment omitted by default' not_contains "$INSTALLED" 'BOTD_HOSTS_FILE'
check 'client entry copied' test -f "$SCRATCH/installed/$entry"
check 'tests excluded' missing "$SCRATCH/installed/test"
check 'test support excluded' missing "$SCRATCH/installed/test-support"
check 'scratch excluded' missing "$SCRATCH/installed/.tmp"
check 'launch agent bootstrapped' contains "$LOG" 'bootstrap gui/'
check 'uninstall succeeds' run --uninstall
check 'uninstall removes plist' missing "$INSTALLED"
check 'uninstall stops agent' contains "$LOG" 'bootout gui/'
FAKE_NODE_VERSION=v23.9.0
export FAKE_NODE_VERSION
if run --render-only "$SCRATCH/old"; then
  printf 'not ok - old node unexpectedly accepted\n'; failures=$((failures + 1))
else
  check 'old node rejected' contains "$OUT" 'FAILED'
  check 'old node error names minimum' contains "$OUT" 'node >= 24'
fi
unset FAKE_NODE_VERSION
if run --hosts "$SCRATCH/missing" --render-only "$SCRATCH/missing-render"; then
  printf 'not ok - missing hosts unexpectedly accepted\n'; failures=$((failures + 1))
else
  check 'missing hosts rejected' contains "$OUT" 'FAILED'
  check 'missing hosts error is clear' contains "$OUT" 'hosts file is missing or unreadable'
fi
mkdir -p "$SCRATCH/fallback/scripts" "$SCRATCH/fallback/client-ui"
cp "$INSTALL" "$SCRATCH/fallback/scripts/install-client.sh"
cp "$REPO_DIR/client-ui/serve.mjs" "$SCRATCH/fallback/client-ui/serve.mjs"
if bash "$SCRATCH/fallback/scripts/install-client.sh" --render-only "$SCRATCH/fallback/render" > "$OUT" 2>&1; then
  check 'serve entry selected when relay is absent' contains "$SCRATCH/fallback/render/com.volto.client.plist" '/serve.mjs'
else
  printf 'not ok - fallback render failed\n'; failures=$((failures + 1))
fi
printf '\n%d checks, %d failures\n' "$checks" "$failures"
[ "$failures" -eq 0 ]
