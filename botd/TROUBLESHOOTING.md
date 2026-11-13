# botd troubleshooting for M0 operators

Run checks from the controller unless noted. `<host>` is the executor's SSH
alias, `<home>` is the daemon's home (`--home` / `BOTD_HOME`, default
`~/.volto-botd`) and `<bot-cli>` is the adapter's binary. Run daemon-side
checks as the user, with the environment, that runs `botd`. Replace
placeholders locally; no host names or addresses belong in this file.

`botd serve` speaks NDJSON on stdin/stdout and stops when stdin closes, so
never start a second interactive serve against a live session. The probes
below that pipe frames into `serve` use a throwaway `--home` and never touch
the live session table. Terms and frames are defined in
[PROTOCOL.md](PROTOCOL.md); the `error` frame is `{"op":"error","code":...,
"message":...,"sid"?}`.

## Probes used below

| Probe | What it tells you |
| --- | --- |
| `ssh <host> 'botd --version'` | The launcher and node work on the host; prints the protocol version (`0.1.0`). Compare with `botdVersion` in the `hello` answer. On a source checkout: `node botd/src/main.ts --version`. |
| `ssh <host> 'node --version'` | Node floor: 22.18 enforced by the installer, 22.22 or newer supported ([RUNBOOK](RUNBOOK.md#the-node-of-the-host)). |
| `ssh <host> 'cat <home>/sessions.json'` | Session table: per `sid` the `state`, `providerSessionId`, `lastSeq` and `ackedSeq`. |
| `ssh <host> 'ps -eo pid,pgid,etime,stat,args \| grep -E "[b]otd\|<bot-cli>"'` | Whether the daemon and the child (and which process group) are alive. |
| `printf '<frame>\n' \| ssh <host> 'botd serve --home=$(mktemp -d)'` | Reproduces a daemon answer for one frame in an isolated home (examples below). |

## Protocol errors

These are all the codes the daemon sends ([PROTOCOL.md section 7](PROTOCOL.md#7-error-codes)).

| Symptom | Cause | Check command | Fix |
| --- | --- | --- | --- |
| `bad_json` | The line is not valid JSON, or a pending line is longer than 8 MiB ([framing](PROTOCOL.md#1-framing)). | `printf 'not json\n' \| ssh <host> 'botd serve --home=$(mktemp -d)'` returns `bad_json` when the daemon is healthy. If it does, the fault is in what the controller sent: log the raw bytes written to the transport and look for banner text, a shell profile `echo`, or a frame without a trailing LF. | Make the transport carry only frames: one JSON object per line, LF terminated. Remove anything that prints to stdout before `botd serve` on the executor (login banner, profile output). |
| `bad_frame` | Valid JSON but not a valid client frame: unknown `op`, missing field or wrong type ([op catalog](PROTOCOL.md#2-op-catalog)). The `message` names the problem. | `printf '{"op":"nope"}\n' \| ssh <host> 'botd serve --home=$(mktemp -d)'` returns `bad_frame` with `unknown op "nope"`. Compare the `message` of the real error with the field list in section 2. | Fix the frame. If a newer controller sends an op the daemon lacks, the daemon refuses it: compare `botd --version` with `botdVersion` ([versioning](PROTOCOL.md#8-versioning)) and reinstall the daemon ([RUNBOOK](RUNBOOK.md#install-botd-on-an-executor-host)). |
| `no_lease` | A frame other than `hello` came first, or a `renew` came with no lease ([lease](PROTOCOL.md#3-lease-fence-and-renewal)). | `printf '{"op":"send","sid":"a","payload":1}\n' \| ssh <host> 'botd serve --home=$(mktemp -d)'` returns `no_lease`. In the controller trace, check whether `hello` was written first on the new connection. | Send `hello` first on every new connection. After a reconnect the client must repeat `hello`; a stale `leaseId` from the old connection is not reusable. |
| `stale_fence` | The connection's fence is not the current one: another client took the lease with a different `clientId` (higher fence), or the client renews with an old fence. | Compare `fence` in the controller's last `hello` answer with the one in the frames it sends. Two controllers with different `clientId` against one host cause this: `ps -eo pid,etime,args \| grep "[b]otd serve"` on the host shows how many `serve` processes (connections) exist. | Stop the second controller, or have the intended holder send `hello` again to take the lease back (it gets a higher fence). Keep one stable `clientId` per controller so a reconnect keeps its fence. |
| `stale_lease` | A `renew` carries a `leaseId` the daemon does not know (daemon restarted, or the lease was replaced). | `printf '{"op":"hello","clientId":"probe"}\n{"op":"renew","leaseId":"x","fence":1}\n' \| ssh <host> 'botd serve --home=$(mktemp -d)'` returns `stale_lease` for the bogus id. Check whether the daemon's `ps` start time (`etime`) is newer than the last `hello` the controller saw. | Send `hello` and use the `leaseId` and `fence` from its answer. |
| `session_exists` | `open` reused a `sid` whose session is still live. | `ssh <host> 'cat <home>/sessions.json'` lists the `sid` with `state` not `exited`. | Use a new `sid`, or `close` the old one first. An `exited` session can be reopened under the same `sid`. |
| `unknown_session` | `send`, `cancel`, `close` or `resume` named a `sid` the daemon does not hold. | `ssh <host> 'cat <home>/sessions.json'`: absent means it was never opened here, or `close` removed it. Present with an old `ps` start time of the daemon means the daemon restarted and the metadata survived but the live session did not. `resume` of a session known only to the table answers with `gap`, not this error. | `open` the session (pass `resume.providerSessionId` from the table to continue the conversation). Check the `sid` for typos and the controller's host mapping. |
| `lease_paused` | `send` was refused because the lease passed its TTL without a `renew`; the children are alive but input is not forwarded. | Look for the stderr line `botd: lease expired, the sessions are paused` (stderr capture: [RUNBOOK](RUNBOOK.md#collecting-a-debug-log)), and check the controller's renew timing: the client renews every TTL/3 and the TTL is 15000 ms by default (`--lease-ttl-ms`, minimum 250). If renews were sent in time, suspect a stalled transport rather than the daemon. | Send `renew` or `hello`; paused sessions wake up. Fix the cause of the missed renewals (transport stall, a blocked event loop on either side). If it stays paused for twice the TTL the children are terminated; see "Sessions vanished" below. |
| `session_exited` | The child process is gone. | `ssh <host> 'cat <home>/sessions.json'` shows `state: exited`; `ps` shows no child. The cause is in the earlier `child_error` frames and daemon stderr: crash, SIGKILL after a cancel, `close`, or the lease death. | `open` a new session, passing `resume.providerSessionId` to continue. Fix the cause shown by the previous frames first. |
| `session_cancelling` | `send` arrived while a cancel is pending ([cancellation](PROTOCOL.md#6-cancellation-and-escalation)). | Session `state` is `paused`; `ps -eo pid,pgid,etime,stat,args` shows whether the child is still alive and for how long (`etime`) since the cancel. | Wait for the bot to answer the cancel (it produces output again and the session returns to `running`), or for the escalation: SIGINT after 3 s (`--cancel-grace-ms`), SIGKILL 3 s later (`--cancel-kill-grace-ms`). Then `open` again if it exited. |
| `child_error` | The bot wrote to stderr, or could not be started. The `message` is the stderr text or the spawn error (for example `spawn <bot-cli> ENOENT`). | `ssh <host> 'command -v <bot-cli>'` (binary on the daemon user's PATH?) and run the CLI's own login/status command as the daemon user. Reproduce a spawn failure with `printf '{"op":"hello","clientId":"p"}\n{"op":"open","sid":"p","bot":{"kind":"acp","command":["<bot-cli>"]}}\n' \| ssh <host> 'botd serve --home=$(mktemp -d)'`: ENOENT means a PATH problem, other text is the CLI's own error. stderr output is forwarded as `child_error` even for warnings, so read the text before assuming failure. | Install the CLI on the PATH of the daemon user and log in as that user ([adapters](RUNBOOK.md#the-bot-binaries-per-adapter)). Copilot needs `COPILOT_ENABLED=1` in the daemon's environment. |

## Other frames and symptoms

| Symptom | Cause | Check command | Fix |
| --- | --- | --- | --- |
| A `gap` frame after `resume` | The ring (1000 events or 1 MiB per session, `--ring-max-events` / `--ring-max-bytes`) already dropped the requested events, or the daemon restarted and only the table survived ([ring](PROTOCOL.md#4-sessions-sequence-numbers-acknowledgements-and-the-ring-buffer)). | `ssh <host> 'cat <home>/sessions.json'`: compare `ackedSeq` with `lastSeq` for the `sid`; a large difference means the controller acknowledged late. Compare the `gap` range with the `ackedSeq + 1` the client asked for. | Accept the loss of the range named by `gap`. Always resume from `ackedSeq + 1` and `ack` promptly; raise the ring flags for future sessions if `ack` cannot keep up. After a daemon restart, reopen with the provider session id. |
| A `stall` frame | No output from the bot for `--stall-ms` (default 30000 ms). It is a report, not a failure. | `ps -eo pid,etime,stat,args \| grep "<bot-cli>"`: is the child alive; is it waiting for a permission answer from the controller? `state` in the table is `idle` when silent over 2 s (`--idle-ms`). | If the child is alive and the turn is legitimately long, wait or raise `--stall-ms`. If it is stuck, `cancel` it and use the escalation above. |
| Sessions vanished and the lease died | The lease passed twice its TTL with no `renew`: the daemon terminated the children (SIGTERM, then SIGKILL after 3 s, `--terminate-grace-ms`). | stderr contains `botd: lease expired twice, the sessions are terminated`; table `state` is `exited`. | Fix the transport or controller stall, then `hello` and `open` again with the provider session id. |
| Lease keeps flapping (`lease_paused` repeatedly) | Renews arrive later than TTL, or two clients alternate. | `date -u; ssh <host> 'date -u'` for clock skew; count `serve` processes with `ps -eo pid,etime,args \| grep "[b]otd serve"` (more than one controller connection); stderr shows each `lease expired` line with its timing. | Fix skew, run one controller per host, or raise `--lease-ttl-ms` (the controller sends `leaseTtlMs` in `hello`; the daemon never goes below 250 ms). |
| `botd: ...` line `could not persist the session table` on stderr | The table cannot be written: wrong `--home` / `--store-file`, permissions, or a full disk. | `ssh <host> 'ls -ld <home>; ls -l <home>/sessions.json; df -h <home>'`. Check which home is in effect from the launch command's flags and environment (`--store-file` / `BOTD_STORE_FILE` win over `<home>/sessions.json`). | Fix the permissions or space, or point `--home` at a writable directory. |
| The daemon does not start, or prints a launcher error | Node is missing or too old, or the installed copy is broken. | `ssh <host> 'node --version'`, then `ssh <host> 'botd --version'`; on a checkout `node botd/src/main.ts --version`. A node below 22.18 cannot run the sources without flags. | Reinstall with the [installer](RUNBOOK.md#install-botd-on-an-executor-host) (`--ensure-node` if the host has no suitable node). |
| Diagnostic log or event log missing | Diagnostics go to the daemon's stderr only; there is no default log file. The event log module ([`src/session-log.ts`](src/session-log.ts), `<BOTD_HOME>/sessions/`) is not wired into the daemon, and on its own it falls back to `~/.botd`, not `~/.volto-botd`. | `ssh <host> 'ls <home>; ls <home>/sessions 2>&1'`. A missing `sessions/` directory is expected today. | Capture stderr in the launcher, for example `2>>"<home>/botd.log"` ([RUNBOOK](RUNBOOK.md#collecting-a-debug-log)). Review the files before sharing them. |
| Bot kind unavailable (copilot disabled, pi missing) | Copilot ships disabled; the pi adapter module is loaded lazily and its kind stays disabled when `src/adapters/pi.ts` is missing from the install. | `ssh <host> 'ls <prefix>/app/src/adapters/'` lists `pi.ts`? and `ssh <host> 'printenv COPILOT_ENABLED'` for copilot (run in the daemon's environment). | Set `COPILOT_ENABLED=1` for the daemon, or reinstall so the whole `botd/` directory is copied ([adapters](RUNBOOK.md#the-bot-binaries-per-adapter)). |

Process-local metrics (`botd/src/metrics.ts`) are not wired into the daemon and
the CLI has no metrics command or endpoint, so there is nothing to scrape.
Use frames, the session table and stderr. For the full list of flags and
environment variables see [RUNBOOK configuration](RUNBOOK.md#configuration),
and for installer and adapter failures see [RUNBOOK common failures](RUNBOOK.md#common-failures).

## Verified against

- [PROTOCOL.md section 7 error codes](PROTOCOL.md#7-error-codes), [section 3 lease](PROTOCOL.md#3-lease-fence-and-renewal), [section 4 ring and resume](PROTOCOL.md#4-sessions-sequence-numbers-acknowledgements-and-the-ring-buffer), [section 6 cancellation](PROTOCOL.md#6-cancellation-and-escalation).
- `botd/src/daemon.ts` (every `code:` in this guide and the stderr lines), `botd/src/session.ts` (stderr to `child_error`), `botd/src/cli.ts` (flags, `--version`), `botd/src/config.ts` (defaults), `botd/src/store.ts` (table fields), `botd/src/client.ts` (renew every TTL/3).
- Probes `bad_json`, `bad_frame`, `no_lease`, `stale_lease`, `unknown_session` and the ENOENT `child_error` were run against `node botd/src/main.ts serve --home=<tmp>`.
