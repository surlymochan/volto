#!/usr/bin/env bash
# volto — install the botd runtime on an executor host.
#
# Usage: scripts/install-botd.sh <ssh-alias> [--prefix ~/.volto-botd]
#                               [--ensure-node] [--dry-run]
#
# The script talks to the executor host over ssh and nowhere else. It never
# installs anything system wide, never runs sudo and never prints environment
# variables. Each step prints exactly one status line.
#
# Steps:
#   1 preflight   the host must run node >= 22.18
#   2 node        only with --ensure-node and only when the host has no node
#                 24: install a private node 24 into <prefix>/node
#   3 directories create <prefix>/app and <prefix>/bin on the host
#   4 sync        copy botd/ (without test/, node_modules/ and .tmp/) into <prefix>/app
#   5 wrapper     install the <prefix>/bin/botd launcher
#   6 link        symlink ~/.local/bin/botd to <prefix>/bin/botd
#   7 verify      run `botd --version` on the host
#
# The node step only exists when a private node is really installed, so a host
# that already runs node 24 keeps the six steps and the six status lines it
# always had.
#
# The node rules:
#   * below 22.18 the host cannot run the typed sources — --experimental-strip-
#     types needs node >= 22.18 — and the install stops with a clear message
#   * between 22.18 and 23.x the install continues with a "node 24 recommended"
#     warning, node 24 is the version the project targets
#   * --ensure-node installs a private node 24 into <prefix>/node when the
#     host has no node 24: the official tarball from nodejs.org/dist, its
#     checksum verified against the published SHASUMS256.txt, unpacked into
#     the prefix only. No sudo, no system wide change, no global setting is
#     touched. The launcher then prefers <prefix>/node/bin/node.
#
# The launcher runs `node --experimental-strip-types <prefix>/app/src/main.ts`.
# src/main.ts ships with botd itself; this script never creates it.

set -euo pipefail

PROG=${0##*/}
DEFAULT_PREFIX='~/.volto-botd'
# The oldest node that can run the typed sources: --experimental-strip-types
# needs node >= 22.18.
MIN_NODE_VERSION='22.18'
# The node release the project targets.
TARGET_NODE_MAJOR=24
TARGET_NODE_VERSION='24.0.0'
# The node release --ensure-node installs. VOLTO_NODE_VERSION may point at
# another 24.x patch release.
NODE_VERSION=${VOLTO_NODE_VERSION:-v24.3.0}
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
Usage: $PROG <ssh-alias> [--prefix <dir>] [--ensure-node] [--dry-run]

Install the volto botd runtime on an executor host over ssh.

  <ssh-alias>     host to install on, as understood by ssh(1)
  --prefix <dir>  install root on the host (default: $DEFAULT_PREFIX);
                  must be an absolute path or start with "~/"
  --ensure-node   when the host has no node $TARGET_NODE_MAJOR, install a private
                  node $TARGET_NODE_MAJOR into <prefix>/node: the official tarball
                  from nodejs.org/dist, its checksum verified against the
                  published SHASUMS256.txt. Nothing is installed system wide,
                  sudo is never used and the launcher prefers
                  <prefix>/node/bin/node. Hosts below node $MIN_NODE_VERSION and
                  hosts without any node are supported with this flag.
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

# version_lt <a> <b> — true when the dotted version a is older than b.
version_lt() {
  local a=$1 b=$2 i x y
  local -a av bv
  IFS=. read -r -a av <<< "$a"
  IFS=. read -r -a bv <<< "$b"
  for i in 0 1 2; do
    x=${av[i]:-0}
    y=${bv[i]:-0}
    x=${x%%[!0-9]*}
    y=${y%%[!0-9]*}
    [ -n "$x" ] || x=0
    [ -n "$y" ] || y=0
    if [ "$x" -lt "$y" ]; then
      return 0
    fi
    if [ "$x" -gt "$y" ]; then
      return 1
    fi
  done
  return 1
}

# platform_for <uname -s> <uname -m> — the nodejs.org platform name, for
# example linux-x64. Only the platforms node ships a tarball for are
# accepted.
platform_for() {
  local os=${1:-} arch=${2:-} platform
  case $os in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) return 1 ;;
  esac
  case $arch in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) return 1 ;;
  esac
  platform="$os-$arch"
  case $platform in
    linux-x64|linux-arm64|darwin-arm64) printf '%s' "$platform" ;;
    *) return 1 ;;
  esac
}

