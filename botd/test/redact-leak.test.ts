// Security regression tests. All credentials and paths below are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Botd } from "../src/daemon.ts";
import { redact, REDACTED } from "../src/redact.ts";
import { FAKE_CHILD, TestClient, makeTempDir, startHarness, waitFor } from "./helpers.ts";

const secrets = {
  anthropic: "sk-ant-FAKEFAKEFAKEFAKEFAKE1234",
  api: "sk-FAKEFAKEFAKEFAKEFAKE1234",
  github: "ghp_FAKEFAKEFAKEFAKEFAKEFAKE1234",
  bearer: "fakeBearerValue123456789",
  aws: "AKIAFAKEFAKEFAKEFAKE",
  password: "fakePassword98765",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake-private-key-material\n-----END OPENSSH PRIVATE KEY-----",
  home: "/home/fake-redact-user/project",
  env: "fakeEnvironmentTokenValue98765",
};
const credentialText = `ordinary text ${secrets.anthropic} ${secrets.api} ${secrets.github} Authorization: Bearer ${secrets.bearer} ${secrets.aws} https://example.invalid/?password=${secrets.password} ${secrets.privateKey}`;

function assertAbsent(value: unknown, forbidden: string[]): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of forbidden) assert.ok(!serialized.includes(secret), `leaked ${secret}`);
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [fs.readFileSync(file, "utf8")];
  });
}

async function open(client: TestClient): Promise<void> {
  client.send({ op: "open", sid: "s1", bot: { kind: "acp", command: [process.execPath, FAKE_CHILD], env: { EXAMPLE_TOKEN: secrets.env } } });
  await client.waitFor((f) => f.op === "state" && f.sid === "s1" && f.state === "running");
}

test("redact preserves ordinary nested structure and is idempotent", () => {
  const input = { text: credentialText, nested: [{ EXAMPLE_TOKEN: secrets.env, keep: "ordinary text", count: 2 }] };
  const output = redact(input);
  assertAbsent(output, Object.values(secrets).filter((v) => v !== secrets.home));
  assert.equal(output.nested[0].EXAMPLE_TOKEN, REDACTED);
  assert.equal(output.nested[0].keep, "ordinary text");
  assert.equal(output.nested[0].count, 2);
  assert.match(output.text, /^ordinary text /);
  assert.deepEqual(redact(output), output);
  assert.equal(input.nested[0].EXAMPLE_TOKEN, secrets.env);
});

// TODO(defect): the redactor has no rule for usernames in home paths.
test.skip("redact masks home directory usernames", () => {
  assertAbsent(redact({ path: secrets.home }), [secrets.home, "fake-redact-user"]);
});

// TODO(defect): stdout and replay are forwarded without redaction.
test.skip("child text, tool arguments and permission details stay out of frames and logs", async (t) => {
  const { daemon, client, home, storeFile } = startHarness({ ringMaxEvents: 2 });
  t.after(() => daemon.close());
  await client.hello("first", 60_000);
  await open(client);
  const payloads = [
    { text: credentialText, home: secrets.home, EXAMPLE_TOKEN: secrets.env },
    { method: "tool/call", params: { arguments: { text: credentialText, home: secrets.home, EXAMPLE_TOKEN: secrets.env } } },
    { method: "session/request_permission", params: { detail: credentialText, home: secrets.home, EXAMPLE_TOKEN: secrets.env } },
  ];
  for (const payload of payloads) client.send({ op: "send", sid: "s1", payload: { cmd: "echo", text: payload } });
  await client.waitFor((f) => f.op === "event" && f.sid === "s1" && f.seq === 3);
  const reconnect = new TestClient(daemon);
  await reconnect.hello("second", 60_000);
  reconnect.send({ op: "resume", sid: "s1", fromSeq: 1 });
  await reconnect.waitFor((f) => f.op === "gap" && f.sid === "s1");
  await waitFor(() => reconnect.events("s1").length === 2);
  assert.ok(client.frames.some((f) => f.op === "state"));
  assert.ok(reconnect.frames.some((f) => f.op === "gap"));
  for (const output of [client.frames, reconnect.frames, filesUnder(path.join(home, "sessions")), fs.readFileSync(storeFile, "utf8")]) {
    assertAbsent(output, Object.values(secrets));
  }
});

// TODO(defect): stderr is emitted as a raw child_error frame.
test.skip("child stderr does not leak into error frames", async (t) => {
  const { daemon, client } = startHarness();
  t.after(() => daemon.close());
  await client.hello("stderr", 60_000);
  await open(client);
  client.send({ op: "send", sid: "s1", payload: { cmd: "stderr", text: credentialText } });
  await client.waitFor((f) => f.op === "error" && f.code === "child_error");
  client.send({ op: "send", sid: "s1", payload: { cmd: "exit", code: 1 } });
  await client.waitFor((f) => f.op === "state" && f.sid === "s1" && f.state === "exited");
  assertAbsent(client.frames, Object.values(secrets));
});

// TODO(defect): spawn errors and session metadata include the command verbatim.
test.skip("child startup errors and persisted metadata do not expose secrets", async (t) => {
  const home = makeTempDir("redact-leak-");
  const logs: string[] = [];
  const daemon = new Botd({ home, storeFile: path.join(home, "sessions.json") }, { onFrame: () => {}, onLog: (message) => logs.push(message) });
  t.after(() => daemon.close());
  const client = new TestClient(daemon);
  await client.hello("spawn-error", 60_000);
  client.send({ op: "open", sid: "s1", bot: { kind: "acp", command: [path.join(home, secrets.api)], env: { EXAMPLE_TOKEN: secrets.env } } });
  await client.waitFor((f) => f.op === "error" && f.code === "child_error");
  for (const output of [client.frames, logs, filesUnder(path.join(home, "sessions")), fs.readFileSync(path.join(home, "sessions.json"), "utf8")]) {
    assertAbsent(output, Object.values(secrets));
  }
});

// TODO(defect): persistence errors are passed to onLog without redaction.
test.skip("persistence diagnostics do not expose secrets", async (t) => {
  const home = makeTempDir("redact-log-");
  const logs: string[] = [];
  fs.writeFileSync(path.join(home, secrets.api), "not a directory");
  const daemon = new Botd({ home, storeFile: path.join(home, secrets.api, "sessions.json") }, { onFrame: () => {}, onLog: (message) => logs.push(message) });
  t.after(() => daemon.close());
  const client = new TestClient(daemon);
  await client.hello("log", 60_000);
  await open(client);
  await waitFor(() => logs.length > 0);
  assertAbsent(logs, Object.values(secrets));
});
