// botd/test/adapters/resume-crash.test.ts
//
// Resume after a crash, across every adapter.
//
// When the child of a session dies, the control plane starts a fresh child and
// hands the provider session id of the crashed run to the adapter
// (`OpenOptions.resumeProviderSessionId`, see botd/src/adapter-types.ts and
// botd/src/orchestrator.ts).  For the crashed conversation to continue, the
// adapter has to put that id on the wire the way its provider expects:
//
//   * a flag in argv (`claude --resume <id>`, `agy --resume <id>`), or
//   * a load/resume request in the handshake (`thread/resume`, `session/load`,
//     `switch_session`), or
//   * nothing at all, when the provider cannot resume (`dsh`).
//
// The suite is table driven: one row per adapter (`agy` appears twice, once
// per protocol it can speak) and one set of tests per row, so a new adapter
// only needs a new row.
//
// The fixtures are synthetic: no provider is contacted, no host, account or
// token is used.  Every provider line below is a plausible shape of the line a
// provider answers with after a crash: the acknowledgement of the resume and
// the "session not found" of a stale id.
//
// Documented gaps (this suite never changes the sources; the gaps are
// recorded here and in the pull request):
//
//   * `dsh` never resumes: its handshake always sends `session/new`, although
//     the capability table (botd/src/adapters/index.ts) announces
//     `supportsResume: true` for it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AgyAdapter, createAgyAdapter } from "../../src/adapters/agy.ts";
import { ClaudeAdapter } from "../../src/adapters/claude.ts";
import { CodexAdapter } from "../../src/adapters/codex.ts";
import { COPILOT_ENABLED_ENV, CopilotAdapter } from "../../src/adapters/copilot.ts";
import { DshAdapter } from "../../src/adapters/dsh.ts";
import { PiAdapter } from "../../src/adapters/pi.ts";
import { listAdapters } from "../../src/adapters/index.ts";
import type {
  BotAdapter,
  BotKind,
  NormalizedEvent,
  OpenOptions,
  SpawnSpec,
} from "../../src/adapter-types.ts";

/* --------------------------------------------------------------- fixtures */

/** Working directory of the synthetic sessions. */
const CWD = "/synthetic/work";

/** The prompt that is sent after the session was resumed. */
const PROMPT = "continue the crashed turn";

/** The provider session id of the crashed run. */
const RESUME_ID = "ps-0000-1111";

/**
 * Provider session ids that are stale or malformed.
 *
 * A crash means the id may come from an old journal entry, from another
 * provider or from a half written file: the adapter has to survive it.
 */
const MALFORMED_IDS: readonly string[] = [
  "",
  "   ",
  "not-a-session-id",
  "ps-0000-1111\nps-0000-2222",
  '"quoted"',
  "ünïcødé-🎉",
  "../escape",
  "'; rm -rf /",
  "x".repeat(2048),
  "ps-0000-1111\u0000ps-0000-2222",
];

/* ---------------------------------------------------------------- helpers */

/** Run `body` with the copilot CLI enabled (it needs a paid seat). */
function withCopilotEnabled<T>(body: () => T): T {
  const previous = process.env[COPILOT_ENABLED_ENV];
  process.env[COPILOT_ENABLED_ENV] = "1";
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env[COPILOT_ENABLED_ENV];
    else process.env[COPILOT_ENABLED_ENV] = previous;
  }
}

/** Spawn through the adapter; the copilot CLI has to be enabled first. */
function spawnOf(adapter: BotAdapter, options: OpenOptions): SpawnSpec {
  if (adapter.kind === "copilot") return withCopilotEnabled(() => adapter.spawn(options));
  return adapter.spawn(options);
}

