#!/usr/bin/env bash
# volto — offline self test for scripts/install-botd.sh.
#
# The installer is exercised many times: with --dry-run (no host is contacted)
# and against a fake host. The fake host is a set of shims on PATH: a fake
# `ssh` that records every command it is given and emulates the remote
# shell, a fake `rsync` that records its arguments, a fake `node` that
# answers --version, a fake `uname` that answers the platform and a fake
# `curl` that serves a tiny node tarball together with its SHASUMS256.txt.
# The self test then asserts the commands that were issued, the files that
# were installed and the error paths.
#
# The covered cases: a host with node 24, a host with node 22 (the warning),
# a host with a node below 22.18 (the refusal), the installation of a
# private node 24 with --ensure-node, a checksum that does not match (the
# abort) and the dry run.
#
# Everything happens inside the repository: the scratch directory lives in
# botd/.tmp (botd/.gitignore already ignores it) and nothing is ever deleted —
# directories that have to disappear are moved aside instead.

set -uo pipefail

PROG=${0##*/}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
INSTALL="$SCRIPT_DIR/install-botd.sh"

SCRATCH="$REPO_DIR/botd/.tmp/selftest.$$"
SHIM_DIR="$SCRATCH/bin"
FAKE_HOME="$SCRATCH/home"
FIXTURES="$SCRATCH/fixtures"
FIXTURES_BAD="$SCRATCH/fixtures-bad"
OUT="$SCRATCH/out"
ERR="$SCRATCH/err"

# The node release the fixtures pretend to be.
NODE_RELEASE=v24.3.0
NODE_PLATFORM=linux-x64
NODE_TARBALL="node-$NODE_RELEASE-$NODE_PLATFORM.tar.gz"

ALIAS=executor-selftest
PREFIX='~/.volto-botd'

failures=0
checks=0

# One log file per test case: a case that must not call ssh simply has no
# log file at all.
SSH_LOG=''
RSYNC_LOG=''
CURL_LOG=''
log_seq=0

pass() {
  checks=$((checks + 1))
  printf 'ok %d - %s\n' "$checks" "$1"
}

fail() {
  checks=$((checks + 1))
  failures=$((failures + 1))
  printf 'not ok %d - %s\n' "$checks" "$1"
}

cleanup() {
  # Nothing is deleted: the scratch directory is moved into botd/.tmp.
  if [ -d "$SCRATCH" ]; then
    mkdir -p -- "$REPO_DIR/botd/.tmp/graveyard"
    mv -- "$SCRATCH" "$REPO_DIR/botd/.tmp/graveyard/selftest.$$" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# reset_logs — start a new set of log files for the next test case.
reset_logs() {
  log_seq=$((log_seq + 1))
  SSH_LOG="$SCRATCH/ssh.$log_seq.log"
  RSYNC_LOG="$SCRATCH/rsync.$log_seq.log"
  CURL_LOG="$SCRATCH/curl.$log_seq.log"
}

# move_aside <path> — move a path out of the way instead of deleting it.
move_aside() {
  local path=$1 name target n=0
  [ -e "$path" ] || return 0
  mkdir -p -- "$SCRATCH/aside"
  name=$(basename -- "$path")
  target="$SCRATCH/aside/$name"
  while [ -e "$target" ]; do
    n=$((n + 1))
    target="$SCRATCH/aside/$name.$n"
  done
  mv -- "$path" "$target"
}

# assert_status <expected> <actual> <description>
assert_status() {
  if [ "$1" = "$2" ]; then
    pass "$3 (exit $2)"
  else
    fail "$3 (expected exit $1, got $2)"
  fi
}

# assert_contains <description> <file> <fixed string>
assert_contains() {
  if grep -qF -- "$3" "$2" 2>/dev/null; then
    pass "$1"
  else
    fail "$1 (missing: $3)"
  fi
}

# assert_not_contains <description> <file> <fixed string>
assert_not_contains() {
  if grep -qF -- "$3" "$2" 2>/dev/null; then
    fail "$1 (unexpected: $3)"
  else
    pass "$1"
  fi
}

# assert_matches <description> <file> <extended regex>
assert_matches() {
  if grep -qE -- "$3" "$2" 2>/dev/null; then
    pass "$1"
  else
    fail "$1 (no match for: $3)"
  fi
}

# assert_not_matches <description> <file> <extended regex>
assert_not_matches() {
  if grep -qE -- "$3" "$2" 2>/dev/null; then
    fail "$1 (unexpected match for: $3)"
  else
    pass "$1"
  fi
}

# assert_count <expected> <file> <extended regex> <description>
assert_count() {
  local found
  found=$(grep -cE -- "$3" "$2" 2>/dev/null || true)
  if [ "$found" = "$1" ]; then
    pass "$4 ($found)"
  else
    fail "$4 (expected $1, got $found)"
  fi
}

# assert_exists <description> <path>
assert_exists() {
  if [ -e "$2" ]; then
    pass "$1"
  else
    fail "$1 (missing: $2)"
  fi
}

# assert_absent <description> <path>
assert_absent() {
  if [ -e "$2" ]; then
    fail "$1 (unexpected: $2)"
  else
    pass "$1"
  fi
}

# assert_executable <description> <path>
assert_executable() {
  if [ -x "$2" ]; then
    pass "$1"
  else
    fail "$1 (not executable: $2)"
  fi
}

# assert_symlink <description> <path> <target>
assert_symlink() {
  if [ ! -L "$2" ]; then
    fail "$1 (not a symlink: $2)"
    return
  fi
  local target
  target=$(readlink -- "$2")
  if [ "$target" = "$3" ]; then
    pass "$1"
  else
    fail "$1 (points at $target, expected $3)"
  fi
}

write_shims() {
  mkdir -p -- "$SHIM_DIR" "$FAKE_HOME"

  cat > "$SHIM_DIR/ssh" <<'SHIM'
#!/usr/bin/env bash
# Fake ssh: records the call and emulates the remote host.
#
#   - the preflight question is answered with the facts of the fake host: the
#     fake `node` shim answers the node version, the fake home is the home
#     of the host
#   - `botd --version` is answered with a canned version
#   - every other command is run locally, so file effects are observable
set -uo pipefail

log=${FAKE_SSH_LOG:?}
fake_home=${FAKE_HOME:?}
remote_rsync=${FAKE_RSYNC:-1}

alias=${1-}
cmd=${2-}

printf '%s\t%s\n' "$alias" "$(printf '%s' "$cmd" | tr '\n' ' ')" >> "$log"

case $cmd in
  *NODE=*)
    node_version=$(node --version 2>/dev/null || true)
    printf 'HOME=%s\nNODE=%s\nRSYNC=%s\nTAR=1\n' "$fake_home" "$node_version" "$remote_rsync"
    exit 0
    ;;
esac

case $cmd in
  *botd\ --version*)
    printf 'botd 0.0.0-selftest\n'
    exit 0
    ;;
esac

HOME="$fake_home" sh -c "$cmd"
SHIM

  cat > "$SHIM_DIR/rsync" <<'SHIM'
#!/usr/bin/env bash
# Fake rsync: records the arguments and pretends the copy worked.
set -uo pipefail

log=${FAKE_RSYNC_LOG:?}
printf '%s\n' "$*" >> "$log"
exit 0
SHIM

  cat > "$SHIM_DIR/node" <<'SHIM'
#!/usr/bin/env bash
# Fake node: answers --version like the node of the fake host. An empty
# FAKE_NODE_VERSION means that the host has no node at all.
set -uo pipefail

case ${1:-} in
  --version|-v)
    if [ -z "${FAKE_NODE_VERSION:-}" ]; then
      exit 127
    fi
    printf '%s\n' "$FAKE_NODE_VERSION"
    ;;
  *)
    printf 'fake node\n'
    ;;
