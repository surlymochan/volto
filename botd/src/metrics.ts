// volto-botd metrics.
//
// A tiny, dependency free, in-process metrics registry.  It keeps counters,
// gauges and histograms with fixed buckets, hands out a JSON snapshot and
// renders the Prometheus text exposition format.
//
// The registry is meant to be cheap enough to be called on a hot path -- every
// started session, every forwarded event, every reconnect and every cancel
// escalation -- and it stays completely inside the process: there is no
// server, no network traffic and no background task.
//
// A series is identified by the metric name plus its label set.  Label keys
// are sorted before a series is looked up, so `{a: "1", b: "2"}` and
// `{b: "2", a: "1"}` describe the same series.
//
// An explicitly registered family also creates its base series, so a freshly
// registered counter already reports 0 instead of silently disappearing from
// the exposition.  An observation that carries labels adds a further series
// to the same family; the base series keeps its own value.
//
// The four families botd cares about (sessions, events, reconnects and cancel
// escalations) are pre-registered on the process wide registry; see
// {@link defaultMetrics} and the `record*` helpers below.

/** Kind of a metric family. */
export type MetricType = "counter" | "gauge" | "histogram";

/** Label set of a series. Numbers are coerced to strings. */
export type Labels = Record<string, string | number>;

/** Label set of a series as it is stored and rendered (always strings). */
export type LabelSet = Record<string, string>;

/** Options used when a metric family is registered. */
export interface MetricOptions {
  /** Description shown in the Prometheus exposition. */
  help?: string;
  /** Labels every series of the family carries. */
  labels?: Labels;
  /** Upper bounds of the histogram buckets (ascending, finite). */
  buckets?: number[];
}

/** Options of a {@link MetricsRegistry}. */
export interface MetricsRegistryOptions {
  /** Clock used to stamp snapshots. Defaults to `Date.now`. */
  now?: () => number;
}

/** A counter series. */
export interface CounterSnapshot {
  type: "counter";
  name: string;
  help: string;
  labels: LabelSet;
  /** Current value of the counter. */
  value: number;
}

/** A gauge series. */
export interface GaugeSnapshot {
  type: "gauge";
  name: string;
  help: string;
  labels: LabelSet;
  /** Current value of the gauge. */
  value: number;
}

/** Cumulative count of one histogram bucket. */
export interface HistogramBucketSnapshot {
  /** Upper bound of the bucket. */
  le: number;
  /** Observations in this bucket and in every smaller one. */
  count: number;
}

/** A histogram series. */
export interface HistogramSnapshot {
  type: "histogram";
  name: string;
  help: string;
  labels: LabelSet;
  /** Cumulative counts of the configured finite buckets, ascending. */
  buckets: HistogramBucketSnapshot[];
  /** Total number of observations (the `+Inf` bucket). */
  count: number;
  /** Sum of all observed values. */
  sum: number;
}

/** One series of a snapshot. */
export type MetricSnapshot = CounterSnapshot | GaugeSnapshot | HistogramSnapshot;

/** A point in time view of every series of a registry. */
export interface MetricsSnapshot {
  /** Milliseconds since the epoch, taken when the snapshot was made. */
  takenAt: number;
  /** Every series, ordered by metric name and label set. */
  metrics: MetricSnapshot[];
}

/** Handle of a counter family. */
export interface CounterHandle {
  /** Name of the metric family. */
  readonly name: string;
  /** Increase the counter. The value must be finite and non-negative. */
  inc(value?: number, labels?: Labels): void;
  /** Current value of the series. */
  get(labels?: Labels): number;
}

/** Handle of a gauge family. */
export interface GaugeHandle {
  /** Name of the metric family. */
  readonly name: string;
  /** Set the gauge to an absolute value. */
  set(value: number, labels?: Labels): void;
  /** Increase the gauge (the value may be negative). */
  inc(value?: number, labels?: Labels): void;
  /** Decrease the gauge. */
  dec(value?: number, labels?: Labels): void;
  /** Current value of the series. */
  get(labels?: Labels): number;
}

