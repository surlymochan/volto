// botd/test/dsh-spec-n19.test.ts
//
// The spawn spec of the DeepSeek Shell (`dsh`) adapter.
//
// botd/src/adapters/dsh.ts starts `dsh --profile acp` and speaks ACP
// (JSON-RPC 2.0 over stdio).  Four things of that adapter are pinned here:
//
//   * the argv of the provider (DSH_COMMAND) and that it is readonly,
//   * the spawn spec: the command comes from DSH_COMMAND, the working
//     directory comes from the options, and nothing is started,
//   * the handshake: the first message is `initialize` with the ACP
//     protocol version of the adapter, and
//   * the cancel: without a provider session id there is nothing to write.
//
// The cases of botd/test/adapters/dsh.test.ts, dsh-gaps.test.ts,
// dsh-resume.test.ts and the table suites of the other adapters are not
// repeated here: this file only adds what they do not cover.
//
// One case is a todo: the argv of the provider is typed readonly, but the
// exported array is not frozen at runtime (see the DEFECT below).
//
// Everything is synthetic and in-process.  No provider, host, socket, port
// or child process is contacted; the only file that is read is the source of
// the adapter itself.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ACP_PROTOCOL_VERSION, DSH_COMMAND, DshAdapter, dshAdapter } from "../src/adapters/dsh.ts";

/** Compile time only: true when T is a readonly array. */
type IsReadonlyArray<T> = T extends readonly unknown[] ? (T extends unknown[] ? false : true) : false;
/** Compile time only: the call does not compile when the condition is false. */
function assertType<T extends true>(_condition: T): void {}

/** The synthetic working directory of the cases below. */
const CWD = "/synthetic/work";
/** The synthetic session id the adapter learns from a `session/new` reply. */
const SESSION_ID = "sess_synthetic_0001";

// --- DSH_COMMAND --------------------------------------------------------------

test("DSH_COMMAND is the documented dsh argv", () => {
  assert.ok(Array.isArray(DSH_COMMAND));
  assert.deepEqual([...DSH_COMMAND], ["dsh", "--profile", "acp"]);
  assert.equal(DSH_COMMAND[0], "dsh");
  assert.deepEqual(DSH_COMMAND.slice(1), ["--profile", "acp"]);
});

test("DSH_COMMAND is readonly for the type system", () => {
  // `readonly string[]` in the source: the export cannot be widened to a
  // mutable array by a caller.
  assertType<IsReadonlyArray<typeof DSH_COMMAND>>(true);
  assert.ok(Array.isArray(DSH_COMMAND));
});

test("DSH_COMMAND is a plain array at runtime: the readonly is a type level promise", () => {
  // The type annotation is a promise of the type system; the exported array
  // itself is a plain array and can still be changed.  The runtime freeze is
  // the todo below.
  assert.equal(Object.isFrozen(DSH_COMMAND), false);
});

// DEFECT: DSH_COMMAND is typed readonly but not frozen, so a caller can
// change the argv that every dsh spawn uses.
test.todo("DSH_COMMAND is frozen at runtime", () => {
  assert.equal(Object.isFrozen(DSH_COMMAND), true);
});

// --- spawn --------------------------------------------------------------------

test("spawn() builds the command from DSH_COMMAND and the cwd from the options", () => {
  const adapter = new DshAdapter();
  const spec = adapter.spawn({ cwd: CWD });

  assert.deepEqual(spec.command, [...DSH_COMMAND]);
  assert.deepEqual(spec.command, ["dsh", "--profile", "acp"]);
  assert.equal(spec.command[0], "dsh");
  assert.deepEqual(spec.command.slice(1), ["--profile", "acp"]);
  assert.equal(spec.cwd, CWD);
});

test("spawn() hands out a copy of the argv", () => {
  const adapter = new DshAdapter();
  const spec = adapter.spawn({ cwd: CWD });

  // The spec carries its own array: a caller that changes it cannot corrupt
  // the argv of the next spawn.
  assert.notEqual(spec.command, DSH_COMMAND);
  assert.deepEqual(spec.command, [...DSH_COMMAND]);
});