esac
SHIM

  cat > "$SHIM_DIR/uname" <<'SHIM'
#!/usr/bin/env bash
# Fake uname: answers -s and -m like the platform of the fake host.
set -uo pipefail

case ${1:-} in
  -s) printf '%s\n' "${FAKE_UNAME_SYSTEM:-Linux}" ;;
  -m) printf '%s\n' "${FAKE_UNAME_MACHINE:-x86_64}" ;;
  *) printf '%s\n' "${FAKE_UNAME_SYSTEM:-Linux}" ;;
esac
SHIM

  cat > "$SHIM_DIR/curl" <<'SHIM'
#!/usr/bin/env bash
# Fake curl: serves the files of the fixture directory and records every url
# it was asked for. A file that is not in the fixture directory is a 404, the
# same way the real curl fails.
set -uo pipefail

log=${FAKE_CURL_LOG:?}
dir=${FAKE_CURL_DIR:?}

out=''
url=''
while [ $# -gt 0 ]; do
  case $1 in
    -o|--output) out=${2:-}; shift 2 ;;
    --retry|--connect-timeout|--max-time) shift 2 ;;
    -H|--header) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done

printf '%s\t%s\n' "$url" "$out" >> "$log"

if [ -z "$out" ] || [ -z "$url" ]; then
  printf 'curl: no output file or url\n' >&2
  exit 2
