# botd NDJSON protocol — version 1

The control plane (CP) drives `botd`, the daemon that hosts bots. Both sides
speak one duplex byte stream (unix socket, TCP or pipe). The wire format is
NDJSON: one JSON object per line, UTF-8, LF terminated. This document is
normative: the op names are the vocabulary of `botd/src/adapter-types.ts` —
the `NormalizedEvent` kinds and the `BotAdapter` verbs — so every op named
here also exists in `botd/src`.

## 1. Framing

* One JSON object per line; a frame never spans lines and never carries a
  raw LF (JSON escapes it as `\n`). Blank lines are ignored.
* A line that is not a JSON object, or a frame larger than 1 MiB (without the
  LF), is a violation: the peer answers `error` with `code:"invalid_frame"`
  and skips the line; the session stays open.
* Unknown fields are ignored, so fields may be added inside a version; an
  unknown `op` is answered with `error` and `code:"unknown_op"`.

## 2. Envelope

Every frame carries these fields:

| field | type | meaning |
| --- | --- | --- |
| `v` | int | protocol version (`1` in this document) |
| `op` | string | frame kind, see §3 |
| `seq` | int | per-direction sequence number, starts at 1, +1 per frame |
| `ack` | int | highest contiguous `seq` received from the peer (`0` = none) |
| `session` | string | session id, chosen by the CP |
| `lease` | object | optional `{id, epoch, ttlMs}`, see §6 |
| `task`, `id` | string | optional task id and correlation id |

The fields of an op are listed in §3; `?` marks an optional field. `seq`
counts one direction only — the CP numbers its frames `1,2,3,…`, `botd`
its own — and `ack` always refers to the peer's numbering.

## 3. Frame catalog

| op | direction | purpose | fields |
| --- | --- | --- | --- |
| `handshake` | CP → botd | open, refresh or resume a session | `session`, `lease`, `resume?`, `cwd?`, `model?`, `keepalive?` |
| `prompt` | CP → botd | deliver a prompt and start a turn | `task`, `text` |
| `answerPermission` | CP → botd | answer a pending permission request | `id`, `allow` |
| `cancel` | CP → botd | ask for cancellation of a turn | `task`, `stage`, `reason?` |
| `ready` | botd → CP | session is up; also the keepalive and lease renewal | `lease`, `providerSessionId?` |
| `text` | botd → CP | assistant text delta | `task`, `delta` |
| `tool` | botd → CP | tool call lifecycle: `start`, `end` or `error` | `task`, `name`, `status`, `summary?` |
| `permission` | botd → CP | the bot asks for permission | `task`, `id`, `request` |
| `turn_end` | botd → CP | the turn is over: `ok`, `error` or `cancelled` | `task`, `status`, `usage?` |
| `error` | both | protocol or provider failure | `code`, `message?`, `missing?` |
| `raw` | botd → CP | provider line without a normalized counterpart | `payload` |

## 4. Ordering, sequencing and acknowledgements

* Frames of one direction are delivered to the consumer in `seq` order. A
  frame with an unexpected `seq` is buffered (at most 64 frames or 1 MiB)
  until the hole is filled; it is never delivered out of order.
* `ack` is cumulative: it names the highest *contiguous* `seq` received. A
  frame with `seq <= ack` is a duplicate and is dropped silently.
* Acknowledgements are piggybacked: every frame carries the `ack` of the
  peer. `botd` sends a `ready` keepalive every `ttlMs/3`; the CP flushes
  its `ack` with any frame, or with a `handshake` carrying `keepalive:true`.
* Frames that are not acknowledged within `retransmitMs` (default 3000 ms)
  are retransmitted verbatim — same `seq`, same content. Retransmission is
  idempotent; the receiver drops the duplicates.

## 5. Gaps and resume

* A gap is a hole in the `seq` sequence of one direction. The receiver reports
  it after `gapTimeoutMs` (default 1000 ms) with `error`, `code:"seq_gap"`
  and `missing:{from,to}` (inclusive range); its `ack` stays at the last
  contiguous number.
* The peer answers by replaying the missing frames in `seq` order, starting
  at `from`; buffered frames are released as soon as the hole is filled. If
  the out-of-order buffer overflows (64 frames or 1 MiB), the receiver
  sends `error` with `code:"buffer_overflow"` and closes the session.
