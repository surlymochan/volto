// Tests for the `open`, `send` and `cancel` frames of the botd wire protocol
// (botd/src/protocol.ts, the function `parseClientFrame` and its helper
// `parseBotSpec`).
//
// The frames come from an untrusted client, so every field of an `open` frame
// is checked before the daemon spawns a child process.  The rules come from
// botd/PROTOCOL.md §2 ("Frames"):
//
//   * `bot.kind` is one of `acp`, `codex-app-server`, `pi-rpc`; any other kind
//     is refused with the exact list of the known kinds,
//   * `bot.command` is a non-empty array of strings (the argv of the child,
//     no shell is involved),
//   * `bot.cwd` and `bot.env` are optional; a `cwd` that is not a non-empty
//     string is dropped, and an `env` only keeps its string values,
//   * `open.resume` carries an optional `providerSessionId`; a `resume` that
//     is not an object is ignored,
//   * `send.payload` is any JSON value, but the key has to be there,
//   * `cancel.payload` is optional and is only kept when the key is there.
//
// The tests are pure calls of the parser: no socket is opened, no child
// process is spawned and every id, path and environment value below is
// synthetic.
//
// The cases of botd/test/protocol-parse-edge.test.ts (unknown op, missing
// send payload, the array bot, the non-string command element, the near miss
// bot kind, ...) are not repeated here.  The one exception is the missing
// send payload: it is asserted next to the accepted null payload, because
// the difference between "the key is there" and "the key is missing" is the
// point of that test.  An array in `open.resume` is not asserted either: it
// is already documented as a defect by the todo of
// botd/test/protocol-parse-edge.test.ts.

import test from "node:test";
import assert from "node:assert/strict";

import { BOT_KINDS, parseClientFrame } from "../src/protocol.ts";
import type { BotSpec, ClientFrame } from "../src/protocol.ts";

/** The exact rejection message of a bot kind botd does not know. */
const KIND_MESSAGE = "bot.kind must be one of acp, codex-app-server, pi-rpc";
/** The exact rejection message of a broken command. */
const COMMAND_MESSAGE = "bot.command must be a non-empty array of strings";
/** The exact rejection message of an open frame without a session id. */
const SID_MESSAGE = "open requires a sid";