fi

name=${url##*/}
src="$dir/$name"
if [ ! -f "$src" ]; then
  printf 'curl: (22) The requested URL returned error: 404: %s\n' "$url" >&2
  exit 22
fi

cp -- "$src" "$out"
SHIM

  chmod +x "$SHIM_DIR/ssh" "$SHIM_DIR/rsync" "$SHIM_DIR/node" "$SHIM_DIR/uname" "$SHIM_DIR/curl"
}

# write_fixtures — a tiny node tarball and the checksums that go with it.
write_fixtures() {
  local root="node-$NODE_RELEASE-$NODE_PLATFORM"
  local src="$SCRATCH/fixture-src/$root"
  local sum

  mkdir -p -- "$src/bin" "$FIXTURES" "$FIXTURES_BAD"
  cat > "$src/bin/node" <<EOF
#!/bin/sh
# Fake node of the fixture tarball: it only knows its own version.
printf '%s\n' '$NODE_RELEASE'
EOF
  chmod +x "$src/bin/node"

  tar -czf "$FIXTURES/$NODE_TARBALL" -C "$SCRATCH/fixture-src" "$root"

  if command -v sha256sum >/dev/null 2>&1; then
    sum=$(sha256sum "$FIXTURES/$NODE_TARBALL")
  else
    sum=$(shasum -a 256 "$FIXTURES/$NODE_TARBALL")
  fi
  sum=${sum%% *}
  printf '%s  %s\n' "$sum" "$NODE_TARBALL" > "$FIXTURES/SHASUMS256.txt"

  # The same tarball, but with a checksum that does not match.
  cp -- "$FIXTURES/$NODE_TARBALL" "$FIXTURES_BAD/$NODE_TARBALL"
  printf '%s  %s\n' \
    '0000000000000000000000000000000000000000000000000000000000000000' \
    "$NODE_TARBALL" > "$FIXTURES_BAD/SHASUMS256.txt"
}

# run_install <output file> [args...] — runs the installer with the shims.
run_install() {
  local out=$1
  shift
  PATH="$SHIM_DIR:$PATH" \
    FAKE_SSH_LOG="$SSH_LOG" \
    FAKE_RSYNC_LOG="$RSYNC_LOG" \
    FAKE_CURL_LOG="$CURL_LOG" \
    FAKE_CURL_DIR="${FAKE_CURL_DIR-$FIXTURES}" \
    FAKE_HOME="$FAKE_HOME" \
    FAKE_NODE_VERSION="${FAKE_NODE_VERSION-v24.3.0}" \
    FAKE_UNAME_SYSTEM="${FAKE_UNAME_SYSTEM-Linux}" \
    FAKE_UNAME_MACHINE="${FAKE_UNAME_MACHINE-x86_64}" \
    FAKE_RSYNC="${FAKE_RSYNC-1}" \
    VOLTO_NODE_VERSION="$NODE_RELEASE" \
    bash "$INSTALL" "$@" > "$out" 2> "$ERR"
  return $?
}

