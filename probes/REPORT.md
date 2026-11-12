# volto - bot protocol probes

Generated 2026-11-12 17:58:51 UTC - hard timeout 120 s per bot - probe prompt: "Reply with the single word PONG" (no tools).

Every probe starts the bot in its machine protocol, creates a session, sends one trivial prompt, cancels a second prompt and closes the process.
Transcripts are redacted (no tokens, host names or IP addresses) and live under `probes/out/`, which is git-ignored.

Skipped on this host: Codex (not logged in), Claude Code (binary not found on PATH), dsh (binary not found on PATH), Antigravity (binary not found on PATH).

## Summary

| bot | status | protocol | session create | streaming granularity | cancel works? | resume / load | permission request shape | auth state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | skipped (not logged in) | JSON-RPC 2.0 (app-server) (stdio, newline-delimited JSON) | yes - thread/start | none | yes | yes - thread/resume | server->client requests: item/commandExecution/requestApproval, item/fileChange/requestApproval, item/permissions/requestApproval, item/tool/requestUserInput; approval answer: { decision: 'accept'\|'acceptForSession'\|'decline'\|'cancel' } | not-logged-in |
| Claude Code | skipped (binary not found on PATH) | stream-json (Claude Code SDK) (stdio, newline-delimited JSON) | unknown - implicit (one session per process, session id in the init event) | unknown | unknown | unknown - --resume <session-id> / --continue | server->client: { type: 'control_request', request: { subtype: 'can_use_tool', tool_name, input, permission_suggestions, request_id } }; client->server: { type: 'control_response', response: { subtype: 'success', request_id, response: { behavior: 'allow'\|'deny' } } } | unknown |
| dsh | skipped (binary not found on PATH) | ACP (Agent Client Protocol) (stdio, newline-delimited JSON) | unknown - session/new | unknown | unknown | unknown - session/load | agent->client request: session/request_permission { sessionId, toolCall, options:[{ optionId, name, kind }] }; answer: { outcome: { outcome: 'selected', optionId } } | unknown |
| pi | ok | pi RPC (JSON lines) (stdio, newline-delimited JSON) | yes - new_session | token-delta | yes | yes - switch_session (also fork / clone) | client<-server: { type: 'extension_ui_request', id, method: 'select'\|'confirm'\|'input'\|'editor'\|'notify', title, ... }; client->server answer: { type: 'extension_ui_response', id, value\|confirmed\|cancelled } | logged-in |
| Antigravity | skipped (binary not found on PATH) | ACP (Agent Client Protocol) (stdio, newline-delimited JSON) | unknown - session/new | unknown | unknown | unknown - session/load | agent->client request: session/request_permission { sessionId, toolCall, options:[{ optionId, name, kind }] } | unknown |

## Per bot detail

### Codex

| field | value |
| --- | --- |
| status | skipped (not logged in) |
| binary | codex codex-cli 0.166.0 |
| protocol | JSON-RPC 2.0 (app-server) - stdio, newline-delimited JSON |
| session create | yes - thread/start: thread/start returned a thread id (sessionId present) |
| streaming granularity | none: no assistant output observed |
| cancel works? | yes - turn/interrupt: turn/interrupt accepted, the turn reported status 'interrupted' |
| resume / load support | yes - thread/resume: thread/resume accepted for the current thread |
| permission request shape | server->client requests: item/commandExecution/requestApproval, item/fileChange/requestApproval, item/permissions/requestApproval, item/tool/requestUserInput; approval answer: { decision: 'accept'\|'acceptForSession'\|'decline'\|'cancel' } |
| auth state | not-logged-in: account/read -> requiresOpenaiAuth=true, accountType=none |
| timings | initialize 125 ms, session 22 ms, first output -, prompt 20058 ms, cancel 511 ms, total 20749 ms |
| methods | 179 client requests, 85 notifications, 11 server requests |
| transcript | `probes/out/codex.jsonl` |

Notes:

- Method inventory taken from `codex app-server generate-json-schema`: 179 client requests, 85 server notifications, 11 server requests.
- initialize handshake ok, server reported volto-probe/0.166.0 (Ubuntu 24.4.0; x86_64) unknown (volto-probe; 0.0.1).
- turn/completed did not arrive within the probe budget (expected when the CLI is not authenticated).

Method inventory: 179 client requests, 85 notifications, 11 server requests (full list in `probes/out/summary.json`).

Session / turn related requests: account/gatewayOAuth/cancel, account/gatewayOAuth/login, account/gatewayOAuth/read, account/login/cancel, account/workspaceMessages/read, accountSession/list, accountSession/switch, config/mcpServer/reload, feedback/upload, fuzzyFileSearch/sessionStart, fuzzyFileSearch/sessionStop, fuzzyFileSearch/sessionUpdate, initialize, mcpServer/oauth/login, permissionProfile/list, thread/approveGuardianDeniedAction, thread/archive, thread/attachment/add, thread/attachment/list, thread/attachment/remove, thread/attachmentOwner/list, thread/backgroundTerminals/clean, thread/backgroundTerminals/list, thread/backgroundTerminals/terminate, and 55 more.