* After a transport break the CP re-opens the session with `handshake` and
  `resume:{"fromSeq":N}`: it has durably processed the peer's frames up to
  `N` and asks for `N+1…`. `botd` replays them from its journal; a replayed
  frame keeps its original `seq` and follows the same hole-filling rule.
  When the journal no longer holds that range, `botd` answers `error` with
  `code:"resume_unavailable"` and the CP restarts the task with a fresh
  session. `resume` carries `providerSessionId` when the CP knows it.

## 6. Lease: TTL, renewal and fencing

* The CP leases a session to one bot for a bounded time. The grant rides in
  the `handshake` frame: `lease:{"id":"l-1","epoch":7,"ttlMs":15000}`. The
  `epoch` is the fencing token: it grows on every grant, never shrinks.
* `ttlMs` defaults to 15000 ms. `botd` renews the lease by sending a
  `ready` frame with the same `lease.id` and `lease.epoch` at least every
  `ttlMs/3`; the CP acknowledges that `seq` and echoes the new expiry in
  `lease.ttlMs`.
* If the CP hears no renewal within the TTL it may hand the session to
  another bot. It then bumps `epoch`, which makes every older frame stale.
* Fencing: a peer that receives a `lease` whose `epoch` is lower than the
  highest epoch it has seen for that `lease.id` rejects the frame with
  `error` and `code:"stale_epoch"` and does not apply it. The CP drops
  frames below the current epoch; `botd` stops the turn on a higher one.
* A bot that sees no acknowledgement of its renewals within the TTL has
  lost the lease: it stops the turn and reports `code:"lease_expired"`.
  Handing one session to a second holder with the same epoch is an error
  (`code:"lease_conflict"`) that closes the session.

## 7. Cancellation and escalation

The CP escalates monotonically; every `cancel` carries `stage`:

| stage | effect | answer of `botd` |
| --- | --- | --- |
| `request` | graceful: the bot sends the provider-native cancel | `turn_end` with `status:"cancelled"` |
| `force` | after `cancelGraceMs` (default 5000 ms): output is dropped, the provider process gets SIGTERM | `turn_end` `cancelled`, or `error` `code:"cancel_timeout"` |
| `kill` | the provider process gets SIGKILL and the session closes | `turn_end` `cancelled` |

* A `cancel` for a turn that is not running is answered with `error` and
  `code:"cancel_unknown_turn"`. `cancel` is idempotent: repeating a stage
  has the same effect as the first time; after `force` or `kill` no further
  frame of that turn is sent.

## 8. Error codes

Every error uses `op:"error"` with `code` and `message`:

| code | meaning | session |
| --- | --- | --- |
| `invalid_frame` | not a JSON object, missing field or too large | stays open |
| `unknown_op` | op is not in the catalog | stays open |
| `version_unsupported` | no common protocol version | closes |
| `seq_gap` | frames are missing, see `missing:{from,to}` | stays open |
| `buffer_overflow` | out-of-order buffer exceeded | closes |
| `stale_epoch` | fencing token is older than the current one | stays open |
| `lease_expired` | the lease TTL elapsed | closes |
| `lease_conflict` | the session is leased to another holder | closes |
| `cancel_timeout` | the turn did not stop in time | stays open |
| `cancel_unknown_turn` | no such turn is running | stays open |
| `resume_unavailable` | the requested range cannot be replayed | stays open |
| `provider_error` | the bot CLI failed, `message` carries its text | stays open |
| `internal_error` | anything else | stays open |

## 9. Versioning

* `v` is an integer. This document describes `v = 1`.
* The CP sends its version in `handshake.v`; `botd` answers `ready.v` with
  the version it will speak: the highest version both sides support. The
  daemon never speaks a version the CP did not offer.