test_dry_run() {
  printf '# dry run\n'
  reset_logs
  run_install "$OUT" "$ALIAS" --prefix "$PREFIX" --dry-run
  local status=$?
  assert_status 0 "$status" 'dry run succeeds'
  assert_contains 'dry run prints the plan' "$OUT" "plan: install botd on $ALIAS"
  assert_contains 'dry run prints the prefix' "$OUT" "prefix: $PREFIX"
  assert_count 6 "$OUT" '^  \[[0-9]/6\]' 'dry run lists one line per step'
  assert_contains 'the plan numbers the preflight' "$OUT" '  [1/6] preflight:'
  assert_contains 'the plan numbers the directories' "$OUT" '  [2/6] directories:'
  assert_contains 'the plan numbers the sync' "$OUT" '  [3/6] sync:'
  assert_contains 'the plan numbers the verify' "$OUT" '  [6/6] verify:'
  assert_contains 'dry run checks the node version' "$OUT" 'check node >= 22'
  assert_contains 'dry run copies the botd directory' "$OUT" 'copy botd/ (excluding test/ and node_modules/)'
  assert_contains 'dry run installs the wrapper' "$OUT" 'install ~/.volto-botd/bin/botd'
  assert_contains 'dry run links the launcher' "$OUT" 'symlink ~/.local/bin/botd'
  assert_contains 'dry run verifies the launcher' "$OUT" 'botd --version'
  assert_absent 'dry run does not call ssh' "$SSH_LOG"
  assert_absent 'dry run does not call rsync' "$RSYNC_LOG"
  assert_absent 'dry run does not call curl' "$CURL_LOG"
  assert_not_matches 'dry run prints no environment variables' "$OUT" '(PATH|HOME|API_KEY|TOKEN|SECRET)='
}

test_dry_run_ensure_node() {
  printf '# dry run with --ensure-node\n'
  reset_logs
  run_install "$OUT" "$ALIAS" --prefix "$PREFIX" --ensure-node --dry-run
  local status=$?
  assert_status 0 "$status" 'the dry run with --ensure-node succeeds'
  assert_count 7 "$OUT" '^  \[[0-9]/7\]' 'the plan lists the node step'
  assert_contains 'the plan numbers the node step' "$OUT" '  [2/7] node:'
  assert_contains 'the plan numbers the directories' "$OUT" '  [3/7] directories:'
  assert_contains 'the plan numbers the verify' "$OUT" '  [7/7] verify:'
  assert_contains 'the plan mentions the private node' "$OUT" 'node: install a private node 24'
  assert_contains 'the plan mentions the prefix of the private node' "$OUT" '~/.volto-botd/node'
  assert_absent 'the dry run does not call ssh' "$SSH_LOG"
  assert_absent 'the dry run does not call curl' "$CURL_LOG"
}

test_install() {
  printf '# install against the fake host\n'
  reset_logs
  run_install "$OUT" "$ALIAS"
  local status=$?
  assert_status 0 "$status" 'install succeeds'
  assert_count 6 "$OUT" '^\[[0-9]/6\]' 'install prints one status line per step'
  assert_matches 'install reports the preflight' "$OUT" '^\[1/6\] preflight: ok \(node v'
  assert_matches 'install reports the sync' "$OUT" '^\[3/6\] sync: ok \('
  assert_matches 'install reports the verification' "$OUT" '^\[6/6\] verify: ok \(botd'

  assert_contains 'the node version is checked over ssh' "$SSH_LOG" 'node --version'
  assert_contains 'the prefix directories are created' "$SSH_LOG" 'mkdir -p'
  assert_contains 'the app directory is created' "$SSH_LOG" "$FAKE_HOME/.volto-botd/app"
  assert_contains 'the wrapper is written' "$SSH_LOG" 'cat >'
  assert_contains 'the launcher is linked' "$SSH_LOG" 'ln -sfn'
  assert_contains 'the version is verified over ssh' "$SSH_LOG" 'botd --version'

  assert_contains 'rsync is used' "$RSYNC_LOG" '-az'
  assert_contains 'rsync copies the botd directory' "$RSYNC_LOG" "$REPO_DIR/botd/"
  assert_contains 'rsync targets the app directory' "$RSYNC_LOG" "$FAKE_HOME/.volto-botd/app/"
  assert_contains 'rsync excludes the tests' "$RSYNC_LOG" '--exclude test/'
  assert_contains 'rsync excludes node_modules' "$RSYNC_LOG" '--exclude node_modules/'
  assert_contains 'rsync excludes the scratch directories' "$RSYNC_LOG" '--exclude .tmp/'

  local wrapper="$FAKE_HOME/.volto-botd/bin/botd"
  assert_exists 'the wrapper is installed' "$wrapper"
  assert_executable 'the wrapper is executable' "$wrapper"
  assert_matches 'the wrapper execs node with type stripping' "$wrapper" '^exec node --experimental-strip-types '
  assert_contains 'the wrapper runs app/src/main.ts' "$wrapper" "$FAKE_HOME/.volto-botd/app/src/main.ts"
  assert_contains 'the wrapper forwards its arguments' "$wrapper" '"$@"'
  assert_absent 'the installer does not create main.ts' "$FAKE_HOME/.volto-botd/app/src/main.ts"
  assert_absent 'no private node is installed without --ensure-node' "$FAKE_HOME/.volto-botd/node"

  assert_symlink 'the launcher is linked into ~/.local/bin' "$FAKE_HOME/.local/bin/botd" "$wrapper"
  assert_not_matches 'install prints no environment variables' "$OUT" '(PATH|HOME|API_KEY|TOKEN|SECRET)='
}