/** Parse a frame that has to be accepted. */
function parse(raw: unknown): ClientFrame {
  const result = parseClientFrame(raw);
  assert.equal(result.ok, true, `expected a frame, got ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  return result.frame;
}

/** Parse a frame that has to be refused and return the reason. */
function rejects(raw: unknown): string {
  const result = parseClientFrame(raw);
  assert.equal(result.ok, false, `expected a rejection, got ${JSON.stringify(result)}`);
  if (result.ok) throw new Error("unreachable");
  return result.message;
}

/** An `open` frame with the given bot spec and optional extra fields. */
function open(bot: unknown, extra: Record<string, unknown> = {}): unknown {
  return { op: "open", sid: "s-1", bot, ...extra };
}

/** The bot spec of a frame that was accepted. */
function botOf(frame: ClientFrame): BotSpec {
  assert.equal(frame.op, "open", `expected an open frame, got ${frame.op}`);
  if (frame.op !== "open") throw new Error("unreachable");
  return frame.bot;
}

// ---------------------------------------------------------------------------
// The bot kind
// ---------------------------------------------------------------------------

test("refuses a bot kind outside BOT_KINDS with the exact list of the known kinds", () => {
  // The message is spelled out, not built from BOT_KINDS, so a change of the
  // constant cannot silently change the wire contract.
  assert.equal(KIND_MESSAGE, `bot.kind must be one of ${BOT_KINDS.join(", ")}`);

  for (const kind of ["ACP", "acp ", " acp", "acp2", "codex", "pi", "acp-app-server", ""]) {
    assert.equal(
      rejects(open({ kind, command: ["acp-agent", "--stdio"] })),
      KIND_MESSAGE,
      `the kind ${JSON.stringify(kind)} was not refused with the documented message`,
    );
  }
});

test("refuses a bot kind that is not a string with the same message", () => {
  for (const kind of [7, null, true, ["acp"], { name: "acp" }]) {
    assert.equal(
      rejects(open({ kind, command: ["acp-agent"] })),
      KIND_MESSAGE,
      `the kind ${JSON.stringify(kind)} was not refused with the documented message`,
    );
  }
});

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

test("refuses a command that is not an array of strings", () => {
  for (const command of ["acp-agent", 7, null, true, { argv: ["acp-agent"] }]) {
    assert.equal(
      rejects(open({ kind: "acp", command })),
      COMMAND_MESSAGE,
      `the command ${JSON.stringify(command)} was not refused with the documented message`,
    );
  }
  // A missing command is the same defect as a broken one.
  assert.equal(rejects(open({ kind: "acp" })), COMMAND_MESSAGE);
});

test("refuses a command array that mixes strings with other values", () => {
  const commands = [
    ["acp-agent", 7],
    [7, "acp-agent"],
    ["acp-agent", null],
    ["acp-agent", {}],
    ["acp-agent", ["--stdio"]],
  ];
  for (const command of commands) {
    assert.equal(
      rejects(open({ kind: "acp", command })),
      COMMAND_MESSAGE,
      `the command ${JSON.stringify(command)} was not refused with the documented message`,
    );
  }
});

test("refuses an empty command array", () => {
  assert.equal(rejects(open({ kind: "acp", command: [] })), COMMAND_MESSAGE);
});

test("accepts a minimal bot spec and leaves the optional fields out", () => {
  const frame = parse(open({ kind: "codex-app-server", command: ["codex", "app-server"] }));
  assert.deepEqual(frame, {
    op: "open",
    sid: "s-1",
    bot: { kind: "codex-app-server", command: ["codex", "app-server"] },
  });
  const bot = botOf(frame);
  assert.equal("cwd" in bot, false);
  assert.equal("env" in bot, false);
});

// ---------------------------------------------------------------------------
// The working directory
// ---------------------------------------------------------------------------

test("drops an empty working directory", () => {
  const frame = parse(open({ kind: "acp", command: ["acp-agent"], cwd: "" }));
  assert.deepEqual(frame, {
    op: "open",
    sid: "s-1",
    bot: { kind: "acp", command: ["acp-agent"] },
  });
  assert.equal("cwd" in botOf(frame), false);
});

test("drops a working directory that is not a string", () => {
  for (const cwd of [7, null, true, ["/w"], { path: "/w" }]) {
    const frame = parse(open({ kind: "acp", command: ["acp-agent"], cwd }));
    assert.deepEqual(
      frame,
      { op: "open", sid: "s-1", bot: { kind: "acp", command: ["acp-agent"] } },
      `the cwd ${JSON.stringify(cwd)} was not dropped`,
    );
    assert.equal("cwd" in botOf(frame), false);
  }
});

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

test("keeps only the string values of the environment", () => {
  const frame = parse(
    open({
      kind: "acp",
      command: ["acp-agent"],
      env: {
        BOT_MODE: "fast",
        BOT_COUNT: 2,
        BOT_EMPTY: null,
        BOT_FLAG: true,
        BOT_LIST: ["a"],
        BOT_NESTED: { mode: "fast" },
      },
    }),
  );
  assert.deepEqual(frame, {
    op: "open",
    sid: "s-1",
    bot: {
      kind: "acp",
      command: ["acp-agent"],
      env: { BOT_MODE: "fast" },
    },
  });
});

test("leaves the environment undefined when it is not an object", () => {
  for (const env of ["BOT_MODE=fast", 7, null, true, ["BOT_MODE=fast"]]) {
    const frame = parse(open({ kind: "acp", command: ["acp-agent"], env }));
    assert.deepEqual(
      frame,
      { op: "open", sid: "s-1", bot: { kind: "acp", command: ["acp-agent"] } },
      `the env ${JSON.stringify(env)} was not dropped`,
    );
    assert.equal("env" in botOf(frame), false);
  }
});

// ---------------------------------------------------------------------------
// The resume
// ---------------------------------------------------------------------------

test("ignores a resume that is not an object", () => {
  for (const resume of ["prov-1", 7, null, true]) {
    const frame = parse(open({ kind: "acp", command: ["acp-agent"] }, { resume }));
    assert.deepEqual(
      frame,
      { op: "open", sid: "s-1", bot: { kind: "acp", command: ["acp-agent"] } },
      `the resume ${JSON.stringify(resume)} was not ignored`,
    );
    assert.equal("resume" in frame, false);
  }
});

test("yields an empty resume object for an empty provider session id", () => {
  const frame = parse(
    open({ kind: "acp", command: ["acp-agent"] }, { resume: { providerSessionId: "" } }),
  );
  assert.deepEqual(frame, {
    op: "open",
    sid: "s-1",
    bot: { kind: "acp", command: ["acp-agent"] },
    resume: {},
  });
  // A resume object without any field is the same empty object.
  const bare = parse(open({ kind: "acp", command: ["acp-agent"] }, { resume: {} }));
  assert.deepEqual(bare, frame);
});

// ---------------------------------------------------------------------------
// The session id of the open frame
// ---------------------------------------------------------------------------

test("refuses an open frame without a session id", () => {
  assert.equal(
    rejects({ op: "open", bot: { kind: "acp", command: ["acp-agent"] } }),
    SID_MESSAGE,
  );
  assert.equal(rejects(open({ kind: "acp", command: ["acp-agent"] }, { sid: "" })), SID_MESSAGE);
  assert.equal(rejects(open({ kind: "acp", command: ["acp-agent"] }, { sid: 7 })), SID_MESSAGE);
  assert.equal(rejects(open({ kind: "acp", command: ["acp-agent"] }, { sid: null })), SID_MESSAGE);
});

// ---------------------------------------------------------------------------
// The payload of the send frame
// ---------------------------------------------------------------------------

test("accepts a send frame whose payload is null", () => {
  const frame = parse({ op: "send", sid: "s-1", payload: null });
  assert.deepEqual(frame, { op: "send", sid: "s-1", payload: null });
});

test("tells a present payload key from a missing one", () => {
  // The key is there, so the frame is accepted even when it holds no value.
  const present = parseClientFrame({ op: "send", sid: "s-1", payload: undefined });
  assert.equal(present.ok, true, `expected a frame, got ${JSON.stringify(present)}`);
  if (!present.ok) throw new Error("unreachable");
  assert.equal("payload" in present.frame, true);

  // The key is missing: the frame is refused with a stable reason.
  assert.equal(rejects({ op: "send", sid: "s-1" }), "send requires a payload");
});

// ---------------------------------------------------------------------------
// The payload of the cancel frame
// ---------------------------------------------------------------------------

test("keeps the cancel payload when the key is there, even when it is null", () => {
  const frame = parse({ op: "cancel", sid: "s-1", payload: null });
  assert.deepEqual(frame, { op: "cancel", sid: "s-1", payload: null });
});

test("omits the cancel payload when the key is missing", () => {
  const frame = parse({ op: "cancel", sid: "s-1" });
  assert.deepEqual(frame, { op: "cancel", sid: "s-1" });
  assert.equal("payload" in frame, false);
});

test("keeps the cancel payload key when it holds no value", () => {
  const result = parseClientFrame({ op: "cancel", sid: "s-1", payload: undefined });
  assert.equal(result.ok, true, `expected a frame, got ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  assert.equal("payload" in result.frame, true);
});
