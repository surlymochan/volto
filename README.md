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
| `pi` | `pi` | pi RPC | `pi --mode rpc` |

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
  events of the protocol. All six adapters are in this build, `pi` included:
  the registry loads [botd/src/adapters/pi.ts](botd/src/adapters/pi.ts)
  lazily, so a tree without the module still starts and only the `pi` kind
  stays disabled.

## The modules of botd

`botd/src/` is a set of small modules without dependencies:

| module | what it does |
| --- | --- |
| `botd/src/main.ts`, `botd/src/cli.ts` | the entry point: `botd serve`, `botd version`, `botd help` |
| `botd/src/daemon.ts`, `botd/src/session.ts` | the daemon, the child processes and the events of a session |
| `botd/src/lease.ts` | the lease of the control plane and its fence |
| `botd/src/lease-store.ts` | the two level lease store (host lease, session lease) |
| `botd/src/router.ts` | which bot gets which task (pure, no I/O) |
| `botd/src/orchestrator.ts` | runs one task on a bot: routing, spawning, watchdog, cancel escalation |
| `botd/src/adapters/` | one adapter per bot CLI: `agy`, `claude`, `codex`, `copilot`, `dsh`, `pi` |
| `botd/src/permission.ts` | the permission policy: `allow`, `deny` or `ask` |
| `botd/src/redact.ts` | masks the secrets of a text or of a payload |
| `botd/src/session-log.ts`, `botd/src/store.ts` | the NDJSON event log and the session table |
| `botd/src/metrics.ts` | the in-process metrics registry (counters, gauges, histograms, Prometheus text) |
| `botd/src/protocol.ts`, `botd/src/frames.ts`, `botd/src/config.ts` | the wire format, the NDJSON framing and the configuration |

Two of them are worth a second look, because the daemon itself does not call
them yet (see [Coming](#coming)):

* **[botd/src/orchestrator.ts](botd/src/orchestrator.ts)** — `runTask()` runs
  one task on a bot: the router picks the bot, the adapter starts it, the
  normalized events are streamed to the caller, and the watchdog plus the
  cancel escalation stop a turn that hangs. Everything it touches is
  injected, so the whole flow runs without a real bot.
* **[botd/src/metrics.ts](botd/src/metrics.ts)** — a small, dependency free
  metrics registry: counters, gauges and histograms with fixed buckets, a
  JSON snapshot and the Prometheus text exposition format. It stays inside
  the process: there is no server, no network traffic and no background
  task.

## Repository layout

```
volto/
├── README.md          this file
├── botd/              the bot daemon (Node, TypeScript, no dependencies)
│   ├── PROTOCOL.md    the NDJSON wire protocol, version 1
│   ├── RUNBOOK.md     operator runbook for the executor hosts
│   ├── src/           daemon, sessions, leases, adapters, policy, redaction,
│   │                  orchestration, metrics
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
| development machine (the Mac) | Node **22.22** or newer — **Node 24 preferred** |
| executor host | Node **22.22** or newer — **Node 24 preferred** — plus the bot CLIs you want to drive |

* Node 24 is the version the repository is developed and tested against: CI
  runs the suites on Node 24, and `node --test` runs the TypeScript suites
  directly because Node 24 strips the types itself.
* The daemon declares a lower floor of its own: `botd/package.json` asks for
  `node >= 22.18.0` (the first release that strips types without a flag).
  `scripts/install-botd.sh` refuses a host whose `node` is older than the
  floor it enforces (`MIN_NODE_VERSION`), only warns when the host is below
  node 24, and can install a private node 24 into the prefix with
  `--ensure-node`. **Node 22.22 and later are supported; node 24 is the
  version to use.**
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

# 2b. on a host without node 24: install a private node 24 into the prefix
bash scripts/install-botd.sh <ssh-alias> --ensure-node

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

The following is **not** in this tree yet — either not at all, or as a module
the daemon does not call yet. It is listed here so nobody goes looking for
it:

* **the relay** — the multiplexer between the panel and the executor hosts.
  The diagram above marks it as Coming.
* **the real daemon client** — the panel always uses the mock client today.
* **the session event log in the daemon** — `botd/src/session-log.ts` is a
  tested module, but the daemon does not write it yet (see the runbook).
* **the metrics in the daemon** — `botd/src/metrics.ts` is a tested module
  (counters, gauges, histograms and the Prometheus text exposition), but the
  daemon does not record anything yet.
* **the orchestrator in the daemon** — `botd/src/orchestrator.ts` runs a task
  on a bot (routing, spawning, watchdog, cancel escalation), but the daemon
  does not call it: the control plane is supposed to drive it.
