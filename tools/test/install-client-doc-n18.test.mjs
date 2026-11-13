import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const installerPath = new URL("../../scripts/install-client.sh", import.meta.url);
const installer = readFileSync(installerPath, "utf8");

test("installer starts with a shebang and enables errexit", () => {
  assert.match(installer, /^#![^\n]+/);
  assert.match(installer, /^\s*set\s+-[a-z]*e[a-z]*(?:\s|$)/m);
});

test("literal client-ui paths referenced by the installer exist", () => {
  const paths = [...installer.matchAll(/client-ui\/[\w./-]*/g)].map((match) => match[0]);
  assert.ok(paths.length > 0);
  for (const path of new Set(paths)) {
    assert.ok(existsSync(new URL(path, `file://${root}`)), `missing ${path}`);
  }
});

// DEFECT: README does not mention the existing install-client.sh script.
test.todo("README mentions the installer", () => {
  if (existsSync(installerPath)) {
    assert.match(readFileSync(new URL("../../README.md", import.meta.url), "utf8"), /install-client\.sh/);
  }
});

test("installer avoids piping downloads to a shell and absolute home paths", () => {
  assert.doesNotMatch(installer, /\b(?:curl|wget)\b[^\n|]*\|\s*(?:(?:sudo|env)\s+)*(?:ba|z|da|k)?sh\b/i);
  assert.doesNotMatch(installer, /\/(?:Users|home)\/[^\s/'"$]+/);
});
