#!/usr/bin/env bash
# volto — install the botd runtime on an executor host.
#
# Usage: scripts/install-botd.sh <ssh-alias> [--prefix ~/.volto-botd] [--dry-run]
#
# The script talks to the executor host over ssh and nowhere else. It never
# installs anything system wide, never runs sudo and never prints environment
# variables. Each step prints exactly one status line.
#
# Steps:
#   1 preflight   the host must run node >= 22
#   2 directories create <prefix>/app and <prefix>/bin on the host
#   3 sync        copy botd/ (without test/ and node_modules/) into <prefix>/app
#   4 wrapper     install the <prefix>/bin/botd launcher
#   5 link        symlink ~/.local/bin/botd to <prefix>/bin/botd
#   6 verify      run `botd --version` on the host
#
# The launcher runs `node --experimental-strip-types <prefix>/app/src/main.ts`.
# src/main.ts ships with botd itself; this script never creates it.

set -euo pipefail

PROG=${0##*/}
DEFAULT_PREFIX='~/.volto-botd'
MIN_NODE_MAJOR=22
STEP_COUNT=6

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
SRC_DIR="$REPO_DIR/botd"

# Ask the host for the few facts we need in one round trip. The reply is one
# KEY=value pair per line; the values are used internally and never printed
# except for the node version.
PREFLIGHT_CMD='if command -v node >/dev/null 2>&1; then printf "NODE=%s\n" "$(node --version 2>/dev/null)"; else printf "NODE=\n"; fi; printf "HOME=%s\n" "$HOME"; if command -v rsync >/dev/null 2>&1; then printf "RSYNC=1\n"; else printf "RSYNC=0\n"; fi; if command -v tar >/dev/null 2>&1; then printf "TAR=1\n"; else printf "TAR=0\n"; fi'

step_index=0

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 2
}

usage() {
  cat <<EOF
Usage: $PROG <ssh-alias> [--prefix <dir>] [--dry-run]

Install the volto botd runtime on an executor host over ssh.

  <ssh-alias>     host to install on, as understood by ssh(1)
  --prefix <dir>  install root on the host (default: $DEFAULT_PREFIX);
                  must be an absolute path or start with "~/"
  --dry-run       print the plan and do not connect to the host
EOF
}

