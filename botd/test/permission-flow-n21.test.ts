// The botd permission flow, end to end.
//
//   register : the provider raises a permission request. The adapter keeps it
//              under its id and reports a normalized "permission" event.
//   decide   : botd/src/permission.ts reduces the raw request to the facts a
//              policy needs and answers "allow" | "deny" | "ask".
//   answer   : the decision travels back to the adapter, which turns it into
//              the provider-native answer for that id.
//
// botd/src/permission.ts is a pure decision function: it holds no request
// registry, no promise and no clock, so the "registered" request of this flow
// lives in the adapter (one adapter instance per session) and the answer is
// the decision the policy produced. Nothing in the flow can time out, so no
// timer is injected anywhere in this file.
//
// Fixtures are synthetic: session directories, tool names, commands and
// provider session ids are made up, never real hosts, addresses, credentials
// or user data.

import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";

import * as permission from "../src/permission.ts";
import { decide, normalizeRequest, referencePolicy } from "../src/permission.ts";
import type { PermissionPolicy } from "../src/permission.ts";
import { DshAdapter } from "../src/adapters/dsh.ts";
import type { NormalizedEvent } from "../src/adapter-types.ts";

// --- fixtures ---------------------------------------------------------------

/** Working directory of the first session. */
const SESSION_ALPHA = "/srv/volto/session-alpha";
/** Working directory of the second session. */
const SESSION_BETA = "/srv/volto/session-beta";
/** Provider session id of the synthetic agent. */
const PROVIDER_SESSION = "sess_synthetic_0001";

/** The policy of the first session. */
const alphaPolicy = referencePolicy(SESSION_ALPHA);
/** The policy of the second session. */
const betaPolicy = referencePolicy(SESSION_BETA);
/** A policy that denies everything it does not explicitly allow. */
const denyAll: PermissionPolicy = { cwd: SESSION_ALPHA, default: "deny" };

/** The environment this file runs with: explicit and synthetic. */
const EXPLICIT_ENV: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  HOME: "/tmp/volto-permission-flow-n21",
  LANG: "C",
  NODE_ENV: "test",
  VOLTO_TEST_CASE: "permission-flow-n21",
};

/**
 * Replace the inherited environment with the explicit one and restore the
 * inherited values when the test ends.
 */
function scrubEnv(t: TestContext): void {
  const inherited = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(EXPLICIT_ENV)) process.env[key] = value;
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, value] of Object.entries(inherited)) process.env[key] = value;
  });
}

/** The normalized permission event of a provider request, or a loud failure. */
function permissionEvent(event: NormalizedEvent): Extract<NormalizedEvent, { kind: "permission" }> {
  if (event.kind !== "permission") {
    throw new Error(`expected a permission event, got ${event.kind}`);
  }
  return event;
}

/** The ACP permission request of the synthetic agent, with the given options. */
function permissionLine(options: unknown[]): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "session/request_permission",
    params: {
      sessionId: PROVIDER_SESSION,
      toolCall: {
        toolCallId: "call_synthetic_0003",
        title: "Run command",
        kind: "execute",
      },
      options,
    },
  });
}

/** The options of the synthetic agent: grant once, or reject once. */
const AGENT_OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

/** The options of a second agent that answers the same way but names it differently. */
const OTHER_AGENT_OPTIONS = [
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject-always", name: "Reject always", kind: "reject_always" },
];

// --- the decision: botd/src/permission.ts -----------------------------------

test("a registered request the policy allows answers allow, and the answer does not change", (t) => {
  scrubEnv(t);

  const facts = normalizeRequest({
    kind: "permission",
    id: "perm-flow-allow-0001",
    request: { tool: "Read", paths: ["notes.md"] },
  });
  assert.deepEqual(facts, { tool: "Read", paths: ["notes.md"], command: undefined });

  const first = decide(facts, alphaPolicy);
  const second = decide(facts, alphaPolicy);
  assert.equal(first, "allow");
  assert.equal(second, "allow");

  // Mutation: the same request under a policy that denies by default.
  assert.equal(decide(facts, denyAll), "deny");
});

test("a registered request the policy denies answers deny", (t) => {
  scrubEnv(t);

  const facts = normalizeRequest({
    kind: "permission",
    id: "perm-flow-deny-0001",
    request: { tool: "Bash", command: "sudo systemctl stop volto-agent" },
  });
  assert.equal(facts.tool, "Bash");
  assert.equal(facts.command, "sudo systemctl stop volto-agent");

  assert.equal(decide(facts, alphaPolicy), "deny");

  // Mutation: without the hard deny list the very same request asks.
  assert.equal(decide(facts, { cwd: SESSION_ALPHA }), "ask");
});

