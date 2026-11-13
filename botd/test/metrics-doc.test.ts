// Acceptance test for botd/METRICS.md.
//
// The metrics document has to stay in sync with the implementation: every
// metric name the registry exports has to be in the catalog of the
// document with the type the registry reports, the default buckets have to
// be listed exactly as they are, and every example line of the document
// has to be a valid line of the Prometheus text exposition format.
//
// The metrics below are synthetic: the labels, the observations and the
// role names are made up, no real host, session or credential shows up.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as metricsModule from "../src/metrics.ts";
import {
  DEFAULT_BUCKETS,
  metricsSnapshot,
  prometheusText,
  recordCancelEscalation,
  recordEvent,
  recordEventLatency,
  recordReconnect,
  recordSessionEnded,
  recordSessionStarted,
  resetDefaultMetrics,
} from "../src/metrics.ts";
import type { MetricType } from "../src/metrics.ts";

/** Directory of this file. */
const here = dirname(fileURLToPath(import.meta.url));

/** The document under test. */
const doc = readFileSync(join(here, "..", "METRICS.md"), "utf8");
const docLines = doc.replace(/\n$/, "").split("\n");

/** The source of the registry. */
const source = readFileSync(join(here, "..", "src", "metrics.ts"), "utf8");

/** The exported constants of the registry, as a plain record. */
const exported = metricsModule as unknown as Record<string, unknown>;

/** The names of the exported constants of the registry. */
const constantNames = [...source.matchAll(/export const ([A-Z_]+) = "(botd_[a-z_]+)"/g)].map(
  (match) => match[1] as string,
);

/** The rows of the markdown tables of the document. */
function tableRows(): string[][] {
  const rows: string[][] = [];
  for (const line of docLines) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.every((cell) => cell.length > 0 && /^-+$/.test(cell))) continue; // the separator
    rows.push(cells);
  }
  return rows;
}

/** The rows of the metric catalog: the name, the type and the example. */
function catalogRows(): { name: string; type: string; example: string }[] {
  const rows = tableRows();
  const header = rows.find((row) => row[0] === "name");
  assert.ok(header, "the catalog table has no header");
  const exampleColumn = (header as string[]).indexOf("example Prometheus line");
  assert.ok(exampleColumn > 0, "the catalog table has no example column");
  return rows
    .filter((row) => /^`botd_[a-z_]+`$/.test(row[0] ?? ""))
    .map((row) => ({
      name: (row[0] as string).replace(/`/g, ""),
      type: row[1] ?? "",
      example: (row[exampleColumn] ?? "").replace(/`/g, ""),
    }));
}

/** The lines of the fenced blocks of the document with the given info string. */
function fencedBlocks(info: string): string[] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of docLines) {
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      if (current) {
        blocks.push(current);
        current = null;
      } else if (fence[1] === info) {
        current = [];
      }
      continue;
    }
    if (current) current.push(line);
  }
  if (current) blocks.push(current);
  return blocks.flat();
}

/** One sample of the Prometheus text exposition format. */
interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** The parsed exposition: the samples, the help and the type per family. */
interface Exposition {
  samples: Sample[];
  help: Map<string, string>;
  types: Map<string, string>;
}

/** Unescape the value of a label. */
function unescape(text: string): string {
  return text.replace(/\\(.)/g, (_, char: string) => {
    if (char === "n") return "\n";
    return char;
  });
}

/** Parse the labels of a sample: `a="1",b="2"`. */
function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let rest = text.trim();
  while (rest.length > 0) {
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/.exec(rest);
    assert.ok(match, `cannot parse the labels ${JSON.stringify(text)}`);
    labels[match[1] as string] = unescape(match[2] as string);
    rest = rest.slice(match[0].length).trim();
    if (rest.length === 0) break;
    assert.equal(rest[0], ",", `the labels ${JSON.stringify(text)} are not separated by commas`);
    rest = rest.slice(1).trim();
  }
  return labels;
}

/** Parse the value of a sample. */
function parseValue(text: string): number {
  if (text === "+Inf") return Number.POSITIVE_INFINITY;
  if (text === "-Inf") return Number.NEGATIVE_INFINITY;
  if (text === "NaN") return Number.NaN;
  const value = Number(text);
  assert.ok(Number.isFinite(value), `cannot parse the value ${JSON.stringify(text)}`);
  return value;
}

/** Parse a text of the Prometheus exposition format. */
function parseExposition(text: string): Exposition {
  const samples: Sample[] = [];
  const help = new Map<string, string>();
  const types = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      const helpLine = /^# HELP (\S+) (.*)$/.exec(line);
      if (helpLine) {
        help.set(helpLine[1] as string, helpLine[2] as string);
        continue;
      }
      const typeLine = /^# TYPE (\S+) (\S+)$/.exec(line);
      if (typeLine) {
        types.set(typeLine[1] as string, typeLine[2] as string);
        continue;
      }
      continue; // a plain comment
    }
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\{(.*)\})?[ \t]+(\S+)$/.exec(line);
    assert.ok(match, `cannot parse the sample ${JSON.stringify(raw)}`);
    const name = match[1] as string;
    const labels = match[2] === undefined ? {} : parseLabels(match[2] as string);
    samples.push({ name, labels, value: parseValue(match[3] as string) });
  }
  return { samples, help, types };
}

/** The family of a sample: a histogram series ends in _bucket, _sum or _count. */
function familyOf(name: string): string {
  return name.replace(/_(bucket|sum|count)$/, "");
}