# The script that runs on the host: download the official node tarball, check
# it against the published SHASUMS256.txt and unpack it into <prefix>/node.
# It is fed to the host through stdin and takes the destination, the scratch
# directory, the release and the platform as arguments.
#
# Nothing outside the prefix is touched, sudo is never used and nothing is
# deleted: the downloaded tarball stays in <prefix>/.node-tmp.
remote_node_script() {
  cat <<'REMOTE_EOF'
set -eu

dest=$1
scratch=$2
version=$3
platform=$4

file="node-$version-$platform.tar.gz"
base="https://nodejs.org/dist/$version"

mkdir -p -- "$scratch"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 3 -o "$scratch/$file" "$base/$file" ||
    { echo "download failed: $base/$file" >&2; exit 3; }
  curl -fsSL --retry 3 -o "$scratch/SHASUMS256.txt" "$base/SHASUMS256.txt" ||
    { echo "download failed: $base/SHASUMS256.txt" >&2; exit 3; }
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$scratch/$file" "$base/$file" ||
    { echo "download failed: $base/$file" >&2; exit 3; }
  wget -q -O "$scratch/SHASUMS256.txt" "$base/SHASUMS256.txt" ||
    { echo "download failed: $base/SHASUMS256.txt" >&2; exit 3; }
else
  echo "the host has neither curl nor wget" >&2
  exit 3
fi

expected=''
while read -r sum name rest; do
  if [ "$name" = "$file" ]; then
    expected=$sum
    break
  fi
done < "$scratch/SHASUMS256.txt"
if [ -z "$expected" ]; then
  echo "no checksum for $file in SHASUMS256.txt" >&2
  exit 4
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$scratch/$file")
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$scratch/$file")
else
  echo "the host has neither sha256sum nor shasum" >&2
  exit 3
fi
actual=${actual%% *}

if [ "$expected" != "$actual" ]; then
  echo "checksum mismatch for $file: expected $expected, got $actual" >&2
  exit 4
fi

mkdir -p -- "$dest"
tar -xzf "$scratch/$file" -C "$dest" --strip-components=1 ||
  { echo "cannot unpack $file" >&2; exit 5; }

if [ ! -x "$dest/bin/node" ]; then
  echo "the unpacked archive has no bin/node" >&2
  exit 6
fi

"$dest/bin/node" --version
REMOTE_EOF
}

print_plan() {
  local alias=$1 prefix=$2 ensure_node=$3 total=$STEP_COUNT dir=2
  if [ "$ensure_node" -eq 1 ]; then
    total=7
    dir=3
  fi
  printf 'plan: install botd on %s\n' "$alias"
  printf '  prefix: %s\n' "$prefix"
  printf '  [1/%d] preflight: check node >= %s on %s (ssh)\n' "$total" "$MIN_NODE_VERSION" "$alias"
  if [ "$ensure_node" -eq 1 ]; then
    printf '  [2/%d] node: install a private node %s into %s/node when the host has no node %s (official tarball, checksum verified)\n' \
      "$total" "$TARGET_NODE_MAJOR" "$prefix" "$TARGET_NODE_MAJOR"
  fi
  printf '  [%d/%d] directories: create %s/app and %s/bin on %s\n' "$dir" "$total" "$prefix" "$prefix" "$alias"
  printf '  [%d/%d] sync: copy botd/ (excluding test/ and node_modules/) into %s/app\n' "$((dir + 1))" "$total" "$prefix"
  printf '  [%d/%d] wrapper: install %s/bin/botd\n' "$((dir + 2))" "$total" "$prefix"
  printf '  [%d/%d] link: symlink ~/.local/bin/botd -> %s/bin/botd\n' "$((dir + 3))" "$total" "$prefix"
  printf '  [%d/%d] verify: run `botd --version` on %s\n' "$((dir + 4))" "$total" "$alias"
}

