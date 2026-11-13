# M0 demo runbook — a macOS client, two remote bots over SSH

Card: `P0-volto-demo-runbook`
Repo: `volto`
Base: `origin/main`
Owns: `botd/DEMO.md`

The demo: the client runs on macOS. It opens one ssh connection per host. On
`<host-a>` a `botd` daemon hosts **Claude Code**, on `<host-b>` a second daemon
hosts **Codex**. The client speaks NDJSON frames to both daemons, runs a three
step collaboration (plan → implement → review) and leaves a redacted transcript
behind.

Every command of this runbook exists in this repository or is a standard tool
(`bash`, `ssh`, `mkfifo`, `grep`, `node`). Everything that is not implemented
yet is marked **TODO(card)**.

## 0. What exists and what does not

| piece | state |
| --- | --- |
| `botd serve` over ssh stdio | works — `botd/src/main.ts`, `botd/src/cli.ts` |
| the frame protocol of the daemon | works — `botd/src/protocol.ts` |
| the installer | works — `scripts/install-botd.sh`, self test `scripts/botd-selftest.sh` |
| the client of the panel | **TODO(card)** — `client-ui/src/app.ts` still uses the mock (`client-ui/src/mock-client.ts`); the demo drives the daemons with the shell client of section 4 |
| the normalized events of the adapters | **TODO(card)** — `botd/src/adapters/claude.ts` and `botd/src/adapters/codex.ts` know both bots, but `botd/src/daemon.ts` does not use the registry yet: the daemon forwards the raw provider lines |
| the durable session log | **TODO(card)** — `botd/src/session-log.ts` is not called by the daemon; the transcript of the demo is the capture of the client (section 6) |
| the redaction inside the daemon | **TODO(card)** — `botd/src/redact.ts` is not called by the daemon; the redaction of the demo is done by the operator (section 7) |
| `answerPermission` (a frame of `botd/PROTOCOL.md`) | **TODO(card)** — the daemon has no such client frame; a provider approval is answered with a raw `send` frame (section 5.4) |
| the framing of `botd/PROTOCOL.md` | **TODO(card)** — the document describes `handshake`/`prompt`/…, `botd serve` speaks `hello`/`open`/`send`/…; the demo uses the implemented one (section 4.3) |

## 1. Prerequisites

### 1.1 The client (macOS)

* `ssh` and `bash` (the system ones, bash 3.2 is enough) and `mkfifo`.
* Node for the local checks: **Node ≥ 22.18** (type stripping) or **Node 24**
  (no flag needed). The daemon on the host is started through the launcher
  `node --experimental-strip-types <prefix>/app/src/main.ts` that
  `scripts/install-botd.sh` writes, so Node 22 on the host is enough.
* A clone of this repository: the installer copies `botd/` from the local
  checkout to the host.

```sh
node --experimental-strip-types botd/src/main.ts version   # → 0.1.0
```

### 1.2 The hosts

* Two hosts reachable by ssh, with the aliases `<host-a>` and `<host-b>` in
  `~/.ssh/config`. The same user on both, no `sudo` anywhere.
* On `<host-a>`: the `claude` CLI (Claude Code) on the PATH, logged in.
* On `<host-b>`: the `codex` CLI on the PATH, logged in.
* Node ≥ 22.6 on both hosts: the installer checks node ≥ 22 in its first step,
  and the launcher needs the type stripping of `--experimental-strip-types`
  (node has the flag since 22.6).
* A **shared working copy** `<work>`: the same repository on both hosts (two
  clones of the same remote, or a synced directory). botd moves no files: each
  bot sees the file system of its own host.

`probes/REPORT.md` documents what the probes saw on the machine of the
author (the CLIs were not installed or not logged in there, only `pi` answered);
the demo needs the two CLIs installed and authenticated on the hosts.

### 1.3 The placeholders

| placeholder | meaning |
| --- | --- |
| `<host-a>` | ssh alias of the host that runs Claude Code |
| `<host-b>` | ssh alias of the host that runs Codex |
| `<work>` | absolute path of the shared working copy on the hosts |
| `<demo-dir>` | local directory that holds the transcript (`botd/.tmp/demo` in the clone) |

The commands below quote the placeholders (`'<host-a>'`), so the shell reads
them as words and not as redirections. Replace every placeholder before
running a command.

