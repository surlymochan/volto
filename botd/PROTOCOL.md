# botd NDJSON protocol

`botd` is the bot daemon of volto: it runs on an executor host and hosts one
child process per session. The control plane (the client) drives it over a
duplex byte stream (the stdin/stdout of `botd serve`, a unix socket or a
pipe) that carries newline-delimited JSON (NDJSON) frames in both directions.
This document is normative: it describes the frames of `botd/src/protocol.ts`
(`ClientFrame`, `ServerFrame`), the framing of `botd/src/frames.ts` and the
behaviour of `botd/src/daemon.ts`, `botd/src/session.ts`, `botd/src/lease.ts`
and `botd/src/ring.ts`. The reference client is `botd/src/client.ts`.

## 1. Framing

* One JSON object per line, UTF-8, terminated with a single LF; a frame
  never spans a line and a JSON string carries a newline as `\n`.
* The reader is line oriented and tolerant of chunk boundaries: a line may
  arrive in several chunks and one chunk may carry several lines. Leading
  and trailing whitespace is trimmed, blank lines are ignored.
* `MAX_FRAME_BYTES` (`botd/src/frames.ts`) is 8 MiB. A pending buffer above
  that limit is dropped and the daemon answers `error` with
  `code:"bad_json"`; a line that is not valid JSON is dropped the same way.
  A frame that is not a valid client frame (a missing field, a wrong type,
  an unknown `op`) is answered with `error` and `code:"bad_frame"`. Unknown
  fields are ignored.

## 2. Op catalog

| op | direction | fields | meaning |
| --- | --- | --- | --- |
| `hello` | client → daemon | `clientId`, `leaseTtlMs?`, `v?` | take the lease |
| `renew` | client → daemon | `leaseId`, `fence` | extend the lease |
| `open` | client → daemon | `sid`, `bot`, `resume?` | start a session |
| `send` | client → daemon | `sid`, `payload` | forward a message to the bot |
| `cancel` | client → daemon | `sid`, `payload?` | ask the bot to stop |
| `ack` | client → daemon | `sid`, `seq` | confirm the events up to `seq` |
| `close` | client → daemon | `sid` | stop the bot and drop the session |
| `resume` | client → daemon | `sid`, `fromSeq` | replay the events of a session |
| `hello` | daemon → client | `botdVersion`, `leaseId`, `fence`, `leaseTtlMs` | the answer to `hello` |
| `event` | daemon → client | `sid`, `seq`, `payload` | one stdout line of the bot |
| `state` | daemon → client | `sid`, `state`, `progressAt` | the state of the session changed |
| `error` | daemon → client | `code`, `message`, `sid?` | a failure |
| `gap` | daemon → client | `sid`, `fromSeq`, `toSeq` | the events of the range are lost |
| `stall` | daemon → client | `sid`, `idleMs` | the bot is silent |

`hello.clientId` is a non-empty string and `hello.leaseTtlMs` a positive
number; `bot.kind` is one of `acp`, `codex-app-server`, `pi-rpc`,
`bot.command` a non-empty array of strings, `bot.cwd` and `bot.env` are
optional; `open.resume` carries `providerSessionId`; `send.payload` is any
JSON value; `ack.seq` and `resume.fromSeq` are numbers, `fromSeq` at least 1.

There is no envelope: a frame is a flat JSON object whose `op` names its
kind. The adapter vocabulary of `botd/src/adapter-types.ts` (`ready`,
`text`, `tool`, `permission`, `turn_end`, `raw`) is **not** part of the wire:
an `event` frame carries a raw provider line that the adapters parse into
`NormalizedEvent`s. The frames and the failures of a session go to the lease
holder; the failures of a connection are answered to it.

## 3. Lease, fence and renewal

* `hello` is the first frame of a connection; every other frame before it is
  answered with `error` and `code:"no_lease"`. The lease is a triple of
  `leaseId` (a UUID), `fence` (a counter) and the TTL in milliseconds.
