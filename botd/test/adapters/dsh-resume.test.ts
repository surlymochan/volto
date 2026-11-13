import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { listAdapters } from "../../src/adapters/index.ts";
import { DshAdapter } from "../../src/adapters/dsh.ts";

test("dsh does not advertise resume support", () => {
  assert.equal(listAdapters().find((row) => row.kind === "dsh")?.supportsResume, false);
});

test("resume capability table stays deliberate", () => {
  assert.deepEqual(Object.fromEntries(listAdapters().map(({ kind, supportsResume }) => [kind, supportsResume])), {
    codex: true,
    claude: true,
    dsh: false,
    agy: true,
    copilot: true,
    pi: true,
  });
});

test("dsh opens a new session even when given a resume id", () => {
  const opts = { cwd: "/synthetic/work", resumeProviderSessionId: "abc" };
  const adapter = new DshAdapter();
  const spec = adapter.spawn(opts);
  const messages = adapter.handshake(opts) as Record<string, unknown>[];

  assert.deepEqual(spec, new DshAdapter().spawn({ cwd: opts.cwd }));
  assert.deepEqual(messages.map((message) => message.method), ["initialize", "session/new"]);
  assert.doesNotMatch(JSON.stringify({ command: spec.command, cwd: spec.cwd, messages }), /abc/);
});

for (const { kind, supportsResume } of listAdapters()) {
  if (!supportsResume) continue;
  test(`${kind} source mentions the resume option`, () => {
    const source = readFileSync(new URL(`../../src/adapters/${kind}.ts`, import.meta.url), "utf8");
    assert.match(source, /resumeProviderSessionId/);
  });
}