# Quote a string so the host shell reads it as a single word.
shq() {
  local s=$1
  s=${s//\'/\'\\\'\'}
  printf "'%s'" "$s"
}

# One status line per step.
step() {
  step_index=$((step_index + 1))
  printf '[%d/%d] %s: %s\n' "$step_index" "$STEP_COUNT" "$1" "$2"
}

fail_step() {
  step "$1" "FAILED ($2)"
  exit 1
}

# First line of a command output, shortened so a chatty remote cannot flood
# the log.
summarize() {
  local text=${1%%$'\n'*}
  if [ "${#text}" -gt 120 ]; then
    text="${text:0:117}..."
  fi
  printf '%s' "$text"
}

print_plan() {
  local alias=$1 prefix=$2
  printf 'plan: install botd on %s\n' "$alias"
  printf '  prefix: %s\n' "$prefix"
  printf '  [1/%d] preflight: check node >= %d on %s (ssh)\n' "$STEP_COUNT" "$MIN_NODE_MAJOR" "$alias"
  printf '  [2/%d] directories: create %s/app and %s/bin on %s\n' "$STEP_COUNT" "$prefix" "$prefix" "$alias"
  printf '  [3/%d] sync: copy botd/ (excluding test/ and node_modules/) into %s/app\n' "$STEP_COUNT" "$prefix"
  printf '  [4/%d] wrapper: install %s/bin/botd\n' "$STEP_COUNT" "$prefix"
  printf '  [5/%d] link: symlink ~/.local/bin/botd -> %s/bin/botd\n' "$STEP_COUNT" "$prefix"
  printf '  [6/%d] verify: run `botd --version` on %s\n' "$STEP_COUNT" "$alias"
}

main() {
  local alias='' prefix=$DEFAULT_PREFIX dry_run=0

  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        [ $# -ge 2 ] || die "--prefix needs a value"
        prefix=$2
        shift 2
        ;;
      --prefix=*)
        prefix=${1#--prefix=}
        shift
        ;;
      --dry-run)
        dry_run=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      --)
        shift
        break
        ;;
      -*)
        die "unknown option: $1"
        ;;
      *)
        [ -z "$alias" ] || die "unexpected argument: $1"
        alias=$1
        shift
        ;;
    esac
  done

  if [ $# -gt 0 ]; then
    [ -z "$alias" ] || die "unexpected argument: $1"
    alias=$1
    shift
  fi

  [ -n "$alias" ] || { usage >&2; die "missing <ssh-alias>"; }
  case $alias in
    *[[:space:]]*) die "ssh alias must not contain whitespace" ;;
  esac
  case $prefix in
    *[[:space:]]*) die "prefix must not contain whitespace" ;;
  esac
  case $prefix in
    /*|'~'|'~/'*|'$HOME'|'$HOME/'*) ;;
    *) die "prefix must be an absolute path or start with ~/: $prefix" ;;
  esac
  [ -d "$SRC_DIR" ] || die "botd/ not found next to this script ($SRC_DIR)"

  if [ "$dry_run" -eq 1 ]; then
    print_plan "$alias" "$prefix"
    exit 0
  fi

  # 1 — preflight: the host needs node >= 22 to run the typed sources.
  local preflight_out remote_home='' node_version='' remote_rsync=0 line
  if ! preflight_out=$(ssh "$alias" "$PREFLIGHT_CMD"); then
    fail_step preflight "ssh to $alias failed"
  fi
  while IFS= read -r line; do
    case $line in
      HOME=*) remote_home=${line#HOME=} ;;
      NODE=*) node_version=${line#NODE=} ;;
      RSYNC=1) remote_rsync=1 ;;
    esac
  done <<< "$preflight_out"

  if [ -z "$node_version" ]; then
    fail_step preflight "node was not found on $alias"
  fi
  local node_major=${node_version#v}
  node_major=${node_major%%.*}
  case $node_major in
    ''|*[!0-9]*) fail_step preflight "cannot read the node version: $node_version" ;;
  esac
  if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
    fail_step preflight "node $node_version is older than $MIN_NODE_MAJOR"
  fi
  if [ -z "$remote_home" ]; then
    fail_step preflight "cannot resolve the home directory on $alias"
  fi
  step preflight "ok (node $node_version)"

  # Turn the requested prefix into an absolute path on the host.
  local prefix_abs
  case $prefix in
    '~') prefix_abs=$remote_home ;;
    '~/'*) prefix_abs="$remote_home/${prefix#\~/}" ;;
    '$HOME') prefix_abs=$remote_home ;;
    '$HOME/'*) prefix_abs="$remote_home/${prefix#\$HOME/}" ;;
    /*) prefix_abs=$prefix ;;
  esac
  if [ ${#prefix_abs} -gt 1 ]; then
    prefix_abs=${prefix_abs%/}
  fi

  local app_dir="$prefix_abs/app"
  local bin_dir="$prefix_abs/bin"
  local wrapper="$bin_dir/botd"
  local link_dir="$remote_home/.local/bin"
  local link_path="$link_dir/botd"

  # 2 — directories.
  if ! ssh "$alias" "mkdir -p $(shq "$app_dir") $(shq "$bin_dir")"; then
    fail_step directories "cannot create $prefix/app and $prefix/bin"
  fi
  step directories "ok ($prefix/app, $prefix/bin)"

  # 3 — sync the botd sources. rsync keeps the host in sync exactly; tar over
  # ssh is the fallback for hosts without rsync.
  local sync_tool
  if [ "$remote_rsync" -eq 1 ] && command -v rsync >/dev/null 2>&1; then
    sync_tool=rsync
    if ! rsync -az --delete --exclude 'test/' --exclude 'node_modules/' \
      "$SRC_DIR/" "$alias:$app_dir/"; then
      fail_step sync "rsync to $alias failed"
    fi
  else
    sync_tool=tar
    if ! tar -C "$REPO_DIR" --exclude='botd/test' --exclude='botd/node_modules' -czf - botd \
      | ssh "$alias" "mkdir -p $(shq "$app_dir") && tar -xzf - -C $(shq "$app_dir") --strip-components=1"; then
      fail_step sync "tar over ssh to $alias failed"
    fi
  fi
  step sync "ok ($sync_tool, excluding test/ and node_modules/)"

  # 4 — the launcher. It is written to a temporary file and moved into place
  # so a half written wrapper is never executable.
  local wrapper_body
  wrapper_body=$(cat <<EOF
#!/bin/sh
# botd launcher — generated by scripts/install-botd.sh, do not edit by hand.
exec node --experimental-strip-types $(shq "$app_dir/src/main.ts") "\$@"
EOF
)
  if ! printf '%s\n' "$wrapper_body" \
    | ssh "$alias" "cat > $(shq "$wrapper.tmp") && chmod 0755 $(shq "$wrapper.tmp") && mv -f $(shq "$wrapper.tmp") $(shq "$wrapper")"; then
    fail_step wrapper "cannot install $prefix/bin/botd"
  fi
  step wrapper "ok ($prefix/bin/botd)"

  # 5 — put the launcher on the default PATH of the host user.
  if ! ssh "$alias" "mkdir -p $(shq "$link_dir") && ln -sfn $(shq "$wrapper") $(shq "$link_path")"; then
    fail_step link "cannot link ~/.local/bin/botd"
  fi
  step link "ok (~/.local/bin/botd)"

  # 6 — verify the launcher really runs on the host.
  local version_out version_line
  if ! version_out=$(ssh "$alias" "PATH=$(shq "$link_dir"):\$PATH botd --version 2>&1"); then
    fail_step verify "botd --version failed: $(summarize "$version_out")"
  fi
  version_line=$(summarize "$version_out")
  if [ -z "$version_line" ]; then
    fail_step verify "botd --version printed nothing"
  fi
  step verify "ok ($version_line)"
}

main "$@"
