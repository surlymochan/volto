// Static checks for references in the troubleshooting guide.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const doc = readFileSync(join(root, "botd/TROUBLESHOOTING.md"), "utf8");

function contents(dir: string): string {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? contents(path) : entry.isFile() ? readFileSync(path, "utf8") : "";
  }).join("\n");
}

const source = contents(join(root, "botd/src"));
const scripts = contents(join(root, "scripts"));
const protocol = readFileSync(join(root, "botd/PROTOCOL.md"), "utf8");

function nodeTargets(text: string): string[] {
  const targets: string[] = [];
  for (const block of text.matchAll(/^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\s*\1\s*$/gm)) {
    let cwd = root;
    for (const line of block[2].split("\n")) {
      for (const step of line.split(/&&|;/).map((part) => part.trim())) {
        const cd = /^cd\s+([^\s]+)$/.exec(step);
        if (cd) cwd = resolve(cwd, cd[1]);
        const node = /^node\s+(.+)$/.exec(step);
        if (!node) continue;
        const args = node[1].split(/\s+/);
        const operands = args.filter((arg) => !arg.startsWith("-"));
        for (const target of args.includes("--test") ? operands : operands.slice(0, 1)) {
          targets.push(resolve(cwd, target));
        }
      }
    }
  }
  return targets;
}

test("repository paths named in the guide exist", () => {
  const paths = new Set([...doc.matchAll(/\b(?:botd|scripts)\/[\w./-]*/g)].map((match) => match[0]));
  assert.ok(paths.size > 0, "no repository paths found");
  for (const path of paths) assert.ok(existsSync(join(root, path)), `missing path ${path}`);
});

test("documented environment variables occur in source or scripts", () => {
  const names = new Set(doc.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g) ?? []);
  assert.ok(names.size > 0, "no environment variables found");
  for (const name of names) assert.ok((source + scripts).includes(name), `unknown environment variable ${name}`);
});

test("error code mentions occur in source or the protocol", () => {
  const codes = new Set([...doc.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((match) => match[1]));
  assert.ok(codes.size > 0, "no error codes found");
  for (const code of codes) assert.ok((source + protocol).includes(code), `unknown error code ${code}`);
});

test("fenced Node commands resolve their target relative to cd", () => {
  assert.deepEqual(nodeTargets("```sh\ncd botd && node src/main.ts --version\n```\n"), [join(root, "botd/src/main.ts")]);
  assert.deepEqual(nodeTargets("~~~sh\nnode --test scripts/example.mjs\n~~~\n"), [join(root, "scripts/example.mjs")]);
});

test("fenced Node command targets in the guide exist", () => {
  for (const target of nodeTargets(doc)) assert.ok(existsSync(target), `missing Node command target ${target}`);
});