## 2. Install botd on both hosts

`scripts/install-botd.sh` does the whole job over ssh, in six steps: preflight
(node ≥ 22 on the host), directories, sync of `botd/`, the launcher, the
symlink into `~/.local/bin` and the verification.

```sh
# 1 — the plan; no host is contacted
scripts/install-botd.sh '<host-a>' --dry-run
scripts/install-botd.sh '<host-b>' --dry-run

# 2 — the installation
scripts/install-botd.sh '<host-a>'
scripts/install-botd.sh '<host-b>'
```

Expected output (one status line per step):

```
[1/6] preflight: ok (node v24.3.0)
[2/6] directories: ok (~/.volto-botd/app, ~/.volto-botd/bin)
[3/6] sync: ok (rsync, excluding test/ and node_modules/)
[4/6] wrapper: ok (~/.volto-botd/bin/botd)
[5/6] link: ok (~/.local/bin/botd)
[6/6] verify: ok (0.1.0)
```

What lands on a host:

* `<prefix>/app/` — the copy of `botd/` without `test/` and `node_modules/`
  (the default prefix is `~/.volto-botd`).
* `<prefix>/bin/botd` — the launcher:
  `exec node --experimental-strip-types <prefix>/app/src/main.ts "$@"`.
* `~/.local/bin/botd` — the symlink to the launcher.
* `~/.volto-botd/sessions.json` — the session table of the daemon
  (`BOTD_HOME`, see `botd/src/store.ts`).

Offline check of the installer, without a host:

```sh
bash scripts/botd-selftest.sh      # → 52 checks, 0 failures
```

Verification on both hosts:

```sh
ssh '<host-a>' '~/.volto-botd/bin/botd version'   # → 0.1.0
ssh '<host-b>' '~/.volto-botd/bin/botd version'   # → 0.1.0
```

## 3. Start the daemons

botd has no service mode: every connection starts one daemon as a forced
command, and the daemon stops when the connection ends.

```sh
ssh '<host-a>' '~/.volto-botd/bin/botd serve'
```

* **stdin** — the frames of the client, one JSON object per line.
* **stdout** — the frames of the daemon, one JSON object per line.
* **stderr** — the log of the daemon (`botd: …`).

Two notes:

* Use the absolute path `~/.volto-botd/bin/botd`. The symlink in
  `~/.local/bin` is convenient for humans, but a non interactive ssh command
  does not always carry that directory on the PATH.
* `botd serve` is the default command; `botd version` and `botd help` are the
  two others (`botd/src/cli.ts`).

## 4. Connect the client

### 4.1 The client of the demo

The panel of `client-ui/` is not wired to a daemon yet (**TODO(card)**), so the
demo drives the two daemons with a small shell client: one FIFO per host, the
frames go in, the transcript comes out.

```sh
# the demo directory: inside the clone, and git ignored (botd/.gitignore)
DEMO_DIR="$PWD/botd/.tmp/demo"
mkdir -p "$DEMO_DIR"
mkfifo "$DEMO_DIR/host-a.in" "$DEMO_DIR/host-b.in"

# one daemon per host; stdout is the transcript, stderr is the log
ssh '<host-a>' '~/.volto-botd/bin/botd serve' \
  < "$DEMO_DIR/host-a.in" > "$DEMO_DIR/host-a.ndjson" 2> "$DEMO_DIR/host-a.log" &
ssh '<host-b>' '~/.volto-botd/bin/botd serve' \
  < "$DEMO_DIR/host-b.in" > "$DEMO_DIR/host-b.ndjson" 2> "$DEMO_DIR/host-b.log" &

# the write ends stay open; the daemon stops when they are closed
exec 9> "$DEMO_DIR/host-a.in"
exec 8> "$DEMO_DIR/host-b.in"

send_a() { printf '%s\n' "$1" >&9; }
send_b() { printf '%s\n' "$1" >&8; }
```

The answers of a host are appended to its transcript; watch one of them with:

```sh
tail -f "$DEMO_DIR/host-a.ndjson"
```

### 4.2 The lease

The daemon gives the client a lease; the client has to renew it. The answer of
the `hello` frame carries the id of the lease, its fence and its TTL:

```sh
send_a '{"op":"hello","clientId":"demo-m0"}'
# → {"op":"hello","botdVersion":"0.1.0","leaseId":"<lease-id-a>","fence":1,"leaseTtlMs":15000}
send_b '{"op":"hello","clientId":"demo-m0"}'
# → {"op":"hello","botdVersion":"0.1.0","leaseId":"<lease-id-b>","fence":1,"leaseTtlMs":15000}
```

Every daemon has its own lease: the id of `<host-a>` and the id of `<host-b>`
differ, the fence starts at 1 on both.

Renew every `leaseTtlMs / 3` (5 s with the default TTL of 15 s):

```sh
send_a '{"op":"renew","leaseId":"<lease-id-a>","fence":1}'
send_b '{"op":"renew","leaseId":"<lease-id-b>","fence":1}'
```

A `hello` with the same `clientId` extends the lease as well. Without a
renewal the daemon pauses the sessions after one TTL and terminates their
children after two.

### 4.3 The frames of the demo

The client frames (`botd/src/protocol.ts`):

| frame | meaning |
| --- | --- |
| `hello` | take the lease (`clientId`, optional `leaseTtlMs`) |
| `renew` | extend the lease (`leaseId`, `fence`) |
| `open` | start a session (`sid`, `bot`, optional `resume`) |
| `send` | forward a payload to the bot of a session (`sid`, `payload`) |
| `cancel` | cancel the turn of a session (`sid`, optional `payload`) |
| `ack` | acknowledge the events up to a sequence number (`sid`, `seq`) |
| `close` | stop a session (`sid`) |
| `resume` | replay the events of a session from a sequence number (`sid`, `fromSeq`) |

The frames of the daemon:

| frame | meaning |
| --- | --- |
| `hello` | the answer: `botdVersion`, `leaseId`, `fence`, `leaseTtlMs` |
| `event` | one line of the bot (`sid`, `seq`, `payload`) |
| `state` | the state of a session (`starting`, `running`, `idle`, `paused`, `exited`) |
| `error` | a refusal or a failure (`code`, `message`, optional `sid`) |
| `gap` | the events of a session are not on the ring any more (`fromSeq`, `toSeq`) |
| `stall` | the bot of a session is silent for too long (`idleMs`) |

`botd/PROTOCOL.md` describes a richer framing (`handshake`, `prompt`,
`answerPermission`, …) with a version and per direction sequence numbers. That
framing is the target protocol; the daemon does not speak it yet
(**TODO(card)**), so the demo uses the frames above.

## 5. The three step collaboration

The task of the demo: one small change in the shared working copy `<work>` —
the `greet` script of the demo repository gets a `--verbose` flag. The three
steps are plan → implement → review, and every step is one `send` frame to
the bot that owns the step.

### 5.1 Step 1 — the plan (Claude Code on `<host-a>`)

```sh
send_a '{"op":"open","sid":"s-claude","bot":{"kind":"acp","command":["claude","-p","--input-format","stream-json","--output-format","stream-json","--verbose"],"cwd":"<work>"}}'
send_a '{"op":"send","sid":"s-claude","payload":{"type":"user","message":{"role":"user","content":"Step 1 of 3. Write the plan of the change into PLAN.md in the repository. Write the file and nothing else."}}}'
```

The answer of Claude Code arrives as `event` frames whose payload is the raw
provider line (`{"type":"system",…}`, `{"type":"assistant",…}`,
`{"type":"result",…}`).

The `kind` of the frame is `acp`: the daemon accepts `acp`, `codex-app-server`
and `pi-rpc` (`botd/src/protocol.ts`), and it only uses the kind for the
default cancel message. The adapter registry knows `claude` and `codex`
(`botd/src/adapters/index.ts`), but the daemon does not use it yet
(**TODO(card)**).

### 5.2 Step 2 — the implementation (Codex on `<host-b>`)

Codex needs its handshake before a turn. Three frames, then the turn:

```sh
send_b '{"op":"open","sid":"s-codex","bot":{"kind":"codex-app-server","command":["codex","app-server"],"cwd":"<work>"}}'
send_b '{"op":"send","sid":"s-codex","payload":{"id":1,"method":"initialize","params":{"clientInfo":{"name":"volto-botd","title":"volto botd","version":"0.0.1"},"capabilities":{"experimentalApi":true}}}}'
send_b '{"op":"send","sid":"s-codex","payload":{"method":"initialized"}}'
send_b '{"op":"send","sid":"s-codex","payload":{"id":2,"method":"thread/start","params":{"cwd":"<work>","approvalPolicy":"on-request","sandbox":"workspace-write"}}}'
```

The thread id arrives in the `thread/started` notification; read it out of the
transcript:

```sh
grep -m1 '"thread/started"' "$DEMO_DIR/host-b.ndjson"
```

Then the turn:

```sh
send_b '{"op":"send","sid":"s-codex","payload":{"id":3,"method":"turn/start","params":{"threadId":"<thread-id>","input":[{"type":"text","text":"Step 2 of 3. Implement the plan of PLAN.md in the repository. Change the code only.","text_elements":[]}]}}}'
```

### 5.3 Step 3 — the review (Claude Code on `<host-a>`)

The session of step 1 is still open; the review is the next prompt of the same
session:

```sh
send_a '{"op":"send","sid":"s-claude","payload":{"type":"user","message":{"role":"user","content":"Step 3 of 3. Review the implementation of step 2: read the diff of the repository and report the problems you find. Change nothing."}}}'
```

### 5.4 Approvals, cancels and acknowledgements

* **Acknowledgement** — after a step, the client confirms the events it has
  processed; the daemon keeps the counter in the session table:

  ```sh
  send_a '{"op":"ack","sid":"s-claude","seq":<last-seq>}'
  ```

* **Approval of Codex** — Codex asks for an approval with a server request
  (`item/commandExecution/requestApproval`); the daemon forwards it as a raw
  event. The answer is a raw `send` frame with the provider native response
  (there is no `answerPermission` frame yet, **TODO(card)**):

  ```sh
  send_b '{"op":"send","sid":"s-codex","payload":{"id":<request-id>,"result":{"decision":"accept"}}}'
  ```

* **Cancel** — the daemon sends a default message per kind when the cancel
  frame carries no payload (`botd/src/session.ts`): an ACP `session/cancel` for
  `acp`, a `turn/interrupt` without ids for `codex-app-server`. Neither is
  understood by the provider, so the demo always sends the provider native
  cancel:

  ```sh
  send_a '{"op":"cancel","sid":"s-claude","payload":{"type":"control_request","request_id":"demo-cancel-1","request":{"subtype":"interrupt"}}}'
  send_b '{"op":"cancel","sid":"s-codex","payload":{"id":9,"method":"turn/interrupt","params":{"threadId":"<thread-id>","turnId":"<turn-id>"}}}'
  ```

  A cancel that is not answered escalates: the daemon sends a `SIGINT` to the
  process group of the bot after 3 s and a `SIGKILL` after 3 s more
  (`--cancel-grace-ms`, `--cancel-kill-grace-ms`).

* **Resume** — the daemon keeps the last events of a session in a ring
  (`botd/src/ring.ts`). A client that lost a frame asks for the rest:

  ```sh
  send_a '{"op":"resume","sid":"s-claude","fromSeq":<last-seq-known>}'
  ```

### 5.5 What the transcript looks like

The frames of the daemon, one per line (the volatile ids are placeholders):

```
{"op":"hello","botdVersion":"0.1.0","leaseId":"<lease-id-a>","fence":1,"leaseTtlMs":15000}
{"op":"state","sid":"s-claude","state":"starting","progressAt":<epoch-ms>}
{"op":"state","sid":"s-claude","state":"running","progressAt":<epoch-ms>}
{"op":"event","sid":"s-claude","seq":1,"payload":{"type":"system","subtype":"init","session_id":"<provider-session>"}}
{"op":"event","sid":"s-claude","seq":2,"payload":{"type":"assistant","message":{"content":[{"type":"text","text":"<answer>"}]}}}
{"op":"event","sid":"s-claude","seq":3,"payload":{"type":"result","subtype":"success","usage":{"input_tokens":<n>,"output_tokens":<n>}}}
```

## 6. Capture the transcript