test("spawn() ignores the model, the effort and the resume id", () => {
  const adapter = new DshAdapter();
  const plain = adapter.spawn({ cwd: CWD });
  const rich = adapter.spawn({
    cwd: CWD,
    model: "synthetic-model",
    effort: "high",
    resumeProviderSessionId: "synthetic-resume",
  });

  assert.deepEqual(rich.command, plain.command);
  assert.equal(rich.cwd, plain.cwd);
  assert.doesNotMatch(JSON.stringify(rich.command), /synthetic-model|synthetic-resume/);
});

test("spawn() inherits the environment of the daemon", () => {
  const spec = new DshAdapter().spawn({ cwd: CWD });

  assert.equal(spec.env.PATH, process.env.PATH);
  for (const [key, value] of Object.entries(spec.env)) {
    assert.equal(typeof key, "string");
    assert.equal(typeof value, "string");
  }
});

test("spawn() returns a spawn spec and starts nothing", () => {
  const adapter = new DshAdapter();
  const spec = adapter.spawn({ cwd: CWD });

  // Exactly the three fields of a SpawnSpec, nothing else.
  assert.deepEqual(Object.keys(spec).sort(), ["command", "cwd", "env"]);

  // The adapter module has no runtime import at all, so it cannot start a
  // process or open a socket: spawn() only describes the start.
  const source = readFileSync(new URL("../src/adapters/dsh.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'](node:)?(child_process|net|http|https|tls)["']/);
});

test("the shared dsh adapter builds the same spawn spec as a fresh one", () => {
  assert.equal(dshAdapter.kind, "dsh");
  assert.deepEqual(dshAdapter.spawn({ cwd: CWD }).command, new DshAdapter().spawn({ cwd: CWD }).command);
  assert.equal(dshAdapter.spawn({ cwd: CWD }).cwd, CWD);
});

// --- handshake ----------------------------------------------------------------

test("handshake() opens with initialize at the protocol version of the adapter", () => {
  const adapter = new DshAdapter();
  const messages = adapter.handshake({ cwd: CWD }) as Record<string, unknown>[];

  assert.equal(messages.length, 2);

  const initialize = messages[0];
  assert.equal(initialize.jsonrpc, "2.0");
  assert.equal(initialize.method, "initialize");
  assert.equal(initialize.id, 0);
  const params = initialize.params as Record<string, unknown>;
  assert.equal(params.protocolVersion, ACP_PROTOCOL_VERSION);
  assert.equal(ACP_PROTOCOL_VERSION, 1);
  // The agent keeps its own tools: no file system and no terminal.
  assert.deepEqual(params.clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  });
});

test("handshake() opens the session after the initialize", () => {
  const adapter = new DshAdapter();
  const messages = adapter.handshake({ cwd: CWD }) as Record<string, unknown>[];

  const session = messages[1];
  assert.equal(session.jsonrpc, "2.0");
  assert.equal(session.method, "session/new");
  assert.equal(session.id, 1);
  const params = session.params as Record<string, unknown>;
  assert.equal(params.cwd, CWD);
  assert.deepEqual(params.mcpServers, []);

  // Both messages go to the provider as NDJSON.
  for (const message of messages) {
    assert.doesNotThrow(() => JSON.stringify(message));
  }
});

test("the handshake continues the request counter of the adapter", () => {
  const adapter = new DshAdapter();
  const first = adapter.handshake({ cwd: CWD }) as { id: number }[];
  const second = adapter.handshake({ cwd: CWD }) as { id: number }[];

  assert.deepEqual(first.map((message) => message.id), [0, 1]);
  assert.deepEqual(second.map((message) => message.id), [2, 3]);
});

// --- cancel -------------------------------------------------------------------

test("cancel() without a provider session id writes nothing", () => {
  const adapter = new DshAdapter();

  assert.deepEqual(adapter.cancel({}), []);
  assert.deepEqual(adapter.cancel({ providerSessionId: undefined }), []);
  // An empty id is no id: nothing is addressed.
  assert.deepEqual(adapter.cancel({ providerSessionId: "" }), []);
});

test("cancel() falls back to the session id the adapter learned", () => {
  const adapter = new DshAdapter();
  adapter.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: SESSION_ID } }));

  assert.deepEqual(adapter.cancel({}), [
    { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: SESSION_ID } },
  ]);
});

test("cancel() prefers the provider session id of the caller", () => {
  const adapter = new DshAdapter();
  adapter.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: SESSION_ID } }));

  assert.deepEqual(adapter.cancel({ providerSessionId: "sess_synthetic_0002" }), [
    { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "sess_synthetic_0002" } },
  ]);
});