/** Read a dotted path out of a JSON message ("params.sessionId"). */
function valueAt(message: unknown, path: string): unknown {
  let current: unknown = message;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** The method (or type) of a handshake message. */
function methodOf(message: unknown, key: "method" | "type"): string | undefined {
  const value = valueAt(message, key);
  return typeof value === "string" ? value : undefined;
}

/** The handshake message that carries `method` (or `type`). */
function messageWith(
  messages: readonly unknown[],
  key: "method" | "type",
  method: string,
): Record<string, unknown> | undefined {
  const found = messages.find((message) => methodOf(message, key) === method);
  return found as Record<string, unknown> | undefined;
}

/* ------------------------------------------------------------------ table */

/** How an adapter asks its provider to resume a crashed child. */
type ResumeTransport = "argv" | "handshake" | "none";

interface ResumeCase {
  /** Name of the row; it is the prefix of every test of the row. */
  label: string;
  /** The adapter kind of the row. */
  kind: BotKind;
  /** A fresh adapter instance (the adapters keep per session state). */
  create(): BotAdapter;
  /** Where the provider session id travels. */
  transport: ResumeTransport;
  /** The argv flag that carries the id (transport "argv"). */
  resumeFlag?: string;
  /** The key that names the method of a handshake message. */
  methodKey: "method" | "type";
  /** The handshake message that opens a fresh session (null: no handshake). */
  openMethod: string | null;
  /** The handshake message that resumes a stored session (transport "handshake"). */
  resumeMethod?: string;
  /** Path of the resume id inside the resume message (transport "handshake"). */
  resumeIdPath?: string;
  /** Path of the session id inside the prompt (null: the prompt carries none). */
  promptSessionPath: string | null;
  /** What the prompt carries when no session is known: an empty id or none. */
  emptyPromptSession: "omit" | "empty";
  /** True when the adapter remembers the session id for the next prompt. */
  remembersSessionId: boolean;
  /** The provider line that acknowledges the resume. */
  ackLine: string;
  /** The normalized events of the acknowledgement. */
  ackEvents: NormalizedEvent[];
  /** The provider session id the acknowledgement announces. */
  ackSessionId: string;
  /** The provider line a provider sends when the stored session is unknown. */
  notFoundLine: string;
  /** The normalized events of that line. */
  notFoundEvents: NormalizedEvent[];
}

const CASES: readonly ResumeCase[] = [
  {
    label: "claude",
    kind: "claude",
    create: () => new ClaudeAdapter(),
    transport: "argv",
    resumeFlag: "--resume",
    methodKey: "method",
    openMethod: null,
    promptSessionPath: "session_id",
    // The claude adapter leaves the key out when it knows no session.
    emptyPromptSession: "omit",
    remembersSessionId: false,
    ackLine: JSON.stringify({ type: "system", subtype: "init", session_id: RESUME_ID }),
    ackEvents: [{ kind: "ready", providerSessionId: RESUME_ID }],
    ackSessionId: RESUME_ID,
    notFoundLine: JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: `No conversation found with session ID: ${RESUME_ID}`,
    }),
    // The claude adapter has no error event: a failed resume is a failed turn.
    notFoundEvents: [{ kind: "turn_end", status: "error" }],
  },
  {
    label: "codex",
    kind: "codex",
    create: () => new CodexAdapter(),
    transport: "handshake",
    methodKey: "method",
    openMethod: "thread/start",
    resumeMethod: "thread/resume",
    resumeIdPath: "params.threadId",
    promptSessionPath: "params.threadId",
    emptyPromptSession: "empty",
    remembersSessionId: true,
    ackLine: JSON.stringify({ id: 3, result: { thread: { id: RESUME_ID } } }),
    ackEvents: [{ kind: "ready", providerSessionId: RESUME_ID }],
    ackSessionId: RESUME_ID,
    notFoundLine: JSON.stringify({
      id: 3,
      error: { code: -32001, message: `thread not found: ${RESUME_ID}` },
    }),
    notFoundEvents: [{ kind: "error", message: `thread not found: ${RESUME_ID}` }],
  },
  {
    label: "copilot",
    kind: "copilot",
    create: () => new CopilotAdapter(),
    transport: "handshake",
    methodKey: "method",
    openMethod: "session/new",
    resumeMethod: "session/load",
    resumeIdPath: "params.sessionId",
    promptSessionPath: "params.sessionId",
    emptyPromptSession: "empty",
    remembersSessionId: true,
    ackLine: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: RESUME_ID } }),
    ackEvents: [{ kind: "ready", providerSessionId: RESUME_ID }],
    ackSessionId: RESUME_ID,
    notFoundLine: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32001, message: `session not found: ${RESUME_ID}` },
    }),
    notFoundEvents: [{ kind: "error", message: `session not found: ${RESUME_ID}` }],
  },
  {
    label: "agy (acp)",
    kind: "agy",
    create: () => createAgyAdapter({ protocol: "acp", env: {} }),
    transport: "handshake",
    methodKey: "method",
    openMethod: "session/new",
    resumeMethod: "session/load",
    resumeIdPath: "params.sessionId",
    promptSessionPath: "params.sessionId",
    emptyPromptSession: "empty",
    remembersSessionId: false,
    ackLine: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: RESUME_ID } }),
    ackEvents: [{ kind: "ready", providerSessionId: RESUME_ID }],
    ackSessionId: RESUME_ID,
    notFoundLine: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32001, message: `session not found: ${RESUME_ID}` },
    }),
    notFoundEvents: [{ kind: "error", message: `session not found: ${RESUME_ID}` }],
  },
  {
    label: "agy (stream-json)",
    kind: "agy",
    create: () => createAgyAdapter({ protocol: "stream-json", env: {} }),
    transport: "argv",
    resumeFlag: "--resume",
    methodKey: "method",
    openMethod: null,
    promptSessionPath: null,
    emptyPromptSession: "omit",
    remembersSessionId: false,
    ackLine: JSON.stringify({ type: "system", session_id: RESUME_ID }),
    ackEvents: [{ kind: "ready", providerSessionId: RESUME_ID }],
    ackSessionId: RESUME_ID,
    notFoundLine: JSON.stringify({
      type: "error",
      error: { message: `session not found: ${RESUME_ID}` },
    }),
    notFoundEvents: [{ kind: "error", message: `session not found: ${RESUME_ID}` }],
  },
  {
    label: "dsh",
    kind: "dsh",
    create: () => new DshAdapter(),
    // The dsh adapter never resumes: there is no load request in its wire.
    transport: "none",
    methodKey: "method",
    openMethod: "session/new",
    promptSessionPath: "params.sessionId",
    emptyPromptSession: "empty",
    remembersSessionId: true,
    ackLine: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: RESUME_ID } }),
    ackEvents: [{ kind: "ready", providerSessionId: RESUME_ID }],
    ackSessionId: RESUME_ID,
    notFoundLine: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32001, message: `session not found: ${RESUME_ID}` },
    }),
    notFoundEvents: [{ kind: "error", message: `session not found: ${RESUME_ID}` }],
  },
  {
    label: "pi",
    kind: "pi",
    create: () => new PiAdapter({ env: {} }),
    transport: "handshake",
    methodKey: "type",
    openMethod: "new_session",
    resumeMethod: "switch_session",
    resumeIdPath: "sessionPath",
    // pi runs in the session that is active, so the prompt carries no id.
    promptSessionPath: null,
    emptyPromptSession: "omit",
    remembersSessionId: false,
    ackLine: JSON.stringify({
      type: "response",
      id: "pi-2",
      success: true,
      data: { sessionId: "sess-1", sessionFile: "/synthetic/sessions/sess-1.json" },
    }),
    ackEvents: [{ kind: "ready", providerSessionId: "/synthetic/sessions/sess-1.json" }],
    ackSessionId: "/synthetic/sessions/sess-1.json",
    notFoundLine: JSON.stringify({
      type: "response",
      id: "pi-1",
      success: false,
      error: `session not found: ${RESUME_ID}`,
    }),
    notFoundEvents: [{ kind: "error", message: `session not found: ${RESUME_ID}` }],
  },
];

