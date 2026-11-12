import assert from "node:assert/strict";
import test from "node:test";

import { createRedactor, redactText } from "../lib/redact.mjs";

// All fixtures are synthetic: the addresses come from the documentation
// ranges (RFC 5737 / RFC 2606) and the credentials are made up strings.

test("redacts api keys, tokens and jwt like values", () => {
  const redactor = createRedactor({ worktree: "/work", home: "/home/agent" });
  assert.equal(redactor.text("key sk-ant-EXAMPLEEXAMPLEEXAMPLE"), "key <redacted-key>");
  assert.equal(redactor.text("token ghp_EXAMPLEEXAMPLEEXAMPLE"), "token <redacted-token>");
  assert.equal(redactor.text("Authorization: Bearer EXAMPLEEXAMPLE"), "Authorization: Bearer <redacted-token>");
  assert.equal(
    redactor.text("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJFWFBTEUifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
    "<redacted-token>",
  );
});

test("redacts secret looking json fields", () => {
  const redactor = createRedactor();
  const value = redactor.value({ apiKey: "synthetic-secret-value", model: "test-model" });
  assert.equal(value.apiKey, "<redacted>");
  assert.equal(value.model, "test-model");
});

test("redacts ip addresses, urls and host names", () => {
  const redactor = createRedactor();
  assert.equal(redactor.text("listening on 192.0.2.10:8080"), "listening on <ip>:8080");
  assert.equal(redactor.text("http://198.51.100.7:18765/v1"), "http://<host>:18765/v1");
  assert.equal(redactor.text("server build-box.invalid"), "server <host>");
});

test("keeps clock times intact", () => {
  const redactor = createRedactor();
  assert.equal(redactor.text("2026-11-12 17:48:37 UTC"), "2026-11-12 17:48:37 UTC");
});

test("replaces the work tree and home paths", () => {
  const redactor = createRedactor({ worktree: "/srv/volto", home: "/home/agent" });
  assert.equal(redactor.text("/srv/volto/probes/out/x.jsonl"), "<worktree>/probes/out/x.jsonl");
  assert.equal(redactor.text("/home/agent/.codex/auth.json"), "$HOME/.codex/auth.json");
});

test("redacts identity like fields", () => {
  const redactor = createRedactor();
  const value = redactor.value({ serverName: "builder-01", installationId: "abc", model: "m" });
  assert.equal(value.serverName, "<redacted>");
  assert.equal(value.installationId, "<redacted>");
  assert.equal(value.model, "m");
});

test("redactText helper works on plain strings", () => {
  assert.equal(redactText("nothing to hide"), "nothing to hide");
});
