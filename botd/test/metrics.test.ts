// Tests for the volto-botd metrics registry.
//
// The registry keeps counters, gauges and histograms with fixed buckets and
// renders them in the Prometheus text exposition format.  Everything below is
// synthetic: metric names, label values and observations are made up, no real
// host, session or credential shows up here.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANCEL_ESCALATIONS_TOTAL,
  DEFAULT_BUCKETS,
  EVENTS_TOTAL,
  EVENT_LATENCY_SECONDS,
  MetricsRegistry,
  RECONNECTS_TOTAL,
  SESSIONS_ACTIVE,
  SESSIONS_TOTAL,
  defaultMetrics,
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
import type { MetricSnapshot, MetricsSnapshot } from "../src/metrics.ts";

/** Find one series of a snapshot by name and its exact label set. */
function seriesOf(snapshot: MetricsSnapshot, name: string, labels: Record<string, string> = {}): MetricSnapshot {
  const found = snapshot.metrics.find(
    (metric) =>
      metric.name === name &&
      Object.keys(metric.labels).length === Object.keys(labels).length &&
      Object.entries(labels).every(([key, value]) => metric.labels[key] === value),
  );
  assert.ok(found, `no series ${name} with labels ${JSON.stringify(labels)}`);
  return found;
}

/** The lines of a Prometheus exposition, without the trailing newline. */
function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

test("a counter counts up and starts at zero", () => {
  const registry = new MetricsRegistry();
  const sessions = registry.counter("botd_sessions_total", { help: "Sessions started." });

  assert.equal(sessions.get(), 0);

  sessions.inc();
  sessions.inc(2);
  assert.equal(sessions.get(), 3);

  sessions.inc(4);
  assert.equal(sessions.get(), 7);
});

test("counters keep one series per label set", () => {
  const registry = new MetricsRegistry();
  registry.inc("botd_events_total", 1, { role: "planner" });
  registry.inc("botd_events_total", 2, { role: "reviewer" });
  registry.inc("botd_events_total", 3, { role: "planner" });

  const snapshot = registry.snapshot();
  assert.equal(snapshot.metrics.length, 2);
  assert.equal(seriesOf(snapshot, "botd_events_total", { role: "planner" }).value, 4);
  assert.equal(seriesOf(snapshot, "botd_events_total", { role: "reviewer" }).value, 2);
});

test("label order does not create a second series", () => {
  const registry = new MetricsRegistry();
  registry.inc("botd_events_total", 1, { role: "planner", host: "alpha" });
  registry.inc("botd_events_total", 1, { host: "alpha", role: "planner" });

  const snapshot = registry.snapshot();
  const labelled = snapshot.metrics.filter((metric) => metric.labels.role === "planner");
  assert.equal(labelled.length, 1);
  assert.equal(labelled[0]?.value, 2);
});

test("label values are coerced to strings", () => {
  const registry = new MetricsRegistry();
  registry.inc("botd_events_total", 1, { attempt: 2 });

  const snapshot = registry.snapshot();
  const series = seriesOf(snapshot, "botd_events_total", { attempt: "2" });
  assert.equal(series.value, 1);
});

test("counters refuse negative and non-finite values", () => {
  const registry = new MetricsRegistry();
  assert.throws(() => registry.inc("botd_events_total", -1), /non-negative/);
  assert.throws(() => registry.inc("botd_events_total", Number.NaN), /finite/);
  assert.throws(() => registry.inc("botd_events_total", Number.POSITIVE_INFINITY), /finite/);
});

test("gauges hold, increase and decrease", () => {
  const registry = new MetricsRegistry();
  const active = registry.gauge("botd_sessions_active", { help: "Running sessions." });

  active.set(4);
  assert.equal(active.get(), 4);

  active.inc();
  assert.equal(active.get(), 5);

  active.dec(2);
  assert.equal(active.get(), 3);

  // A gauge may go negative, a counter may not.
  active.set(-1);
  assert.equal(active.get(), -1);
  assert.throws(() => registry.set("botd_sessions_active", Number.NaN), /finite/);
});

test("histograms count observations in cumulative buckets", () => {
  const registry = new MetricsRegistry();
  const latency = registry.histogram("botd_event_latency_seconds", {
    buckets: [0.1, 0.5, 1],
  });

  latency.observe(0.05);
  latency.observe(0.4);
  latency.observe(0.75);
  latency.observe(5);

  const state = latency.get();
  assert.ok(state);
  assert.equal(state.count, 4);
  assert.equal(state.sum, 6.2);
  assert.deepEqual(
    state.buckets.map((bucket) => bucket.count),
    [1, 2, 3],
  );
  assert.deepEqual(
    state.buckets.map((bucket) => bucket.le),
    [0.1, 0.5, 1],
  );
});

test("a histogram observation above every bound only lands in the infinity bucket", () => {
  const registry = new MetricsRegistry();
  const latency = registry.histogram("botd_event_latency_seconds", { buckets: [1, 2] });

  latency.observe(9);

  const state = latency.get();
  assert.ok(state);
  assert.equal(state.count, 1);
  assert.deepEqual(
    state.buckets.map((bucket) => bucket.count),
    [0, 0],
  );
});