### Claude Code

| field | value |
| --- | --- |
| status | skipped (binary not found on PATH) |
| binary | claude |
| protocol | stream-json (Claude Code SDK) - stdio, newline-delimited JSON |
| session create | unknown - implicit (one session per process, session id in the init event): not probed (binary missing) |
| streaming granularity | unknown: not probed (binary missing) |
| cancel works? | unknown - control_request { subtype: 'interrupt' }: not probed (binary missing) |
| resume / load support | unknown - --resume <session-id> / --continue: not probed (binary missing) |
| permission request shape | server->client: { type: 'control_request', request: { subtype: 'can_use_tool', tool_name, input, permission_suggestions, request_id } }; client->server: { type: 'control_response', response: { subtype: 'success', request_id, response: { behavior: 'allow'\|'deny' } } } |
| auth state | unknown: not probed (binary missing) |
| timings | initialize -, session -, first output -, prompt -, cancel -, total - |
| methods | 0 client requests, 0 notifications, 0 server requests |
| transcript | `probes/out/claude.jsonl` |

Notes:

- Install the Claude Code CLI to run this probe.

### dsh

| field | value |
| --- | --- |
| status | skipped (binary not found on PATH) |
| binary | dsh |
| protocol | ACP (Agent Client Protocol) - stdio, newline-delimited JSON |
| session create | unknown - session/new: not probed (binary missing) |
| streaming granularity | unknown: not probed (binary missing) |
| cancel works? | unknown - session/cancel (notification): not probed (binary missing) |
| resume / load support | unknown - session/load: not probed (binary missing) |
| permission request shape | agent->client request: session/request_permission { sessionId, toolCall, options:[{ optionId, name, kind }] }; answer: { outcome: { outcome: 'selected', optionId } } |
| auth state | unknown: not probed (binary missing) |
| timings | initialize -, session -, first output -, prompt -, cancel -, total - |
| methods | 0 client requests, 0 notifications, 0 server requests |
| transcript | `probes/out/dsh.jsonl` |

Notes:

- Install the dsh CLI to run this probe.

### pi

| field | value |
| --- | --- |
| status | ok |
| binary | pi 0.73.0 |
| protocol | pi RPC (JSON lines) - stdio, newline-delimited JSON |
| session create | yes - new_session: new_session accepted (session id + file reported by get_state) |
| streaming granularity | token-delta (1 samples): 1 message_update/text_delta events |
| cancel works? | yes - abort: abort acknowledged; the run ended with stopReason 'aborted' |
| resume / load support | yes - switch_session (also fork / clone): switch_session reloaded the session file created by the probe |
| permission request shape | client<-server: { type: 'extension_ui_request', id, method: 'select'\|'confirm'\|'input'\|'editor'\|'notify', title, ... }; client->server answer: { type: 'extension_ui_response', id, value\|confirmed\|cancelled } |
| auth state | logged-in: provider minimax-sandbox / model MiniMax-M3.1-Flash available |
| timings | initialize 1091 ms, session 25 ms, first output 975 ms, prompt 1411 ms, cancel 57 ms, total 2602 ms |
| methods | 5 client requests, 7 notifications, 0 server requests |
| transcript | `probes/out/pi.jsonl` |

Notes:

- Session persisted to <worktree>/probes/.tmp/pi-mwduq0hd/sessions/2026-11-12T17-58-50-466Z_01a1d0e9-9160-725b-8455-19796335f620.jsonl.
- Session id 01a1d0e9-9160-725b-8455-19796335f620.

Method inventory: 5 client requests, 7 notifications, 0 server requests (full list in `probes/out/summary.json`).

Session / turn related requests: abort, new_session, prompt, switch_session.

### Antigravity

| field | value |
| --- | --- |
| status | skipped (binary not found on PATH) |
| binary | agy |
| protocol | ACP (Agent Client Protocol) - stdio, newline-delimited JSON |
| session create | unknown - session/new: not probed (binary missing) |
| streaming granularity | unknown: not probed (binary missing) |
| cancel works? | unknown - session/cancel (notification): not probed (binary missing) |
| resume / load support | unknown - session/load: not probed (binary missing) |
| permission request shape | agent->client request: session/request_permission { sessionId, toolCall, options:[{ optionId, name, kind }] } |
| auth state | unknown: not probed (binary missing) |
| timings | initialize -, session -, first output -, prompt -, cancel -, total - |
| methods | 0 client requests, 0 notifications, 0 server requests |
| transcript | `probes/out/agy.jsonl` |

Notes:

- Install the Antigravity CLI to run this probe.

## How to reproduce

```sh
node probes/run.mjs --dry-run   # list the probes
node probes/run.mjs            # run them and rewrite this file
node --test "probes/test/**/*.test.mjs"
```

The runner never passes credentials: it only asks each CLI for its own status and inherits the ambient environment.

