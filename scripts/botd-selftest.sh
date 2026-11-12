#!/usr/bin/env bash
# volto — offline self test for scripts/install-botd.sh.
#
# The installer is exercised twice: once with --dry-run (no host is contacted)
# and once against a fake host. The fake host is a pair of shims on PATH: a
# fake `ssh` that records every command it is given and emulates the remote
# shell, and a fake `rsync` that records its arguments. The self test then
# asserts the commands that were issued, the files that were installed and the
# error paths.
#
# Everything happens inside the repository: the scratch directory lives in
# .tmp/ next to the sources and is removed again when the test ends.

set -uo pipefail

PROG=${0##*/}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
INSTALL="$SCRIPT_DIR/install-botd.sh"

SCRATCH="$REPO_DIR/.tmp/botd-selftest.$$"
SHIM_DIR="$SCRATCH/bin"
FAKE_HOME="$SCRATCH/home"
SSH_LOG="$SCRATCH/ssh.log"
RSYNC_LOG="$SCRATCH/rsync.log"
OUT="$SCRATCH/out"
ERR="$SCRATCH/err"

ALIAS=executor-selftest
PREFIX='~/.volto-botd'

failures=0
checks=0

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
  rm -rf -- "$SCRATCH"
}
trap cleanup EXIT

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
#   - the preflight question is answered with canned values
#   - `botd --version` is answered with a canned version
#   - every other command is run locally, so file effects are observable
set -uo pipefail

log=${FAKE_SSH_LOG:?}
fake_home=${FAKE_HOME:?}
node_version=${FAKE_NODE_VERSION:-v24.3.0}
remote_rsync=${FAKE_RSYNC:-1}

alias=${1-}
cmd=${2-}

printf '%s\t%s\n' "$alias" "$(printf '%s' "$cmd" | tr '\n' ' ')" >> "$log"

case $cmd in
  *NODE=*)
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

  chmod +x "$SHIM_DIR/ssh" "$SHIM_DIR/rsync"
}

# run_install <output file> [args...] — runs the installer with the shims.
run_install() {
  local out=$1
  shift
  PATH="$SHIM_DIR:$PATH" \
    FAKE_SSH_LOG="$SSH_LOG" \
    FAKE_RSYNC_LOG="$RSYNC_LOG" \
    FAKE_HOME="$FAKE_HOME" \
    FAKE_NODE_VERSION=${FAKE_NODE_VERSION:-v24.3.0} \
    FAKE_RSYNC=${FAKE_RSYNC:-1} \
    bash "$INSTALL" "$@" > "$out" 2> "$ERR"
  return $?
}

test_dry_run() {
  printf '# dry run\n'
  rm -f -- "$SSH_LOG" "$RSYNC_LOG"
  run_install "$OUT" "$ALIAS" --prefix "$PREFIX" --dry-run
  local status=$?
  assert_status 0 "$status" 'dry run succeeds'
  assert_contains 'dry run prints the plan' "$OUT" "plan: install botd on $ALIAS"
  assert_contains 'dry run prints the prefix' "$OUT" "prefix: $PREFIX"
  assert_count 6 "$OUT" '^  \[[0-9]/6\]' 'dry run lists one line per step'
  assert_contains 'dry run checks the node version' "$OUT" 'check node >= 22'
  assert_contains 'dry run copies the botd directory' "$OUT" 'copy botd/ (excluding test/ and node_modules/)'
  assert_contains 'dry run installs the wrapper' "$OUT" 'install ~/.volto-botd/bin/botd'
  assert_contains 'dry run links the launcher' "$OUT" 'symlink ~/.local/bin/botd'
  assert_contains 'dry run verifies the launcher' "$OUT" 'botd --version'
  assert_absent 'dry run does not call ssh' "$SSH_LOG"
  assert_absent 'dry run does not call rsync' "$RSYNC_LOG"
  assert_not_matches 'dry run prints no environment variables' "$OUT" '(PATH|HOME|API_KEY|TOKEN|SECRET)='
}

test_install() {
  printf '# install against the fake host\n'
  rm -f -- "$SSH_LOG" "$RSYNC_LOG"
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

  local wrapper="$FAKE_HOME/.volto-botd/bin/botd"
  assert_exists 'the wrapper is installed' "$wrapper"
  assert_executable 'the wrapper is executable' "$wrapper"
  assert_matches 'the wrapper execs node with type stripping' "$wrapper" '^exec node --experimental-strip-types '
  assert_contains 'the wrapper runs app/src/main.ts' "$wrapper" "$FAKE_HOME/.volto-botd/app/src/main.ts"
  assert_contains 'the wrapper forwards its arguments' "$wrapper" '"$@"'
  assert_absent 'the installer does not create main.ts' "$FAKE_HOME/.volto-botd/app/src/main.ts"

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
  rm -rf -- "$FAKE_HOME/.volto-botd" "$FAKE_HOME/.local"
  rm -f -- "$SSH_LOG" "$RSYNC_LOG"
  FAKE_NODE_VERSION=v20.11.0 run_install "$OUT" "$ALIAS"
  local status=$?
  if [ "$status" -ne 0 ]; then
    pass "an old node is rejected (exit $status)"
  else
    fail 'an old node is rejected'
  fi
  assert_contains 'the rejection names the node version' "$OUT" 'node v20.11.0 is older than 22'
  assert_absent 'nothing is installed on an old host' "$FAKE_HOME/.volto-botd"
}

test_tar_fallback() {
  printf '# host without rsync\n'
  rm -rf -- "$FAKE_HOME/.volto-botd" "$FAKE_HOME/.local"
  rm -f -- "$SSH_LOG" "$RSYNC_LOG"
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
}

main() {
  if [ ! -f "$INSTALL" ]; then
    printf 'not ok - %s is missing\n' "$INSTALL" >&2
    exit 1
  fi
  mkdir -p -- "$REPO_DIR/.tmp"
  write_shims

  test_dry_run
  test_install
  test_idempotent
  test_old_node
  test_tar_fallback
  test_usage

  printf '\n%d checks, %d failures\n' "$checks" "$failures"
  if [ "$failures" -ne 0 ]; then
    printf '\n--- ssh log ---\n'
    cat -- "$SSH_LOG" 2>/dev/null
    printf '\n--- rsync log ---\n'
    cat -- "$RSYNC_LOG" 2>/dev/null
    printf '\n--- output ---\n'
    cat -- "$OUT" 2>/dev/null
    printf '\n--- errors ---\n'
    cat -- "$ERR" 2>/dev/null
    exit 1
  fi
  exit 0
}

main "$@"
