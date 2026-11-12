import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTranscript } from "../lib/transcript.mjs";
import { createRedactor } from "../lib/redact.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("json lines are redacted structurally", () => {
  const dir = join(here, "..", ".tmp", "tests", "transcript");
  mkdirSync(dir, { recursive: true });
  try {
    const file = join(dir, "bot.jsonl");
    const transcript = createTranscript({ file, redactor: createRedactor({ worktree: "/srv/volto", home: "/home/agent" }) });
    transcript.record("out", "line", JSON.stringify({ method: "remoteControl/status/changed", params: { serverName: "builder-01" } }));
    transcript.record("out", "line", JSON.stringify({ params: { codexHome: "/home/agent/.codex" } }));
    transcript.record("err", "line", "plain error line");
    transcript.close();

    const content = readFileSync(file, "utf8");
    assert.ok(!content.includes("builder-01"), "the host name leaked into the transcript");
    assert.ok(!content.includes("/home/agent"), "the home path leaked into the transcript");
    assert.ok(content.includes("plain error line"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
