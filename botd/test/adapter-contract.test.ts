// botd/test/adapter-contract.test.ts
//
// The shared contract suite for the bot adapters.
//
// Every adapter in botd/src/adapters/ has to behave the same way for the
// control plane, otherwise the daemon needs one exception per provider:
//
//   * it names itself with a kind the control plane knows,
//   * it starts its provider without a shell and without secrets,
//   * it never throws while it parses a provider line, and a line it does
//     not understand becomes a raw event,
//   * the messages it hands out (handshake, prompt, cancel) are JSON
//     serializable, so they can be written to the provider as NDJSON.
//
// The suite discovers the adapters on its own: every module of
// botd/src/adapters/ is imported and every adapter instance it exports is
// checked against the contract.  A build without adapters (the directory is
// missing or empty) is skipped with a clear message instead of failing, so
// the suite can live next to the adapters while they are still landing.
//
// An adapter that is not part of this build may refuse to spawn (the
// Copilot CLI needs a paid seat, the pi adapter is optional); it then has to
// say why, and only the spawn checks are skipped for it.
//
// The fixtures are synthetic: no provider is contacted, no host, account or
// token is used.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  BotAdapter,
  BotKind,
  ModelFamily,
  NormalizedEvent,
  OpenOptions,
  SpawnSpec,
} from "../src/adapter-types.ts";
import { isSecretKeyName, redactText } from "../src/redact.ts";

/* --------------------------------------------------------------- fixtures */

/** The kinds the adapter contract knows (mirrors BotKind in adapter-types.ts). */
const BOT_KINDS: readonly BotKind[] = ["agy", "claude", "codex", "copilot", "dsh", "pi"];

/** The model families the contract knows (mirrors ModelFamily in adapter-types.ts). */
const MODEL_FAMILIES: readonly ModelFamily[] = [
  "claude",
  "deepseek",
  "gemini",
  "gpt",
  "minimax",
  "other",
];

/** Options every adapter is asked to open a session with. */
const OPEN_OPTIONS: OpenOptions = {
  cwd: "/synthetic/work",
  model: "synthetic-model",
  effort: "synthetic-effort",
  systemPrompt: "synthetic system prompt",
};

/** Session id handed to prompt() and cancel(). */
const SESSION_ID = "synthetic-session-0001";

/**
 * A secret looking key with a synthetic value.
 *
 * The environment of the daemon may hold credentials; an adapter must not
 * copy such a value under a second name.  The value is synthetic on purpose.
 */
const PROBE_KEY = "VOLTO_CONTRACT_PROBE_TOKEN";
const PROBE_VALUE = "synthetic-contract-probe-value";