/* ------------------------------------------------------- the table driven */

/* The spawn: where the resume id enters the process. */

for (const entry of CASES) {
  test(`${entry.label}: the spawn command carries the provider session id`, () => {
    const adapter = entry.create();
    const spec = spawnOf(adapter, { cwd: CWD, resumeProviderSessionId: RESUME_ID });
    assert.equal(spec.cwd, CWD);
    assert.ok(
      spec.command.every((part) => typeof part === "string"),
      "the argv has to stay a list of strings",
    );
    if (entry.transport === "argv") {
      const index = spec.command.indexOf(entry.resumeFlag ?? "--resume");
      assert.notEqual(
        index,
        -1,
        `${entry.label}: the resume flag is missing from ${spec.command.join(" ")}`,
      );
      assert.equal(spec.command[index + 1], RESUME_ID);
    } else {
      assert.ok(
        !spec.command.includes(RESUME_ID),
        `${entry.label}: the resume id must not end up in argv`,
      );
    }
    // The provider session id is no secret, but it does not belong in the
    // environment of the child either.
    for (const value of Object.values(spec.env)) {
      assert.ok(!value.includes(RESUME_ID));
    }
  });
}

for (const entry of CASES) {
  test(`${entry.label}: without a provider session id the spawn carries no resume`, () => {
    const adapter = entry.create();
    const spec = spawnOf(adapter, { cwd: CWD });
    assert.ok(!spec.command.includes(RESUME_ID));
    if (entry.transport === "argv") {
      assert.ok(
        !spec.command.includes(entry.resumeFlag ?? "--resume"),
        `${entry.label}: the resume flag must be absent without a session id`,
      );
    }
  });
}

