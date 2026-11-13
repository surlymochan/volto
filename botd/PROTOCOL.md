# botd NDJSON protocol

`botd` is the daemon of the volto control plane. It runs on an executor host
as a forced command (`ssh <host> botd serve`) and speaks newline-delimited
JSON over a duplex byte stream: one JSON object per line, in both
directions. One connection multiplexes many sessions; every session has a
`sid`. This document is normative; the code is in `botd/src` (`protocol.ts`,
`frames.ts`, `daemon.ts`, `lease.ts`, `ring.ts`, `session.ts`).

## 1. Framing

* One JSON object per line, UTF-8, LF terminated; a frame never spans lines
  and never carries a raw LF. Blank lines are ignored; lines may be split.
* A line longer than 8 MiB, or a line that is not valid JSON, is dropped and
  reported with `error` and `code:"bad_json"`. A frame that is not an
  object, whose `op` is unknown, or that misses a field, is answered with
  `error` and `code:"bad_frame"`. The connection stays in sync.
* Errors travel to the connection that caused them; the session frames
  (`event`, `state`, `gap`, `stall`) travel to the lease holder.

## 2. Versioning

* The daemon announces its version in the answer to `hello`: `botdVersion`
  (`"0.1.0"`, `BOTD_VERSION`). No frame carries a version field: the client
  reads `botdVersion` and stops talking to a daemon it does not know.
* The vocabulary of this document ships with botd 0.1.x. Inside a version
  new ops may appear; an unknown op is answered with `code:"bad_frame"`.
  Incompatible changes bump the daemon version.

## 3. Frames

| op | direction | fields | meaning |
| --- | --- | --- | --- |
| `hello` | client → botd | `clientId` (string), `leaseTtlMs?` (number > 0) | take the lease; the first frame of a connection |
| `renew` | client → botd | `leaseId` (string), `fence` (number) | extend the lease |
| `open` | client → botd | `sid`, `bot` `{kind, command, cwd?, env?}`, `resume?` `{providerSessionId?}` | start a session |
| `send` | client → botd | `sid`, `payload` (any) | forward a message to the child |
| `cancel` | client → botd | `sid`, `payload?` (any) | cancel the turn of a session |
| `ack` | client → botd | `sid`, `seq` (number) | acknowledge the events up to `seq` |
| `close` | client → botd | `sid` | terminate the child, drop the session |
| `resume` | client → botd | `sid`, `fromSeq` (number >= 1) | replay the events from `fromSeq` |
| `hello` | botd → client | `botdVersion`, `leaseId`, `fence`, `leaseTtlMs` | the lease was granted |
| `event` | botd → client | `sid`, `seq`, `payload` | one line of the child's stdout |
| `state` | botd → client | `sid`, `state`, `progressAt` | the state changed: `starting`, `running`, `idle`, `paused`, `exited` |
| `error` | botd → client | `code`, `message`, `sid?` | something went wrong |
| `gap` | botd → client | `sid`, `fromSeq`, `toSeq` | the events of that range are lost |
| `stall` | botd → client | `sid`, `idleMs` | the child is silent for too long |

`bot.kind` is `acp`, `codex-app-server` or `pi-rpc`, `bot.command` a
non-empty array of strings (no shell is involved). `send` requires the
`payload` key: a string goes to the child's stdin verbatim, everything else
is JSON encoded. `event.payload` is the parsed stdout line, or the raw line.

## 4. Ordering, sequencing and acknowledgement

* `open` starts the child in its own process group. Every stdout line of the
  child becomes one `event`; the session numbers them `seq = 1, 2, 3, ...`.
  The numbers never skip; the client applies them in the order they arrive.
* The client acknowledges with `ack {sid, seq}`. The acknowledgement is
  cumulative: the daemon stores the highest `seq` it has seen, an older or
  repeated `seq` is ignored. The daemon never retransmits an event; the
  replay of section 5 is the recovery path. It drops no event.
* The events are kept in a bounded ring (1 000 events or 1 MiB per session
  by default); when the budget is exceeded the oldest events are dropped.
* A `state` frame is only sent when the state really changes. A session
  without output for 2 s is `idle`; without output for 30 s it gets one
  `stall` frame with `idleMs`, the next output re-arms it.

