#!/usr/bin/env bash
# Install the client as a per-user macOS LaunchAgent.
set -euo pipefail

PROG=${0##*/}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SRC_DIR="$SCRIPT_DIR/../client-ui"
LABEL=com.volto.client
prefix="$HOME/.volto-client"
hosts=''
port=8795
mode=install
render_dir=''
step_index=0
STEP_COUNT=5

die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 2; }
step() { step_index=$((step_index + 1)); printf '[%d/%d] %s: %s\n' "$step_index" "$STEP_COUNT" "$1" "$2"; }
fail_step() { step "$1" "FAILED ($2)"; exit 1; }
usage() {
  printf 'Usage: %s [--prefix <dir>] [--hosts <file>] [--port <port>] [--dry-run | --render-only <dir>] [--uninstall]\n' "$PROG"
}
expand_path() {
  case $1 in
    '~') printf '%s' "$HOME" ;;
    '~/'*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$PWD" "$1" ;;
  esac
}
xml() {
  local s=$1
  s=${s//&/\&amp;}; s=${s//</\&lt;}; s=${s//>/\&gt;}
  s=${s//\"/\&quot;}; s=${s//\'/\&apos;}
  printf '%s' "$s"
}

while [ $# -gt 0 ]; do
  case $1 in
    --prefix|--hosts|--port|--render-only)
      [ $# -ge 2 ] || die "$1 needs a value"
      case $1 in
        --prefix) prefix=$2 ;;
        --hosts) hosts=$2 ;;
        --port) port=$2 ;;
        --render-only) [ "$mode" = install ] || die 'conflicting modes'; mode=render; render_dir=$2 ;;
      esac
      shift 2 ;;
    --dry-run) [ "$mode" = install ] || die 'conflicting modes'; mode=dry; shift ;;
    --uninstall) [ "$mode" = install ] || die 'conflicting modes'; mode=uninstall; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

prefix=$(expand_path "$prefix")
plist="$HOME/Library/LaunchAgents/$LABEL.plist"
log_dir="$HOME/Library/Logs/volto"
if [ "$mode" = uninstall ]; then
  STEP_COUNT=2
  # A missing or unloaded agent is already stopped.
  launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  step bootout 'ok'
  if [ -e "$plist" ]; then
    backup="$plist.uninstalled.$(date +%s).$$"
    mv -- "$plist" "$backup" || fail_step uninstall 'cannot move the plist aside'
  fi
  step uninstall 'ok (plist removed)'
  exit 0
fi

case $port in ''|*[!0-9]*) die 'port must be a number between 1 and 65535' ;; esac
[ "${#port}" -le 5 ] || die 'port must be a number between 1 and 65535'
port=$((10#$port))
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die 'port must be a number between 1 and 65535'
[ -d "$SRC_DIR" ] || die 'client-ui/ is missing'
entry=serve.mjs
[ ! -f "$SRC_DIR/relay.mjs" ] || entry=relay.mjs
if [ -n "$hosts" ] && [ "$entry" != relay.mjs ]; then
  fail_step preflight '--hosts requires client-ui/relay.mjs; serve.mjs does not accept a hosts file'
fi
if [ "$mode" = dry ]; then
  step preflight 'check node >= 24 and hosts file'
  step directories 'create client and log directories'
  step sync 'copy client-ui/ excluding test/, test-support/ and .tmp/'
  step plist 'render and validate the LaunchAgent'
  step bootstrap 'load the LaunchAgent'
  exit 0
fi

node_bin=$(command -v node 2>/dev/null) || fail_step preflight 'node >= 24 is required'
case $node_bin in /*) ;; *) fail_step preflight 'node must resolve to an absolute path' ;; esac
node_version=$("$node_bin" --version 2>/dev/null) || fail_step preflight 'cannot read node version; node >= 24 is required'
if [[ ! $node_version =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)([^0-9].*)?$ ]] || [ "${BASH_REMATCH[1]}" -lt 24 ]; then
  fail_step preflight 'node >= 24 is required'
fi
if [ -n "$hosts" ]; then
  hosts=$(expand_path "$hosts")
  [ -f "$hosts" ] && [ -r "$hosts" ] || fail_step preflight 'hosts file is missing or unreadable'
fi
step preflight 'ok (node >= 24)'

if [ "$mode" = render ]; then
  plist="$(expand_path "$render_dir")/$LABEL.plist"
  mkdir -p -- "$(dirname -- "$plist")" || fail_step directories 'cannot create render directory'
  step directories 'ok (render directory)'
  step sync 'skipped (render only)'
else
  mkdir -p -- "$prefix" "$log_dir" "$(dirname -- "$plist")" || fail_step directories 'cannot create directories'
  step directories 'ok'
  if ! (cd "$SRC_DIR" && tar --exclude='./test' --exclude='./test-support' --exclude='./.tmp' -cf - .) | (cd "$prefix" && tar -xf -); then
    fail_step sync 'cannot copy client-ui/'
  fi
  step sync 'ok'
fi

# Only the hosts file path, never its contents, belongs in the plist. relay.mjs reads `--hosts <file>`.
hosts_args=''
[ -z "$hosts" ] || hosts_args="    <string>--hosts</string><string>$(xml "$hosts")</string>"
if ! {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$node_bin")</string>
    <string>$(xml "$prefix/$entry")</string>
    <string>--port</string><string>$port</string>
$hosts_args
  </array>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml "$log_dir/client.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$log_dir/client.error.log")</string>
PLIST
  printf '</dict>\n</plist>\n'
} > "$plist"; then
  fail_step plist 'cannot write plist'
fi
plutil -lint "$plist" >/dev/null 2>&1 || fail_step plist 'plist validation failed'
step plist 'ok'
if [ "$mode" = render ]; then
  step bootstrap 'skipped (render only)'
else
  launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 || fail_step bootstrap 'launchctl bootstrap failed'
  step bootstrap 'ok'
fi