/** Characters that would turn a command into a shell command. */
const SHELL_METACHARACTERS = /[;&|<>`$()\\\n\r]/;

/** One line the adapter has to survive. */
interface ParseSample {
  /** Name of the sample, used in the failure messages. */
  name: string;
  /** The line that is handed to parse(). */
  line: string;
  /** True when the line is unknown to every adapter and must stay raw. */
  expectRaw: boolean;
}

/** The lines parse() has to survive without throwing. */
const PARSE_SAMPLES: readonly ParseSample[] = [
  { name: "empty line", line: "", expectRaw: false },
  { name: "blank line", line: "   \t  ", expectRaw: false },
  { name: "plain text", line: "this is not json at all", expectRaw: true },
  { name: "unknown object", line: '{"__volto_contract__":"unknown"}', expectRaw: true },
  { name: "json array", line: "[1,2,3]", expectRaw: true },
  { name: "json null", line: "null", expectRaw: true },
  { name: "json number", line: "42", expectRaw: true },
  { name: "json string", line: '"a string"', expectRaw: true },
  { name: "truncated object", line: '{"type":"assistant"', expectRaw: true },
  { name: "binary bytes", line: "\u0000\u0001\u0002\u0003\ufffd", expectRaw: true },
  { name: "binary object", line: '{"type":"\u0000\u0001"}', expectRaw: true },
  { name: "huge text", line: "x".repeat(1024 * 1024), expectRaw: true },
  {
    name: "huge object",
    line: JSON.stringify({ type: "assistant", filler: "y".repeat(512 * 1024) }),
    expectRaw: true,
  },
];

/* -------------------------------------------------------------- discovery */

/** Directory that holds the adapter modules. */
const ADAPTER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "adapters",
);

/** The registry of the adapters; it exports no adapter instance itself. */
const REGISTRY_MODULE = "index.ts";

/** The adapter modules of this build, sorted by name. */
function adapterModuleFiles(): string[] {
  try {
    const entries = readdirSync(ADAPTER_DIR, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    // The directory does not exist (yet): the suite skips itself.
    return [];
  }
}

const MODULE_FILES = adapterModuleFiles();

/** Reason the suite skips itself, or undefined when there is work to do. */
const SKIP_REASON =
  MODULE_FILES.length === 0
    ? `no adapter modules in ${ADAPTER_DIR}: the directory is missing or empty`
    : undefined;

/** True when the value looks like a bot adapter. */
function isAdapterLike(value: unknown): value is BotAdapter {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BotAdapter>;
  return (
    typeof candidate.kind === "string" &&
    typeof candidate.spawn === "function" &&
    typeof candidate.parse === "function"
  );
}

/** True when the export is a class that implements the adapter contract. */
function isAdapterClass(value: unknown): boolean {
  if (typeof value !== "function") return false;
  const proto = (value as { prototype?: Record<string, unknown> }).prototype;
  return proto !== undefined && typeof proto.spawn === "function" && typeof proto.parse === "function";
}

/** True when the export is a factory that builds an adapter. */
function isAdapterFactory(name: string): boolean {
  return /^(create|make|build|new)[A-Za-z0-9]*Adapter$/.test(name);
}

/**
 * Every adapter instance a module exports.
 *
 * A module may export the adapter itself, a shared instance, a class or a
 * factory; all of them are picked up so a new adapter cannot slip through
 * the suite by exporting its adapter in an unusual way.
 */
function collectAdapters(module: Record<string, unknown>): BotAdapter[] {
  const found = new Set<BotAdapter>();
  // A module namespace lists its default export as well, so one walk over
  // the exports is enough.
  const exports: [string, unknown][] = Object.entries(module);

  for (const [name, value] of exports) {
    if (isAdapterLike(value)) {
      found.add(value);
      continue;
    }
    if (isAdapterClass(value)) {
      try {
        const instance = new (value as new () => unknown)();
        if (isAdapterLike(instance)) found.add(instance);
      } catch {
        // The class wants arguments: it cannot be checked without them.
      }
      continue;
    }
    if (typeof value === "function" && isAdapterFactory(name)) {
      try {
        const instance = (value as () => unknown)();
        if (isAdapterLike(instance)) found.add(instance);
      } catch {
        // The factory wants arguments: it cannot be checked without them.
      }
    }
  }
  return [...found];
}

/* -------------------------------------------------------------- assertions */

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when the text looks like a credential. */
function looksLikeSecret(text: string): boolean {
  return isSecretKeyName(text) || redactText(text) !== text;
}

/** True when the adapter refused to start because it is not part of this build. */
function isUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /disabled|not available|unavailable|not part of this build/i.test(error.message);
}

/** The value as JSON sees it: properties with an undefined value are dropped. */
function jsonShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => (entry === undefined ? null : jsonShape(entry)));
  }
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      // Not a plain object: JSON.stringify has its own rules for those.
      const json = JSON.stringify(value);
      return json === undefined ? undefined : JSON.parse(json);
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = jsonShape(entry);
    }
    return out;
  }
  return value;
}

/** The adapter names itself with a kind the control plane knows. */
function assertIdentity(adapter: BotAdapter): void {
  assert.equal(typeof adapter.kind, "string", `${adapter.kind}: kind is not a string`);
  assert.ok(
    BOT_KINDS.includes(adapter.kind),
    `unknown adapter kind "${adapter.kind}": expected one of ${BOT_KINDS.join(", ")}`,
  );
  assert.equal(typeof adapter.family, "string", `${adapter.kind}: family is not a string`);
  assert.ok(
    MODEL_FAMILIES.includes(adapter.family),
    `unknown model family "${adapter.family}": expected one of ${MODEL_FAMILIES.join(", ")}`,
  );
  for (const method of ["spawn", "handshake", "prompt", "cancel", "parse", "answerPermission"]) {
    assert.equal(
      typeof (adapter as unknown as Record<string, unknown>)[method],
      "function",
      `${adapter.kind}: ${method}() is missing`,
    );
  }
}

/** The spawn spec starts the provider without a shell and without secrets. */
function assertSpawn(adapter: BotAdapter): void {
  const previous = process.env[PROBE_KEY];
  process.env[PROBE_KEY] = PROBE_VALUE;
  try {
    let spec: SpawnSpec;
    try {
      spec = adapter.spawn(OPEN_OPTIONS);
    } catch (error) {
      // An adapter that is not part of this build may refuse to start, but it
      // has to say why.
      assert.ok(
        isUnavailable(error),
        `${adapter.kind}: spawn() threw: ${messageOf(error)}`,
      );
      return;
    }

    assert.ok(spec !== null && typeof spec === "object", `${adapter.kind}: spawn() returned nothing`);
    assert.ok(
      Array.isArray(spec.command),
      `${adapter.kind}: spawn() must return a command array`,
    );
    assert.ok(spec.command.length > 0, `${adapter.kind}: spawn() must return a non-empty command`);

    for (const [index, arg] of spec.command.entries()) {
      assert.equal(typeof arg, "string", `${adapter.kind}: argv[${index}] is not a string`);
      assert.ok(arg.length > 0, `${adapter.kind}: argv[${index}] is empty`);
      assert.ok(!arg.includes("\n"), `${adapter.kind}: argv[${index}] carries a newline`);
      assert.ok(
        !looksLikeSecret(arg),
        `${adapter.kind}: argv[${index}] looks like a secret: ${arg}`,
      );
    }
    assert.ok(
      !SHELL_METACHARACTERS.test(spec.command[0]),
      `${adapter.kind}: argv[0] is not a plain command: ${spec.command[0]}`,
    );

    assert.equal(
      typeof spec.cwd,
      "string",
      `${adapter.kind}: spawn() must return a cwd`,
    );
    assert.ok(spec.cwd.length > 0, `${adapter.kind}: spawn() returned an empty cwd`);
    assert.equal(
      spec.cwd,
      OPEN_OPTIONS.cwd,
      `${adapter.kind}: spawn() must run in the requested cwd`,
    );

    assertSpawnEnv(adapter, spec);
  } finally {
    if (previous === undefined) delete process.env[PROBE_KEY];
    else process.env[PROBE_KEY] = previous;
  }
}

/** The environment of the child carries no secret of its own. */
function assertSpawnEnv(adapter: BotAdapter, spec: SpawnSpec): void {
  const env = spec.env;
  assert.ok(
    env !== null && typeof env === "object" && !Array.isArray(env),
    `${adapter.kind}: spawn() must return an env object`,
  );

  // Everything the daemon environment already holds is the operator's
  // business; only what the adapter adds is the adapter's business.
  const inherited = new Set(Object.keys(process.env));
  for (const [key, value] of Object.entries(env)) {
    assert.equal(typeof value, "string", `${adapter.kind}: env ${key} is not a string`);
    if (inherited.has(key)) continue;
    assert.ok(
      !isSecretKeyName(key),
      `${adapter.kind}: spawn() adds the secret looking env key "${key}"`,
    );
    assert.ok(
      !looksLikeSecret(value),
      `${adapter.kind}: spawn() adds a secret looking env value for "${key}"`,
    );
  }

  // A secret of the environment must not be echoed under a second name.
  for (const [key, value] of Object.entries(env)) {
    if (value !== PROBE_VALUE) continue;
    assert.equal(
      key,
      PROBE_KEY,
      `${adapter.kind}: spawn() echoes a secret of the environment under "${key}"`,
    );
  }
}

/** parse() survives every hostile line and keeps unknown lines raw. */
function assertParse(adapter: BotAdapter): void {
  for (const sample of PARSE_SAMPLES) {
    const events = parseSafely(adapter, sample.line, sample.name);
    for (const [index, event] of events.entries()) {
      assertEvent(adapter, event, `${sample.name}[${index}]`);
    }

    if (sample.expectRaw) {
      const raw = events.filter((event) => event.kind === "raw");
      assert.ok(
        raw.length > 0,
        `${adapter.kind}: parse(${sample.name}) must map an unknown line to a raw event`,
      );
      continue;
    }

    // A blank line carries nothing: it must not start a turn either.
    const loud = events.filter(
      (event) => event.kind === "text" || event.kind === "tool" || event.kind === "turn_end",
    );
    assert.equal(
      loud.length,
      0,
      `${adapter.kind}: parse(${sample.name}) must not produce output events`,
    );
  }
}

/** parse() returns events instead of throwing. */
function parseSafely(adapter: BotAdapter, line: string, label: string): NormalizedEvent[] {
  try {
    const events = adapter.parse(line);
    assert.ok(
      Array.isArray(events),
      `${adapter.kind}: parse(${label}) must return an array`,
    );
    return events;
  } catch (error) {
    assert.fail(`${adapter.kind}: parse(${label}) threw: ${messageOf(error)}`);
  }
}

/** One normalized event has the shape the daemon expects. */
function assertEvent(adapter: BotAdapter, event: NormalizedEvent, label: string): void {
  assert.ok(
    event !== null && typeof event === "object",
    `${adapter.kind}: parse() produced a non object event (${label})`,
  );

  switch (event.kind) {
    case "ready": {
      const ready = event as { providerSessionId?: unknown };
      assert.ok(
        ready.providerSessionId === undefined || typeof ready.providerSessionId === "string",
        `${adapter.kind}: a ready event carries no session id (${label})`,
      );
      break;
    }
    case "text": {
      const text = event as { delta?: unknown };
      assert.equal(typeof text.delta, "string", `${adapter.kind}: a text event carries no delta (${label})`);
      break;
    }
    case "tool": {
      const tool = event as { name?: unknown; status?: unknown; summary?: unknown };
      assert.equal(typeof tool.name, "string", `${adapter.kind}: a tool event carries no name (${label})`);
      assert.ok(
        tool.status === "start" || tool.status === "end" || tool.status === "error",
        `${adapter.kind}: a tool event carries the unknown status ${JSON.stringify(tool.status)} (${label})`,
      );
      assert.ok(
        tool.summary === undefined || typeof tool.summary === "string",
        `${adapter.kind}: a tool event carries no summary (${label})`,
      );
      break;
    }
    case "permission": {
      const permission = event as { id?: unknown; request?: unknown };
      assert.equal(
        typeof permission.id,
        "string",
        `${adapter.kind}: a permission event carries no id (${label})`,
      );
      assert.ok(
        "request" in permission,
        `${adapter.kind}: a permission event carries no request (${label})`,
      );
      break;
    }
    case "turn_end": {
      const turn = event as { status?: unknown; usage?: unknown };
      assert.ok(
        turn.status === "ok" || turn.status === "error" || turn.status === "cancelled",
        `${adapter.kind}: a turn_end event carries the unknown status ${JSON.stringify(turn.status)} (${label})`,
      );
      if (turn.usage !== undefined) {
        assert.ok(
          turn.usage !== null && typeof turn.usage === "object" && !Array.isArray(turn.usage),
          `${adapter.kind}: a turn_end event carries no usage object (${label})`,
        );
        const usage = turn.usage as { inputTokens?: unknown; outputTokens?: unknown };
        assert.ok(
          usage.inputTokens === undefined || typeof usage.inputTokens === "number",
          `${adapter.kind}: the usage of a turn_end event is not a number (${label})`,
        );
        assert.ok(
          usage.outputTokens === undefined || typeof usage.outputTokens === "number",
          `${adapter.kind}: the usage of a turn_end event is not a number (${label})`,
        );
      }
      break;
    }
    case "error": {
      const error = event as { message?: unknown };
      assert.equal(typeof error.message, "string", `${adapter.kind}: an error event carries no message (${label})`);
      break;
    }
    case "raw": {
      assert.ok(
        "payload" in (event as object),
        `${adapter.kind}: a raw event carries no payload (${label})`,
      );
      break;
    }
    default: {
      const kind = (event as { kind?: unknown }).kind;
      assert.fail(
        `${adapter.kind}: parse() produced the unknown event kind ${JSON.stringify(kind)} (${label})`,
      );
    }
  }
}

/** The handshake, the prompt and the cancel are JSON serializable. */
function assertMessages(adapter: BotAdapter): void {
  const handshake = adapter.handshake(OPEN_OPTIONS);
  assert.ok(Array.isArray(handshake), `${adapter.kind}: handshake() must return an array`);
  for (const [index, message] of handshake.entries()) {
    assertSerializable(adapter, message, `handshake[${index}]`);
  }

  const prompt = adapter.prompt("synthetic prompt", { providerSessionId: SESSION_ID });
  assert.ok(
    prompt !== undefined && prompt !== null,
    `${adapter.kind}: prompt() must return a message`,
  );
  assertSerializable(adapter, prompt, "prompt");

  const cancel = adapter.cancel({ providerSessionId: SESSION_ID });
  assert.ok(Array.isArray(cancel), `${adapter.kind}: cancel() must return an array`);
  for (const [index, message] of cancel.entries()) {
    assertSerializable(adapter, message, `cancel[${index}]`);
  }
}

/** A message survives a JSON round trip. */
function assertSerializable(adapter: BotAdapter, value: unknown, label: string): void {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    assert.fail(`${adapter.kind}: ${label} is not JSON serializable: ${messageOf(error)}`);
  }
  assert.equal(typeof json, "string", `${adapter.kind}: ${label} is not JSON serializable`);

  let round: unknown;
  let shape: unknown;
  try {
    round = JSON.parse(json as string);
    shape = jsonShape(value);
  } catch (error) {
    assert.fail(`${adapter.kind}: ${label} is not JSON serializable: ${messageOf(error)}`);
  }
  assert.deepStrictEqual(
    round,
    shape,
    `${adapter.kind}: ${label} does not survive a JSON round trip`,
  );
}

/** Every part of the contract of one adapter. */
function assertAdapterContract(adapter: BotAdapter): void {
  assertIdentity(adapter);
  assertSpawn(adapter);
  assertParse(adapter);
  assertMessages(adapter);
}

/* ------------------------------------------------------------------ tests */

test("the adapter modules of this build are discovered", { skip: SKIP_REASON }, async (t) => {
  assert.ok(MODULE_FILES.length > 0, "no adapter module was discovered");

  for (const file of MODULE_FILES) {
    const module = await importModule(file, t);
    if (module === undefined) continue;
    const found = collectAdapters(module);
    t.diagnostic(
      `${file}: ${found.length} adapter instance(s)` +
        (found.length > 0 ? ` (${found.map((adapter) => adapter.kind).join(", ")})` : ""),
    );
  }
});

for (const file of MODULE_FILES) {
  test(`adapter contract: ${file}`, { skip: SKIP_REASON }, async (t) => {
    const module = await importModule(file, t);
    if (module === undefined) return;

    const adapters = collectAdapters(module);
    if (adapters.length === 0) {
      // The registry exports the adapters of the other modules, not one.
      t.diagnostic(`${file} exports no adapter instance: there is nothing to check`);
      return;
    }

    for (const adapter of adapters) {
      await t.test(`${file}: ${adapter.kind}`, () => {
        // A module named after a kind has to implement that kind.
        const name = path.basename(file, ".ts");
        if (BOT_KINDS.includes(name as BotKind)) {
          assert.equal(
            adapter.kind,
            name,
            `${file} implements "${adapter.kind}" but is named "${name}"`,
          );
        }
        assertAdapterContract(adapter);
      });
    }
  });
}

test("the contract suite covered the adapters of this build", { skip: SKIP_REASON }, async (t) => {
  let adapters = 0;
  for (const file of MODULE_FILES) {
    const module = await importModule(file, t);
    if (module === undefined) continue;
    adapters += collectAdapters(module).length;
  }
  assert.ok(adapters > 0, "no adapter instance was checked by the contract suite");
});

/** Import one adapter module; the registry may be missing, the rest may not. */
async function importModule(
  file: string,
  t: { diagnostic: (message: string) => void },
): Promise<Record<string, unknown> | undefined> {
  const url = pathToFileURL(path.join(ADAPTER_DIR, file)).href;
  try {
    return (await import(url)) as Record<string, unknown>;
  } catch (error) {
    if (file === REGISTRY_MODULE) {
      // The registry is not an adapter; it has its own test suite.
      t.diagnostic(`the adapter registry ${file} could not be imported: ${messageOf(error)}`);
      return undefined;
    }
    throw error;
  }
}