test("histograms need finite observations", () => {
  const registry = new MetricsRegistry();
  assert.throws(() => registry.observe("botd_event_latency_seconds", Number.NaN), /finite/);
  assert.throws(() => registry.observe("botd_event_latency_seconds", Number.POSITIVE_INFINITY), /finite/);
});

test("a snapshot holds every series and survives a JSON round trip", () => {
  const registry = new MetricsRegistry({ now: () => 1700000000000 });
  registry.inc("botd_sessions_total", 2, { role: "planner" });
  registry.set("botd_sessions_active", 1);
  registry.observe("botd_event_latency_seconds", 0.25, { role: "planner" });

  const snapshot = registry.snapshot();
  assert.equal(snapshot.takenAt, 1700000000000);
  assert.equal(snapshot.metrics.length, 3);

  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);

  const counter = seriesOf(snapshot, "botd_sessions_total", { role: "planner" });
  assert.equal(counter.type, "counter");
  assert.equal(counter.value, 2);

  const gauge = seriesOf(snapshot, "botd_sessions_active");
  assert.equal(gauge.type, "gauge");
  assert.equal(gauge.value, 1);

  const histogram = seriesOf(snapshot, "botd_event_latency_seconds", { role: "planner" });
  assert.equal(histogram.type, "histogram");
  assert.equal(histogram.count, 1);
  assert.equal(histogram.sum, 0.25);
});

test("the Prometheus text carries help, type and one line per series", () => {
  const registry = new MetricsRegistry();
  registry.counter("botd_sessions_total", { help: "Sessions started." });
  registry.inc("botd_sessions_total", 3);
  registry.inc("botd_sessions_total", 1, { role: "planner" });

  assert.equal(
    registry.renderPrometheus(),
    [
      "# HELP botd_sessions_total Sessions started.",
      "# TYPE botd_sessions_total counter",
      "botd_sessions_total 3",
      'botd_sessions_total{role="planner"} 1',
      "",
    ].join("\n"),
  );
});

test("the Prometheus text escapes label values", () => {
  const registry = new MetricsRegistry();
  registry.inc("botd_events_total", 1, { note: 'a"b\\c\nd' });

  const text = registry.renderPrometheus();
  assert.ok(text.includes('botd_events_total{note="a\\"b\\\\c\\nd"} 1'));
  // One sample per line: the escaped newline does not break the format.
  assert.equal(lines(text).length, 2);
});

test("the Prometheus text of a histogram carries buckets, sum and count", () => {
  const registry = new MetricsRegistry();
  registry.histogram("botd_event_latency_seconds", {
    help: "Time spent on one event.",
    buckets: [0.5, 1, 30],
  });
  registry.observe("botd_event_latency_seconds", 0.25);
  registry.observe("botd_event_latency_seconds", 2);

  assert.equal(
    registry.renderPrometheus(),
    [
      "# HELP botd_event_latency_seconds Time spent on one event.",
      "# TYPE botd_event_latency_seconds histogram",
      'botd_event_latency_seconds_bucket{le="0.5"} 1',
      'botd_event_latency_seconds_bucket{le="1"} 1',
      'botd_event_latency_seconds_bucket{le="30"} 2',
      'botd_event_latency_seconds_bucket{le="+Inf"} 2',
      "botd_event_latency_seconds_sum 2.25",
      "botd_event_latency_seconds_count 2",
      "",
    ].join("\n"),
  );
});

test("the Prometheus text keeps the le label last", () => {
  const registry = new MetricsRegistry();
  registry.histogram("botd_event_latency_seconds", { buckets: [1] });
  registry.observe("botd_event_latency_seconds", 0.5, { role: "planner" });

  assert.ok(
    registry
      .renderPrometheus()
      .includes('botd_event_latency_seconds_bucket{role="planner",le="1"} 1'),
  );
});

test("the Prometheus text is ordered by metric name and label set", () => {
  const registry = new MetricsRegistry();
  registry.inc("botd_events_total", 1, { role: "reviewer" });
  registry.inc("botd_events_total", 1, { role: "planner" });
  registry.inc("botd_sessions_total", 1);

  assert.deepEqual(lines(registry.renderPrometheus()), [
    "# TYPE botd_events_total counter",
    'botd_events_total{role="planner"} 1',
    'botd_events_total{role="reviewer"} 1',
    "# TYPE botd_sessions_total counter",
    "botd_sessions_total 1",
  ]);
});

test("metric and label names are validated", () => {
  const registry = new MetricsRegistry();
  assert.throws(() => registry.counter("botd-sessions"), /invalid metric name/);
  assert.throws(() => registry.counter("1botd_sessions"), /invalid metric name/);
  assert.throws(() => registry.inc("botd_events_total", 1, { "bad-label": "x" }), /invalid label name/);
  assert.throws(() => registry.inc("botd_events_total", 1, { role: undefined }), /no value/);
});

