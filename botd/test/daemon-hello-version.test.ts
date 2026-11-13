import test from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers.ts";

for (const v of [undefined, 1]) {
  test(`hello accepts version ${v === undefined ? "absent" : v}`, async (t) => {
    const { daemon, client } = startHarness();
    t.after(() => daemon.close());
    client.send({ op: "hello", clientId: "client-a", ...(v === undefined ? {} : { v }) });
    const answer = await client.waitFor(() => true);
    assert.equal(answer.op, "hello");
  });
}

for (const v of [2, 99]) {
  test(`hello rejects unsupported version ${v} without taking the lease`, async (t) => {
    const { daemon, client } = startHarness();
    t.after(() => daemon.close());
    client.send({ op: "hello", clientId: "client-a", v });
    const answer = await client.waitFor(() => true);
    assert.equal(answer.op, "error");
    if (answer.op !== "error") return;
    assert.equal(answer.code, "version_unsupported");
    assert.equal("sid" in answer, false);
    client.send({ op: "hello", clientId: "client-b", v: 1 });
    const hello = await client.waitFor((frame) => frame.op === "hello");
    assert.equal(hello.op, "hello");
    if (hello.op === "hello") assert.equal(hello.fence, 1);
  });
}

for (const v of [0, -1, 1.5, "1"]) {
  test(`hello rejects invalid version ${JSON.stringify(v)}`, async (t) => {
    const { daemon, client } = startHarness();
    t.after(() => daemon.close());
    client.send({ op: "hello", clientId: "client-a", v });
    const answer = await client.waitFor(() => true);
    assert.equal(answer.op, "error");
    if (answer.op === "error") assert.equal(answer.code, "bad_frame");
  });
}
