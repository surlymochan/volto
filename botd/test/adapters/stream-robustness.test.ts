// botd/test/adapters/stream-robustness.test.ts
//
// Robustness tests for the stream parsers of the claude, copilot, dsh and
// agy adapters.
//
// A provider stream is not a clean NDJSON channel: the CLI may print ANSI
// colour codes, a stack trace of its own crash, an empty line, a line that
// is cut in half by the chunk boundary of the pipe or a line that carries
// megabytes of text.  The adapter contract (botd/src/adapter-types.ts) says
// of `parse()`: "Map one stdout JSON line to normalized events. Must never
// throw."  This suite feeds every hostile shape to every adapter and checks
// three things:
//
//   1. the parser does not throw,
//   2. the line behind the hostile one is still parsed (no lost event),
//   3. the hostile line has a defined outcome -- it is skipped, kept
//      verbatim as a raw event or reported as an error; it is never
//      swallowed silently and never turned into a wrong answer.
//
// The suite is table driven: one row per adapter flavour (the agy adapter
// speaks two protocols, so it has two rows) and one case per hostile shape.
// The line framing is done by a small framer that mirrors the daemon
// (botd/src/session.ts reads the provider stdout with `setEncoding("utf8")`
// and cuts it at every LF), because the adapters parse whole lines.
//
// No provider binary is started and no network is used: every fixture is a
// synthetic string.
//
// Known deviations
// ----------------
// A blank line reaches the adapters as raw noise in the claude adapter
// (it keeps every line verbatim), while the ACP adapters skip it.  The
// daemon drops blank lines before an adapter sees them
// (botd/src/session.ts), so the difference is cosmetic and no data is lost.

import { test } from "node:test";
import assert from "node:assert/strict";
import { StringDecoder } from "node:string_decoder";

import { ClaudeAdapter } from "../../src/adapters/claude.ts";
import { CopilotAdapter } from "../../src/adapters/copilot.ts";
import { DshAdapter } from "../../src/adapters/dsh.ts";
import { createAgyAdapter } from "../../src/adapters/agy.ts";
import type { BotAdapter, NormalizedEvent } from "../../src/adapter-types.ts";

/* ------------------------------------------------------------------ helpers */

/** Every kind a normalized event may have. */
const EVENT_KINDS: readonly string[] = [
  "ready",
  "text",
  "tool",
  "permission",
  "turn_end",
  "error",
  "raw",
];

/** The kinds that carry an answer; noise must never produce one of them. */
const LOUD_KINDS: readonly string[] = [
  "ready",
  "text",
  "tool",
  "permission",
  "turn_end",
];

/**
 * A line framer that mirrors the daemon.
 *
 * botd/src/session.ts reads the provider stdout with `setEncoding("utf8")`
 * and cuts it at every LF, so a line may arrive in several chunks and one
 * chunk may carry several lines.  The decoder keeps a multi-byte character
 * that is split across two chunks intact, so the adapter always sees a
 * whole, correctly decoded line.  The line is handed over as it came: the
 * adapters have to survive the noise of the provider, not a cleaned up
 * version of it.
 */
class LineFramer {
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #count = 0;

  /** Feed a chunk of provider output; the finished lines are returned. */
  push(chunk: string | Buffer): string[] {
    this.#buffer +=
      typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    const lines: string[] = [];
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index === -1) break;
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      this.#count += 1;
      lines.push(line);
    }
    return lines;
  }

  /** The line that is not terminated yet. */
  get pending(): string {
    return this.#buffer;
  }

  /** How many lines the framer has delivered. */
  get count(): number {
    return this.#count;
  }
}

/** parse() must not throw; the events are checked and returned. */
function parseSafely(
  adapter: BotAdapter,
  line: string,
  label: string,
): NormalizedEvent[] {
  let events: NormalizedEvent[];
  try {
    events = adapter.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`${adapter.kind}: parse(${label}) threw: ${message}`);
  }
  assert.ok(
    Array.isArray(events),
    `${adapter.kind}: parse(${label}) did not return an array`,
  );
  for (const event of events) {
    assert.ok(
      event !== null && typeof event === "object",
      `${adapter.kind}: parse(${label}) produced a non object event`,
    );
    assert.ok(
      EVENT_KINDS.includes(event.kind),
      `${adapter.kind}: parse(${label}) produced the unknown event kind ${JSON.stringify(event.kind)}`,
    );
  }
  return events;
}

