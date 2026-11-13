# botd troubleshooting for M0 operators

Run checks from the Mac controller unless noted. `<host>` is the executor's SSH
alias; run daemon-side checks as the same user and with the same environment as
`botd`. `botd serve` uses stdin/stdout for protocol frames: do not run a second
interactive serve against a live session. The check commands below inspect the
host or CLI; inspect the controller's captured frames and daemon stderr for the
specific fields mentioned. Replace placeholders locally. In traces, `handshake`
opens or resumes a session, `prompt` starts a turn, `delta` carries text, and
`tool` and `raw` frames carry tool activity and provider `payload`. A permission
answer uses `allow`; a cancelled turn reports `cancelled`.

## Protocol errors

| Symptom | Cause | Check command | Fix |
| --- | --- | --- | --- |
| `invalid_frame` | A frame is not a JSON object, lacks a field, or is too large. | `ssh <host> 'botd version'` | Inspect the rejected frame and size in the controller trace; correct its fields and encoding before retrying. |
| `unknown_op` | The operation is outside the protocol catalog. | `ssh <host> 'botd version'` | Correct the operation using [PROTOCOL.md §3](PROTOCOL.md#3-operations); align controller and daemon versions. |
| `version_unsupported` | There is no common protocol version; the session closes. | `ssh <host> 'botd version'` | Install compatible controller and daemon versions and reconnect. |
| `seq_gap` | Frames are missing. | `ssh <host> 'botd version'` | Inspect `missing.from` and `missing.to`; replay the missing frames in sequence with their original contents and sequence numbers. |
| `buffer_overflow` | The out-of-order buffer exceeded its limit; the session closes. | `ssh <host> 'botd version'` | Repair the transport or ordering problem, reconnect and resume; restart the task in a fresh session if replay is unavailable. |
| `stale_epoch` | A frame carries an older fencing epoch. | `ssh <host> 'botd version'` | Stop the old holder and use the current lease and epoch; do not replay stale frames as new work. |
| `lease_expired` | The lease TTL elapsed; the session closes. | `ssh <host> 'botd help'` | Restore timely communication and renewals, then obtain a fresh lease and reconnect. See lease flapping below. |
| `lease_conflict` | Another holder has the session at the same epoch; the session closes. | `ssh <host> 'botd version'` | Identify and stop the duplicate holder; have the controller grant a new, higher epoch to one holder. |
| `cancel_timeout` | The turn did not stop in time. | `ssh <host> 'botd help'` | Inspect the task and cancellation stage, then escalate through the controller as described below. |
| `cancel_unknown_turn` | The named turn is not running. | `ssh <host> 'botd version'` | Check the task ID and latest `turn_end`; cancel the active turn if needed, or treat an already completed turn as finished. |
| `resume_unavailable` | The requested range cannot be replayed. | `ssh <host> 'botd help'` | Start the task in a fresh session; see resume below. |
| `provider_error` | The bot CLI failed; the error message contains its text. | `ssh <host> 'botd version'` | Inspect the message and daemon stderr; repair the CLI, authentication or provider issue before retrying. |
| `internal_error` | An unexpected daemon error occurred. | `ssh <host> 'botd version'` | Collect stderr, version, configuration and a sanitized controller trace; investigate the reported error before retrying. |

## Operational symptoms

| Symptom | Cause | Check command | Fix |
| --- | --- | --- | --- |
| Lease flaps or work stops repeatedly | Delayed/disconnected transport, missed renewal/acknowledgement, competing holders, or clock skew can make expiry diagnosis unreliable. | `date -u; ssh <host> 'date -u'` | Compare clocks and synchronize them using the hosts' time service; inspect controller frames for `ready`, acknowledgements, lease ID, epoch and TTL, and repair transport or duplicate holders. Protocol renewal is at least every TTL/3; default TTL is 15 seconds. Check the actual configured TTL before changing it. |
| Turn is silent or stuck | A provider may be slow, waiting for permission, or unresponsive. Silence alone does not prove failure. | `ssh <host> 'botd help'` | Inspect frames and provider state. Ask the controller to cancel with `request`, then `force` and `kill` if needed; watch for `turn_end` or `cancel_timeout`. Protocol `force` sends SIGTERM and `kill` sends SIGKILL. The runbook also describes daemon-side native cancel, SIGINT and process-group SIGKILL escalation; configured defaults for its two grace intervals are 3 seconds each. |
| `resume_unavailable` after a long disconnect | Requested frames have been evicted or are otherwise unavailable. A restart retains session metadata, not the old events. | `ssh <host> 'botd help'` | Reconnect with the last durably processed sequence; if replay is unavailable, accept the missing range and restart the task in a fresh session. Supply a known provider session ID where supported. Default ring limits are 1,000 events or 1 MiB per session; adjust the documented ring flags for future sessions if appropriate. |
| Bot CLI missing or unauthenticated | The binary is absent from the daemon user's PATH, or that user has not logged in. | `ssh <host> 'command -v <bot-cli>'` | Install the adapter's CLI on that PATH and authenticate as the daemon user using the provider's instructions. Check the `provider_error` message and stderr. Copilot also requires `COPILOT_ENABLED=1`; pi is unavailable in this build. See [the adapter list](RUNBOOK.md#the-bot-binaries-per-adapter). |
| Daemon fails to launch or version differs | The executor's Node version or installed daemon is incompatible. | `ssh <host> 'node --version'` and `ssh <host> 'botd version'` | Install Node 22 or newer on the executor and reinstall the compatible daemon following the [runbook](RUNBOOK.md#install-botd-on-an-executor-host). Compare the daemon version with the controller's supported protocol. |
| Session data or diagnostic log missing | The table path was overridden, or stderr was not captured. | `ssh <host> 'botd help'` | Check the actual launch flags and environment: `--store-file` / `BOTD_STORE_FILE` overrides `<home>/sessions.json`; `--home` / `BOTD_HOME` sets home, default `~/.volto-botd`. Diagnostics go to stderr, not a default log file. Capture stderr in the service or SSH launcher. The runbook's optional session event log is not wired into the daemon; do not assume it exists. Review artifacts before sharing. |
| Reconnects, stalls or cancellations need diagnosis | A process may be reconnecting, forwarding few events, or escalating cancels. | `ssh <host> 'botd help'` | If the embedding exposes the metrics registry, inspect `botd_reconnects_total`, `botd_events_total`, `botd_sessions_active`, `botd_sessions_total`, `botd_cancel_escalations_total` and `botd_event_latency_seconds`. These are process-local metrics; the CLI defines no metrics command or endpoint, and the helpers are not wired into the daemon here. Use frames and stderr for the running M0 daemon. |

## Verified against

- [PROTOCOL.md:22](PROTOCOL.md#L22), [ordering and resume:54](PROTOCOL.md#L54), [leases and cancellation:86](PROTOCOL.md#L86), [error codes:122](PROTOCOL.md#L122).
- [RUNBOOK.md:18](RUNBOOK.md#L18), [adapters:77](RUNBOOK.md#L77), [reconnects and escalation:116](RUNBOOK.md#L116), [logs:232](RUNBOOK.md#L232).
- [config.ts:41](src/config.ts#L41), [session table path:61](src/config.ts#L61), [configuration loading:73](src/config.ts#L73); [store.ts:31](src/store.ts#L31) for the default home.
- [metrics.ts:560](src/metrics.ts#L560), [registry:575](src/metrics.ts#L575); [cli.ts:13](src/cli.ts#L13), [entry point:34](src/cli.ts#L34).
