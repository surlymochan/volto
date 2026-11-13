import test from "node:test";
import assert from "node:assert/strict";

import { checkHostPolicy } from "../src/host-policy.ts";

const claudeError = { ok: false, code: "HOST_POLICY", message: "Claude must run on the local host." };
const localError = { ok: false, code: "HOST_POLICY", message: "Non-Claude providers must run on a remote host." };
const aliasError = { ok: false, code: "HOST_POLICY", message: "Host must be a non-empty SSH alias containing only letters, digits, underscores, dots, and hyphens." };

test("provider kinds obey the local and remote host policy", () => {
  for (const kind of ["claude", "codex", "pi", "agy", "dsh", "copilot", "other"]) {
    for (const host of ["local", "remote-1"]) {
      const expected = kind === "claude"
        ? host === "local" ? { ok: true } : claudeError
        : host === "local" ? localError : { ok: true };
      assert.deepEqual(checkHostPolicy({ kind, host }), expected, `${kind} on ${host}`);
    }
  }
});

test("remote aliases must be non-empty and use only the allowed characters", () => {
  for (const host of ["a", "Z09_foo.bar-baz", "-", ".", "_"]) {
    assert.deepEqual(checkHostPolicy({ kind: "codex", host }), { ok: true }, host);
  }
  for (const host of ["", "host name", "host\n", "user@host", "host:22", "/host", "höst"]) {
    assert.deepEqual(checkHostPolicy({ kind: "codex", host }), aliasError, JSON.stringify(host));
    assert.deepEqual(checkHostPolicy({ kind: "claude", host }), claudeError, JSON.stringify(host));
  }
});