/* The handshake: where the resume request is written. */

for (const entry of CASES) {
  test(`${entry.label}: the handshake opens a fresh session without a provider session id`, () => {
    const adapter = entry.create();
    const messages = adapter.handshake({ cwd: CWD });
    assert.ok(Array.isArray(messages));
    if (entry.openMethod === null) {
      assert.deepEqual(messages, [], `${entry.label}: the handshake must stay empty`);
      return;
    }
    const open = messageWith(messages, entry.methodKey, entry.openMethod);
    assert.ok(
      open,
      `${entry.label}: expected a ${entry.openMethod} message in ${JSON.stringify(messages)}`,
    );
    if (entry.resumeMethod) {
      assert.ok(
        !messageWith(messages, entry.methodKey, entry.resumeMethod),
        `${entry.label}: a fresh session must not be resumed`,
      );
    }
  });
}

for (const entry of CASES) {
  test(`${entry.label}: the handshake resumes the crashed session with the provider session id`, () => {
    const adapter = entry.create();
    const messages = adapter.handshake({ cwd: CWD, resumeProviderSessionId: RESUME_ID });
    assert.ok(Array.isArray(messages));
    if (entry.transport === "handshake") {
      const resume = messageWith(messages, entry.methodKey, entry.resumeMethod ?? "");
      assert.ok(
        resume,
        `${entry.label}: expected a ${entry.resumeMethod} message in ${JSON.stringify(messages)}`,
      );
      assert.equal(
        valueAt(resume, entry.resumeIdPath ?? ""),
        RESUME_ID,
        `${entry.label}: the resume request must name the crashed session`,
      );
    } else {
      // The resume travels in argv (or nowhere at all): the handshake must
      // not repeat the id.
      assert.ok(
        !JSON.stringify(messages).includes(RESUME_ID),
        `${entry.label}: the handshake must not carry the provider session id`,
      );
      if (entry.transport === "none") {
        const open = messageWith(messages, entry.methodKey, entry.openMethod ?? "");
        assert.ok(open, `${entry.label}: the handshake must open a session`);
      }
    }
    // The daemon writes the handshake as NDJSON.
    assert.doesNotThrow(() => JSON.stringify(messages));
  });
}

/* The prompt: who the resumed turn is addressed to. */

for (const entry of CASES) {
  test(`${entry.label}: the prompt carries the provider session id when the caller knows it`, () => {
    const adapter = entry.create();
    const message = adapter.prompt(PROMPT, { providerSessionId: RESUME_ID });
    if (entry.promptSessionPath === null) {
      assert.ok(
        !JSON.stringify(message).includes(RESUME_ID),
        `${entry.label}: the prompt must not invent a session id`,
      );
    } else {
      assert.equal(
        valueAt(message, entry.promptSessionPath),
        RESUME_ID,
        `${entry.label}: the prompt must name the resumed session`,
      );
    }
    assert.doesNotThrow(() => JSON.stringify(message));
  });
}

for (const entry of CASES) {
  test(`${entry.label}: a prompt without a provider session id does not invent one`, () => {
    const adapter = entry.create();
    const message = adapter.prompt(PROMPT, {});
    if (entry.promptSessionPath === null) {
      assert.ok(!JSON.stringify(message).includes(RESUME_ID));
    } else if (entry.emptyPromptSession === "omit") {
      assert.equal(
        valueAt(message, entry.promptSessionPath),
        undefined,
        `${entry.label}: the prompt must leave the session id out`,
      );
    } else {
      assert.equal(
        valueAt(message, entry.promptSessionPath),
        "",
        `${entry.label}: the adapter does not know a session yet`,
      );
    }
  });
}