/** Handle of a histogram family. */
export interface HistogramHandle {
  /** Name of the metric family. */
  readonly name: string;
  /** Record one observation. The value must be finite. */
  observe(value: number, labels?: Labels): void;
  /** Current state of the series, null when it does not exist yet. */
  get(labels?: Labels): HistogramSnapshot | null;
}

/** Bucket bounds used when a histogram does not name its own. */
export const DEFAULT_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Metric names Prometheus accepts. */
const METRIC_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** Label names Prometheus accepts. */
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** One series of a family. */
interface Series {
  /** Labels of the series, sorted by key. */
  labels: LabelSet;
  /** Value of a counter or a gauge. */
  value: number;
  /** Cumulative counts of the finite buckets of a histogram. */
  counts: number[];
  /** Number of observations of a histogram. */
  count: number;
  /** Sum of the observations of a histogram. */
  sum: number;
}

/** One metric family: a name, a kind and the series it holds. */
class Family {
  readonly name: string;
  readonly type: MetricType;
  /** Description of the family, empty when none was given. */
  help: string;
  /** Upper bounds of the histogram buckets, ascending. */
  readonly buckets: number[];
  /** Labels every series of the family carries. */
  readonly staticLabels: LabelSet;
  readonly series = new Map<string, Series>();

  constructor(
    name: string,
    type: MetricType,
    help: string,
    buckets: number[],
    staticLabels: LabelSet,
  ) {
    this.name = name;
    this.type = type;
    this.help = help;
    this.buckets = buckets;
    this.staticLabels = staticLabels;
  }
}

/** Validate a metric name and return it. */
function checkMetricName(name: string): string {
  if (typeof name !== "string" || !METRIC_NAME.test(name)) {
    throw new Error(`invalid metric name: ${String(name)}`);
  }
  return name;
}

/** Validate the label names and coerce the values to strings. */
function normalizeLabels(labels: Labels | undefined): LabelSet {
  const out: LabelSet = {};
  if (!labels) return out;
  for (const [key, value] of Object.entries(labels)) {
    if (!LABEL_NAME.test(key)) throw new Error(`invalid label name: ${key}`);
    if (value === null || value === undefined) {
      throw new Error(`label ${key} has no value`);
    }
    out[key] = String(value);
  }
  return out;
}