test("a metric name cannot change its kind", () => {
  const registry = new MetricsRegistry();
  registry.counter("botd_sessions_total");
  assert.throws(() => registry.gauge("botd_sessions_total"), /already registered/);
  assert.throws(() => registry.histogram("botd_sessions_total"), /already registered/);
  // Registering the same family again is fine.
  registry.counter("botd_sessions_total");
  assert.deepEqual(registry.families(), ["botd_sessions_total"]);
});

test("a histogram cannot change its buckets", () => {
  const registry = new MetricsRegistry();
  registry.histogram("botd_event_latency_seconds", { buckets: [1, 2] });
  assert.throws(
    () => registry.histogram("botd_event_latency_seconds", { buckets: [1, 3] }),
    /other buckets/,
  );
  registry.histogram("botd_event_latency_seconds", { buckets: [1, 2] });
});

test("histogram buckets must be finite and ascending", () => {
  const registry = new MetricsRegistry();
  assert.throws(() => registry.histogram("botd_a", { buckets: [1, 0.5] }), /ascending/);
  assert.throws(() => registry.histogram("botd_b", { buckets: [1, 1] }), /ascending/);
  assert.throws(() => registry.histogram("botd_c", { buckets: [Number.POSITIVE_INFINITY] }), /finite/);
});

test("the default buckets are the Prometheus ones", () => {
  assert.deepEqual([...DEFAULT_BUCKETS], [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
});

test("the process wide registry tracks sessions, events, reconnects and escalations", () => {
  resetDefaultMetrics();

  recordSessionStarted({ role: "planner" });
  recordSessionStarted({ role: "planner" });
  recordSessionEnded({ role: "planner" });
  recordEvent({ role: "planner" });
  recordReconnect({ role: "planner" });
  recordCancelEscalation({ role: "planner" });
  recordEventLatency(0.25, { role: "planner" });

  const snapshot = metricsSnapshot();
  assert.equal(seriesOf(snapshot, SESSIONS_TOTAL, { role: "planner" }).value, 2);
  assert.equal(seriesOf(snapshot, SESSIONS_ACTIVE, { role: "planner" }).value, 1);
  assert.equal(seriesOf(snapshot, EVENTS_TOTAL, { role: "planner" }).value, 1);
  assert.equal(seriesOf(snapshot, RECONNECTS_TOTAL, { role: "planner" }).value, 1);
  assert.equal(seriesOf(snapshot, CANCEL_ESCALATIONS_TOTAL, { role: "planner" }).value, 1);

  const latency = seriesOf(snapshot, EVENT_LATENCY_SECONDS, { role: "planner" });
  assert.equal(latency.type, "histogram");
  assert.equal(latency.count, 1);

  const text = prometheusText();
  assert.ok(text.includes(`# TYPE ${SESSIONS_TOTAL} counter`));
  assert.ok(text.includes(`# TYPE ${SESSIONS_ACTIVE} gauge`));
  assert.ok(text.includes(`# TYPE ${EVENT_LATENCY_SECONDS} histogram`));

  resetDefaultMetrics();
});

test("the process wide registry is shared and can be dropped", () => {
  resetDefaultMetrics();
  const first = defaultMetrics();
  assert.equal(defaultMetrics(), first);

  recordEvent();
  assert.equal(metricsSnapshot().metrics.length > 0, true);

  resetDefaultMetrics();
  assert.notEqual(defaultMetrics(), first);
  const fresh = metricsSnapshot();
  const counters = fresh.metrics.filter((metric) => metric.type === "counter");
  assert.equal(counters.length, 4);
  assert.equal(counters.every((metric) => metric.value === 0), true);
  const gauge = fresh.metrics.find((metric) => metric.type === "gauge");
  assert.equal(gauge?.value, 0);
  const histogram = fresh.metrics.find((metric) => metric.type === "histogram");
  assert.equal(histogram?.count, 0);

  resetDefaultMetrics();
});

test("unknown metrics read as empty", () => {
  const registry = new MetricsRegistry();
  assert.equal(registry.value("botd_sessions_total"), 0);
  assert.equal(registry.histogramState("botd_event_latency_seconds"), null);

  registry.inc("botd_sessions_total", 2);
  assert.equal(registry.value("botd_sessions_total"), 2);
  assert.equal(registry.value("botd_sessions_total", { role: "planner" }), 0);
});

test("the registered families are listed in order", () => {
  const registry = new MetricsRegistry();
  registry.counter("botd_sessions_total");
  registry.gauge("botd_sessions_active");
  registry.counter("botd_events_total");

  assert.deepEqual(registry.families(), [
    "botd_events_total",
    "botd_sessions_active",
    "botd_sessions_total",
  ]);
});

test("reset drops every family", () => {
  const registry = new MetricsRegistry();
  registry.counter("botd_sessions_total");
  registry.inc("botd_sessions_total", 3);
  assert.deepEqual(registry.families(), ["botd_sessions_total"]);

  registry.reset();
  assert.deepEqual(registry.families(), []);
  assert.equal(registry.renderPrometheus(), "");
  assert.deepEqual(registry.snapshot().metrics, []);
});
