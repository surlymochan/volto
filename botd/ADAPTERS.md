# botd adapters

`botd` runs one bot CLI per session. Every CLI speaks its own machine
protocol, so `botd/src/adapters/` holds one adapter per CLI: the adapter
starts the CLI in its machine protocol and translates the lines the CLI
prints into the normalized events of `botd/src/adapter-types.ts`
(`NormalizedEvent`). The rest of the daemon never sees a provider line.

The registry (`botd/src/adapters/index.ts`) is the single place that knows
every adapter kind:

* `ADAPTER_CAPABILITIES` is the capability table, one row per known kind.
* `listAdapters()` hands out plain copies of that table.
* `getAdapter(kind)` builds a fresh adapter instance for one kind. The
  adapters keep per-session state (session ids, pending permissions, token
  usage), so a session asks for its own instance instead of sharing one.

This document describes what the code does today. Every fact below is taken
from the sources named with it; everything the code does not state is marked
`unverified`.

## 1. The capability table

The protocols of the table are the ones of `ADAPTER_CAPABILITIES`: `acp`,
`stream-json`, `json-rpc` and `rpc`.

| kind | protocol | binary/command | resume support | cancel method | permission support | known limits |
| --- | --- | --- | --- | --- | --- | --- |
| `codex` | `json-rpc` | `codex app-server` | yes: `thread/resume` | `turn/interrupt` | yes: the approval requests of the app-server | no interrupt without a turn id; a user question is not answered |
| `claude` | `stream-json` | `claude -p --input-format stream-json --output-format stream-json --verbose` | yes: `--resume` | `control_request` with the subtype `interrupt` | yes: `can_use_tool` | only `can_use_tool` is answered; 64 pending permissions at most |
| `dsh` | `acp` | `dsh --profile acp` | registry: yes, adapter: unverified (it always opens a new session) | `session/cancel` | yes: `session/request_permission` | only `allow_*` and `reject_*` options are picked; a refusal ends the turn as `ok` |
| `pi` | `rpc` | `pi --mode rpc` | yes: `switch_session` | `abort` | yes: `confirm` and `select` | effort and system prompt are ignored; the `--model` flag is an assumption |
| `agy` | `acp` | `agy --acp`, or `agy -p --output-format stream-json` | yes: `session/load` (ACP), `--resume` (fallback) | `session/cancel` (ACP), none (fallback) | yes (ACP), none (fallback) | the ACP path is unverified; the fallback has neither a cancel nor permissions |
| `copilot` | `acp` | `copilot --acp` | yes: `session/load` | `session/cancel` | yes: `session/request_permission` | disabled without `COPILOT_ENABLED=1`; the real CLI is unverified |

The binary of an adapter has to be on the `PATH` of the user that runs the
daemon. The daemon starts a CLI without a shell and never puts a credential
into `argv`; the child inherits the environment of the daemon.

## 2. codex

Source: `botd/src/adapters/codex.ts`.

**How a turn starts.** The adapter spawns `codex app-server`: a JSON-RPC
style dialect over stdio, one object per line, without the `jsonrpc` member.
The handshake writes three messages to stdin: `initialize` (with the client
info of the daemon and the experimental capability), the `initialized`
notification, and then `thread/start` — or `thread/resume` when the caller
passes a provider session id. The prompt is a `turn/start` request whose
`input` carries one text block; the thread id comes from the provider
session id of the session, or from the last thread the adapter has seen.
The model, the effort and the system prompt travel in the request, never in
the command line.

**How the events are normalized.**

* `thread/started` becomes a `ready` event with the provider session id (the
  thread id); it is announced once per thread.
* `item/started` and `item/completed` become `tool` events. The item type
  decides the name: `commandExecution` is `shell`, `fileChange` is
  `apply_patch`, `webSearch` is `web_search`, `plan` is `update_plan`, an
  MCP call is `mcp:<server>/<tool>` and a dynamic call is `dynamic:<tool>`.
  A failed or declined item ends with the status `error`, every other item
  with `end`.