| what | where | who writes it |
| --- | --- | --- |
| the frames the client received | `<demo-dir>/host-a.ndjson`, `<demo-dir>/host-b.ndjson` | the client (the redirect of the ssh stdout) |
| the log of the daemon | `<demo-dir>/host-a.log`, `<demo-dir>/host-b.log` | the daemon (stderr) |
| the session table | `~/.volto-botd/sessions.json` on the host | the daemon (`botd/src/store.ts`) |
| the durable session log | `~/.volto-botd/sessions/<sid>.ndjson` on the host | **TODO(card)** — `botd/src/session-log.ts` is not called by the daemon yet |
| the last events of a session | the ring of the daemon, in memory (`botd/src/ring.ts`) | the daemon; a `resume` frame replays them |

The transcript is NDJSON: one frame per line, exactly what the daemon sent.
The directory `botd/.tmp/` is git ignored (`botd/.gitignore`), so the demo
never dirties the clone.

```sh
wc -l "$DEMO_DIR"/host-*.ndjson                    # the size of the transcript
grep -c '"op":"event"' "$DEMO_DIR/host-a.ndjson"   # the events of a step
grep -c '"op":"error"' "$DEMO_DIR"/host-*.ndjson   # 0 — no error frame
grep -c '"op":"state"' "$DEMO_DIR"/host-*.ndjson   # the state changes
```

`grep -c` prints the count and exits 1 when it counts nothing: the `0` of the
error frames is the wanted answer here.

The session table of a host lists the live sessions with their `lastSeq` and
`ackedSeq`; read it while the daemon runs (the last write of a stopping daemon
leaves the table empty):

```sh
ssh '<host-a>' 'cat ~/.volto-botd/sessions.json'
```

## 7. The redaction check

Two steps: a scan for the shapes of a secret, and a masked copy of the
transcript.

### 7.1 The scan

```sh
grep -nE 'sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}' \
  "$DEMO_DIR"/host-*.ndjson
```

No output means no token of a known shape. The patterns are the ones of
`botd/src/redact.ts` (`SECRET_PATTERNS` of that file).

The host names and the addresses of the transcript:

```sh
grep -nE '[0-9]{1,3}(\.[0-9]{1,3}){3}' "$DEMO_DIR"/host-*.ndjson
```

### 7.2 The masked copy

The repository ships a redactor that needs no build step
(`probes/lib/redact.mjs`): it masks the credentials, the host names, the
addresses, the path of the worktree and `$HOME`.

```sh
cp "$DEMO_DIR/host-a.ndjson" "$DEMO_DIR/host-a.redacted.ndjson"
cp "$DEMO_DIR/host-b.ndjson" "$DEMO_DIR/host-b.redacted.ndjson"

node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { createRedactor } from "./probes/lib/redact.mjs";
const { text } = createRedactor();
for (const file of process.argv.slice(1)) {
  const lines = readFileSync(file, "utf8").split("\n");
  writeFileSync(file, lines.map((line) => (line.length > 0 ? text(line) : line)).join("\n"));
}
' "$DEMO_DIR/host-a.redacted.ndjson" "$DEMO_DIR/host-b.redacted.ndjson"
```

The redactor of the daemon (`botd/src/redact.ts`) is the one that will mask
the frames inside `botd serve`; it is not wired in yet (**TODO(card)**). It
knows two modes: the secrets are always masked, the host names and the
addresses only with `hostMask`.

## 8. Verification checklist

| # | check | command | expected |
| --- | --- | --- | --- |
| 1 | the daemon starts locally | `node --experimental-strip-types botd/src/main.ts version` | `0.1.0` |
| 2 | the installer works offline | `bash scripts/botd-selftest.sh` | `52 checks, 0 failures` |
| 3 | botd is installed on `<host-a>` | `ssh '<host-a>' '~/.volto-botd/bin/botd version'` | `0.1.0` |
| 4 | botd is installed on `<host-b>` | `ssh '<host-b>' '~/.volto-botd/bin/botd version'` | `0.1.0` |
| 5 | the daemon answers over ssh | the `hello` frame of section 4.2 | `{"op":"hello",…}` |
| 6 | the sessions started | `grep -c '"op":"state"' "$DEMO_DIR"/host-*.ndjson` | ≥ 2 per host |
| 7 | the three steps ran | `grep -c '"op":"event"' "$DEMO_DIR/host-a.ndjson"` | ≥ 3 (a step is at least one answer) |
| 8 | no error frame | `grep -c '"op":"error"' "$DEMO_DIR"/host-*.ndjson` | `0` |
| 9 | the transcript is complete | `wc -l "$DEMO_DIR"/host-*.ndjson` | ≥ 4 per host |
| 10 | no secret in the transcript | the grep of section 7.1 | no output |
| 11 | the session table of the host | `ssh '<host-a>' 'cat ~/.volto-botd/sessions.json'` | the session with its `lastSeq` |
| 12 | the lockfile is consistent | `node tools/check-lock.mjs` | `lock check: ok` |
| 13 | the suites of the repository | `node --test "botd/test/**/*.test.ts" "client-ui/test/**/*.test.ts"` | all green |
| 14 | the end to end suite | `node --test "botd/e2e/*.test.ts"` | all green |
| 15 | the probes | `node --test "probes/test/**/*.test.mjs"` | all green |