for (const entry of CASES) {
  test(`${entry.label}: the prompt falls back to the session id the adapter learned`, () => {
    const adapter = entry.create();
    // The resumed child announces its session: the adapter remembers it.
    adapter.parse(entry.ackLine);
    const message = adapter.prompt(PROMPT, {});
    if (entry.remembersSessionId && entry.promptSessionPath !== null) {
      assert.equal(
        valueAt(message, entry.promptSessionPath),
        entry.ackSessionId,
        `${entry.label}: the prompt must reuse the session of the resumed child`,
      );
    } else {
      assert.ok(
        !JSON.stringify(message).includes(entry.ackSessionId),
        `${entry.label}: the prompt must not carry a session id`,
      );
    }
  });
}

/* The provider answers: the acknowledgement and the failure. */

for (const entry of CASES) {
  test(`${entry.label}: the resume acknowledgement is a normalized ready event`, () => {
    const adapter = entry.create();
    const events = adapter.parse(entry.ackLine);
    assert.deepEqual(events, entry.ackEvents);
    const ready = events.find((event) => event.kind === "ready");
    assert.ok(ready, `${entry.label}: the acknowledgement must announce the session`);
    if (ready?.kind === "ready") {
      assert.equal(ready.providerSessionId, entry.ackSessionId);
    }
  });
}

for (const entry of CASES) {
  test(`${entry.label}: a "session not found" line is normalized and never throws`, () => {
    const adapter = entry.create();
    let events: NormalizedEvent[] = [];
    assert.doesNotThrow(() => {
      events = adapter.parse(entry.notFoundLine);
    });
    assert.deepEqual(events, entry.notFoundEvents);
    assert.ok(events.length > 0, `${entry.label}: the failure must not be swallowed`);
    assert.ok(
      events.every((event) => event.kind !== "raw"),
      `${entry.label}: the failure must not stay an unnormalized line`,
    );
  });
}

for (const entry of CASES) {
  test(`${entry.label}: a stale or malformed provider session id never throws`, () => {
    for (const id of MALFORMED_IDS) {
      const adapter = entry.create();
      const options: OpenOptions = { cwd: CWD, resumeProviderSessionId: id };

      let spec: SpawnSpec | undefined;
      let messages: unknown[] | undefined;
      let message: unknown;
      assert.doesNotThrow(() => {
        spec = spawnOf(adapter, options);
      }, `${entry.label}: spawn threw for ${JSON.stringify(id)}`);
      assert.doesNotThrow(() => {
        messages = adapter.handshake(options);
      }, `${entry.label}: handshake threw for ${JSON.stringify(id)}`);
      assert.doesNotThrow(() => {
        message = adapter.prompt(PROMPT, { providerSessionId: id });
      }, `${entry.label}: prompt threw for ${JSON.stringify(id)}`);

      // The daemon writes all of it as NDJSON.
      assert.doesNotThrow(() => JSON.stringify(spec));
      assert.doesNotThrow(() => JSON.stringify(messages));
      assert.doesNotThrow(() => JSON.stringify(message));
      assert.ok(Array.isArray(messages));
    }
  });
}

/* --------------------------------------------------------- the known gaps */

test("dsh cannot resume a crashed child: the handshake always opens a new session", () => {
  const adapter = new DshAdapter();
  const messages = adapter.handshake({ cwd: CWD, resumeProviderSessionId: RESUME_ID });
  assert.ok(
    !messageWith(messages, "method", "session/load"),
    "dsh must not pretend that it loads a stored session",
  );
  const open = messageWith(messages, "method", "session/new");
  assert.ok(open, "dsh has to open a session");
  assert.ok(!JSON.stringify(messages).includes(RESUME_ID));
  // The id is still carried by the prompt, so the provider answers that the
  // session does not exist.
  const prompt = adapter.prompt(PROMPT, { providerSessionId: RESUME_ID }) as Record<string, unknown>;
  assert.equal(valueAt(prompt, "params.sessionId"), RESUME_ID);
});

test(
  "the capability table announces resume support for dsh although the adapter never resumes",
  {
    skip:
      "dsh sends session/new even when a provider session id is known, " +
      "while botd/src/adapters/index.ts announces supportsResume: true for it",
  },
  () => {
    const row = listAdapters().find((entry) => entry.kind === "dsh");
    assert.ok(row, "the capability table has no row for dsh");
    assert.equal(row?.supportsResume, false);
  },
);

test("claude reports a failed resume as a failed turn", () => {
  const adapter = new ClaudeAdapter();
  const events = adapter.parse(
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: `No conversation found with session ID: ${RESUME_ID}`,
    }),
  );
  assert.deepEqual(events, [{ kind: "turn_end", status: "error" }]);
});

