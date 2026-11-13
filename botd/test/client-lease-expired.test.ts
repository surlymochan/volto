import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { BotdClient } from "../src/client.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for frame");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function setup() {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line) frames.push(JSON.parse(line));
  });
  const client = new BotdClient({ clientId: "client-a", leaseTtlMs: 300, transport: () => ({
    stdin: input, stdout: output, kill: () => { input.destroy(); output.destroy(); },
  }) });
  const send = (frame: object) => output.write(`${JSON.stringify(frame)}\n`);
  const hello = (leaseId: string, fence: number, leaseTtlMs: number) =>
    send({ op: "hello", leaseId, fence, leaseTtlMs });
  const of = (op: string) => frames.filter((frame) => frame.op === op);
  return { client, frames, send, hello, of };
}

async function start(fake: ReturnType<typeof setup>) {
  const started = fake.client.start();
  await waitFor(() => fake.of("hello").length === 1);
  fake.hello("old", 1, 300);
  await started;
}

test("expired renewal reacquires once and renews the new lease at its new interval", async () => {
  const fake = setup();
  const errors: string[] = [];
  fake.client.on("error", (error) => errors.push(error.code));
  try {
    await start(fake);
    await waitFor(() => fake.of("renew").length === 1);
    fake.send({ op: "error", code: "lease_expired" });
    fake.send({ op: "error", code: "lease_expired" });
    await waitFor(() => fake.of("hello").length === 2);
    assert.deepEqual(fake.of("hello")[1], { op: "hello", clientId: "client-a", leaseTtlMs: 300 });
    assert.equal(fake.of("hello").length, 2);
    assert.deepEqual(errors, ["lease_expired", "lease_expired"]);
    const answeredAt = Date.now();
    fake.hello("new", 2, 600);
    await waitFor(() => fake.of("renew").length === 2);
    assert.ok(Date.now() - answeredAt >= 160, "renewal uses the new TTL");
    assert.deepEqual(fake.of("renew")[1], { op: "renew", leaseId: "new", fence: 2 });
  } finally {
    await fake.client.stop();
  }
});

test("other errors and errors after stop do not send hello", async () => {
  const fake = setup();
  await start(fake);
  fake.send({ op: "error", code: "stale_fence" });
  assert.equal(fake.of("hello").length, 1);
  await fake.client.stop();
  fake.send({ op: "error", code: "lease_expired" });
  assert.equal(fake.of("hello").length, 1);
});
