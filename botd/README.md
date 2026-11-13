# botd — the bot daemon of volto

## What botd is

botd is the daemon of volto: it runs on an executor host, starts one bot CLI per
session and speaks the NDJSON protocol of [PROTOCOL.md](PROTOCOL.md) with the
control plane — the relay in `client-ui/relay.mjs`, which reaches the daemon over ssh.

## Requirements

* **Node >= 22.18** — the floor of `botd/package.json` (`engines`), the first
  release that strips the types of the sources without a flag. **Node 24 is
  preferred**: it is the version the project targets and CI runs on.
* **Two executor hosts** reachable over ssh, with the aliases `<host-a>` and
  `<host-b>` in `~/.ssh/config`. The alias is the only name that is used — no
  hostname, no address, no user name, no token — and ssh has to reach the
  hosts without a prompt (`BatchMode=yes`).
* **The bot CLIs on the hosts**: `claude` on `<host-a>`, `codex` on
  `<host-b>`, installed and logged in. `RUNBOOK.md` lists the binary of every
  adapter.
* Nothing to install: `botd/` has no `node_modules` and no build step.

## Quickstart — a macOS client, two remote bots

### 1. Install botd on both hosts

`scripts/install-botd.sh` installs the daemon over ssh in six steps (seven with
`--ensure-node`): preflight (node >= 22.18), directories, sync of `botd/`, the
launcher, the symlink and the verification. It never uses sudo and never
writes outside the prefix.

```sh
# the plan first: no host is contacted
bash scripts/install-botd.sh '<host-a>' --dry-run
bash scripts/install-botd.sh '<host-b>' --dry-run

# the installation: one status line per step
bash scripts/install-botd.sh '<host-a>'
bash scripts/install-botd.sh '<host-b>'

# only on a host without node 24: a private node 24 into the prefix
bash scripts/install-botd.sh '<host-b>' --ensure-node
```

What lands on a host: `~/.volto-botd/app` (the copy of `botd/` without
`test/`), the launcher `~/.volto-botd/bin/botd` and the symlink
`~/.local/bin/botd` — `botd serve` starts the daemon.

### 2. Start the relay with the two hosts

The relay serves the panel and its API on one port and talks to every host
over ssh. The host list comes from `--hosts <file>` or from `BOTD_HOSTS`.

```sh
mkdir -p botd/.tmp
cat > botd/.tmp/hosts.json <<'JSON'
[
  {
    "alias": "<host-a>",
    "label": "claude host",
    "command": ["ssh", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "<host-a>", "botd", "serve"]
  },
  {
    "alias": "<host-b>",
    "label": "codex host",
    "command": ["ssh", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "<host-b>", "botd", "serve"]
  }
]
JSON

node client-ui/relay.mjs --hosts botd/.tmp/hosts.json --port 8080
# → relay listening on http://127.0.0.1:8080
```

The fields of a host:

| field | meaning |
| --- | --- |
| `alias` | required; the ssh alias of the host, `[A-Za-z0-9_][A-Za-z0-9_.-]*`. The angle brackets of the example are placeholders: replace `<host-a>` and `<host-b>` with the real aliases |
| `label` | optional; the name the panel shows next to the alias |
| `command` | optional; the argv the relay spawns for the host |

The `command` array is the argv of the child the relay spawns and speaks
NDJSON to; the array of the example is `sshArgs()` of `botd/src/client.ts`,
and without `command` the relay uses exactly that array with the alias. A
control plane that wants a unix socket instead of stdio uses
`scripts/botd-stdio-bridge.mjs <ssh-alias> <socket-path>`.

### 3. Open the panel and drive both hosts

The panel is served by `client-ui/serve.mjs`; the relay starts that same
server, so the panel and the API share the port of the relay. The panel reads
the relay from the `relay` query parameter and falls back to the origin of the
page (`client-ui/src/real-client.ts`); the relay answers only requests from
its own origin, so the panel stays on that port. Open
<http://127.0.0.1:8080/> — the explicit form of the same thing is
<http://127.0.0.1:8080/?relay=http://127.0.0.1:8080/>.

1. Both hosts appear in the sidebar. Press **Connect** on `<host-a>` and on
   `<host-b>`: the relay opens the ssh session, the daemon answers the
   `hello` frame, and the bots of the host go from `down` to `idle`.
2. Open a claude bot on `<host-a>` and a codex bot on `<host-b>`. The panel
   has no start button yet, so the session is opened over the API of the
   relay; the panel picks it up on the next poll:

```sh
curl -sS -X POST http://127.0.0.1:8080/api/hosts/<host-a>/sessions \
  -H 'content-type: application/json' -d '{"kind":"claude"}'
# → {"sessionId":"…","botId":"<host-a>:claude"}

curl -sS -X POST http://127.0.0.1:8080/api/hosts/<host-b>/sessions \
  -H 'content-type: application/json' -d '{"kind":"codex"}'
# → {"sessionId":"…","botId":"<host-b>:codex"}
```

The `kind` names the adapter (`claude` runs `claude -p --input-format
stream-json --output-format stream-json --verbose`, `codex` runs `codex
app-server`); without `cwd` the bot starts in the home of the ssh user.

### 4. Lease, fence and the frame log

The relay takes one lease per host with a `hello` frame and renews it every
third of the TTL (15 s by default): a host that stays quiet for longer than
the TTL pauses its sessions and, after two TTLs, terminates the children. The
fence is the counter that makes a takeover safe — a second client that takes
over an expired lease gets a higher fence, and the frames of the old client
are refused with `stale_fence`.

To see the frames of a run, start the relay with a frame log:

```sh
node client-ui/relay.mjs --hosts botd/.tmp/hosts.json --port 8080 \
  --frame-log botd/.tmp/frames.ndjson
tail -f botd/.tmp/frames.ndjson
```

The log is NDJSON: one redacted frame per line (`ts`, host, kind, `dir`,
`c2s` or `s2c`, and the frame); `BOTD_FRAME_LOG` names the same file.

## Where to go next

* [DEMO.md](DEMO.md) — the M0 demo end to end: the two hosts, the frames, the
  collaboration and the teardown.
* [RUNBOOK.md](RUNBOOK.md) — the operator runbook: the install, the bot
  binaries, the leases, the permissions and the debug logs.
* [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — the protocol errors and the other
  symptoms, with the probes that tell them apart.
* [PROTOCOL.md](PROTOCOL.md) — the wire format between the control plane and
  the daemon, version 1.
