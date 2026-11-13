import { test } from "node:test";
import assert from "node:assert/strict";

import { MetricsRegistry } from "../src/metrics.ts";

test("a rejected counter increment preserves the existing series", () => {
  const counter = new MetricsRegistry().counter("edge_counter");
  counter.inc(3, { kind: "a" });
  assert.throws(() => counter.inc(-1, { kind: "a" }), /non-negative/);
  assert.equal(counter.get({ kind: "a" }), 3);
});

test("a failed type registration preserves the original family", () => {
  const registry = new MetricsRegistry();
  const gauge = registry.gauge("edge_family");
  gauge.set(4);
  assert.throws(() => registry.counter("edge_family"), /already registered/);
  assert.equal(gauge.get(), 4);
  assert.deepEqual(registry.families(), ["edge_family"]);
});

test.todo("re-registering a family with different static labels rejects the conflict", () => {
  const registry = new MetricsRegistry();
  registry.counter("edge_labels", { labels: { zone: "a" } });
  assert.throws(() => registry.counter("edge_labels", { labels: { zone: "b" } }));
});

test("escaping consecutive special characters preserves one sample line", () => {
  const registry = new MetricsRegistry();
  registry.inc("edge_escape", 1, { note: '\\"\n\\' });
  assert.equal(registry.renderPrometheus(), '# TYPE edge_escape counter\nedge_escape{note="\\\\\\"\\n\\\\"} 1\n');
});

test("label order is independent when reading a registered series", () => {
  const counter = new MetricsRegistry().counter("edge_order", { labels: { fixed: "x" } });
  counter.inc(2, { z: "last", a: "first" });
  assert.equal(counter.get({ a: "first", z: "last" }), 2);
});

test("observations equal to bounds belong to those cumulative buckets", () => {
  const histogram = new MetricsRegistry().histogram("edge_bounds", { buckets: [0, 1, 2] });
  histogram.observe(0);
  histogram.observe(1);
  histogram.observe(2);
  assert.deepEqual(histogram.get()?.buckets.map((bucket) => bucket.count), [1, 2, 3]);
});

test("the infinity bucket includes observations above the largest bound", () => {
  const registry = new MetricsRegistry();
  const histogram = registry.histogram("edge_inf", { buckets: [1] });
  histogram.observe(1);
  histogram.observe(5);
  assert.equal(registry.renderPrometheus(), [
    "# TYPE edge_inf histogram",
    'edge_inf_bucket{le="1"} 1',
    'edge_inf_bucket{le="+Inf"} 2',
    "edge_inf_sum 6",
    "edge_inf_count 2",
    "",
  ].join("\n"));
});

test("negative observations count in matching buckets and contribute to the sum", () => {
  const histogram = new MetricsRegistry().histogram("edge_negative", { buckets: [-1, 0, 1] });
  histogram.observe(-2);
  histogram.observe(-0.5);
  const state = histogram.get();
  assert.deepEqual(state?.buckets.map((bucket) => bucket.count), [1, 2, 2]);
  assert.equal(state?.count, 2);
  assert.equal(state?.sum, -2.5);
});

test("a rejected NaN observation leaves histogram state unchanged", () => {
  const histogram = new MetricsRegistry().histogram("edge_nan", { buckets: [1] });
  histogram.observe(0.5);
  const before = histogram.get();
  assert.throws(() => histogram.observe(NaN), /finite/);
  assert.deepEqual(histogram.get(), before);
});

test("a snapshot retains values and buckets after later observations", () => {
  const registry = new MetricsRegistry();
  const histogram = registry.histogram("edge_snapshot", { buckets: [1] });
  histogram.observe(0.5);
  const before = registry.snapshot();
  histogram.observe(2);
  assert.equal(before.metrics[0]?.type, "histogram");
  const state = before.metrics[0];
  assert.ok(state && state.type === "histogram");
  assert.equal(state.count, 1);
  assert.deepEqual(state.buckets, [{ le: 1, count: 1 }]);
});

test.todo("mutating snapshot labels does not alter the registry", () => {
  const registry = new MetricsRegistry();
  registry.inc("edge_copy", 1, { kind: "a" });
  registry.snapshot().metrics[0]!.labels.kind = "changed";
  assert.equal(registry.renderPrometheus(), '# TYPE edge_copy counter\nedge_copy{kind="a"} 1\n');
});

test("a new empty registry has an empty exposition and snapshot", () => {
  const registry = new MetricsRegistry({ now: () => 123 });
  assert.equal(registry.renderPrometheus(), "");
  assert.deepEqual(registry.snapshot(), { takenAt: 123, metrics: [] });
});