* `item/agentMessage/delta` becomes a `text` delta. The text of a finished
  `agentMessage` item is only used when no delta was streamed for that item.
* `turn/completed` becomes a `turn_end` with the status `ok`, `error` or
  `cancelled`, together with the token usage that
  `thread/tokenUsage/updated` reported for the turn. A failed turn that
  carries a message also emits an `error` event.
* An `error` notification becomes an `error` event. Every other line (status
  changes, reasoning deltas, ...) stays a `raw` event.

**How cancel works.** The adapter sends `turn/interrupt` with the thread id
and the turn id of the running turn. When the turn id is unknown, nothing is
written to the provider. The pending approvals of the turn are marked
cancelled, so a late allow is refused; a late deny still goes through.

**How resume works.** The provider session id of a codex session is its
thread id. A resumed session sends `thread/resume` with that thread id
instead of `thread/start`, and passes the model, the effort and the system
prompt again.

**Known limits.** The app-server asks the client for a decision on a tool
call and for an answer to a question. Only the first kind is an approval:
`item/tool/requestUserInput` is a question, so it is surfaced as a `raw`
event instead of being answered. The approval policy is fixed to
`on-request` and the sandbox to `workspace-write`. Whether the app-server
of the installed codex CLI behaves the way the adapter assumes is
unverified.

## 3. claude

Source: `botd/src/adapters/claude.ts`.

**How a turn starts.** The adapter spawns `claude -p --input-format
stream-json --output-format stream-json --verbose`, plus `--model`,
`--resume` and `--append-system-prompt` when the caller asks for them.
There is no handshake message: the first line on stdin opens the session. The
prompt is a user message (`{"type":"user","message":{"role":"user",...}}`)
that carries the session id when one is known.

**How the events are normalized.**

* A `system` line with the subtype `init` becomes a `ready` event with the
  session id.
* An `assistant` line becomes a `text` delta per text block and a `tool`
  event with the status `start` per `tool_use` block. The name of the tool
  is remembered under its tool use id.
* A `user` line closes the tool calls: every `tool_result` block becomes a
  `tool` event with the status `end`, or `error` when the block carries
  `is_error`. The name comes from the tool use id of the block.
* A `result` line becomes a `turn_end` with the status `ok`, `error` or
  `cancelled` and the usage of the turn (`input_tokens`, `output_tokens`).
* A `control_request` line with the subtype `can_use_tool` becomes a
  `permission` event.
* A `stream_event` line with a text delta becomes a `text` delta. The CLI
  only emits that line with `--include-partial-messages`, which the spawn
  command does not pass, so this branch is unverified in this build.
* Every other line stays a `raw` event.

**How cancel works.** The adapter writes a provider native `control_request`
with the subtype `interrupt` to stdin. The pending permissions of the turn
are marked cancelled, so a late allow is dropped; a late deny still answers.

**How resume works.** The provider session id is the `session_id` of the
`system` line with the subtype `init`. A resumed session puts `--resume` and
that id into the command line of the CLI.

**Known limits.** Only the `can_use_tool` requests are answered; every other
control request stays raw. At most 64 pending permissions are remembered,
the oldest ones are evicted first. The answer of an allow repeats the input
of the request, a deny carries a fixed message.

## 4. dsh

Source: `botd/src/adapters/dsh.ts`.

**How a turn starts.** The adapter spawns `dsh --profile acp` and speaks
ACP: JSON-RPC 2.0 over stdio, one object per line. The handshake writes
`initialize` (protocol version 1, no file system and no terminal
capability, because the agent keeps its own tools) and `session/new` with
the working directory and an empty list of MCP servers. The prompt is a
`session/prompt` request with the session id and one text block.

**How the events are normalized.**

* A `session/update` notification with the update `agent_message_chunk`
  becomes a `text` delta.