/** Feed a chunk of provider output and return the events of the finished lines. */
function feed(
  adapter: BotAdapter,
  framer: LineFramer,
  chunk: string | Buffer,
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (const line of framer.push(chunk)) {
    const label = JSON.stringify(line.length > 80 ? `${line.slice(0, 80)}...` : line);
    events.push(...parseSafely(adapter, line, label));
  }
  return events;
}

/** The text deltas of the events, in order. */
function textOf(events: NormalizedEvent[]): string[] {
  return events
    .filter((event) => event.kind === "text")
    .map((event) => (event as { delta: string }).delta);
}

/** Noise must not turn into an answer. */
function assertNoLoudEvents(events: NormalizedEvent[], label: string): void {
  for (const event of events) {
    assert.ok(
      !LOUD_KINDS.includes(event.kind),
      `${label}: the line produced a ${event.kind} event`,
    );
  }
}

/** The line was skipped or kept verbatim, but it never became an answer. */
function assertRawOnly(events: NormalizedEvent[], label: string): void {
  assertNoLoudEvents(events, label);
  for (const event of events) {
    assert.equal(
      event.kind,
      "raw",
      `${label}: the line produced a ${event.kind} event instead of raw`,
    );
  }
}

/** The raw payload of an event. */
function rawPayload(event: NormalizedEvent): unknown {
  assert.equal(event.kind, "raw", "expected a raw event");
  return (event as { payload: unknown }).payload;
}

/* ------------------------------------------------------------------ fixtures */

/**
 * One adapter flavour: the adapter instance and the provider lines its
 * protocol uses.  Every line is synthetic.
 */
interface AdapterFlavour {
  /** Name of the row; it is part of every test title. */
  readonly name: string;
  /** A fresh adapter instance; no binary is started. */
  create(): BotAdapter;
  /** A provider line that carries a text delta. */
  textLine(text: string): string;
  /** A provider line with an event the adapter does not know. */
  unknownLine(): string;
}

/** A stream-json line with a text block (claude, agy in stream-json mode). */
function streamJsonTextLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/** An ACP session/update line with an agent message chunk (copilot, dsh, agy). */
function acpTextLine(text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-0001",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

/** The adapter flavours of this suite. */
const FLAVOURS: readonly AdapterFlavour[] = [
  {
    name: "claude",
    create: () => new ClaudeAdapter(),
    textLine: streamJsonTextLine,
    unknownLine: () =>
      JSON.stringify({ type: "totally_new_event", payload: { hint: 1 } }),
  },
  {
    name: "copilot",
    create: () => new CopilotAdapter(),
    textLine: acpTextLine,
    unknownLine: () =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/unknown_update",
        params: { sessionId: "session-0001" },
      }),
  },
  {
    name: "dsh",
    create: () => new DshAdapter(),
    textLine: acpTextLine,
    unknownLine: () =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/unknown_update",
        params: { sessionId: "session-0001" },
      }),
  },
  {
    name: "agy (stream-json)",
    create: () => createAgyAdapter({ protocol: "stream-json" }),
    textLine: streamJsonTextLine,
    unknownLine: () =>
      JSON.stringify({ type: "totally_new_event", payload: { hint: 1 } }),
  },
  {
    name: "agy (acp)",
    create: () => createAgyAdapter({ protocol: "acp" }),
    textLine: acpTextLine,
    unknownLine: () =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/unknown_update",
        params: { sessionId: "session-0001" },
      }),
  },
];

/* ----------------------------------------------------------------- scenarios */

/** One hostile shape and the check it has to pass. */
interface Scenario {
  /** Name of the case; it is part of every test title. */
  readonly name: string;
  /** The check; it gets a fresh adapter instance. */
  run(flavour: AdapterFlavour): void;
}