## 5. Gaps and resume

* After a transport break the client reconnects, sends `hello` again and then
  `resume {sid, fromSeq}`: it applied the events up to `fromSeq - 1` and asks
  for the rest. The daemon replays the buffered events from `fromSeq` in
  `seq` order and closes the replay with a `state` frame.
* When the events between `fromSeq` and the oldest buffered event were
  dropped, the daemon sends `gap {sid, fromSeq, toSeq}` first: `toSeq` is the
  highest dropped `seq`. The hole is permanent, the client continues with
  what it has.
* When the session is gone (the daemon restarted or the lease killed the
  child) the daemon answers `gap {sid, fromSeq, toSeq}` with `toSeq` the
  `lastSeq` of the persisted session and a `state` frame with the state
  `exited`. An unknown `sid` is answered with `code:"unknown_session"`.

## 6. Lease: TTL, renewal and fencing

* The client holds the lease and has to renew it before the TTL runs out. The
  first frame of a connection must be `hello`; every other frame sent before
  a lease exists is answered with `code:"no_lease"`.
* `hello` answers with `leaseId` (a uuid), `fence` (a counter) and the
  effective `leaseTtlMs`: the `leaseTtlMs` of the client clamped to the
  minimum TTL (250 ms), the default TTL is 15 000 ms.
* `renew {leaseId, fence}` extends the lease: `renewedAt` becomes now, the
  pause deadline becomes `now + ttl` and the kill deadline `now + 2 * ttl`.
  A renew with an unknown `leaseId` is answered with `code:"stale_lease"`, a
  renew with a wrong `fence` with `code:"stale_fence"`.
* Fencing: a `hello` of the same `clientId` keeps `leaseId` and `fence` (a
  reconnect), a `hello` of another `clientId` takes the lease over with a
  new `leaseId` and `fence + 1`; the old connection is then stale.
* Expiry: one TTL after the last renewal the sessions are paused, the
  children stay alive but no input is forwarded any more (`send` is
  answered with `code:"lease_paused"`). Two TTL after the last renewal the
  children are terminated (SIGTERM, then SIGKILL of the process group). A
  `renew` or a new `hello` brings them back to life (`state` `running` or
  `idle`); renew well before the TTL expires.

## 7. Cancellation and escalation

* `cancel {sid, payload?}` cancels the turn of a session: the daemon sends
  `payload`, or the default of the bot flavour (`session/cancel` for `acp`,
  `turn/interrupt` for `codex-app-server`, `abort` for `pi-rpc`), to the child
  and sets the session to `paused` while the cancel is pending.
* The escalation is a timer chain: after `cancelGraceMs` (3 000 ms) without
  an answer the process group gets SIGINT, after `cancelKillGraceMs`
  (3 000 ms) more it gets SIGKILL. A child that answers the cancel stops the
  escalation and goes back to `running`; a second `cancel` replaces it.
* While the cancel is pending a `send` is refused with
  `code:"session_cancelling"`; a `cancel` for an unknown `sid` is answered
  with `code:"unknown_session"`, for a gone session with `code:"session_exited"`.

## 8. Error codes

Every error is `{"op":"error","code":...,"message":...}`, `sid` is optional:

| code | when | effect |
| --- | --- | --- |
| `bad_json` | the line is not valid JSON or is too long | the line is dropped, the connection stays open |
| `bad_frame` | not a JSON object, unknown `op`, missing or invalid field | the frame is dropped, the connection stays open |
| `no_lease` | a frame other than `hello` arrives before the lease | the frame is dropped |
| `stale_fence` | the fence of the connection is not the current one | the frame is dropped |
| `stale_lease` | the `leaseId` of a renew is unknown | the frame is dropped |
| `unknown_session` | the `sid` is unknown | the frame is dropped |
| `session_exists` | `open` for a session that is still running | the session is kept |
| `session_exited` | the session is gone | the frame is dropped |
| `session_cancelling` | a `send` while a cancel is pending | the frame is dropped |
| `lease_paused` | the lease expired, the input is not forwarded | the frame is dropped |
| `child_error` | the child wrote to stderr or could not be started | the session stays open |