* The update `tool_call` becomes a `tool` event with the status `start`, the
  update `tool_call_update` becomes a `tool` event with the status `end` for
  a completed call, `error` for a failed one and `start` for the rest. The
  name of a tool call is remembered under its tool call id, so an update
  without a title keeps the name of the call.
* The other updates (thoughts, plans, ...) stay `raw` events.
* The result of `session/new` carries the session id and becomes a `ready`
  event; the result of `session/prompt` carries the stop reason and becomes
  a `turn_end`, with the usage when the agent reports one.
* A JSON-RPC error becomes an `error` event, every other line stays `raw`.

**How cancel works.** The adapter writes the `session/cancel` notification
with the session id. When no session id is known yet, nothing is written.
The pending permissions are marked cancelled, so a late allow is refused; a
late deny still answers.

**How resume works.** The registry reports resume support for this kind,
but the adapter never sends `session/load`: its handshake always opens a
new session with `session/new` and the `resumeProviderSessionId` of the
options is not used. Resuming a dsh session through this adapter is
therefore unverified.

**Known limits.** The answer of a permission request picks the option whose
kind is `allow_once` or `allow_always`, and `reject_once` or
`reject_always`; when the agent offers none of them, the answer is the
outcome `cancelled`. Only the stop reason `cancelled` ends the turn as
cancelled, every other stop reason — a refusal included — ends it as `ok`.

## 5. pi

Source: `botd/src/adapters/pi.ts`.

**How a turn starts.** The adapter spawns `pi --mode rpc` (plus `--model`
when the caller asks for one) and speaks the pi RPC protocol: newline
delimited JSON, one object per line, every line with a `type` discriminator.
The handshake writes `new_session` — or `switch_session` with the path of
the session file when the caller resumes — and then `get_state`, which
reports the session id and the session file. The prompt is a `prompt`
command with the message; pi runs in the session that is currently active,
so the command carries no session id.

**How the events are normalized.**

* A `response` line is the answer to a command. The session id and the
  session file are remembered, and the session is announced once as a
  `ready` event whose provider session id is the session file: the file path
  is the only value a later resume can use. A failed response becomes an
  `error` event.
* A `message_update` line becomes a `text` delta when it carries a text
  delta event.
* A `message_end` line becomes the final text of the message, but only when
  nothing was streamed for it.
* The lines `tool_execution_start` and `tool_execution_end` become `tool`
  events: `start` for the first, `end` or `error` for the second.
* An `agent_end` line becomes a `turn_end` with the status of the stop
  reason (`aborted` and its synonyms are `cancelled`) and the usage.
* An `extension_ui_request` line with the method `confirm` or `select`
  becomes a `permission` event; the free form `input` and `editor` requests
  and the `notify` messages stay `raw`.
* Every other line stays a `raw` event.

**How cancel works.** The adapter writes the `abort` command; the run then
ends with the stop reason `aborted`, which the adapter maps onto the status
`cancelled`. The pending extension UI requests of the run are marked
cancelled, so a late allow is refused; a late deny still answers.

**How resume works.** The provider session id is the path of the session file
that pi persisted. A resumed session writes `switch_session` with that path.
The plain session id stays available in the adapter, but it is not the value
the daemon resumes with.

**Known limits.** The effort and the system prompt have no counterpart in
the pi RPC surface known here, so they are ignored; the `--model` flag is
the one assumption of the spawn command. The exact member names of
`message_end`, `tool_execution_start` and `tool_execution_end` are not
documented in this repository, so the adapter accepts several spellings and
keeps an event it cannot read as `raw`. At most 64 pending extension UI
requests are remembered. The registry loads this adapter lazily: a tree
without the module keeps the kind in the table with `enabled: false`, and
the family of the row falls back to `minimax`.

## 6. agy

Source: `botd/src/adapters/agy.ts`.

**How a turn starts.** The adapter speaks two protocols and the registry
resolves the one to use once, then reuses it for every adapter:
`VOLTO_AGY_PROTOCOL` pins the choice, otherwise `agy --help` is probed for
the token `acp`. A missing binary — or a binary that does not mention ACP —
selects the stream-json fallback.