test_idempotent() {
  printf '# second install\n'
  local before="$SCRATCH/wrapper.before"
  cp -- "$FAKE_HOME/.volto-botd/bin/botd" "$before"
  run_install "$OUT" "$ALIAS"
  local status=$?
  assert_status 0 "$status" 'the second install succeeds'
  assert_count 6 "$OUT" '^\[[0-9]/6\]' 'the second install prints one status line per step'
  assert_symlink 'the link survives the second install' "$FAKE_HOME/.local/bin/botd" "$FAKE_HOME/.volto-botd/bin/botd"
  if cmp -s -- "$before" "$FAKE_HOME/.volto-botd/bin/botd"; then
    pass 'the wrapper is unchanged by the second install'
  else
    fail 'the wrapper is unchanged by the second install'
  fi
}

test_old_node() {
  printf '# host with an old node\n'
  move_aside "$FAKE_HOME/.volto-botd"
  move_aside "$FAKE_HOME/.local"
  reset_logs
  FAKE_NODE_VERSION=v20.11.0 run_install "$OUT" "$ALIAS"
  local status=$?
  if [ "$status" -ne 0 ]; then
    pass "an old node is rejected (exit $status)"
  else
    fail 'an old node is rejected'
  fi
  assert_contains 'the rejection names the node version' "$OUT" 'node v20.11.0 is older than 22'
  assert_contains 'the rejection names the minimum version' "$OUT" '22.18'
  assert_contains 'the rejection points at --ensure-node' "$OUT" '--ensure-node'
  assert_absent 'nothing is installed on an old host' "$FAKE_HOME/.volto-botd"
}

test_node_22() {
  printf '# host with node 22\n'
  move_aside "$FAKE_HOME/.volto-botd"
  move_aside "$FAKE_HOME/.local"
  reset_logs
  FAKE_NODE_VERSION=v22.20.0 run_install "$OUT" "$ALIAS"
  local status=$?
  assert_status 0 "$status" 'a host with node 22.20 is accepted'
  assert_count 6 "$OUT" '^\[[0-9]/6\]' 'the install keeps one status line per step'
  assert_matches 'the preflight reports the node of the host' "$OUT" '^\[1/6\] preflight: ok \(node v22\.20\.0'
  assert_contains 'the preflight warns that node 24 is recommended' "$OUT" 'node 24 recommended'
  assert_exists 'the launcher is installed on a node 22 host' "$FAKE_HOME/.volto-botd/bin/botd"
}

test_node_boundary() {
  printf '# host with the oldest supported node\n'
  move_aside "$FAKE_HOME/.volto-botd"
  move_aside "$FAKE_HOME/.local"
  reset_logs
  FAKE_NODE_VERSION=v22.17.9 run_install "$OUT" "$ALIAS"
  local status=$?
  if [ "$status" -ne 0 ]; then
    pass "node 22.17.9 is rejected (exit $status)"
  else
    fail 'node 22.17.9 is rejected'
  fi
  assert_contains 'the rejection names the node version' "$OUT" 'node v22.17.9 is older than 22.18'

  reset_logs
  FAKE_NODE_VERSION=v22.18.0 run_install "$OUT" "$ALIAS"
  status=$?
  assert_status 0 "$status" 'node 22.18.0 is accepted'
  assert_contains 'node 22.18.0 gets the recommendation' "$OUT" 'node 24 recommended'
}

