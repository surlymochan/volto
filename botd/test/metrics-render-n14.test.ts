// Tests for the rendering of the volto-botd metrics registry.
//
// The registry counts, renders the Prometheus text exposition format and hands
// out a JSON snapshot.  The cases below cover the counter handle (a zero
// increment, a fractional increment), the escaping of a label value, the empty
// exposition of a registry without families and the isolation of two
// registries.  Everything is synthetic: metric names, label values and
// observations are made up, no real host, session or credential shows up here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { EVENTS_TOTAL, MetricsRegistry, defaultMetrics, recordEvent, resetDefaultMetrics } from "../src/metrics.ts";

/** The lines of a Prometheus exposition, without the trailing newline. */
function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

/** Unescape a label value the way the Prometheus text format defines it. */
function unescapeLabelValue(text: string): string {
  return text.replace(/\\(.)/g, (_, char: string) => (char === "n" ? "\n" : char));
}

test("a zero increment leaves the counter unchanged and a fraction adds up", () => {
  const registry = new MetricsRegistry();
  const counter = registry.counter("n14_counter_total", { help: "Probe counter." });

  assert.equal(counter.get(), 0);

  counter.inc(0);
  assert.equal(counter.get(), 0);

  counter.inc(0.5);
  assert.equal(counter.get(), 0.5);

  counter.inc(0.25);
  assert.equal(counter.get(), 0.75);

  // The exposition carries the fraction as it is.
  assert.ok(registry.renderPrometheus().includes("n14_counter_total 0.75"));

  // A zero increment with a label set still adds the series of that label
  // set, with the value it starts at.
  counter.inc(0, { role: "planner" });
  assert.equal(counter.get({ role: "planner" }), 0);
  assert.equal(counter.get(), 0.75);
  assert.equal(registry.snapshot().metrics.length, 2);
});

test("a label value with a quote, a backslash and a newline is escaped in the text", () => {
  const registry = new MetricsRegistry();
  // A quote, a backslash, a newline and a literal backslash-n sequence.
  const note = 'quote " backslash \\ newline \n literal \\n end';
  registry.inc("n14_escape_total", 1, { note });

  const text = registry.renderPrometheus();
  assert.equal(
    text,
    '# TYPE n14_escape_total counter\n' +
      'n14_escape_total{note="quote \\" backslash \\\\ newline \\n literal \\\\n end"} 1\n',
  );

  // The escaped newline does not break the format: the sample stays on one line.
  assert.equal(lines(text).length, 2);
  // The raw newline of the label value never reaches the exposition.
  assert.equal(text.includes(`newline ${"\n"} literal`), false);

  // The escaped value unescapes back to the value that went in.
  const rendered = /\{note="(.*)"\} 1/.exec(text)?.[1] ?? "";
  assert.equal(unescapeLabelValue(rendered), note);
});

test("a registry without families renders the empty exposition", () => {
  const registry = new MetricsRegistry({ now: () => 1700000000000 });

  // The documented shape of the exposition is one line per family and per
  // series: a registry without families has no line at all.
  assert.equal(registry.renderPrometheus(), "");
  assert.equal(registry.renderPrometheus().length, 0);
  assert.equal(registry.renderPrometheus().includes("\n"), false);
  assert.deepEqual(registry.snapshot(), { takenAt: 1700000000000, metrics: [] });
  assert.deepEqual(registry.families(), []);

  // Rendering twice does not change the empty output.
  assert.equal(registry.renderPrometheus(), registry.renderPrometheus());

  // The documented counterpart: a registered family reports 0 instead of
  // disappearing from the exposition.
  const withFamily = new MetricsRegistry();
  withFamily.counter("n14_registered_total");
  assert.ok(withFamily.renderPrometheus().includes("n14_registered_total 0"));
});

test("two registries keep their counter state apart", () => {
  const first = new MetricsRegistry();
  const second = new MetricsRegistry();

  first.inc("n14_shared_total", 5);

  assert.equal(first.value("n14_shared_total"), 5);
  assert.equal(second.value("n14_shared_total"), 0);
  assert.equal(second.renderPrometheus(), "");

  second.inc("n14_shared_total", 2);
  assert.equal(first.value("n14_shared_total"), 5);
  assert.equal(second.value("n14_shared_total"), 2);

  // The same metric name is one series per registry, not one shared series.
  assert.equal(first.snapshot().metrics.length, 1);
  assert.equal(second.snapshot().metrics.length, 1);
});

test("the process wide registry does not leak into a fresh registry", () => {
  resetDefaultMetrics();
  recordEvent({ role: "planner" });

  const fresh = new MetricsRegistry();
  assert.equal(fresh.value(EVENTS_TOTAL), 0);
  assert.equal(fresh.value(EVENTS_TOTAL, { role: "planner" }), 0);

  // The event landed in the series of the process wide registry only.
  assert.equal(defaultMetrics().value(EVENTS_TOTAL, { role: "planner" }), 1);
  assert.equal(defaultMetrics().value(EVENTS_TOTAL), 0);

  resetDefaultMetrics();
});
