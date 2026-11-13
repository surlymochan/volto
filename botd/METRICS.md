# botd metrics

`botd` keeps its metrics in a small, dependency free, in-process registry
([src/metrics.ts](src/metrics.ts)). The registry holds counters, gauges and
histograms, hands out a JSON snapshot and renders the Prometheus text
exposition format. Everything stays inside the process: there is no server,
no network traffic and no background task.

This document describes the families the registry pre-registers, the buckets
of the histogram, how to read the snapshot and how to print the exposition.
The registry is filled through the exported helpers (`recordSessionStarted()`
and friends), so every process that calls them sees the numbers below. The
daemon does not call them yet, see
[RUNBOOK](RUNBOOK.md#metrics-and-orchestration) and
[TROUBLESHOOTING](TROUBLESHOOTING.md).

* [The metric catalog](#the-metric-catalog)
* [The buckets of the histogram](#the-buckets-of-the-histogram)
* [Reading the snapshot](#reading-the-snapshot)
* [Printing the exposition](#printing-the-exposition)
* [A scrape example](#a-scrape-example)

## The metric catalog

| name | type | labels | unit | emitted when | example Prometheus line |
| --- | --- | --- | --- | --- | --- |
| `botd_sessions_total` | counter | none | sessions | a session starts (`recordSessionStarted()`) | `botd_sessions_total 3` |
| `botd_sessions_active` | gauge | none | sessions | a session starts (`recordSessionStarted()`) and ends (`recordSessionEnded()`) | `botd_sessions_active 1` |
| `botd_events_total` | counter | none | events | an event is forwarded (`recordEvent()`) | `botd_events_total 12` |
| `botd_reconnects_total` | counter | none | reconnects | a reconnect happens (`recordReconnect()`) | `botd_reconnects_total 2` |
| `botd_cancel_escalations_total` | counter | none | escalations | a cancel is escalated (`recordCancelEscalation()`) | `botd_cancel_escalations_total 1` |
| `botd_event_latency_seconds` | histogram | none | seconds | the handling of one event is timed (`recordEventLatency(seconds)`) | `botd_event_latency_seconds_bucket{le="0.1"} 4` |

* The counters only grow and start at 0; they are gone when the process
  restarts. The gauge goes up and down: it holds the sessions that run
  right now, so it returns to 0 once every session ended.
* No family carries a fixed label. The `record*` helpers take an optional
  label set (for example `{ role: "planner" }`); the registry keys a series
  by its labels, sorted by name, so every distinct label set becomes its own
  series of the family and the family keeps its own base series.
* The names of the metrics and of the labels are validated against the
  Prometheus rules (`[a-zA-Z_][a-zA-Z0-9_]*`); an invalid name throws
  instead of producing a broken exposition.
* The values of the example column are examples: the last column shows the
  shape of one line of the exposition, not the output of a real run.
* Every name is exported as a constant as well (`SESSIONS_TOTAL`,
  `SESSIONS_ACTIVE`, `EVENTS_TOTAL`, `RECONNECTS_TOTAL`,
  `CANCEL_ESCALATIONS_TOTAL`, `EVENT_LATENCY_SECONDS`), so a caller does
  not have to spell the name out.

## The buckets of the histogram

* `botd_event_latency_seconds` is registered with the buckets
  `[0.01, 0.05, 0.1, 0.5, 1, 5, 30]` (seconds).
* A histogram that does not name its own buckets falls back to
  `DEFAULT_BUCKETS`, the buckets of the Prometheus client library:
  `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` (seconds).
* The buckets are cumulative: the count of a bucket holds the observations
  of that bucket and of every smaller one. The exposition adds the `+Inf`
  bucket, which holds every observation, next to the `_sum` (the sum of the
  observed values) and the `_count` (the number of observations) of the
  series.

## Reading the snapshot

`metricsSnapshot()` returns a point in time view of the registry:

```json
{
  "takenAt": 1700000000000,
  "metrics": [
    {
      "type": "histogram",
      "name": "botd_event_latency_seconds",
      "help": "Time spent handling one bot event.",
      "labels": { "role": "planner" },
      "buckets": [{ "le": 0.01, "count": 0 }, { "le": 0.05, "count": 0 }],
      "count": 1,
      "sum": 0.12
    }
  ]
}
```

* `takenAt` is the millisecond timestamp of the snapshot.
* `metrics` holds one entry per series, sorted by metric name and label
  set. A family with several label sets shows up several times.
* A counter or a gauge entry carries `type`, `name`, `help`, `labels` and
  `value`.
* A histogram entry carries `type`, `name`, `help`, `labels`, `buckets`
  (the cumulative counts of the configured buckets), `count` (the number of
  observations) and `sum` (the sum of the observed values).
* The snapshot is plain JSON: it survives a `JSON.stringify()` /
  `JSON.parse()` round trip without a change.

## Printing the exposition

`prometheusText()` renders the registry in the Prometheus text exposition
format:

* one `# HELP` line per family (the description it was registered with) and
  one `# TYPE` line with the type of the family (`counter`, `gauge` or
  `histogram`);
* one line per series; a histogram expands into one `_bucket` line per
  bucket (the `le` label comes last), one `_sum` line and one `_count`
  line;
* the families are sorted by name, the series of a family by label set.

## A scrape example

There is no HTTP endpoint: a scrape is a process that calls
`prometheusText()` and hands the result to the collector. From the root of
the repository:

```sh
node --input-type=module -e '
  import { recordEvent, recordEventLatency, prometheusText } from "./botd/src/metrics.ts";
  recordEvent({ role: "planner" });
  recordEventLatency(0.12, { role: "planner" });
  process.stdout.write(prometheusText());
'
```

The exposition of that run holds one `# HELP` and one `# TYPE` line per
family, the base series of every family (a registered family reports 0
instead of disappearing) and the series the helpers filled. The excerpt
below shows the two families the example touched:

```prometheus
# HELP botd_event_latency_seconds Time spent handling one bot event.
# TYPE botd_event_latency_seconds histogram
botd_event_latency_seconds_bucket{role="planner",le="0.01"} 0
botd_event_latency_seconds_bucket{role="planner",le="0.05"} 0
botd_event_latency_seconds_bucket{role="planner",le="0.1"} 0
botd_event_latency_seconds_bucket{role="planner",le="0.5"} 1
botd_event_latency_seconds_bucket{role="planner",le="1"} 1
botd_event_latency_seconds_bucket{role="planner",le="5"} 1
botd_event_latency_seconds_bucket{role="planner",le="30"} 1
botd_event_latency_seconds_bucket{role="planner",le="+Inf"} 1
botd_event_latency_seconds_sum{role="planner"} 0.12
botd_event_latency_seconds_count{role="planner"} 1
# HELP botd_events_total Bot events forwarded since the process started.
# TYPE botd_events_total counter
botd_events_total{role="planner"} 1
```

The same numbers are available as JSON, for a collector that reads a file
instead of a stream:

```sh
node --input-type=module -e '
  import { metricsSnapshot } from "./botd/src/metrics.ts";
  console.log(JSON.stringify(metricsSnapshot(), null, 2));
'
```

`defaultMetrics()` returns the process wide registry behind both calls and
`resetDefaultMetrics()` drops it, so that the next call builds a fresh one
with the families registered again and every counter at 0.