* A `hello` with the same `clientId` keeps the lease id and the fence. A
  `hello` with another `clientId` takes an expired lease over (new lease id,
  higher fence; the old client gets `code:"stale_fence"`) and is refused with
  `code:"lease_conflict"` while the lease is `ok`.
* The TTL is 15000 ms by default (`--lease-ttl-ms`), at least 250 ms and at
  most one year; the answer of `hello` carries the effective TTL.
* `renew` extends the lease by its TTL and is not answered; the client
  renews every third of the TTL (`botd/src/client.ts`). Refused: without a
  lease `no_lease`, wrong fence `stale_fence`, wrong lease id `stale_lease`,
  at or after the first deadline `lease_expired` (send `hello` instead).
* The lease has two deadlines: `renewedAt + ttl` and `renewedAt + 2 * ttl`.
  At the first one the lease is *paused*: the children stay alive, every
  session becomes `paused` and `send` is refused with `code:"lease_paused"`.
  At the second one the lease is *dead* and the children are terminated
  (SIGTERM, then SIGKILL after 3 s). A `hello`, or a `renew` before the
  first deadline, wakes the paused sessions up.

## 4. Sessions, sequence numbers, acknowledgements and the ring buffer

* A session is identified by the `sid` the client chooses. `open` starts the
  child and is answered with a `state` frame (`starting`); a `sid` that is
  already live is refused with `code:"session_exists"`.
* Every stdout line of the child becomes one `event` frame. Its `seq` starts
  at 1 and grows by one per line; the `payload` is the parsed JSON of the
  line, or the raw line when it is not JSON.
* `ack` is cumulative: the daemon keeps the highest acknowledged sequence
  number of the session in the session table and never lets it go backwards.
* The events of a session are kept in a bounded ring buffer
  (`botd/src/ring.ts`): at most 1000 events or 1 MiB (`--ring-max-events`,
  `--ring-max-bytes`); the oldest events are dropped first.
* `resume` replays the buffered events from `fromSeq` (inclusive) and
  answers with a `state` frame. If the events between `fromSeq` and the
  oldest buffered event were dropped, the daemon sends a `gap` frame before
  the events that survived; if the session is gone but the session table
  knows it, it sends the `gap` to the last sequence number of the session
  and the recorded state, because the events are lost. An unknown `sid` is
  refused with `code:"unknown_session"`. The client resumes with
  `fromSeq = ackedSeq + 1`.

## 5. The state machine

The states of a session (`SESSION_STATES` in `botd/src/protocol.ts`):

| state | meaning |
| --- | --- |
| `starting` | the session is open, the bot has not produced a line yet |
| `running` | the bot produced a line less than 2 s ago (`--idle-ms`) |
| `idle` | the bot is silent for 2 s |
| `paused` | the lease expired or a cancel is pending |
| `exited` | the child is gone |

The watchdog runs every 250 ms (`--watchdog-ms`): it turns a silent session
into `idle` and raises a `stall` frame after 30 s of silence (`--stall-ms`).

## 6. Cancellation and escalation

* `cancel` writes the payload (or the default cancel message: `session/cancel`
  for `acp`, `turn/interrupt` for `codex-app-server` and `abort` for
  `pi-rpc`) to the stdin of the child; the session becomes `paused` and is
  marked as cancelling.
* The escalation: after 3 s (`--cancel-grace-ms`) the process group of the
  child gets a SIGINT, 3 s later (`--cancel-kill-grace-ms`) a SIGKILL.
* A bot that answers the cancel — it produces a line again — ends the
  escalation: the session is usable again and goes back to `running`.
* While a cancel is pending, `send` is refused with
  `code:"session_cancelling"`; a second `cancel` replaces the escalation.
* `close` terminates the child (SIGTERM, then SIGKILL after 3 s) and removes
  the session from the table.

