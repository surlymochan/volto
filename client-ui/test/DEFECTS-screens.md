# Defects in the client-ui screens

Defects found while writing `client-ui/test/screens.test.ts` (the session list
and the permission prompt of the "Remote bots" panel). The panel sources were
not touched: every defect below is reported, not fixed.

Each defect names the test that pins it down. Those tests are marked `todo`,
so `node --test` reports them as `not ok … # TODO` and the run still passes.
They turn into ordinary tests once the panel is fixed.

Everything below was observed on the panel as it is in `client-ui/src`; all
fixtures are synthetic.

## 1. The session list shows neither the status nor the bot of a session

**Test:** `every session entry shows the status of its session` (todo)

**Where:** `client-ui/src/panel.ts`, `renderStream()`. The chip of a session is
built with the session id and nothing else:

```ts
element("button", {
  className: entry.id === state.selectedSession ? "chip chip-active" : "chip",
  text: entry.id,
  testId: `session-chip-${entry.id}`,
  ...
```

**What happens:** the list of the sessions of a host is a row of chips that
carry the session id only. The status of the session (`running`, `ended`,
`cancelled`) and the bot it belongs to are known to the state
(`SessionState.status`, `SessionState.botId`) but never reach the list. The
status is drawn only for the session that is currently open, in the head of
the event stream.

**Why it matters:** with more than one session per host the user has to open
every chip to find out which sessions are still running and which bot works
on them. A session that ended looks exactly like a running one.

**How it could be fixed:** draw the status of the session next to the chip
(the panel already has a badge for it in the stream head) and name the bot it
belongs to.

## 2. The session list is ordered by id, not by age

**Test:** `the session list is ordered oldest first` (todo)

**Where:** `client-ui/src/state.ts`, `selectHostSessions()`. The sessions are
sorted by their id:

```ts
.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
```

The doc comment of the function promises the opposite: "Sessions of one host,
oldest first."

**What happens:** the daemon numbers its sessions without padding
(`alpha-session-1` … `alpha-session-10`, see `client-ui/src/mock-client.ts`).
As soon as a host runs ten sessions, the list reads `alpha-session-1`,
`alpha-session-10`, `alpha-session-11`, `alpha-session-12`,
`alpha-session-2`, … — the tenth session is listed before the second one.

**Why it matters:** the order of the list is what a user reads as "the
sessions of this host, oldest first". A wrong order makes a long running
host look scrambled.

**How it could be fixed:** keep the order the sessions were created in (the
state records them in that order already) or sort on a field that grows with
the session instead of on its id.

## 3. A permission request of a session that is not shown is never surfaced

**Test:** `the prompt of a session that is not shown is still offered` (todo)

**Where:** `client-ui/src/panel.ts`, `renderStream()` and `renderBots()`. The
panel draws the events of `state.selectedSession` only, and neither the bot
list nor the chips of the session list mark a session that waits for an
answer. `selectPendingPermissions()` in `client-ui/src/state.ts` collects the
pending requests of every session, but the panel never calls it.

**What happens:** a permission request that arrives for a session other than
the open one is stored in the state and never shown. The user sees no prompt,
no badge and no hint; the bot keeps waiting for an answer that cannot be
given from the screen.

**Why it matters:** a request that waits for an answer can be missed
completely, and the panel does not even tell the user that it is waiting.

**How it could be fixed:** mark the chips of the sessions that have a pending
request, or list the pending requests of every session above the event
stream, so that a request can be answered from any session.

## 4. The panel has no redaction of its own

**Test:** `the panel masks a secret that reaches it unredacted` (todo)

**Where:** `client-ui/src/panel.ts`, `renderEvent()`. The payload of an event
is drawn as it arrives; nothing in `client-ui/` masks anything.

**What happens:** the daemon masks the secrets before it sends an event
(`botd/src/redact.ts`), so the panel can rely on it — and the redacted
content indeed stays redacted on the screen (see the passing test `content
the daemon redacted is shown redacted`). But the panel is the last place a
secret would be shown, and it does not check what it receives: a secret that
reaches the UI is drawn verbatim. The mock client of `client-ui/src/`, which
stands in for the daemon in the development setup, sends unredacted text as
well.

**Why it matters:** the guarantee "no secret ever reaches a screen" rests on
a single component. A daemon that forgets to mask, or a client that is
pointed at something else, puts the secret on the screen.

**How it could be fixed:** mask the payload in the panel too (the rules of
`botd/src/redact.ts` are pure and easy to port), or make the daemon client
layer the one place that guarantees the redaction.

## Further observations (no automated test)

* **A failing answer is swallowed.** The click handler of the permission
  buttons calls `void answerPermission(...)`, and `answerPermission()` in
  `client-ui/src/panel.ts` awaits `client.answerPermission()` without a
  `catch`. A daemon that refuses the answer therefore leaves the prompt
  pending, shows no error and raises an unhandled rejection in the browser.
  There is no test for it: a client that rejects makes `node --test` report
  an unhandled rejection, which would fail the whole file instead of a
  single test.
* **`client-ui/` has no `package.json`.** The bot daemon ships one with
  `"type": "module"` (`botd/package.json`), the client UI does not, so its
  TypeScript modules are loaded as ESM by the syntax detection of Node, which
  prints a `MODULE_TYPELESS_PACKAGE_JSON` warning on the way. A
  `client-ui/package.json` with `"type": "module"` would remove the warning.

## What the tests cover

| Behaviour of the card | Test | State |
| --- | --- | --- |
| The list shows one entry per session of a bot | `the session list shows one entry per bot that runs a session` | passes |
| The list follows the selected host | `the session list only shows the sessions of the selected host` | passes |
| The empty state | `the session list is empty when no session runs` | passes |
| The order of the list | `the session list is ordered oldest first` | todo, defect 2 |
| The status of a session in the list | `every session entry shows the status of its session` | todo, defect 1 |
| The prompt appears on a permission event | `the permission prompt appears when the daemon asks for one` | passes |
| Approve sends the answer to the client | `approving a permission sends the answer to the client` | passes |
| Deny sends the answer to the client | `denying a permission sends the answer to the client` | passes |
| The prompt is dismissed after the answer | `the prompt is dismissed once it is answered` | passes |
| Several queued prompts, in order | `several queued prompts are shown in the order they arrived` | passes |
| Answering one prompt leaves the others waiting | `answering one prompt leaves the other prompts waiting` | passes |
| The prompt of a session that is not open | `the prompt of a session that is not shown is still offered` | todo, defect 3 |
| Redacted content stays redacted | `content the daemon redacted is shown redacted` | passes |
| The panel masks what it receives | `the panel masks a secret that reaches it unredacted` | todo, defect 4 |
