import assert from "node:assert/strict";
import test from "node:test";

import { renderReport } from "../lib/report.mjs";
import { createResult } from "../lib/result.mjs";
import { createRedactor } from "../lib/redact.mjs";

/**
 * @param {Partial<import("../lib/result.mjs").ProbeResult>} overrides
 */
function sample(overrides = {}) {
  const result = createResult({ id: "sample", label: "Sample", command: "sample" });
  result.status = "ok";
  result.auth.state = "logged-in";
  result.protocol.name = "JSON-RPC";
  result.protocol.transport = "stdio";
  result.protocol.framing = "newline-delimited JSON";
  result.protocol.sessionCreate.supported = true;
  result.protocol.sessionCreate.method = "session/new";
  result.protocol.streaming.granularity = "token-delta";
  result.protocol.cancel.works = true;
  result.protocol.cancel.method = "abort";
  result.protocol.resume.supported = true;
  result.protocol.resume.method = "switch_session";
  result.protocol.permissions.shape = "shape";
  result.methods.requests = ["initialize", "session/new"];
  result.methods.notifications = ["session/update"];
  return { ...result, ...overrides };
}

test("the report contains one row per bot with the required columns", () => {
  const markdown = renderReport({
    results: [sample(), sample({ id: "other", label: "Other" })],
    generatedAt: "2026-01-01 00:00:00 UTC",
    timeoutMs: 120_000,
    prompt: "Reply with the single word PONG",
    redactor: createRedactor(),
  });

  const header = markdown.split("\n").find((line) => line.startsWith("| bot |"));
  assert.ok(header, "the summary table header is missing");
  for (const column of [
    "status",
    "protocol",
    "session create",
    "streaming granularity",
    "cancel works?",
    "resume / load",
    "permission request shape",
    "auth state",
  ]) {
    assert.ok(header.includes(column), `the summary table is missing the column ${column}`);
  }

  const rows = markdown.split("\n").filter((line) => line.startsWith("| Sample |") || line.startsWith("| Other |"));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes("token-delta"));
  assert.ok(rows[0].includes("logged-in"));
});

test("the report redacts host names and ips", () => {
  const markdown = renderReport({
    results: [sample({ notes: ["connected to 192.0.2.55 and build-box.invalid"] })],
    generatedAt: "2026-01-01 00:00:00 UTC",
    timeoutMs: 120_000,
    prompt: "PONG",
    redactor: createRedactor(),
  });
  assert.ok(!markdown.includes("192.0.2.55"));
  assert.ok(!markdown.includes("build-box.invalid"));
});
