# botd end-to-end suite

The suite starts the **real** daemon (`botd/src/main.ts`) as a child process
and drives it over stdio with the NDJSON frames of the protocol. The bot
behind the sessions is the fake ACP bot of `fixtures/fake-bot.mjs`: it
streams the chunks of a turn, it can hang and it ignores SIGINT, so the
escalation of a cancel is visible.

Everything is synthetic: no host name, address, token or real data shows up
in the suite. The scratch space (the botd homes, the logs of the fake bot)
lives inside the worktree, in `botd/e2e/.tmp` (git ignored).

## Running the suite

The suite is TypeScript and runs straight through Node, which strips the
types itself (Node 23 and later, Node 24 in the CI):

```sh
node --test botd/e2e/*.test.ts   # the test files
node --test botd/e2e             # the whole suite through botd/e2e/aggregate.ts
```

The suite needs the daemon entry point: when `botd/src/main.ts` is missing,
every test is skipped with a clear message instead of failing.

## What is covered

| file | what it checks |
| --- | --- |
| `stream.test.ts` | the daemon streams the events of a turn to the client, numbers them and records the acknowledgement in the session table |
| `resume.test.ts` | the client resumes a session: the events it missed are replayed when the transport to the bot dies, and the daemon reports the gap when the daemon itself went away |
| `lease.test.ts` | the daemon pauses the sessions when the lease expires (the input is not forwarded any more) and resumes them on a renew |
| `cancel.test.ts` | the daemon escalates a cancel: the provider cancel first, then SIGINT, then the kill of the process group of the bot |

## The pieces

* `frame-client.ts` — the minimal frame client: it starts the daemon, sends
  the frames (`hello`, `open`, `send`, `ack`, `cancel`, `resume`, `renew`)
  and waits for the answers.
* `support.ts` — the helpers: the paths, the scratch space, the log of the
  fake bot and the session table of the daemon.
* `fixtures/fake-bot.mjs` — the fake ACP bot.