test_ensure_node_already_valid() {
  printf '# install with --ensure-node on a host with node 24\n'
  move_aside "$FAKE_HOME/.volto-botd"
  move_aside "$FAKE_HOME/.local"
  reset_logs
  FAKE_NODE_VERSION=v24.3.0 run_install "$OUT" "$ALIAS" --ensure-node
  local status=$?
  assert_status 0 "$status" 'the install with --ensure-node succeeds on a node 24 host'
  assert_count 6 "$OUT" '^\[[0-9]/6\]' 'a valid host keeps the six steps'
  assert_matches 'the preflight reports the node of the host' "$OUT" '^\[1/6\] preflight: ok \(node v24\.3\.0'
  assert_absent 'no private node is installed' "$FAKE_HOME/.volto-botd/node"
  assert_absent 'nothing is downloaded' "$CURL_LOG"
  assert_not_contains 'the launcher does not know about a private node' "$FAKE_HOME/.volto-botd/bin/botd" '.volto-botd/node/bin/node'
}

test_ensure_node() {
  printf '# install with --ensure-node\n'
  move_aside "$FAKE_HOME/.volto-botd"
  move_aside "$FAKE_HOME/.local"
  reset_logs
  FAKE_NODE_VERSION=v22.20.0 run_install "$OUT" "$ALIAS" --ensure-node
  local status=$?
  assert_status 0 "$status" 'the install with --ensure-node succeeds'
  assert_count 7 "$OUT" '^\[[0-9]/7\]' 'the install prints one status line per step'
  assert_matches 'the preflight reports the node of the host' "$OUT" '^\[1/7\] preflight: ok \(node v22\.20\.0'
  assert_matches 'the node step is reported' "$OUT" '^\[2/7\] node: ok \(node v24\.3\.0'
  assert_matches 'the directories step is reported' "$OUT" '^\[3/7\] directories: ok \('
  assert_matches 'the verify step is reported' "$OUT" '^\[7/7\] verify: ok \(botd'

  assert_exists 'the private node is installed' "$FAKE_HOME/.volto-botd/node/bin/node"
  assert_executable 'the private node is executable' "$FAKE_HOME/.volto-botd/node/bin/node"
  assert_contains 'the tarball comes from nodejs.org' "$CURL_LOG" "https://nodejs.org/dist/$NODE_RELEASE/$NODE_TARBALL"
  assert_contains 'the checksum file comes from nodejs.org' "$CURL_LOG" "https://nodejs.org/dist/$NODE_RELEASE/SHASUMS256.txt"

  local wrapper="$FAKE_HOME/.volto-botd/bin/botd"
  assert_exists 'the wrapper is installed' "$wrapper"
  assert_contains 'the wrapper prefers the private node' "$wrapper" "if [ -x '$FAKE_HOME/.volto-botd/node/bin/node' ]; then"
  assert_contains 'the wrapper runs the private node' "$wrapper" "exec '$FAKE_HOME/.volto-botd/node/bin/node' --experimental-strip-types"
  assert_contains 'the wrapper falls back to the node of the host' "$wrapper" 'exec node --experimental-strip-types '

  assert_not_matches 'no sudo is used on the host' "$SSH_LOG" 'sudo'
  assert_not_matches 'nothing is installed outside the prefix' "$SSH_LOG" '/usr/local|/opt|/etc/'
}

test_ensure_node_checksum() {
  printf '# install with a broken checksum\n'
  move_aside "$FAKE_HOME/.volto-botd"
  move_aside "$FAKE_HOME/.local"
  reset_logs
  FAKE_NODE_VERSION=v22.20.0 FAKE_CURL_DIR="$FIXTURES_BAD" run_install "$OUT" "$ALIAS" --ensure-node
  local status=$?
  if [ "$status" -ne 0 ]; then
    pass "a checksum mismatch aborts the install (exit $status)"
  else
    fail 'a checksum mismatch aborts the install'
  fi
  assert_contains 'the mismatch is reported' "$OUT" 'checksum mismatch'
  assert_contains 'the checksum file was downloaded' "$CURL_LOG" 'SHASUMS256.txt'
  assert_absent 'no private node is installed' "$FAKE_HOME/.volto-botd/node/bin/node"
  assert_absent 'nothing else is installed' "$FAKE_HOME/.volto-botd/app"
}