/** Key of a series: its labels, sorted by label name. */
function seriesKey(labels: LabelSet): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${JSON.stringify(labels[key])}`)
    .join(",");
}

/** Labels of a series, sorted by label name. */
function sortedLabels(labels: LabelSet): LabelSet {
  const out: LabelSet = {};
  for (const key of Object.keys(labels).sort()) out[key] = labels[key] as string;
  return out;
}

/** Check and copy the bucket bounds of a histogram. */
function normalizeBuckets(buckets: readonly number[]): number[] {
  const out: number[] = [];
  for (const bound of buckets) {
    if (typeof bound !== "number" || !Number.isFinite(bound)) {
      throw new Error("histogram buckets must be finite numbers");
    }
    if (out.length > 0 && bound <= out[out.length - 1] as number) {
      throw new Error("histogram buckets must be sorted in ascending order");
    }
    out.push(bound);
  }
  return out;
}

/** True when two bucket lists hold the same bounds. */
function sameBuckets(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((bound, index) => bound === b[index]);
}

/** A fresh, empty series. */
function newSeries(labels: LabelSet, buckets: readonly number[]): Series {
  return {
    labels: sortedLabels(labels),
    value: 0,
    counts: buckets.map(() => 0),
    count: 0,
    sum: 0,
  };
}

/** Format a number the way the Prometheus text format wants it. */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

/** Format a bucket bound for the `le` label. */
function formatBound(bound: number): string {
  return bound === Number.POSITIVE_INFINITY ? "+Inf" : formatValue(bound);
}

/** Escape a label value for the Prometheus text format. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** Render a label set, with an optional trailing label. */
function renderLabels(labels: LabelSet, last?: { name: string; value: string }): string {
  const parts: string[] = [];
  for (const key of Object.keys(labels)) {
    parts.push(`${key}="${escapeLabelValue(labels[key] as string)}"`);
  }
  if (last) parts.push(`${last.name}="${escapeLabelValue(last.value)}"`);
  if (parts.length === 0) return "";
  return `{${parts.join(",")}}`;
}

/**
 * An in-process metrics registry.
 *
 * The registry keeps counters, gauges and histograms.  Every family is
 * registered once, either up front (with the help text and the bucket bounds
 * it should use) or implicitly by the first observation.
 */
export class MetricsRegistry {
  readonly #families = new Map<string, Family>();
  readonly #now: () => number;

  constructor(options: MetricsRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** Register (or fetch) a counter family. */
  counter(name: string, options: MetricOptions = {}): CounterHandle {
    const family = this.#family(name, "counter", options);
    return {
      name: family.name,
      inc: (value = 1, labels?: Labels): void => {
        this.#add(family, value, labels);
      },
      get: (labels?: Labels): number => this.#read(family, labels),
    };
  }

  /** Register (or fetch) a gauge family. */
  gauge(name: string, options: MetricOptions = {}): GaugeHandle {
    const family = this.#family(name, "gauge", options);
    return {
      name: family.name,
      set: (value: number, labels?: Labels): void => {
        this.#set(family, value, labels);
      },
      inc: (value = 1, labels?: Labels): void => {
        this.#set(family, this.#read(family, labels) + value, labels);
      },
      dec: (value = 1, labels?: Labels): void => {
        this.#set(family, this.#read(family, labels) - value, labels);
      },
      get: (labels?: Labels): number => this.#read(family, labels),
    };
  }

  /** Register (or fetch) a histogram family. */
  histogram(name: string, options: MetricOptions = {}): HistogramHandle {
    const family = this.#family(name, "histogram", options);
    return {
      name: family.name,
      observe: (value: number, labels?: Labels): void => {
        this.#observe(family, value, labels);
      },
      get: (labels?: Labels): HistogramSnapshot | null => this.#histogram(family, labels),
    };
  }

  /** Increase a counter, registering it when it is unknown. */
  inc(name: string, value = 1, labels?: Labels): void {
    this.#add(this.#family(name, "counter", {}, false), value, labels);
  }

  /** Set a gauge, registering it when it is unknown. */
  set(name: string, value: number, labels?: Labels): void {
    this.#set(this.#family(name, "gauge", {}, false), value, labels);
  }

  /** Change a gauge by a delta, registering it when it is unknown. */
  adjust(name: string, delta: number, labels?: Labels): void {
    const family = this.#family(name, "gauge", {}, false);
    this.#set(family, this.#read(family, labels) + delta, labels);
  }

  /** Record a histogram observation, registering the family when unknown. */
  observe(name: string, value: number, labels?: Labels): void {
    this.#observe(this.#family(name, "histogram", {}, false), value, labels);
  }

  /** Current value of a counter or a gauge, 0 when it is unknown. */
  value(name: string, labels?: Labels): number {
    const family = this.#families.get(name);
    if (!family) return 0;
    return this.#read(family, labels);
  }

  /** Current state of a histogram series, null when it is unknown. */
  histogramState(name: string, labels?: Labels): HistogramSnapshot | null {
    const family = this.#families.get(name);
    if (!family) return null;
    return this.#histogram(family, labels);
  }

  /** A point in time view of every series of the registry. */
  snapshot(): MetricsSnapshot {
    const metrics: MetricSnapshot[] = [];
    for (const family of this.#sortedFamilies()) {
      for (const series of this.#sortedSeries(family)) {
        if (family.type === "histogram") {
          metrics.push({
            type: "histogram",
            name: family.name,
            help: family.help,
            labels: series.labels,
            buckets: family.buckets.map((le, index) => ({ le, count: series.counts[index] as number })),
            count: series.count,
            sum: series.sum,
          });
        } else {
          metrics.push({
            type: family.type,
            name: family.name,
            help: family.help,
            labels: series.labels,
            value: series.value,
          });
        }
      }
    }
    return { takenAt: this.#now(), metrics };
  }

  /** Render the registry in the Prometheus text exposition format. */
  renderPrometheus(): string {
    const lines: string[] = [];
    for (const family of this.#sortedFamilies()) {
      const series = this.#sortedSeries(family);
      if (series.length === 0) continue;
      if (family.help.length > 0) {
        lines.push(`# HELP ${family.name} ${family.help.replace(/[\r\n]+/g, " ")}`);
      }
      lines.push(`# TYPE ${family.name} ${family.type}`);
      for (const entry of series) {
        if (family.type === "histogram") {
          for (let index = 0; index < family.buckets.length; index += 1) {
            const bound = family.buckets[index] as number;
            const le = { name: "le", value: formatBound(bound) };
            lines.push(
              `${family.name}_bucket${renderLabels(entry.labels, le)} ${entry.counts[index] as number}`,
            );
          }
          const inf = { name: "le", value: "+Inf" };
          lines.push(`${family.name}_bucket${renderLabels(entry.labels, inf)} ${entry.count}`);
          lines.push(`${family.name}_sum${renderLabels(entry.labels)} ${formatValue(entry.sum)}`);
          lines.push(`${family.name}_count${renderLabels(entry.labels)} ${entry.count}`);
        } else {
          lines.push(`${family.name}${renderLabels(entry.labels)} ${formatValue(entry.value)}`);
        }
      }
    }
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  }

  /** Drop every family and series of the registry. */
  reset(): void {
    this.#families.clear();
  }

  /** Names of the registered families, sorted. */
  families(): string[] {
    return this.#sortedFamilies().map((family) => family.name);
  }

  /**
   * Fetch or create a family.
   *
   * An explicit registration (through `counter`, `gauge` or `histogram`)
   * creates the base series of the family, so a registered family shows up in
   * the exposition right away.  A family that is only implied by an
   * observation stays invisible until it has one.
   */
  #family(name: string, type: MetricType, options: MetricOptions, explicit = true): Family {
    checkMetricName(name);
    const existing = this.#families.get(name);
    if (existing) {
      if (existing.type !== type) {
        throw new Error(`metric ${name} is already registered as a ${existing.type}`);
      }
      if (type === "histogram" && options.buckets !== undefined) {
        const buckets = normalizeBuckets(options.buckets);
        if (!sameBuckets(buckets, existing.buckets)) {
          throw new Error(`metric ${name} is already registered with other buckets`);
        }
      }
      if (existing.help.length === 0 && options.help) existing.help = options.help;
      return existing;
    }
    const buckets = type === "histogram" ? normalizeBuckets(options.buckets ?? DEFAULT_BUCKETS) : [];
    const family = new Family(name, type, options.help ?? "", buckets, normalizeLabels(options.labels));
    this.#families.set(name, family);
    if (explicit) {
      family.series.set(seriesKey(family.staticLabels), newSeries(family.staticLabels, buckets));
    }
    return family;
  }

  /** Resolve the series of a family, creating it when needed. */
  #series(family: Family, labels?: Labels): Series {
    const merged = { ...family.staticLabels, ...normalizeLabels(labels) };
    const key = seriesKey(merged);
    const existing = family.series.get(key);
    if (existing) return existing;
    const series = newSeries(merged, family.buckets);
    family.series.set(key, series);
    return series;
  }

  /** Increase a counter. */
  #add(family: Family, value: number, labels?: Labels): void {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`counter ${family.name} only counts finite, non-negative values`);
    }
    this.#series(family, labels).value += value;
  }

  /** Set a gauge. */
  #set(family: Family, value: number, labels?: Labels): void {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`gauge ${family.name} needs a finite value`);
    }
    this.#series(family, labels).value = value;
  }

  /** Record a histogram observation. */
  #observe(family: Family, value: number, labels?: Labels): void {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`histogram ${family.name} needs a finite observation`);
    }
    const series = this.#series(family, labels);
    for (let index = 0; index < family.buckets.length; index += 1) {
      if (value <= (family.buckets[index] as number)) series.counts[index] = (series.counts[index] as number) + 1;
    }
    series.count += 1;
    series.sum += value;
  }

  /** Read the value of a counter or a gauge. */
  #read(family: Family, labels?: Labels): number {
    if (family.type === "histogram") {
      const state = this.#histogram(family, labels);
      return state ? state.count : 0;
    }
    const merged = { ...family.staticLabels, ...normalizeLabels(labels) };
    const series = family.series.get(seriesKey(merged));
    return series ? series.value : 0;
  }

  /** Read the state of a histogram series. */
  #histogram(family: Family, labels?: Labels): HistogramSnapshot | null {
    const merged = { ...family.staticLabels, ...normalizeLabels(labels) };
    const series = family.series.get(seriesKey(merged));
    if (!series) return null;
    return {
      type: "histogram",
      name: family.name,
      help: family.help,
      labels: series.labels,
      buckets: family.buckets.map((le, index) => ({ le, count: series.counts[index] as number })),
      count: series.count,
      sum: series.sum,
    };
  }

  /** Families of the registry, ordered by name. */
  #sortedFamilies(): Family[] {
    return [...this.#families.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Series of a family, ordered by label set. */
  #sortedSeries(family: Family): Series[] {
    return [...family.series.values()].sort((a, b) => {
      const left = seriesKey(a.labels);
      const right = seriesKey(b.labels);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }
}

/** Sessions started since the process started. */
export const SESSIONS_TOTAL = "botd_sessions_total";
/** Sessions currently running. */
export const SESSIONS_ACTIVE = "botd_sessions_active";
/** Events forwarded since the process started. */
export const EVENTS_TOTAL = "botd_events_total";
/** Reconnects since the process started. */
export const RECONNECTS_TOTAL = "botd_reconnects_total";
/** Cancels that had to be escalated since the process started. */
export const CANCEL_ESCALATIONS_TOTAL = "botd_cancel_escalations_total";
/** Time spent handling one event, in seconds. */
export const EVENT_LATENCY_SECONDS = "botd_event_latency_seconds";

let shared: MetricsRegistry | null = null;

/**
 * The process wide registry with the botd families registered.
 *
 * The families are: started and running sessions, forwarded events,
 * reconnects, cancel escalations and the latency of one event.
 */
export function defaultMetrics(): MetricsRegistry {
  if (!shared) {
    const registry = new MetricsRegistry();
    registry.counter(SESSIONS_TOTAL, { help: "Bot sessions started since the process started." });
    registry.gauge(SESSIONS_ACTIVE, { help: "Bot sessions currently running." });
    registry.counter(EVENTS_TOTAL, { help: "Bot events forwarded since the process started." });
    registry.counter(RECONNECTS_TOTAL, { help: "Bot reconnects since the process started." });
    registry.counter(CANCEL_ESCALATIONS_TOTAL, { help: "Cancels escalated since the process started." });
    registry.histogram(EVENT_LATENCY_SECONDS, {
      help: "Time spent handling one bot event.",
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30],
    });
    shared = registry;
  }
  return shared;
}