* In ACP mode the command is `agy --acp` (plus `--model`), the handshake
  writes `initialize` and `session/new` — or `session/load` to resume — and
  the model, the effort and the system prompt travel in the `_meta`
  extension field of the session request. The prompt is a `session/prompt`
  request.
* In the stream-json fallback the command is `agy -p --output-format
  stream-json` (plus `--append-system-prompt`, `--resume` and `--model`),
  there is no handshake and the prompt is written to stdin as plain text.

**How the events are normalized.** In ACP mode the mapping is the one of the
other ACP adapters: a `session/update` with the update `agent_message_chunk`
becomes a `text` delta, `tool_call` and `tool_call_update` become `tool`
events, the result of the session request becomes a `ready` event, the
result of `session/prompt` becomes a `turn_end` (`end_turn` and
`max_tokens` are `ok`, `cancelled` is `cancelled`, `max_turn_requests` and
`refusal` are `error`) and a `session/request_permission` request becomes a
`permission` event. In the stream-json fallback a `system` line becomes a
`ready` event, an `assistant` line becomes text and tool events, a
`stream_event` line becomes a text delta, a `result` line becomes a
`turn_end` and an `error` line becomes an `error` event. Two Gemini shapes
are understood as well: an object with a `response` field becomes text plus
a `turn_end`, an object with a `text` field becomes a text delta.

**How cancel works.** In ACP mode the adapter writes the `session/cancel`
notification with the session id. In the stream-json fallback it writes
nothing: such a turn can only be stopped with a signal. That is why the
capability row of this kind states the capabilities of the ACP protocol.

**How resume works.** In ACP mode the handshake sends `session/load` with
the session id instead of `session/new`. In the stream-json fallback the
session id goes into the command line with `--resume`.

**Known limits.** The ACP path was never confirmed against a real binary —
the host that wrote the adapter had none — so it is unverified. The CLI
flags of the fallback (`--model`, `--append-system-prompt` and `--resume`)
are an assumption of the adapter and are unverified as well. The fallback
has no permission support: `answerPermission` answers nothing there.

## 7. copilot

Source: `botd/src/adapters/copilot.ts`.

**How a turn starts.** The adapter spawns `copilot --acp` (plus `--model`
and `--reasoning-effort`) and speaks ACP. The handshake writes
`initialize` and `session/new` — or `session/load` to resume — with the
working directory and no MCP server. ACP has no dedicated channel for a
system prompt, so it travels in the `_meta` extension field, which an agent
is free to ignore. The prompt is a `session/prompt` request.

**How the events are normalized.** A `session/update` with the update
`agent_message_chunk` becomes a `text` delta, `tool_call` and
`tool_call_update` become `tool` events, the result of the session request
becomes a `ready` event, the result of `session/prompt` becomes a
`turn_end` (`cancelled` is `cancelled`, `refusal` is `error`, everything
else is `ok`) and a `session/request_permission` request becomes a
`permission` event. A JSON-RPC error becomes an `error` event, every other
line stays `raw`.

**How cancel works.** The adapter writes the `session/cancel` notification
with the session id; when no session id is known, nothing is written. The
pending permissions are marked cancelled, so a late allow is refused; a late
deny still answers.

**How resume works.** The provider session id is the `sessionId` of the
result of the session request. A resumed session sends `session/load` with
that id.

**Known limits.** The adapter ships disabled: the Copilot CLI needs a paid
seat, so the row of the table reports `enabled: false` and `spawn()` refuses
to start the CLI until the operator sets `COPILOT_ENABLED=1`. The protocol
mapping does not need the binary and is tested without it, but the behaviour
of the real CLI — the login, the seat and the events it really sends — is
unverified. The answer of a permission request picks the option whose kind
is `allow_once` or `allow_always`, and `reject_once` or `reject_always`;
when the agent uses custom kinds, the name of the option is searched for
`allow`, `approve` or `yes` and for `reject`, `deny` or `no`.
