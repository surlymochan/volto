import assert from "node:assert/strict";
import test from "node:test";

import { createResult, markNotProbed } from "../lib/result.mjs";

const meta = { id: "sample", label: "Sample", command: "sample" };

test("createResult initializes the result fields", () => {
  assert.deepEqual(createResult(meta), {
    id: "sample",
    label: "Sample",
    status: "failed",
    binary: { command: "sample", available: false },
    auth: { state: "unknown", evidence: "not probed" },
    protocol: {
      name: "unknown",
      transport: "unknown",
      framing: "unknown",
      sessionCreate: { supported: null, method: "", detail: "" },
      streaming: { granularity: "unknown", detail: "", samples: 0 },
      cancel: { works: null, method: "", detail: "" },
      resume: { supported: null, method: "", detail: "" },
      permissions: { shape: "unknown", observed: [] },
    },
    timings: {
      initializeMs: null,
      sessionCreateMs: null,
      firstOutputMs: null,
      promptMs: null,
      cancelMs: null,
      totalMs: null,
    },
    methods: { requests: [], notifications: [], serverRequests: [] },
    notes: [],
    transcript: "",
  });
});

// DEFECT: markNotProbed does not set the status to skipped.
test.todo("markNotProbed sets the status to skipped");

for (const [description, reason] of [
  ["default", undefined],
  ["custom", "not probed (synthetic reason)"],
]) {
  test(`markNotProbed records the ${description} reason and preserves metadata`, () => {
    const result = createResult(meta);
    result.protocol.sessionCreate.supported = true;
    result.protocol.streaming.granularity = "token";
    result.protocol.cancel.works = true;
    result.protocol.resume.supported = true;
    result.auth.state = "known";
    markNotProbed(result, reason);
    const expected = reason ?? "not probed (binary missing)";
    assert.deepEqual(result.protocol.sessionCreate, { supported: null, method: "", detail: expected });
    assert.deepEqual(result.protocol.streaming, { granularity: "unknown", detail: expected, samples: 0 });
    assert.deepEqual(result.protocol.cancel, { works: null, method: "", detail: expected });
    assert.deepEqual(result.protocol.resume, { supported: null, method: "", detail: expected });
    assert.deepEqual(result.auth, { state: "unknown", evidence: expected });
    assert.equal(result.id, meta.id);
    assert.equal(result.label, meta.label);
    assert.deepEqual(result.binary, { command: meta.command, available: false });
  });
}

test("createResult does not share arrays between results", () => {
  const first = createResult(meta);
  const second = createResult(meta);
  first.notes.push("sample");
  first.methods.requests.push("sample");
  first.methods.notifications.push("sample");
  first.methods.serverRequests.push("sample");
  first.protocol.permissions.observed.push("sample");
  assert.deepEqual(second.notes, []);
  assert.deepEqual(second.methods, { requests: [], notifications: [], serverRequests: [] });
  assert.deepEqual(second.protocol.permissions.observed, []);
});