test("a request that reaches outside the session answers deny", (t) => {
  scrubEnv(t);

  const outside = normalizeRequest({
    kind: "permission",
    id: "perm-flow-outside-0001",
    request: { tool: "Write", paths: [`${SESSION_ALPHA}/../shared/notes.md`] },
  });
  assert.deepEqual(outside.paths, [`${SESSION_ALPHA}/../shared/notes.md`]);
  assert.equal(decide(outside, alphaPolicy), "deny");

  // Mutation: the same write inside the session is not a hard deny.
  const inside = normalizeRequest({
    kind: "permission",
    id: "perm-flow-outside-0001",
    request: { tool: "Write", paths: [`${SESSION_ALPHA}/notes.md`] },
  });
  assert.equal(decide(inside, alphaPolicy), "ask");
});

test("a second answer to the same request repeats the answer and leaves the request untouched", (t) => {
  scrubEnv(t);

  // The pending request, as the control plane holds it.
  const request = { tool: "Read", paths: ["notes.md"] };
  const snapshot = structuredClone(request);
  const facts = normalizeRequest({ kind: "permission", id: "perm-flow-repeat-0001", request });
  const factsSnapshot = structuredClone(facts);

  const first = decide(request, alphaPolicy);
  // Another request is answered in between.
  const other = decide(
    normalizeRequest({ kind: "permission", id: "perm-flow-repeat-0002", request: { tool: "Write", paths: ["notes.md"] } }),
    alphaPolicy,
  );
  const second = decide(request, alphaPolicy);

  assert.equal(first, "allow");
  assert.equal(other, "ask");
  assert.equal(second, "allow");
  // Neither the request that was answered nor its facts were touched.
  assert.deepEqual(request, snapshot);
  assert.deepEqual(facts, factsSnapshot);
});

test("an unknown permission id is ignored and the request falls back to the default", (t) => {
  scrubEnv(t);

  const unknown = normalizeRequest({
    kind: "permission",
    id: "perm-flow-unregistered-0001",
    request: { tool: "MysteryTool" },
  });
  assert.deepEqual(unknown, { tool: "MysteryTool", paths: [], command: undefined });
  // The id is not part of the decision: it never reaches the facts.
  assert.deepEqual(Object.keys(unknown), ["tool", "paths", "command"]);
  assert.equal(decide(unknown, alphaPolicy), "ask");

  // The id is not part of the decision: another unknown id answers the same.
  const otherId = normalizeRequest({
    kind: "permission",
    id: "perm-flow-unregistered-0002",
    request: { tool: "MysteryTool" },
  });
  assert.equal(decide(otherId, alphaPolicy), "ask");

  // Mutation: a policy that denies by default turns the same request into deny.
  assert.equal(decide(unknown, denyAll), "deny");
});

test("the same permission id in two sessions is decided by the policy of that session", (t) => {
  scrubEnv(t);

  const facts = normalizeRequest({
    kind: "permission",
    id: "perm-flow-shared-0001",
    request: { tool: "Read", paths: [`${SESSION_ALPHA}/notes.md`] },
  });
  assert.deepEqual(facts.paths, [`${SESSION_ALPHA}/notes.md`]);

  assert.equal(decide(facts, alphaPolicy), "allow");
  assert.equal(decide(facts, betaPolicy), "deny");

  // Answering in the first session leaves the answer of the second one alone.
  decide(facts, alphaPolicy);
  assert.equal(decide(facts, betaPolicy), "deny");
});

test("the permission module has no clock, so a permission request cannot time out", (t) => {
  scrubEnv(t);

  // The public surface of the module: a decision function, a normalizer and
  // two helpers. There is no timer, no clock and no request registry, so the
  // timeout case of the flow cannot be covered here.
  assert.deepEqual(Object.keys(permission).sort(), [
    "decide",
    "normalizeRequest",
    "pathScope",
    "referencePolicy",
  ]);
});

// --- the answer: the adapter keeps the pending request ----------------------

