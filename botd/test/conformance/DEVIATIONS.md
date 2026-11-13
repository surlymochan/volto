# Deviations between `botd/PROTOCOL.md` and the daemon

The tests of this directory check the daemon against `botd/PROTOCOL.md`, the
normative document of the wire protocol. This file records

* the historical deviation that has been fixed (D1), and
* the cases of the task card that belong to a **retired** version of the
  document: the protocol of `botd/PROTOCOL.md` before commit `81488ee`
  ("docs: reconcile botd PROTOCOL.md with the implemented wire protocol").
  That version had an envelope (`v`, `seq`, `ack`), a frame limit of 1 MiB,
  the codes `invalid_frame` and `unknown_op` and the ops `handshake`,
  `prompt` and `ready`. The current document (§2, §8) has none of them and
  the daemon follows the current document.

Retired cases remain marked in the test suite with a `test.todo` naming the
section of the document.

| # | section | case | state |
| --- | --- | --- | --- |
| D1 | §3 | a frame before `hello` on a second connection | **fixed**: pre-hello frames now receive `no_lease` |
| D2 | §2, §8 | the envelope (`v`, `seq`, `ack`) | retired: the document has no envelope, the daemon has none |
| D3 | §1 | the size limit of a frame | retired: the limit is 8 MiB (`MAX_FRAME_BYTES`), not 1 MiB |
| D4 | §1, §7, §8 | the codes `invalid_frame` and `unknown_op` | retired: the codes are `bad_json` and `bad_frame` |
| D5 | §2 | the ops `handshake`, `ready`, `prompt` | retired: the catalog is `hello`, `renew`, `open`, `send`, `cancel`, `ack`, `close`, `resume` and `hello`, `event`, `state`, `error`, `gap`, `stall` |

The frames below are the raw NDJSON lines of the wire: `→` is a frame of the
control plane, `←` a frame of `botd`. The ids are synthetic.

## D1 — a frame before `hello` is answered with `stale_fence` on a second connection

**The document (§3):** "`hello` is the first frame of a connection; every
other frame before it is answered with `error` and `code:"no_lease"`."

**Historical behavior:** `botd/src/daemon.ts` looked at the lease before it looks at
the fence of the connection. While no lease is held the frame is refused
with `no_lease`, but as soon as another connection holds the lease the fence
of the connection (`null` before the `hello`) is compared with the fence of
the lease and the frame is refused with `stale_fence`.

```
→ (client-a) {"op":"hello","clientId":"client-a","leaseTtlMs":60000}
← (client-a) {"op":"hello","botdVersion":"0.1.0","leaseId":"0b3e656c-a697-4fbe-b5af-a1710f998681","fence":1,"leaseTtlMs":60000}
→ (client-b, before its hello) {"op":"ack","sid":"s1","seq":1}
← (client-b) {"op":"error","code":"stale_fence","message":"fence none is stale, the current fence is 1"}
```

The same frame on a connection that finds no lease is refused the way the
document says:

```
→ (client-a, before its hello) {"op":"ack","sid":"s1","seq":1}
← (client-a) {"op":"error","code":"no_lease","message":"send hello before other frames"}
```

**Test:** `test/conformance/lease.test.ts` — "PROTOCOL.md §3: a frame before
hello is answered with no_lease". The daemon now checks the connection before
comparing its fence, including for renewals.

## D2 — there is no envelope

**The document (§2):** "There is no envelope: a frame is a flat JSON object
whose `op` names its kind." **§8:** "There is no version field on the wire
and no negotiation: the client reads the version of the answer and decides
whether it can talk to the daemon."

The retired version of the document had an envelope: every frame carried `v`
(the protocol version), `seq` (the number of the frame in its direction) and
`ack` (the highest `seq` of the peer). The daemon carries none of them; the
version travels in the field `botdVersion` of the answer to `hello`.