* When no version is acceptable, `botd` answers `error` with
  `code:"version_unsupported"` and `expected` (the daemon's version), then
  closes the session. Inside a version fields may be added and new ops may
  appear: unknown fields are ignored, unknown ops are answered with
  `unknown_op`. Incompatible changes bump `v`.

## 10. Example sessions

`→` is a frame of the control plane, `←` a frame of `botd`.

### Example 1 — a turn that runs to the end

```
→ {"v":1,"op":"handshake","seq":1,"ack":0,"session":"s-1","cwd":"/w","model":"m-1","lease":{"id":"l-1","epoch":7,"ttlMs":15000}}
← {"v":1,"op":"ready","seq":1,"ack":1,"session":"s-1","lease":{"id":"l-1","epoch":7,"ttlMs":15000},"providerSessionId":"ps-1"}
→ {"v":1,"op":"prompt","seq":2,"ack":1,"session":"s-1","task":"t-1","text":"add a regression test"}
← {"v":1,"op":"text","seq":2,"ack":2,"session":"s-1","task":"t-1","delta":"looking "}
← {"v":1,"op":"tool","seq":3,"ack":2,"session":"s-1","task":"t-1","name":"bash","status":"start"}
← {"v":1,"op":"tool","seq":4,"ack":2,"session":"s-1","task":"t-1","name":"bash","status":"end","summary":"1 failed"}
← {"v":1,"op":"raw","seq":5,"ack":2,"session":"s-1","task":"t-1","payload":{"type":"agent_thought_chunk"}}
← {"v":1,"op":"turn_end","seq":6,"ack":2,"session":"s-1","task":"t-1","status":"ok","usage":{"inputTokens":120,"outputTokens":40}}
```

### Example 2 — a permission request and a cancelled turn

```
→ {"v":1,"op":"handshake","seq":1,"ack":0,"session":"s-2","lease":{"id":"l-2","epoch":1,"ttlMs":15000}}
← {"v":1,"op":"ready","seq":1,"ack":1,"session":"s-2","lease":{"id":"l-2","epoch":1,"ttlMs":15000}}
→ {"v":1,"op":"prompt","seq":2,"ack":1,"session":"s-2","task":"t-2","text":"run the linter"}
← {"v":1,"op":"tool","seq":2,"ack":2,"session":"s-2","task":"t-2","name":"bash","status":"start"}
← {"v":1,"op":"permission","seq":3,"ack":2,"session":"s-2","task":"t-2","id":"p-1","request":{"tool":"bash"}}
→ {"v":1,"op":"answerPermission","seq":3,"ack":3,"session":"s-2","task":"t-2","id":"p-1","allow":true}
← {"v":1,"op":"tool","seq":4,"ack":3,"session":"s-2","task":"t-2","name":"bash","status":"end","summary":"clean"}
→ {"v":1,"op":"cancel","seq":4,"ack":4,"session":"s-2","task":"t-2","stage":"request","reason":"user aborted"}
← {"v":1,"op":"turn_end","seq":5,"ack":4,"session":"s-2","task":"t-2","status":"cancelled"}
```

### Example 3 — a gap, a replay and a resumed session

```
→ {"v":1,"op":"handshake","seq":1,"ack":0,"session":"s-3","lease":{"id":"l-3","epoch":4,"ttlMs":15000}}
← {"v":1,"op":"ready","seq":1,"ack":1,"session":"s-3","lease":{"id":"l-3","epoch":4,"ttlMs":15000}}
→ {"v":1,"op":"prompt","seq":2,"ack":1,"session":"s-3","task":"t-3","text":"refactor the parser"}
← {"v":1,"op":"text","seq":2,"ack":2,"session":"s-3","task":"t-3","delta":"first "}
← {"v":1,"op":"text","seq":4,"ack":2,"session":"s-3","task":"t-3","delta":"third "}
→ {"v":1,"op":"error","seq":3,"ack":2,"session":"s-3","code":"seq_gap","message":"missing seq 3","missing":{"from":3,"to":3}}
   --- the transport drops before the replay arrives; the CP applied frames 1 and 2 ---
→ {"v":1,"op":"handshake","seq":4,"ack":2,"session":"s-3","resume":{"fromSeq":2},"lease":{"id":"l-3","epoch":5,"ttlMs":15000}}
← {"v":1,"op":"text","seq":3,"ack":4,"session":"s-3","task":"t-3","delta":"second "}
← {"v":1,"op":"text","seq":4,"ack":4,"session":"s-3","task":"t-3","delta":"third "}
← {"v":1,"op":"ready","seq":5,"ack":4,"session":"s-3","lease":{"id":"l-3","epoch":5,"ttlMs":15000}}
```

Replayed frames keep their old `seq`; epoch 5 fences off the old epoch 4 (§6).