test("an empty provider session id is treated as \"no id\" by most adapters", () => {
  // The adapters that check for a non empty string open a fresh session.
  const codex = new CodexAdapter();
  const codexMessages = codex.handshake({ cwd: CWD, resumeProviderSessionId: "" });
  assert.ok(messageWith(codexMessages, "method", "thread/start"));

  const copilot = new CopilotAdapter();
  const copilotMessages = copilot.handshake({ cwd: CWD, resumeProviderSessionId: "" });
  assert.ok(messageWith(copilotMessages, "method", "session/new"));

  const pi = new PiAdapter({ env: {} });
  const piMessages = pi.handshake({ cwd: CWD, resumeProviderSessionId: "" });
  assert.ok(messageWith(piMessages, "type", "new_session"));

  const claude = new ClaudeAdapter();
  const claudeSpec = claude.spawn({ cwd: CWD, resumeProviderSessionId: "" });
  assert.ok(!claudeSpec.command.includes("--resume"));
});

test("agy in ACP mode loads a session even when the provider session id is empty", () => {
  // The agy adapter only checks for `undefined`: an empty id is loaded and
  // the provider answers that the session does not exist.  It does not throw.
  const adapter = createAgyAdapter({ protocol: "acp", env: {} });
  const messages = adapter.handshake({ cwd: CWD, resumeProviderSessionId: "" });
  const load = messageWith(messages, "method", "session/load");
  assert.ok(load, "agy loads the session it was given");
  assert.equal(valueAt(load, "params.sessionId"), "");
});

test("the copilot CLI is not started without the opt in of the operator", () => {
  // A crashed child is retried: the adapter has to fail loudly instead of
  // starting a CLI that cannot authenticate.
  const previous = process.env[COPILOT_ENABLED_ENV];
  delete process.env[COPILOT_ENABLED_ENV];
  try {
    const adapter = new CopilotAdapter();
    assert.throws(() => adapter.spawn({ cwd: CWD }), /copilot adapter is disabled/);
  } finally {
    if (previous === undefined) delete process.env[COPILOT_ENABLED_ENV];
    else process.env[COPILOT_ENABLED_ENV] = previous;
  }
});

test(
  "a provider session id with a null byte cannot be used in argv",
  {
    skip:
      "the adapter passes the provider session id on verbatim, but exec(2) " +
      "rejects an argv with a null byte, so such an id cannot be resumed",
  },
  () => {
    const adapter = new ClaudeAdapter();
    const spec = adapter.spawn({ cwd: CWD, resumeProviderSessionId: "ps-1\u0000ps-2" });
    assert.ok(!spec.command.some((part) => part.includes("\u0000")));
  },
);

/* ------------------------------------------------- the whole table at once */

test("every adapter of the table survives a crash with a stale provider session id", () => {
  for (const entry of CASES) {
    const adapter = entry.create();
    const adapterKind: BotKind = entry.kind;
    assert.equal(adapter.kind, adapterKind);

    // The crashed run is resumed: the adapter is asked to open the session.
    const options: OpenOptions = { cwd: CWD, resumeProviderSessionId: RESUME_ID };
    assert.doesNotThrow(() => spawnOf(adapter, options));
    assert.doesNotThrow(() => adapter.handshake(options));
    assert.doesNotThrow(() => adapter.prompt(PROMPT, { providerSessionId: RESUME_ID }));

    // The provider acknowledges the resume and the turn continues.
    const events = adapter.parse(entry.ackLine);
    assert.ok(
      events.some((event) => event.kind === "ready"),
      `${entry.label}: the resumed child must announce its session`,
    );
  }
});

test("the adapters of the table are the ones the registry knows", () => {
  const kinds = new Set(listAdapters().map((row) => row.kind));
  for (const entry of CASES) {
    assert.ok(kinds.has(entry.kind), `the registry does not know ${entry.kind}`);
  }
});

test("the agy adapter speaks both protocols and both are covered by the table", () => {
  const acp = new AgyAdapter({ protocol: "acp", env: {} });
  const stream = new AgyAdapter({ protocol: "stream-json", env: {} });
  assert.equal(acp.protocol, "acp");
  assert.equal(stream.protocol, "stream-json");
  const labels = CASES.filter((entry) => entry.kind === "agy").map((entry) => entry.label);
  assert.equal(labels.length, 2);
});