```
→ {"op":"hello","clientId":"client-a","leaseTtlMs":60000}
← {"op":"hello","botdVersion":"0.1.0","leaseId":"ed5a5709-b781-4eda-b2b5-27d76d2d423a","fence":1,"leaseTtlMs":60000}
← {"op":"state","sid":"s1","state":"starting","progressAt":1794559323861}
← {"op":"state","sid":"s1","state":"running","progressAt":1794559323861}
← {"op":"event","sid":"s1","seq":1,"payload":{"jsonrpc":"2.0","id":null,"result":{"seq":0}}}
```

The `seq` of an `event` frame is the sequence number of the session (§4), not
the number of the frame in the direction.

**Test:** `test/conformance/envelope.test.ts` — "the frames of the daemon are
flat objects without an envelope" and "PROTOCOL.md (retired §2): every frame
carries the envelope fields v, seq and ack" (`test.todo`).

## D3 — the limit of a frame is 8 MiB

**The document (§1):** "`MAX_FRAME_BYTES` (`botd/src/frames.ts`) is 8 MiB. A
pending buffer above that limit is dropped and the daemon answers `error` with
`code:"bad_json"`."

The retired version of the document limited a frame to 1 MiB. The daemon
follows the current document: a line of 8 MiB is dropped, a line of 1 MiB is
accepted.

```
→ {"op":"hello","clientId":"<8 MiB of x>"}
← {"op":"error","code":"bad_json","message":"frame exceeds the maximum frame size"}
```

```
→ {"op":"hello","clientId":"<1 MiB of x>"}
← {"op":"hello","botdVersion":"0.1.0","leaseId":"8e8071ef-d3e1-4b0e-bb1b-164954124214","fence":1,"leaseTtlMs":15000}
```

**Test:** `test/conformance/framing.test.ts` — "answers a line above the size
limit with bad_json" and "PROTOCOL.md (retired §1): a line above 1 MiB is
refused with invalid_frame" (`test.todo`).

## D4 — the codes of a broken frame are `bad_json` and `bad_frame`

**The document (§1):** "a line that is not valid JSON is dropped the same
way" — the daemon answers `error` with `code:"bad_json"`. "A frame that is
not a valid client frame (a missing field, a wrong type, an unknown op) is
answered with `error` and `code:"bad_frame"`." **§8:** "an unknown op of the
client is refused with `code:"bad_frame"`".

The retired version of the document used the codes `invalid_frame` (a broken
or too long line) and `unknown_op` (an unknown op).

```
→ this is not json
→ {"op":"unknown_op"}
← {"op":"error","code":"bad_json","message":"Unexpected token 'h', \"this is not json\" is not valid JSON"}
← {"op":"error","code":"bad_frame","message":"unknown op \"unknown_op\""}
```

**Test:** `test/conformance/framing.test.ts` — "answers a line that is not
JSON with bad_json", "refuses an unknown op with bad_frame" and the two
`test.todo` cases "PROTOCOL.md (retired §1): a line that is not JSON is
refused with invalid_frame" and "PROTOCOL.md (retired §1): an unknown op is
refused with unknown_op".

## D5 — the ops of the catalog

The retired version of the document used the ops `handshake`, `prompt` and
`ready` (and `answerPermission`, `text`, `tool`, `permission`, `turn_end`,
`raw`). The current catalog (§2) is the one of `botd/src/protocol.ts`:
`hello`, `renew`, `open`, `send`, `cancel`, `ack`, `close` and `resume` from
the control plane, `hello`, `event`, `state`, `error`, `gap` and `stall` from
the daemon. The daemon and the document agree; `botd/test/protocol-doc.test.ts`
keeps them in sync.

**Test:** the conformance tests use the ops of the current catalog only; the
ops of the retired version are not sent by any test.

## Observation — the session table is emptied by a graceful shutdown

Not a deviation of the wire protocol, but it touches §4 ("the daemon keeps
the highest acknowledged sequence number of the session in the session
table"): `Botd.close()` in `botd/src/daemon.ts` clears the sessions **before**
it writes the table, so the table of a daemon that is shut down gracefully
holds no session and the metadata of the running sessions is lost. During the
run the table is correct (`test/conformance/envelope.test.ts` checks it). The
fix belongs to `botd/src`, which this card does not own.