The globs need `globstar` in bash, exactly like the CI
(`.github/workflows/botd-ci.yml`):

```sh
shopt -s globstar nullglob
node --test "botd/test/**/*.test.ts" "client-ui/test/**/*.test.ts"
node --test "botd/e2e/*.test.ts"
node --test "probes/test/**/*.test.mjs"
```

On Node 22 the TypeScript suites need the flag (on Node 24 it is not needed):

```sh
node --experimental-strip-types --test "botd/test/**/*.test.ts"
```

## 9. Troubleshooting

| symptom | cause | what to do |
| --- | --- | --- |
| `ssh: Could not resolve hostname <host-a>` | the alias is unknown | `ssh -G '<host-a>' \| head` prints the resolved configuration |
| `botd: command not found` over ssh | `~/.local/bin` is not on the PATH of a non interactive shell | use the absolute path `~/.volto-botd/bin/botd` |
| `Error [ERR_NO_TYPESCRIPT]: Node.js is not compiled with TypeScript support` | the node of the host was built without type stripping | install an official node ≥ 22.18 (or node 24) on the host |
| `{"op":"error","code":"bad_frame","message":"bot.kind must be one of acp, codex-app-server, pi-rpc"}` | the kind of the `open` frame is wrong | use `acp` for Claude Code and `codex-app-server` for Codex (section 5) |
| `{"op":"error","code":"no_lease","message":"send hello before other frames"}` | the `hello` frame is missing | send `hello` first, it carries the lease |
| `{"op":"error","code":"lease_paused"}` and `botd: lease expired, the sessions are paused` | the lease was not renewed | renew every `leaseTtlMs / 3` (section 4.2) |
| `botd: lease expired twice, the sessions are terminated` | no renewal for two TTL | send `hello` again and open the session anew |
| `{"op":"error","code":"stale_fence",…}` | another client took the lease over | one client per daemon; the new `hello` invalidated the old fence |
| `{"op":"error","code":"stale_lease","message":"unknown lease …"}` | the renew carried a wrong lease id | copy `leaseId` and `fence` from the answer of the `hello` |
| `{"op":"error","code":"session_exited"}` | the bot of the session died | the reason is in the log of the daemon: `cat "$DEMO_DIR/host-a.log"` |
| the transcript stays empty | the stdout of the ssh command was not redirected | redirect it: `> "$DEMO_DIR/host-a.ndjson"`; the daemon stops as soon as its stdin ends, so keep the write end of the FIFO open |
| the bot answers nothing | the CLI is not installed or not logged in on the host | `ssh '<host-a>' 'claude --version'`, then check the login of the CLI; `probes/REPORT.md` shows what the probes found on the machine of the author |
| Codex does not start the turn | the handshake is missing or the thread id is wrong | send `initialize`, `initialized` and `thread/start` first; the thread id is in the `thread/started` notification |
| the daemon does not answer the approval of Codex | there is no `answerPermission` frame | answer with a raw `send` frame (section 5.4) |
| the session table is empty after the demo | the last write of the stopping daemon clears the table | read the table while the daemon runs (section 6) |

## 10. Teardown

```sh
# 1 — close the write ends: both daemons stop and take their children with
#     them (the daemon kills the process group of every session)
exec 9>&-
exec 8>&-

# 2 — nothing of the demo is left on the hosts
ssh '<host-a>' 'rm -rf ~/.volto-botd ~/.local/bin/botd'
ssh '<host-b>' 'rm -rf ~/.volto-botd ~/.local/bin/botd'

# 3 — the transcript is inside the clone and git ignored
rm -rf botd/.tmp/demo
```

