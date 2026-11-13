# Two-host collaboration demo

From the repository root, use Node.js 24 with native TypeScript stripping. Install botd on two distinct SSH hosts, with Claude Code installed and logged in on the first, and Codex installed and logged in on the second:

```sh
scripts/install-botd.sh <claude-ssh-alias>
scripts/install-botd.sh <codex-ssh-alias>
export REMOTE_CLAUDE=<claude-ssh-alias>
export REMOTE_CODEX=<codex-ssh-alias>
node botd/demo/collab.mjs
```

To run Claude locally and Codex on an SSH host, install botd on the remote host and run:

```sh
REMOTE_CLAUDE=local REMOTE_CODEX=<ssh-alias> node botd/demo/collab.mjs
```

Either bot can use `local`, but the two host values must be distinct. A local bot uses the machine's own provider login.

The relay connects to remote hosts through SSH, and the providers need permission to create files and run tests. The demo automatically approves provider permission requests. Claude is asked to create a temporary directory, implement and test `slugify`, and return both files. Its answer is sent to the independently routed Codex reviewer. The reviewer returns a PASS or FAIL verdict. A missing verdict is reported as UNKNOWN and fails the run. The script prints the turns and writes `botd/demo/out/<timestamp>/summary.json` and `transcript.ndjson`. Transcripts can contain prompts, code, and provider output; treat them as private. Host display names are REMOTE_A and REMOTE_B.

Offline, no SSH or provider login is required:

```sh
node botd/demo/collab.mjs --fake
node --test botd/demo/test/*.test.mjs
```

The fake mode drives the real adapters and scripted fake provider in-process, without a daemon or HTTP listener, so it works where loopback listening is unavailable. Its transcript records the provider messages in frame-shaped entries; real runs record actual relay wire frames. The fake replies are canned and do not implement or review code. Use `--out <directory>` to choose a different output directory.
