# volto protocol probes

Read only probes for the five bots volto wants to drive. Each probe starts the
bot in its **machine protocol**, creates a session, sends one trivial prompt
("Reply with the single word PONG", no tools), cancels a second prompt and
closes the process. The probes record timings and which methods / notifications
exist.

| bot | machine protocol | started as |
| --- | --- | --- |
| Codex | JSON-RPC 2.0 over stdio | `codex app-server` |
| Claude Code | stream-json (Claude Code SDK) | `claude -p --output-format stream-json --input-format stream-json --verbose` |
| dsh | ACP (Agent Client Protocol) | `dsh --profile acp` |
| pi | pi RPC (JSON lines) | `pi --mode rpc` |
| Antigravity | ACP, print mode as fallback | `agy --acp` / `agy -p --output-format stream-json` |

## Usage

```sh
node probes/run.mjs --dry-run        # list the probes, exit 0
node probes/run.mjs                   # run every probe and rewrite probes/REPORT.md
node probes/run.mjs --bot pi          # run a single probe
node probes/run.mjs --timeout 60     # shorter hard timeout per bot
node --test "probes/test/**/*.test.mjs"
```

Every probe has a hard timeout of 120 s (override with `--timeout`).

## Safety rules

* The probes never pass credentials: no API keys, no tokens, no `--api-key`
  flags. They only ask a CLI for its own status (`codex login status`, the
  pi model list, ...) and inherit the ambient environment.
* A bot whose binary is missing, or that is not logged in, is skipped cleanly
  and reported as `skipped`.
* Every probe runs in its own scratch directory below `probes/.tmp/` (git
  ignored) and writes its transcript to `probes/out/` (git ignored).
* Transcripts and the report are redacted: no tokens, no host names, no IP
  addresses, no user names.
* The probes only read: the prompts they send need no tools and the Codex
  probe runs with `approvalPolicy: never` and `sandbox: read-only`. Approval
  requests are always declined.

## Layout

```
probes/
├── run.mjs          # CLI: --dry-run, --bot, --timeout, --out, --report
├── REPORT.md        # generated report (committed)
├── bots/            # one module per bot
├── lib/             # jsonl, jsonrpc, acp, process, redact, report helpers
├── out/             # raw redacted transcripts (git ignored)
└── test/            # node --test suites
```