Keep the redacted transcript if the demo is to be shown; it is the only
artefact of the run that may leave the machine.

## Appendix A — the frames of one demo run

| # | host | direction | frame |
| --- | --- | --- | --- |
| 1 | `<host-a>` | client → daemon | `{"op":"hello","clientId":"demo-m0"}` |
| 2 | `<host-a>` | daemon → client | `{"op":"hello","botdVersion":"0.1.0","leaseId":"…","fence":1,"leaseTtlMs":15000}` |
| 3 | `<host-a>` | client → daemon | `{"op":"open","sid":"s-claude","bot":{"kind":"acp","command":["claude","-p","--input-format","stream-json","--output-format","stream-json","--verbose"],"cwd":"<work>"}}` |
| 4 | `<host-a>` | daemon → client | `{"op":"state","sid":"s-claude","state":"starting",…}` |
| 5 | `<host-a>` | daemon → client | `{"op":"state","sid":"s-claude","state":"running",…}` |
| 6 | `<host-a>` | client → daemon | `{"op":"send","sid":"s-claude","payload":{"type":"user","message":{"role":"user","content":"Step 1 of 3 …"}}}` |
| 7 | `<host-a>` | daemon → client | `{"op":"event","sid":"s-claude","seq":1,"payload":{…}}` |
| 8 | `<host-b>` | client → daemon | `{"op":"hello","clientId":"demo-m0"}` |
| 9 | `<host-b>` | client → daemon | `{"op":"open","sid":"s-codex","bot":{"kind":"codex-app-server","command":["codex","app-server"],"cwd":"<work>"}}` |
| 10 | `<host-b>` | client → daemon | `{"op":"send","sid":"s-codex","payload":{"id":1,"method":"initialize","params":{…}}}` |
| 11 | `<host-b>` | client → daemon | `{"op":"send","sid":"s-codex","payload":{"method":"initialized"}}` |
| 12 | `<host-b>` | client → daemon | `{"op":"send","sid":"s-codex","payload":{"id":2,"method":"thread/start","params":{…}}}` |
| 13 | `<host-b>` | daemon → client | `{"op":"event","sid":"s-codex","seq":1,"payload":{"method":"thread/started",…}}` |
| 14 | `<host-b>` | client → daemon | `{"op":"send","sid":"s-codex","payload":{"id":3,"method":"turn/start","params":{"threadId":"<thread-id>","input":[…]}}}` |
| 15 | `<host-b>` | daemon → client | `{"op":"event","sid":"s-codex","seq":2,"payload":{…}}` |
| 16 | `<host-a>` | client → daemon | `{"op":"send","sid":"s-claude","payload":{"type":"user","message":{"role":"user","content":"Step 3 of 3 …"}}}` |
| 17 | `<host-a>` | client → daemon | `{"op":"ack","sid":"s-claude","seq":<last-seq>}` |
| 18 | both | client → daemon | `{"op":"renew","leaseId":"<lease-id-a>","fence":1}` (every 5 s, one lease per host) |

## Appendix B — `botd/PROTOCOL.md` and the frames of the daemon

| `botd/PROTOCOL.md` | implemented in `botd/src/protocol.ts` | state |
| --- | --- | --- |
| `handshake` | `hello` | the lease is taken with `hello` |
| `prompt` | `send` | the payload is the provider native message |
| `answerPermission` | — | **TODO(card)**: a raw `send` frame answers an approval |
| `cancel` with a stage | `cancel` | the escalation is done by the daemon |
| `ready` | `state` | the state of the session |
| `text`, `tool`, `permission`, `turn_end` | `event` | the payload is the raw provider line |
| `error` with a code of §8 | `error` | the codes of the daemon differ (`bad_frame`, `no_lease`, `lease_paused`, `stale_fence`, `stale_lease`, `session_exited`, `unknown_session`, `child_error`, `bad_json`) |
| `resume` with `fromSeq` | `resume` | the replay comes from the ring |
| the sequence numbers and the acknowledgements of §4 | `ack` | the daemon numbers the events per session |