/** The scenarios of this suite. */
const SCENARIOS: readonly Scenario[] = [
  {
    name: "a JSON line split across three chunks is parsed once and intact",
    run(flavour) {
      const adapter = flavour.create();
      // The line and its terminator are cut into three chunks.
      const line = `${flavour.textLine("split-across-chunks")}\n`;
      const framer = new LineFramer();

      const first = Math.floor(line.length / 3);
      const second = Math.floor((2 * line.length) / 3);
      const events = [
        ...feed(adapter, framer, line.slice(0, first)),
        ...feed(adapter, framer, line.slice(first, second)),
        ...feed(adapter, framer, line.slice(second)),
      ];

      assert.equal(framer.count, 1, "the line was cut into more than one line");
      assert.equal(framer.pending, "", "the line was not completed");
      assert.deepEqual(textOf(events), ["split-across-chunks"]);

      // A half line that is handed to the adapter directly is noise, not a
      // half answer: it must not produce a text event with a cut delta.
      const partial = parseSafely(adapter, line.slice(0, first), "partial line");
      assertRawOnly(partial, "partial line");
    },
  },
  {
    name: "a truncated JSON line does not swallow the next line",
    run(flavour) {
      const adapter = flavour.create();
      const framer = new LineFramer();

      const full = flavour.textLine("truncated-payload");
      const truncated = full.slice(0, Math.max(8, Math.floor(full.length / 2)));
      assert.throws(
        () => JSON.parse(truncated),
        "the fixture is not truncated JSON",
      );

      const truncatedEvents = feed(adapter, framer, `${truncated}\n`);
      const afterEvents = feed(
        adapter,
        framer,
        `${flavour.textLine("after-the-truncation")}\n`,
      );

      // The truncated line is kept verbatim, but it never becomes an answer.
      assertRawOnly(truncatedEvents, "truncated line");
      assert.ok(
        String(rawPayload(truncatedEvents[0])).includes(truncated.slice(0, 8)),
        "the truncated line lost its bytes",
      );
      // The line behind it is not lost.
      assert.deepEqual(textOf(afterEvents), ["after-the-truncation"]);
    },
  },
  {
    name: "empty and whitespace-only lines carry no answer",
    run(flavour) {
      const adapter = flavour.create();
      const framer = new LineFramer();

      const blankEvents = [
        ...feed(adapter, framer, "\n"),
        ...feed(adapter, framer, "   \t  \n"),
        ...feed(adapter, framer, "\n\n"),
      ];
      const afterEvents = feed(
        adapter,
        framer,
        `${flavour.textLine("after-the-blank-lines")}\n`,
      );

      // A blank line carries nothing: it is skipped or kept as raw noise,
      // but it never starts a turn and never becomes an answer.
      assertRawOnly(blankEvents, "blank lines");
      // The line behind the blank ones is not lost.
      assert.deepEqual(textOf(afterEvents), ["after-the-blank-lines"]);
    },
  },
  {
    name: "ANSI colour codes and a stack trace stay noise",
    run(flavour) {
      const adapter = flavour.create();
      const framer = new LineFramer();

      const ansi = "\u001b[1;31mERROR\u001b[0m the provider exploded";
      const stack = [
        "Error: boom",
        "    at run (/synthetic/app.js:1:1)",
        "    at Module._compile (node:internal/modules:1:1)",
      ];

      const ansiEvents = feed(adapter, framer, `${ansi}\n`);
      const stackEvents = stack.flatMap((line) => feed(adapter, framer, `${line}\n`));
      const afterEvents = feed(
        adapter,
        framer,
        `${flavour.textLine("after-the-noise")}\n`,
      );

      assertRawOnly(ansiEvents, "ANSI noise");
      assert.ok(
        String(rawPayload(ansiEvents[0])).includes("the provider exploded"),
        "the ANSI line lost its text",
      );
      assertRawOnly(stackEvents, "stack trace");
      assert.ok(
        String(rawPayload(stackEvents[0])).includes("Error: boom"),
        "the stack trace lost its text",
      );
      // The line behind the noise is not lost.
      assert.deepEqual(textOf(afterEvents), ["after-the-noise"]);
    },
  },
  {
    name: "valid JSON of the wrong type stays raw",
    run(flavour) {
      const adapter = flavour.create();
      const framer = new LineFramer();

      const wrongTypes = ["[1,2,3]", "42", "null", '"a string"', "true"];
      const events = wrongTypes.flatMap((line) => feed(adapter, framer, `${line}\n`));
      const afterEvents = feed(
        adapter,
        framer,
        `${flavour.textLine("after-the-wrong-types")}\n`,
      );

      assert.equal(events.length, wrongTypes.length);
      for (const [index, event] of events.entries()) {
        assertRawOnly([event], `wrong type ${wrongTypes[index]}`);
        assert.deepEqual(
          rawPayload(event),
          JSON.parse(wrongTypes[index]),
          `wrong type ${wrongTypes[index]}: the payload was not kept verbatim`,
        );
      }
      // The line behind them is not lost.
      assert.deepEqual(textOf(afterEvents), ["after-the-wrong-types"]);
    },
  },
  {
    name: "an unknown event type is not lost",
    run(flavour) {
      const adapter = flavour.create();
      const framer = new LineFramer();

      const line = flavour.unknownLine();
      const events = feed(adapter, framer, `${line}\n`);
      const afterEvents = feed(
        adapter,
        framer,
        `${flavour.textLine("after-the-unknown-event")}\n`,
      );

      // The unknown line is kept verbatim ...
      assertRawOnly(events, "unknown event");
      assert.deepEqual(
        rawPayload(events[0]),
        JSON.parse(line),
        "the unknown event lost its payload",
      );
      // ... and the line behind it is not lost.
      assert.deepEqual(textOf(afterEvents), ["after-the-unknown-event"]);
    },
  },
  {
    name: "text with CJK, emoji and RTL is forwarded intact",
    run(flavour) {
      const adapter = flavour.create();
      const text = "你好世界 🌍 مرحبا بالعالم";
      const events = parseSafely(adapter, flavour.textLine(text), "unicode text");

      assert.deepEqual(textOf(events), [text]);
      assert.ok(
        !textOf(events).join("").includes("\ufffd"),
        "the text was mangled on the way",
      );
    },
  },
  {
    name: "a multi-byte character split across two chunks survives",
    run(flavour) {
      const adapter = flavour.create();
      const framer = new LineFramer();

      const text = "a\u{1F30D}b";
      const bytes = Buffer.from(`${flavour.textLine(text)}\n`, "utf8");
      const emoji = Buffer.from("\u{1F30D}", "utf8");
      const offset = bytes.indexOf(emoji);
      assert.ok(offset > 0, "the emoji is not part of the line");

      // The first chunk ends in the middle of the four byte character.
      const first = feed(adapter, framer, bytes.subarray(0, offset + 1));
      const second = feed(adapter, framer, bytes.subarray(offset + 1));

      assert.deepEqual(first, [], "the incomplete line was parsed too early");
      assert.deepEqual(textOf(second), [text]);
      assert.ok(
        !textOf(second).join("").includes("\ufffd"),
        "the split character was replaced",
      );
    },
  },
  {
    name: "invalid UTF-8 bytes do not throw",
    run(flavour) {
      const adapter = flavour.create();
      const framer = new LineFramer();

      const bytes = Buffer.concat([
        Buffer.from([0xff, 0xfe, 0x00, 0x01]),
        Buffer.from("\n", "utf8"),
      ]);
      const events = feed(adapter, framer, bytes);
      const afterEvents = feed(
        adapter,
        framer,
        `${flavour.textLine("after-the-invalid-bytes")}\n`,
      );

      // The bytes cannot be parsed, but they do not break the stream either.
      assertRawOnly(events, "invalid UTF-8");
      assert.deepEqual(textOf(afterEvents), ["after-the-invalid-bytes"]);
    },
  },
  {
    name: "a 1 MiB text delta is forwarded without loss",
    run(flavour) {
      const adapter = flavour.create();
      const big = "x".repeat(1024 * 1024);

      const started = process.hrtime.bigint();
      const events = parseSafely(adapter, flavour.textLine(big), "1 MiB delta");
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

      // The delta may be delivered in one piece or in chunks, but no
      // character may get lost on the way.
      const text = textOf(events).join("");
      assert.equal(text.length, big.length, "the 1 MiB delta lost characters");
      assert.equal(text, big, "the 1 MiB delta was changed");
      assert.ok(
        elapsedMs < 1000,
        `the 1 MiB delta took ${elapsedMs.toFixed(1)} ms`,
      );
    },
  },
];

/* --------------------------------------------------------------------- tests */

for (const flavour of FLAVOURS) {
  for (const scenario of SCENARIOS) {
    test(`${flavour.name}: ${scenario.name}`, () => {
      scenario.run(flavour);
    });
  }
}

test("the suite covers every adapter flavour with every scenario", () => {
  assert.ok(FLAVOURS.length >= 4, "fewer than four adapter flavours are covered");
  assert.ok(
    SCENARIOS.length >= 6,
    "fewer than six hostile shapes are covered",
  );
  assert.ok(
    FLAVOURS.length * SCENARIOS.length >= 24,
    "the suite has fewer than 24 cases",
  );
});
