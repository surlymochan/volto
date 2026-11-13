# volto

**volto** — every bot wears a role.

A control plane where AI bots work as a cast: each bot has its own role,
memory, and knowledge, and they negotiate the work among themselves.

volto is made of three parts:

* **client-ui** — the "Remote bots" panel. The place where an operator sees
  the hosts, the bots on them, their leases and the events of their sessions.
* **botd** — the bot daemon. It runs on an *executor host*, starts the bot
  CLIs and speaks one line-based protocol with the control plane.
* **the adapters** — one per bot CLI. Each adapter knows how to start its CLI
  in the machine protocol of that CLI and how to translate what the CLI
  prints into the events volto speaks.

The wire format between the control plane and the daemon is specified in
[botd/PROTOCOL.md](botd/PROTOCOL.md). The operator view of the same daemon —
installing it, the bot binaries it needs, leases, permissions, redaction and
debug logs — is in [botd/RUNBOOK.md](botd/RUNBOOK.md).

## Architecture

```
   browser                control plane               executor host
 +-------------+       +---------------+        +----------------------+
 |  client-ui  |       |     relay     |  ssh   |  botd serve          |
 | "Remote     | ----> |   (Coming)    | -----> |  (botd/src)          |
 |  bots"      | NDJSON|               | <alias>|                      |
 +-------------+       +---------------+        +----------+-----------+
                                                             |
                                          one child process per session
                                                             v
       +---------+  +---------+  +---------+  +---------+  +---------+  +-------+
       | claude  |  | codex   |  | copilot |  |   agy   |  |   dsh   |  |  pi   |
       +---------+  +---------+  +---------+  +---------+  +---------+  +-------+
```

The adapters and the machine protocol of every bot CLI:

| adapter | binary on the host | machine protocol | note |
| --- | --- | --- | --- |
| `claude` | `claude` | stream-json | |
| `codex` | `codex` | JSON-RPC app-server | |
| `copilot` | `copilot` | ACP | disabled unless `COPILOT_ENABLED=1` |
| `agy` | `agy` | ACP, stream-json fallback | `VOLTO_AGY_PROTOCOL` pins the choice |
| `dsh` | `dsh` | ACP | |
| `pi` | `pi` | pi RPC | Coming: the adapter module is not in this build |

Reading the diagram from the left:

* **client-ui** is a browser panel. It talks to a `BotdClient`
  ([client-ui/src/client.ts](client-ui/src/client.ts)); today the only
  implementation is the mock client, so the panel runs against simulated
  hosts and bots.
* **relay** is the multiplexer that will sit between the panel and the
  executor hosts. It is **Coming**: it is not in this tree yet, and the
  diagram marks it as such.
* **ssh** is the transport to an executor host. The daemon is started as a
  forced command (`ssh <ssh-alias> botd serve`) and speaks NDJSON over
  stdin/stdout.
* **botd** owns the sessions, the leases and the session table. It spawns
  one child process per session — never through a shell, and never with a
  secret in `argv`.
* **the adapters** translate the output of a bot CLI into the normalized
  events of the protocol. The `pi` adapter is **Coming**: the registry knows
  the kind, but `botd/src/adapters/pi.ts` is not part of this build yet.

## Repository layout

```
volto/
├── README.md          this file
├── botd/              the bot daemon (Node, TypeScript, no dependencies)
│   ├── PROTOCOL.md    the NDJSON wire protocol, version 1
│   ├── RUNBOOK.md     operator runbook for the executor hosts
│   ├── src/           daemon, sessions, leases, adapters, policy, redaction
│   └── test/          the botd test suite (node --test)
├── client-ui/         the "Remote bots" panel (browser, no bundler)
│   ├── serve.mjs      the dev server (transpiles the sources on the fly)
│   ├── src/           panel, state, client contract, mock client
│   └── test/          the client-ui test suite (node --test)
├── probes/            read-only probes of the bot CLIs (probes/README.md)
├── python/            the python packaging of volto
├── scripts/           install-botd.sh and botd-selftest.sh
└── .github/workflows/ CI: the botd and client-ui suites on Node 24
```

## Requirements

| where | what |
| --- | --- |
| development machine (the Mac) | Node **24** or newer |
| executor host | Node **24** or newer, plus the bot CLIs you want to drive |

* Node 24 is the version the repository is developed and tested against: CI
  runs the suites on Node 24, and `node --test` runs the TypeScript suites
  directly because Node 24 strips the types itself.
* The daemon itself declares a lower floor: `botd/package.json` asks for
  `node >= 22.18.0` (the first release that strips types without a flag),
  and `scripts/install-botd.sh` refuses a host whose `node` is older than 22.
  That floor is not exercised by CI, so **24 is the supported runtime**.
* No dependencies have to be installed: `botd/` has no `node_modules` and no
  build step, and the panel transpiles its TypeScript on the fly when the
  dev server serves it.
* Each adapter needs its own CLI on the executor host (see
  [botd/RUNBOOK.md](botd/RUNBOOK.md#the-bot-binaries-per-adapter)).

## Quick start

Everything below runs from a clone of this repository.

```sh
# 1. see what the installer would do (no host is contacted)
bash scripts/install-botd.sh <ssh-alias> --dry-run

# 2. install the daemon on an executor host
bash scripts/install-botd.sh <ssh-alias>

# 3. run the offline self test of the installer
bash scripts/botd-selftest.sh

# 4. run the test suites
node --test "botd/test/**/*.test.ts"
node --test "client-ui/test/**/*.test.ts"

# 5. open the panel
node client-ui/serve.mjs --port 8080
```

Then open <http://127.0.0.1:8080/?mock=1>.

The panel today always runs against the mock client
([client-ui/src/app.ts](client-ui/src/app.ts)); the `?mock=1` marker names
the mode that is coming with the real daemon client and is ignored by the
current build. The dev server picks a random free port when `--port` is
missing and prints the URL it bound to.

More things that exist today:

```sh
# list the probes and exit (no bot is started)
node probes/run.mjs --dry-run

# the browser smoke test of the panel (skipped when playwright is missing)
node client-ui/smoke.mjs

# the botd suite from inside botd/ (npm test)
cd botd && npm test
```

## Coming

The following is **not** in this tree yet; it is listed here so nobody goes
looking for it:

* **the relay** — the multiplexer between the panel and the executor hosts.
  The diagram above marks it as Coming.
* **the real daemon client** — the panel always uses the mock client today.
* **the `pi` adapter** — `botd/src/adapters/pi.ts` is not part of this build;
  the registry hands out a placeholder that refuses to talk to a provider.
  The pi CLI itself speaks `pi --mode rpc` (see
  [probes/README.md](probes/README.md)).
* **the session event log in the daemon** — `botd/src/session-log.ts` is a
  tested module, but the daemon does not write it yet (see the runbook).