## 9. Example sessions

`→` is a frame of the client, `←` a frame of `botd`.

### Example 1 - a turn that runs to the end

```
→ {"op":"hello","clientId":"cp-1","leaseTtlMs":15000}
← {"op":"hello","botdVersion":"0.1.0","leaseId":"l-1","fence":1,"leaseTtlMs":15000}
→ {"op":"open","sid":"s-1","bot":{"kind":"pi-rpc","command":["pi","--rpc"],"cwd":"/w"}}
← {"op":"state","sid":"s-1","state":"starting","progressAt":1700000000000}
← {"op":"state","sid":"s-1","state":"running","progressAt":1700000000000}
→ {"op":"send","sid":"s-1","payload":{"method":"prompt","text":"add a test"}}
← {"op":"event","sid":"s-1","seq":1,"payload":{"method":"chunk","text":"working"}}
← {"op":"event","sid":"s-1","seq":2,"payload":{"method":"chunk","text":" done"}}
→ {"op":"ack","sid":"s-1","seq":2}
# 30 s without output: the session stalls
← {"op":"stall","sid":"s-1","idleMs":30000}
→ {"op":"close","sid":"s-1"}
```

### Example 2 - a cancel and its escalation

```
→ {"op":"hello","clientId":"cp-1"}
← {"op":"hello","botdVersion":"0.1.0","leaseId":"l-1","fence":1,"leaseTtlMs":15000}
→ {"op":"open","sid":"s-2","bot":{"kind":"acp","command":["acp","serve"]}}
→ {"op":"send","sid":"s-2","payload":{"method":"session/prompt","text":"run the linter"}}
← {"op":"event","sid":"s-2","seq":1,"payload":{"method":"session/update","text":"running"}}
→ {"op":"cancel","sid":"s-2"}
← {"op":"state","sid":"s-2","state":"paused","progressAt":1700000001000}
→ {"op":"send","sid":"s-2","payload":{"method":"session/prompt","text":"again"}}
← {"op":"error","code":"session_cancelling","sid":"s-2","message":"session s-2 is being cancelled"}
← {"op":"event","sid":"s-2","seq":2,"payload":{"method":"session/update","text":"stopping"}}
← {"op":"state","sid":"s-2","state":"running","progressAt":1700000002000}
```

### Example 3 - lease expiry, takeover and a resume

```
→ {"op":"hello","clientId":"cp-1","leaseTtlMs":1000}
← {"op":"hello","botdVersion":"0.1.0","leaseId":"l-1","fence":1,"leaseTtlMs":1000}
→ {"op":"open","sid":"s-3","bot":{"kind":"codex-app-server","command":["codex","app-server"]}}
→ {"op":"send","sid":"s-3","payload":{"method":"turn/start","input":"refactor"}}
← {"op":"event","sid":"s-3","seq":1,"payload":{"method":"item/completed","text":"first"}}
← {"op":"event","sid":"s-3","seq":2,"payload":{"method":"item/completed","text":"second"}}
# the client stops renewing: one TTL later the session is paused
← {"op":"state","sid":"s-3","state":"paused","progressAt":1700000002000}
→ {"op":"renew","leaseId":"l-1","fence":1}
← {"op":"state","sid":"s-3","state":"running","progressAt":1700000002000}
# another client takes the lease over: the fence is bumped, the old
# connection is stale and cp-2 asks for the events it missed
→ {"op":"hello","clientId":"cp-2"}
← {"op":"hello","botdVersion":"0.1.0","leaseId":"l-2","fence":2,"leaseTtlMs":15000}
→ {"op":"send","sid":"s-3","payload":{"method":"turn/start","input":"more"}}
← {"op":"error","code":"stale_fence","message":"fence 1 is stale, the current fence is 2"}
→ {"op":"resume","sid":"s-3","fromSeq":1}
← {"op":"gap","sid":"s-3","fromSeq":1,"toSeq":1}
← {"op":"event","sid":"s-3","seq":2,"payload":{"method":"item/completed","text":"second"}}
← {"op":"state","sid":"s-3","state":"running","progressAt":1700000002000}
```