/** The type the registry reports for a metric name. */
function registryTypes(): Map<string, MetricType> {
  resetDefaultMetrics();
  recordSessionStarted({ role: "planner" });
  recordSessionEnded({ role: "planner" });
  recordEvent({ role: "planner" });
  recordReconnect({ role: "planner" });
  recordCancelEscalation({ role: "planner" });
  recordEventLatency(0.12, { role: "planner" });

  const types = new Map<string, MetricType>();
  for (const metric of metricsSnapshot().metrics) {
    // A family has one type, however many label sets it holds.
    assert.equal(
      types.get(metric.name) ?? metric.type,
      metric.type,
      `two types for the metric ${metric.name}`,
    );
    types.set(metric.name, metric.type);
  }
  resetDefaultMetrics();
  return types;
}

test("every exported metric name constant is documented", () => {
  assert.ok(constantNames.length >= 6, `only ${constantNames.length} exported metric names`);
  const rows = catalogRows();
  const documented = rows.map((row) => row.name);

  for (const constant of constantNames) {
    const name = exported[constant];
    assert.equal(typeof name, "string", `the constant ${constant} is not a metric name`);
    assert.ok(
      documented.includes(name as string),
      `the metric ${String(name)} of ${constant} is not in the catalog of botd/METRICS.md`,
    );
    assert.ok(doc.includes(constant), `the document does not mention the constant ${constant}`);
  }

  // The document may not invent a metric the registry does not know.
  for (const row of documented) {
    assert.ok(
      constantNames.some((constant) => exported[constant] === row),
      `the catalog documents the metric ${row}, which the registry does not export`,
    );
  }
});

test("the catalog types match the types the registry reports", () => {
  const types = registryTypes();
  const exposition = parseExposition(prometheusText());

  for (const row of catalogRows()) {
    assert.equal(types.get(row.name), row.type, `the type of ${row.name} drifted`);
    assert.equal(
      exposition.types.get(row.name),
      row.type,
      `the exposition of ${row.name} does not report the documented type`,
    );
  }
});

test("the document lists the exact default buckets", () => {
  // The buckets are compared without the spaces, the document may wrap them.
  const flat = doc.replace(/\s+/g, "");
  const buckets = JSON.stringify([...DEFAULT_BUCKETS]);
  assert.ok(
    flat.includes(buckets.replace(/\s+/g, "")),
    `the document does not list the buckets ${buckets}`,
  );

  // The histogram of the latency uses its own buckets, they are documented too.
  resetDefaultMetrics();
  recordEventLatency(0.12, { role: "planner" });
  const histogram = metricsSnapshot().metrics.find(
    (metric) => metric.name === "botd_event_latency_seconds" && metric.type === "histogram",
  );
  assert.ok(histogram && histogram.type === "histogram");
  const bounds = JSON.stringify(histogram.buckets.map((bucket) => bucket.le));
  assert.ok(
    flat.includes(bounds.replace(/\s+/g, "")),
    `the document does not list the buckets ${bounds}`,
  );
  resetDefaultMetrics();
});

test("every example line of the catalog is a valid exposition line", () => {
  const rows = catalogRows();
  assert.ok(rows.length >= 6, `the catalog holds only ${rows.length} metrics`);

  // The bucket of a histogram example has to be one of the buckets of the family.
  resetDefaultMetrics();
  recordEventLatency(0.12, { role: "planner" });
  const histogram = metricsSnapshot().metrics.find((metric) => metric.type === "histogram");
  assert.ok(histogram && histogram.type === "histogram");
  const bounds = histogram.buckets.map((bucket) => bucket.le);
  resetDefaultMetrics();

  for (const row of rows) {
    const exposition = parseExposition(row.example);
    assert.equal(exposition.samples.length, 1, `the example of ${row.name} is not one sample`);
    const sample = exposition.samples[0] as Sample;
    assert.equal(
      familyOf(sample.name),
      row.name,
      `the example of ${row.name} names the metric ${sample.name}`,
    );
    assert.ok(Number.isFinite(sample.value), `the example of ${row.name} has no value`);
    const le = sample.labels.le;
    if (le !== undefined) {
      assert.ok(
        le === "+Inf" || bounds.includes(Number(le)),
        `the example of ${row.name} uses the bucket ${le}, which the family does not know`,
      );
    }
  }
});

test("the exposition example of the document matches the implementation", () => {
  const lines = fencedBlocks("prometheus").filter((line) => line.trim().length > 0);
  assert.ok(lines.length >= 5, `the exposition example holds only ${lines.length} lines`);

  resetDefaultMetrics();
  recordEvent({ role: "planner" });
  recordEventLatency(0.12, { role: "planner" });
  const rendered = prometheusText().split("\n");
  resetDefaultMetrics();

  for (const line of lines) {
    parseExposition(line); // the parser has to accept every line of the example
    assert.ok(
      rendered.includes(line.trim()),
      `the line ${JSON.stringify(line)} is not part of the exposition of the registry`,
    );
  }
});

test("the document names the exported functions of the registry", () => {
  for (const name of [
    "defaultMetrics",
    "resetDefaultMetrics",
    "metricsSnapshot",
    "prometheusText",
    "recordSessionStarted",
    "recordSessionEnded",
    "recordEvent",
    "recordReconnect",
    "recordCancelEscalation",
    "recordEventLatency",
    "DEFAULT_BUCKETS",
  ]) {
    assert.ok(doc.includes(name), `the document does not mention ${name}`);
  }
});

test("the document names no host and no address", () => {
  assert.ok(!/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(doc), "the document holds an IP address");
  assert.ok(!/localhost/i.test(doc), "the document names a host");
  assert.ok(
    !/\b[a-z0-9-]+\.(?:com|net|org|io|dev|example)\b/i.test(doc),
    "the document names a host",
  );
});
