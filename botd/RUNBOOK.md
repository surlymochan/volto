# botd runbook

The operator view of **botd**, the volto bot daemon. `botd` runs on an
*executor host*, starts the bot CLIs there and speaks one NDJSON stream with
the control plane. The wire format is specified in
[PROTOCOL.md](PROTOCOL.md); this document is about running the thing.

* [Install botd on an executor host](#install-botd-on-an-executor-host)
* [Check the version](#check-the-version)
* [The bot binaries per adapter](#the-bot-binaries-per-adapter)
* [Leases, acknowledgements and reconnects](#leases-acknowledgements-and-reconnects)
* [The permission policy](#the-permission-policy)
* [Redaction](#redaction)
* [Collecting a debug log](#collecting-a-debug-log)
* [Configuration](#configuration)
* [Common failures](#common-failures)

## Install botd on an executor host

From a clone of this repository:

```sh
bash scripts/install-botd.sh <ssh-alias> [--prefix <dir>] [--dry-run]
```

`<ssh-alias>` is the name of the executor host in the operator's ssh config.
The script talks to that host over ssh and nowhere else: it never installs
anything system wide, never runs `sudo` and never prints environment
variables. `--prefix` defaults to `~/.volto-botd` and has to be an absolute
path or start with `~/`. `--dry-run` prints the plan and exits without
contacting the host.

The installer prints one status line per step:

| step | what it does |
| --- | --- |
| 1 preflight | the host must run `node >= 22` |
| 2 directories | create `<prefix>/app` and `<prefix>/bin` on the host |
| 3 sync | copy `botd/` (without `test/` and `node_modules/`) into `<prefix>/app` |
| 4 wrapper | install the `<prefix>/bin/botd` launcher |
| 5 link | symlink `~/.local/bin/botd` to `<prefix>/bin/botd` |
| 6 verify | run `botd --version` on the host |

The launcher is a two-line shell script; it runs the typed sources of the
daemon with the type stripping of node:

```sh
exec node --experimental-strip-types <prefix>/app/src/main.ts "$@"
```

The install is idempotent: running it a second time leaves the same launcher
in place. To uninstall, remove `<prefix>` and the symlink in
`~/.local/bin/`.

The installer itself has an offline self test (it emulates a host with a
fake `ssh` and a fake `rsync`; no host is contacted):

```sh
bash scripts/botd-selftest.sh
```

## Check the version

On the executor host:

```sh
botd version
botd --version
```

Both print the protocol version of the daemon (`0.1.0`, `BOTD_VERSION` in
[src/protocol.ts](src/protocol.ts)). The installer runs `botd --version` as
its last step, so a successful install already proved that the launcher
works. `botd help` prints the usage with every flag and environment
variable.

## The bot binaries per adapter

One adapter per bot CLI. The adapter starts the CLI in its machine protocol
and translates the output into the events of the protocol. The binary has to
be on the `PATH` of the user that runs the daemon.

| adapter | binary | command botd spawns | protocol |
| --- | --- | --- | --- |
| `claude` | `claude` | `claude -p --input-format stream-json --output-format stream-json --verbose` | stream-json |
| `codex` | `codex` | `codex app-server` | JSON-RPC app-server |
| `dsh` | `dsh` | `dsh --profile acp` | ACP |
| `agy` | `agy` | `agy --acp`, or `agy -p --output-format stream-json` | ACP, with a stream-json fallback |
| `copilot` | `copilot` | `copilot --acp` | ACP |
| `pi` | `pi` | *not in this build* (see below) | pi RPC |

Extra flags the adapters add: `--model <model>`, `--resume <provider
session id>` and `--append-system-prompt <text>` for `claude`, `--model
<model>` for `agy` and `copilot`, `--reasoning-effort <level>` for
`copilot`, and `--resume` plus `--append-system-prompt` for `agy` in its
stream-json mode. `codex` and `dsh` add no flags.

Environment:

* The child process inherits the environment of the daemon
  ([src/session.ts](src/session.ts)), so every CLI has to be logged in as the
  user that runs the daemon. `botd` never puts a credential into `argv` and
  never starts a shell.
* `copilot` ships **disabled**: it needs a paid Copilot seat, so the adapter
  refuses to start the CLI until the operator sets `COPILOT_ENABLED=1` in the
  environment of the daemon.
* `agy` probes `agy --help` once. When the binary mentions ACP the adapter
  uses `agy --acp`, otherwise it falls back to the Claude-compatible
  stream-json mode. `VOLTO_AGY_PROTOCOL=acp` (or `=stream-json`) pins the
  choice.
* `pi` is **not part of this build**: the registry knows the kind, but
  `src/adapters/pi.ts` is missing, so every call fails with "the pi adapter
  is not available in this build". The pi CLI itself speaks `pi --mode rpc`
  (see [../probes/README.md](../probes/README.md)).

## Leases, acknowledgements and reconnects

In operator terms:

* **The control plane holds a lease on the daemon.** It sends `hello` first;
  the daemon answers with the lease id, the fence and the time to live. The
  default TTL is 15 s (`BOTD_LEASE_TTL_MS`), the daemon never goes below
  250 ms.
* **The lease is renewed** with `renew` before the TTL runs out. A renewal
  with an unknown lease id or an old fence is refused (`stale_lease`,
  `stale_fence`).
* **When the TTL runs out, the sessions are paused**: the children stay
  alive, but no input is forwarded any more (`lease_paused`). When the TTL
  runs out a second time (twice the TTL), the children are terminated —
  `SIGTERM` first, `SIGKILL` for the process group after the grace period.
* **A reconnect keeps or breaks the lease, depending on the client id.** A
  `hello` from the same client id keeps the fence and wakes the paused
  sessions. A `hello` from a different client id takes the lease over and
  *bumps the fence*: from then on the frames of the old client are refused
  with `stale_fence`. The fence is what keeps two control planes from
  driving the same host at the same time.
* **Every event of a session carries a sequence number.** The client
  confirms what it processed with `ack` (the highest sequence it handled);
  the daemon stores it in the session table, and the acknowledged sequence is
  what the session log compacts with.
* **A client that lost the connection replays.** It reconnects and asks for
  `resume` with the sequence it wants from. The daemon replays the events
  from its ring buffer — the last 1000 events or 1 MiB per session by
  default (`BOTD_RING_MAX_EVENTS`, `BOTD_RING_MAX_BYTES`). When the events
  were evicted already, the daemon answers with a `gap` frame that names the
  lost range: the client has to accept the loss and start a new task.
* **A daemon restart keeps the metadata, not the events.** The session table
  holds the provider session id, so a new session can be opened with it (the
  `resume` field of the `open` frame) and the bot CLI continues the
  conversation. The events of the dead session are gone; the daemon reports
  them as a gap.
* **Silence is reported.** After 2 s without output a session is `idle`
  (`BOTD_IDLE_MS`); after 30 s without output the daemon sends a `stall`
  frame (`BOTD_STALL_MS`).
* **A cancel escalates.** The provider-native cancel message goes to the
  child first; if it does not answer within 3 s (`BOTD_CANCEL_GRACE_MS`) it
  gets a `SIGINT`, and 3 s later (`BOTD_CANCEL_KILL_GRACE_MS`) the whole
  process group is killed. A child that answers the cancel ends the
  escalation.

## The permission policy

The policy lives in [src/permission.ts](src/permission.ts) and is a pure
function: `decide(request, policy)` answers `allow`, `deny` or `ask`, never
touches the filesystem, and always answers the same for the same request and
the same policy.

A policy is an ordered list of rules plus a default:

```
{ cwd, rules?, denyCommands?, allowCommands?, default? }
```

The precedence is:

1. `denyCommands` — deny, whatever the rules say.
2. the first matching rule — its decision.
3. `allowCommands` — allow.
4. `default` — `ask`, when it is not set.

The reference policy (`referencePolicy(cwd)`) is:

* denied commands: `sudo*`, `git push*`, `curl*|sh*`, `curl*|bash*`,
  `wget*|sh*`, `wget*|bash*`;
* the rule "scope `outside` → deny": nothing reaches outside the working
  directory;
* the rules `Read*` → allow, `Glob*` → allow, `Grep*` → allow: reading inside
  the working directory is fine;
* the default: `ask`.

Details worth knowing:

* A rule matches on the tool name (a glob) and on the path scope. Command
  lists narrow a rule: `denyCommands` denies outright, `allowCommands` only
  lets the rule speak for the commands it lists.
* The path scope is decided lexically, without touching the filesystem:
  `inside` when every path of the request resolves inside the working
  directory, `outside` when at least one does not, `none` when the request
  mentions no path at all. A path that cannot be resolved (a shell variable,
  `~/…`) counts as `outside` — it is not provably inside. A pattern is
  judged by its literal prefix, so `src/**` is inside and `/etc/**` is not.
* An argv command is matched as a whole and per part, so `bash -lc git push`
  does not hide the command it runs.
* The decision travels with the request: the adapters answer the permission
  request of the provider with the option the caller picked
  (`answerPermission(id, allow)` answers with `allow_once`/`allow_always` or
  `reject_once`/`reject_always`). The policy module itself is **not wired
  into the daemon yet** — it is a tested decision function that the caller
  (the control plane) applies before it answers the bot.

## Redaction

The redaction lives in [src/redact.ts](src/redact.ts) and is pure: the same
input always yields the same output, and the input is never modified.

* `redactText()` masks the secrets of a text, `redact()` walks a value of
  any shape (strings, arrays, plain objects) and returns a copy.
* Masked are: PEM private key blocks; key/value pairs whose key names a
  secret (`api_key`, `token`, `password`, `secret`, `authorization`, ...);
  `Bearer`/`Basic` values; the well known token shapes (`sk-…`, GitHub
  tokens, AWS access key ids, Slack tokens, JWTs); and every value that is
  stored under a key which names a secret.
* The placeholders are `<redacted>` for secrets, `<host>` for host names and
  `<ip>` for addresses.
* Host names and IP addresses are only masked when `hostMask` is set — it is
  off by default, because a transcript often needs a usable host to stay
  useful.
* The session log can run every payload through a redaction hook before it
  is written. If the hook throws, the payload is stored as `null`: a broken
  hook fails closed instead of leaking the raw payload into the log.

## Collecting a debug log

What the daemon writes today:

* **Diagnostics on stderr.** Every diagnostic is one `botd: …` line: a lease
  that expired, a session table that could not be persisted, a child that
  failed. Nothing else is written to stderr.
* **The session table** at `<BOTD_HOME>/sessions.json` — one record per
  session: the session id, the bot kind, the command, the working directory,
  the provider session id, the state, the timestamps and the last and
  acknowledged sequence number. `BOTD_HOME` defaults to `~/.volto-botd`. The
  table is written atomically (a temporary file that is renamed over the
  old one), so a crash never leaves half a table behind.
* **The session event log** of [src/session-log.ts](src/session-log.ts): one
  NDJSON segment per session under `<BOTD_HOME>/sessions/` —
  `<sid>.ndjson` (the active segment), `<sid>.ndjson.<n>` (the rotated ones)
  and `<sid>.index.json` (the index). A segment rotates at 8 MiB, at most 4
  segments are kept per session and the oldest rotated ones are dropped
  first. Every event carries `seq`, `ts`, `type` and the (redacted) payload.
  `read(sid, fromSeq)` replays, `compact(sid, ackedSeq)` drops the segments
  that are fully acknowledged. This module is **not wired into the daemon
  yet** — the daemon writes the table and its stderr lines. Without
  `BOTD_HOME` the log falls back to `~/.botd`, while the daemon's table
  falls back to `~/.volto-botd`: set `BOTD_HOME` explicitly, so that both
  end up in the same directory.

How to collect a log:

1. Reproduce the problem with the diagnostics on stderr:

   ```sh
   ssh <ssh-alias> 'BOTD_HOME="$HOME/.volto-botd" botd serve 2>>"$HOME/.volto-botd/botd.log"'
   ```

2. Collect the artifacts:

   * `$HOME/.volto-botd/botd.log` — the stderr lines of the daemon;
   * `$HOME/.volto-botd/sessions.json` — the session table;
   * `$HOME/.volto-botd/sessions/` — the event log, when it is written;
   * `<prefix>/app/src` — the sources of the daemon that ran (the installer
     puts them there).

3. Note the version that ran (`botd version` on the host) and the command
   that started it.

The artifacts hold no credentials: `botd` never puts a secret into `argv`,
and the payloads of the event log run through the redaction hook. Read them
before you share them anyway.

## Configuration

Every knob exists as a flag and as an environment variable; the environment
variable is the fallback.

| flag | environment variable | default | meaning |
| --- | --- | --- | --- |
| `--home=<dir>` | `BOTD_HOME` | `~/.volto-botd` | the home directory of the daemon |
| `--store-file=<file>` | `BOTD_STORE_FILE` | `<home>/sessions.json` | the session table |
| `--lease-ttl-ms=<ms>` | `BOTD_LEASE_TTL_MS` | `15000` | the TTL of the lease |
| `--ring-max-events=<n>` | `BOTD_RING_MAX_EVENTS` | `1000` | events kept per session |
| `--ring-max-bytes=<n>` | `BOTD_RING_MAX_BYTES` | `1048576` | bytes kept per session |
| `--idle-ms=<ms>` | `BOTD_IDLE_MS` | `2000` | silence after which a session is idle |
| `--stall-ms=<ms>` | `BOTD_STALL_MS` | `30000` | silence after which a stall is reported |
| `--watchdog-ms=<ms>` | `BOTD_WATCHDOG_MS` | `250` | the interval of the watchdog |
| `--cancel-grace-ms=<ms>` | `BOTD_CANCEL_GRACE_MS` | `3000` | cancel to `SIGINT` |
| `--cancel-kill-grace-ms=<ms>` | `BOTD_CANCEL_KILL_GRACE_MS` | `3000` | `SIGINT` to `SIGKILL` |
| `--terminate-grace-ms=<ms>` | `BOTD_TERMINATE_GRACE_MS` | `3000` | `SIGTERM` to `SIGKILL` |

## Common failures

| what you see | what it means | what to do |
| --- | --- | --- |
| `node v20.11.0 is older than 22` (step 1 of the installer) | the host runs a node that is too old | install node 24 on the host, run the installer again |
| `[6/6] verify: FAILED (…)` | the launcher did not answer `botd --version` | run `botd --version` on the host by hand; check the node version and that `<prefix>/app/src/main.ts` was copied |
| error `no_lease` ("send hello before other frames") | a frame was sent before `hello` | send `hello` first; the daemon answers with the lease id and the fence |
| error `stale_fence` | another client took the lease over, or the fence is too old | reconnect with `hello`; the fence of the new lease is higher |
| error `stale_lease` ("unknown lease …") | the lease id does not belong to the current lease | reconnect with `hello` |
| error `lease_paused` ("the lease expired, input is not forwarded") | the TTL ran out: the sessions are paused, the children are alive | renew the lease (or send `hello` again) — the sessions resume |
| the sessions are gone after a pause | the TTL ran out twice: the daemon terminated the children | open a new session with the provider session id of the old one |
| error `session_exists` | a session with that id is already running | use a new id, or close the session first |
| error `unknown_session` | no session with that id (never opened, or the daemon restarted) | open the session; after a restart only the metadata survives |
| error `session_exited` | the child is gone | open a new session, with the provider session id to continue the conversation |
| error `session_cancelling` | a cancel is still running | wait for the turn to end; a second cancel replaces the first |
| error `child_error` | the bot CLI could not be started, or it wrote to stderr | check the binary and its login state on the host (see the adapter table) |
| error `bad_json` or `bad_frame` | a line was not a JSON object, or not a known frame | check the framing: one JSON object per line, LF terminated |
| a `gap` frame after a reconnect | the events were evicted from the ring buffer (1000 events or 1 MiB) | accept the loss and start a new task; raise the limits with `BOTD_RING_MAX_EVENTS` and `BOTD_RING_MAX_BYTES` |
| a `stall` frame | the bot printed nothing for 30 s | look at the CLI; raise the threshold with `BOTD_STALL_MS` |
| "the copilot adapter is disabled: set COPILOT_ENABLED=1 …" | the copilot adapter needs a paid seat and ships disabled | set `COPILOT_ENABLED=1` in the environment of the daemon, if you have a seat |
| "the pi adapter is not available in this build (botd/src/adapters/pi.ts is missing)" | the pi adapter is not part of this build | see "Coming" in the [README](../README.md) |
| `agy` behaves like Claude Code | `agy --help` did not mention ACP, so the adapter chose the stream-json fallback | pin the protocol with `VOLTO_AGY_PROTOCOL=acp` |
| the panel shows mock hosts only | the panel always uses the mock client today | see "Coming" in the [README](../README.md) |