main() {
  local alias='' prefix=$DEFAULT_PREFIX dry_run=0 ensure_node=0

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
      --ensure-node)
        ensure_node=1
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
  case $NODE_VERSION in
    v24.*) ;;
    *) die "VOLTO_NODE_VERSION must be a node $TARGET_NODE_MAJOR release (v${TARGET_NODE_MAJOR}.x.y): $NODE_VERSION" ;;
  esac

  if [ "$dry_run" -eq 1 ]; then
    print_plan "$alias" "$prefix" "$ensure_node"
    exit 0
  fi

  # 1 — preflight: the host needs node >= 22.18 to run the typed sources.
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

  # Read the node version of the host: below 22.18 the typed sources cannot
  # run, below 24 the project asks for a newer node.
  local node_num='' node_too_old=0 node24_missing=0
  if [ -z "$node_version" ]; then
    node_too_old=1
    node24_missing=1
  else
    case $node_version in
      v[0-9]*) node_num=${node_version#v} ;;
      *) fail_step preflight "cannot read the node version: $node_version" ;;
    esac
    if version_lt "$node_num" "$MIN_NODE_VERSION.0"; then
      node_too_old=1
    fi
    if version_lt "$node_num" "$TARGET_NODE_VERSION"; then
      node24_missing=1
    fi
  fi

  if [ "$node_too_old" -eq 1 ] && [ "$ensure_node" -eq 0 ]; then
    if [ -z "$node_version" ]; then
      fail_step preflight "node was not found on $alias (node >= $MIN_NODE_VERSION is required, --ensure-node installs a private node $TARGET_NODE_MAJOR)"
    fi
    fail_step preflight "node $node_version is older than $MIN_NODE_VERSION (--experimental-strip-types needs node >= $MIN_NODE_VERSION, --ensure-node installs a private node $TARGET_NODE_MAJOR)"
  fi

  if [ -z "$remote_home" ]; then
    fail_step preflight "cannot resolve the home directory on $alias"
  fi

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

  # A private node is installed as its own step, so the plan grows a step.
  if [ "$ensure_node" -eq 1 ] && [ "$node24_missing" -eq 1 ]; then
    STEP_COUNT=7
  fi

  # The preflight line reports the node of the host.
  if [ -z "$node_version" ]; then
    if [ "$ensure_node" -eq 1 ] && [ "$node24_missing" -eq 1 ]; then
      step preflight "ok (no node on $alias, a private node $TARGET_NODE_MAJOR is installed next)"
    else
      step preflight "ok (no node on $alias)"
    fi
  elif [ "$node24_missing" -eq 1 ]; then
    step preflight "ok (node $node_version, node $TARGET_NODE_MAJOR recommended)"
  else
    step preflight "ok (node $node_version)"
  fi

  # 2 — node: only with --ensure-node and only when the host has no node 24.
  # The private node lives in the prefix, nothing outside it is touched.
  local private_node=0 private_version='' node_dest='' node_bin=''
  if [ "$ensure_node" -eq 1 ] && [ "$node24_missing" -eq 1 ]; then
    local probe host_os='' host_arch='' platform
    if ! probe=$(ssh "$alias" "uname -s; uname -m"); then
      fail_step node "cannot read the platform of $alias"
    fi
    host_os=$(printf '%s\n' "$probe" | head -n 1)
    host_arch=$(printf '%s\n' "$probe" | tail -n 1)
    if ! platform=$(platform_for "$host_os" "$host_arch"); then
      fail_step node "unsupported platform: ${host_os:-unknown}-${host_arch:-unknown} (supported: linux-x64, linux-arm64, darwin-arm64)"
    fi

    node_dest="$prefix_abs/node"
    node_bin="$node_dest/bin/node"
    local node_scratch="$prefix_abs/.node-tmp"
    local node_out='' node_status=0
    node_out=$(remote_node_script | ssh "$alias" "sh -s -- $(shq "$node_dest") $(shq "$node_scratch") $(shq "$NODE_VERSION") $(shq "$platform")" 2>&1) || node_status=$?
    if [ "$node_status" -ne 0 ]; then
      fail_step node "cannot install node $NODE_VERSION on $alias: $(summarize "$node_out")"
    fi
    private_version=$(printf '%s\n' "$node_out" | tail -n 1)
    case $private_version in
      v24.*) ;;
      *) fail_step node "the private node reports '$private_version', expected v$TARGET_NODE_MAJOR.x" ;;
    esac
    private_node=1
  fi

  if [ "$private_node" -eq 1 ]; then
    step node "ok (node $private_version in $prefix/node)"
  fi

  local app_dir="$prefix_abs/app"
  local bin_dir="$prefix_abs/bin"
  local wrapper="$bin_dir/botd"
  local link_dir="$remote_home/.local/bin"
  local link_path="$link_dir/botd"

  # 3 — directories.
  if ! ssh "$alias" "mkdir -p $(shq "$app_dir") $(shq "$bin_dir")"; then
    fail_step directories "cannot create $prefix/app and $prefix/bin"
  fi
  step directories "ok ($prefix/app, $prefix/bin)"

  # 4 — sync the botd sources. rsync keeps the host in sync exactly; tar over
  # ssh is the fallback for hosts without rsync. The scratch directories of the
  # tests never travel to the host.
  local sync_tool
  if [ "$remote_rsync" -eq 1 ] && command -v rsync >/dev/null 2>&1; then
    sync_tool=rsync
    if ! rsync -az --delete --exclude 'test/' --exclude 'node_modules/' --exclude '.tmp/' \
      "$SRC_DIR/" "$alias:$app_dir/"; then
      fail_step sync "rsync to $alias failed"
    fi
  else
    sync_tool=tar
    if ! tar -C "$REPO_DIR" --exclude='botd/test' --exclude='botd/node_modules' --exclude='botd/.tmp' -czf - botd \
      | ssh "$alias" "mkdir -p $(shq "$app_dir") && tar -xzf - -C $(shq "$app_dir") --strip-components=1"; then
      fail_step sync "tar over ssh to $alias failed"
    fi
  fi
  step sync "ok ($sync_tool, excluding test/ and node_modules/)"

  # 5 — the launcher. It is written to a temporary file and moved into place
  # so a half written wrapper is never executable. With a private node the
  # launcher prefers it and falls back to the host node.
  local wrapper_body
  if [ "$private_node" -eq 1 ]; then
    wrapper_body=$(cat <<EOF
#!/bin/sh
# botd launcher — generated by scripts/install-botd.sh, do not edit by hand.
# Prefer the private node of --ensure-node, fall back to the node of the host.
if [ -x $(shq "$node_bin") ]; then
  exec $(shq "$node_bin") --experimental-strip-types $(shq "$app_dir/src/main.ts") "\$@"
fi
exec node --experimental-strip-types $(shq "$app_dir/src/main.ts") "\$@"
EOF
)
  else
    wrapper_body=$(cat <<EOF
#!/bin/sh
# botd launcher — generated by scripts/install-botd.sh, do not edit by hand.
exec node --experimental-strip-types $(shq "$app_dir/src/main.ts") "\$@"
EOF
)
  fi
  if ! printf '%s\n' "$wrapper_body" \
    | ssh "$alias" "cat > $(shq "$wrapper.tmp") && chmod 0755 $(shq "$wrapper.tmp") && mv -f $(shq "$wrapper.tmp") $(shq "$wrapper")"; then
    fail_step wrapper "cannot install $prefix/bin/botd"
  fi
  step wrapper "ok ($prefix/bin/botd)"

  # 6 — put the launcher on the default PATH of the host user.
  if ! ssh "$alias" "mkdir -p $(shq "$link_dir") && ln -sfn $(shq "$wrapper") $(shq "$link_path")"; then
    fail_step link "cannot link ~/.local/bin/botd"
  fi
  step link "ok (~/.local/bin/botd)"

  # 7 — verify the launcher really runs on the host.
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