/** Drop the process wide registry (the next call builds a fresh one). */
export function resetDefaultMetrics(): void {
  shared = null;
}

/** Record a started session. */
export function recordSessionStarted(labels?: Labels): void {
  const registry = defaultMetrics();
  registry.inc(SESSIONS_TOTAL, 1, labels);
  registry.adjust(SESSIONS_ACTIVE, 1, labels);
}

/** Record a session that ended. */
export function recordSessionEnded(labels?: Labels): void {
  defaultMetrics().adjust(SESSIONS_ACTIVE, -1, labels);
}

/** Record a forwarded event. */
export function recordEvent(labels?: Labels): void {
  defaultMetrics().inc(EVENTS_TOTAL, 1, labels);
}

/** Record a reconnect. */
export function recordReconnect(labels?: Labels): void {
  defaultMetrics().inc(RECONNECTS_TOTAL, 1, labels);
}

/** Record a cancel that had to be escalated. */
export function recordCancelEscalation(labels?: Labels): void {
  defaultMetrics().inc(CANCEL_ESCALATIONS_TOTAL, 1, labels);
}

/** Record how long the handling of one event took. */
export function recordEventLatency(seconds: number, labels?: Labels): void {
  defaultMetrics().observe(EVENT_LATENCY_SECONDS, seconds, labels);
}

/** A snapshot of the process wide registry. */
export function metricsSnapshot(): MetricsSnapshot {
  return defaultMetrics().snapshot();
}

/** The process wide registry in the Prometheus text exposition format. */
export function prometheusText(): string {
  return defaultMetrics().renderPrometheus();
}