## 7. Error codes

Every error is a frame with `op:"error"`, a `code` and a `message`.

| code | meaning |
| --- | --- |
| `bad_json` | the line is not valid JSON or it is too long |
| `bad_frame` | the frame is not a valid client frame |
| `version_unsupported` | the requested hello protocol version is unsupported |
| `no_lease` | a frame arrived before `hello`, or a renewal without a lease |
| `stale_fence` | the fence of the connection is not the current fence |
| `stale_lease` | the lease id of a renewal is unknown |
| `lease_expired` | a renewal arrived after the lease expired; send `hello` again |
| `lease_conflict` | a `hello` of another client while the lease is still live |
| `session_exists` | the `sid` of `open` is already live |
| `unknown_session` | the `sid` is unknown |
| `lease_paused` | the lease expired, the input is not forwarded |
| `session_exited` | the child of the session is gone |
| `session_cancelling` | a cancel of the session is still pending |
| `child_error` | the bot wrote to stderr or could not be started |

## 8. Versioning

* The daemon announces its version in the answer to `hello`: `botdVersion`
  is `BOTD_VERSION` of `botd/src/protocol.ts` (0.1.0 today).
* `hello.v` is a positive integer, defaults to 1, and only version 1 is supported.
  Other versions receive `version_unsupported` without taking the lease; the connection stays open.
  Fields and ops may be added: unknown client ops receive `bad_frame`; the client ignores unknown daemon ops.

## 9. Examples

`→` is a frame of the control plane, `←` a frame of `botd` (synthetic ids).
### Example 1 — a session that runs

```
→ {"op":"hello","clientId":"volto-cp","leaseTtlMs":15000}
← {"op":"hello","botdVersion":"0.1.0","leaseId":"11111111-2222-3333-4444-555555555555","fence":1,"leaseTtlMs":15000}
→ {"op":"renew","leaseId":"11111111-2222-3333-4444-555555555555","fence":1}
→ {"op":"open","sid":"s-1","bot":{"kind":"acp","command":["acp-agent","--stdio"],"cwd":"/w"},"resume":{"providerSessionId":"prov-1"}}
← {"op":"state","sid":"s-1","state":"starting","progressAt":1700000000000}
← {"op":"state","sid":"s-1","state":"running","progressAt":1700000000000}
→ {"op":"send","sid":"s-1","payload":{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"text":"add a test"}}}
← {"op":"event","sid":"s-1","seq":1,"payload":{"jsonrpc":"2.0","method":"session/update","params":{"text":"looking"}}}
→ {"op":"ack","sid":"s-1","seq":1}
← {"op":"stall","sid":"s-1","idleMs":30000}
→ {"op":"close","sid":"s-1"}
```

### Example 2 — a cancel that is refused while it is pending

```
→ {"op":"open","sid":"s-2","bot":{"kind":"codex-app-server","command":["codex","app-server"]}}
→ {"op":"cancel","sid":"s-2","payload":{"jsonrpc":"2.0","method":"turn/interrupt","params":{}}}
← {"op":"state","sid":"s-2","state":"paused","progressAt":1700000000000}
→ {"op":"send","sid":"s-2","payload":{"jsonrpc":"2.0","method":"turn/start","params":{}}}
← {"op":"error","code":"session_cancelling","sid":"s-2","message":"session s-2 is being cancelled"}
```

### Example 3 — a resume that reports a gap

```
→ {"op":"resume","sid":"s-3","fromSeq":2}
← {"op":"gap","sid":"s-3","fromSeq":2,"toSeq":3}
← {"op":"event","sid":"s-3","seq":4,"payload":{"jsonrpc":"2.0","method":"chunk","params":{"text":"fourth"}}}
← {"op":"state","sid":"s-3","state":"running","progressAt":1700000000000}
```

The events 2 and 3 of the session s-3 were evicted from the ring buffer: the
client accepts the loss and restarts the task.