test_ensure_node_without_host_node() {
  printf '# install with --ensure-node on a host without node\n'
  move_aside "$FAKE_HOME/.volto-botd"
  move_aside "$FAKE_HOME/.local"
  reset_logs
  FAKE_NODE_VERSION='' run_install "$OUT" "$ALIAS" --ensure-node
  local status=$?
  assert_status 0 "$status" 'a host without node is accepted with --ensure-node'
  assert_matches 'the preflight reports the missing node' "$OUT" '^\[1/7\] preflight: ok \(no node on '
  assert_exists 'the private node is installed' "$FAKE_HOME/.volto-botd/node/bin/node"
}

test_ensure_node_unsupported_platform() {
  printf '# install with --ensure-node on an unsupported platform\n'
  move_aside "$FAKE_HOME/.volto-botd"
  move_aside "$FAKE_HOME/.local"
  reset_logs
  FAKE_NODE_VERSION=v22.20.0 FAKE_UNAME_MACHINE=ppc64 run_install "$OUT" "$ALIAS" --ensure-node
  local status=$?
  if [ "$status" -ne 0 ]; then
    pass "an unsupported platform is rejected (exit $status)"
  else
    fail 'an unsupported platform is rejected'
  fi
  assert_contains 'the rejection names the platform' "$OUT" 'unsupported platform'
  assert_absent 'no private node is installed' "$FAKE_HOME/.volto-botd/node/bin/node"
}

test_tar_fallback() {
  printf '# host without rsync\n'
  move_aside "$FAKE_HOME/.volto-botd"
  move_aside "$FAKE_HOME/.local"
  reset_logs
  FAKE_RSYNC=0 run_install "$OUT" "$ALIAS"
  local status=$?
  assert_status 0 "$status" 'the tar fallback succeeds'
  assert_contains 'the tar fallback is reported' "$OUT" 'sync: ok (tar'
  assert_absent 'rsync is not used without rsync on the host' "$RSYNC_LOG"
  assert_exists 'the sources arrive over tar' "$FAKE_HOME/.volto-botd/app/src/router.ts"
  assert_absent 'the tests are not copied' "$FAKE_HOME/.volto-botd/app/test"
}

test_usage() {
  printf '# usage errors\n'
  run_install "$OUT"
  local status=$?
  if [ "$status" -ne 0 ]; then
    pass "a missing host is rejected (exit $status)"
  else
    fail 'a missing host is rejected'
  fi
  assert_contains 'the usage error names the missing host' "$ERR" 'ssh-alias'

  run_install "$OUT" --help
  status=$?
  assert_status 0 "$status" '--help succeeds'
  assert_contains '--help prints the usage' "$OUT" 'Usage:'
  assert_contains '--help documents --ensure-node' "$OUT" '--ensure-node'
}

main() {
  if [ ! -f "$INSTALL" ]; then
    printf 'not ok - %s is missing\n' "$INSTALL" >&2
    exit 1
  fi
  mkdir -p -- "$REPO_DIR/botd/.tmp"
  write_shims
  write_fixtures
  reset_logs

  test_dry_run
  test_dry_run_ensure_node
  test_install
  test_idempotent
  test_old_node
  test_node_22
  test_node_boundary
  test_ensure_node
  test_ensure_node_already_valid
  test_ensure_node_checksum
  test_ensure_node_without_host_node
  test_ensure_node_unsupported_platform
  test_tar_fallback
  test_usage

  printf '\n%d checks, %d failures\n' "$checks" "$failures"
  if [ "$failures" -ne 0 ]; then
    printf '\n--- ssh log ---\n'
    cat -- "$SSH_LOG" 2>/dev/null
    printf '\n--- rsync log ---\n'
    cat -- "$RSYNC_LOG" 2>/dev/null
    printf '\n--- curl log ---\n'
    cat -- "$CURL_LOG" 2>/dev/null
    printf '\n--- output ---\n'
    cat -- "$OUT" 2>/dev/null
    printf '\n--- errors ---\n'
    cat -- "$ERR" 2>/dev/null
    exit 1
  fi
  exit 0
}

main "$@"
