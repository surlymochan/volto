# Two-host collaboration demo

From the repository root, use Node.js 24 with native TypeScript stripping. Run Claude Code on your own machine, with its local provider login, and install botd and Codex on a remote SSH host with Codex logged in there:

```sh
scripts/install-botd.sh <codex-ssh-alias>
export REMOTE_CODEX=<codex-ssh-alias>
node botd/demo/collab.mjs
```

`REMOTE_CLAUDE` defaults to `local`; `REMOTE_CODEX` is required. Claude bots run only on the local machine and must never be installed, logged in, or configured on a remote host. Codex and pi bots run only on remote SSH hosts; `local` is rejected for them.

The relay connects to remote hosts through SSH, and the providers need permission to create files and run tests. The demo automatically approves provider permission requests. Claude is asked to create a temporary directory, implement and test `slugify`, and return both files. Its answer is sent to the independently routed Codex reviewer. The reviewer returns a PASS or FAIL verdict. A missing verdict is reported as UNKNOWN and fails the run. The script prints the turns and writes `botd/demo/out/<timestamp>/summary.json` and `transcript.ndjson`. Transcripts can contain prompts, code, and provider output; treat them as private. Host display names are REMOTE_A and REMOTE_B.

Offline, no SSH or provider login is required:

```sh
node botd/demo/collab.mjs --fake
node --test botd/demo/test/*.test.mjs
```

The fake mode drives the real adapters and scripted fake provider in-process, without a daemon or HTTP listener, so it works where loopback listening is unavailable. Its transcript records the provider messages in frame-shaped entries; real runs record actual relay wire frames. The fake replies are canned and do not implement or review code. Use `--out <directory>` to choose a different output directory.