test("a registered permission answered allow resolves once", (t) => {
  scrubEnv(t);

  const adapter = new DshAdapter();
  const events = adapter.parse(permissionLine(AGENT_OPTIONS));
  assert.equal(events.length, 1);
  const event = permissionEvent(events[0]);
  assert.equal(event.id, "2");
  const id = event.id;

  const facts = normalizeRequest(event.request);
  assert.deepEqual(facts, { tool: "execute", paths: [], command: undefined });

  const decision = decide(facts, { cwd: SESSION_ALPHA, rules: [{ tool: "execute", decision: "allow" }] });
  assert.equal(decision, "allow");

  const answer = adapter.answerPermission(id, decision === "allow");
  assert.deepEqual(answer, {
    jsonrpc: "2.0",
    id: 2,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });

  // The answer resolves exactly once: a second answer finds nothing pending.
  assert.equal(adapter.answerPermission(id, true), null);

  // Mutation: the same request under a policy that denies is a different decision.
  assert.equal(decide(facts, { cwd: SESSION_ALPHA, rules: [{ tool: "execute", decision: "deny" }] }), "deny");
});

test("a registered permission answered deny resolves once", (t) => {
  scrubEnv(t);

  const adapter = new DshAdapter();
  const events = adapter.parse(permissionLine(AGENT_OPTIONS));
  const event = permissionEvent(events[0]);
  const id = event.id;
  assert.equal(id, "2");

  const facts = normalizeRequest(event.request);
  const decision = decide(facts, { cwd: SESSION_ALPHA, rules: [{ tool: "execute", decision: "deny" }] });
  assert.equal(decision, "deny");

  const answer = adapter.answerPermission(id, decision === "allow");
  assert.deepEqual(answer, {
    jsonrpc: "2.0",
    id: 2,
    result: { outcome: { outcome: "selected", optionId: "reject-once" } },
  });

  // The answer resolves exactly once: a second answer finds nothing pending.
  assert.equal(adapter.answerPermission(id, false), null);

  // Mutation: the same request under a policy that allows is a different decision.
  assert.equal(decide(facts, { cwd: SESSION_ALPHA, rules: [{ tool: "execute", decision: "allow" }] }), "allow");
});

test("an unknown id is answered with nothing and leaves the pending request unchanged", (t) => {
  scrubEnv(t);

  const adapter = new DshAdapter();
  const events = adapter.parse(permissionLine(AGENT_OPTIONS));
  const event = permissionEvent(events[0]);
  const id = event.id;
  assert.equal(id, "2");

  // The wrong id answers nothing at all.
  assert.equal(adapter.answerPermission("perm-flow-unregistered-0001", true), null);

  // The pending request is untouched: it is still answerable with its own id.
  const answer = adapter.answerPermission(id, true);
  assert.deepEqual(answer, {
    jsonrpc: "2.0",
    id: 2,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });

  // Mutation: the answered request is gone now, so the same id answers nothing.
  assert.equal(adapter.answerPermission(id, true), null);
});

test("the same permission id in two sessions does not collide", (t) => {
  scrubEnv(t);

  const alpha = new DshAdapter();
  const beta = new DshAdapter();
  const alphaId = permissionEvent(alpha.parse(permissionLine(AGENT_OPTIONS))[0]).id;
  const betaId = permissionEvent(beta.parse(permissionLine(OTHER_AGENT_OPTIONS))[0]).id;
  assert.equal(alphaId, "2");
  assert.equal(betaId, "2");

  // Answering in the first session leaves the second session pending.
  assert.deepEqual(alpha.answerPermission(alphaId, true), {
    jsonrpc: "2.0",
    id: 2,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });
  assert.equal(alpha.answerPermission(alphaId, true), null);

  // The second session answers with its own option, not with the one of the
  // first session.
  assert.deepEqual(beta.answerPermission(betaId, true), {
    jsonrpc: "2.0",
    id: 2,
    result: { outcome: { outcome: "selected", optionId: "allow-always" } },
  });
});

test("a request the policy does not decide stays pending until a human answers", (t) => {
  scrubEnv(t);

  const adapter = new DshAdapter();
  const events = adapter.parse(permissionLine(AGENT_OPTIONS));
  const event = permissionEvent(events[0]);
  const id = event.id;

  const facts = normalizeRequest(event.request);
  const decision = decide(facts, { cwd: SESSION_ALPHA, rules: [{ tool: "Read*", decision: "allow" }] });
  assert.equal(decision, "ask");

  // "ask" is not an answer: the request is still pending.
  const answer = adapter.answerPermission(id, false);
  assert.deepEqual(answer, {
    jsonrpc: "2.0",
    id: 2,
    result: { outcome: { outcome: "selected", optionId: "reject-once" } },
  });

  // Mutation: the very same request is decided when a rule matches it.
  assert.equal(decide(facts, { cwd: SESSION_ALPHA, rules: [{ tool: "execute", decision: "allow" }] }), "allow");
});
