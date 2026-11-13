// Text-only checks for the repository and end-to-end READMEs.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const documents = ["README.md", "botd/e2e/README.md"];

function withoutFences(text: string): string {
  return text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "");
}

function headings(text: string): string[] {
  return [...withoutFences(text).matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)]
    .map((match) => match[1].trim().toLowerCase());
}

function commands(text: string): string[] {
  const blocks = text.matchAll(/^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\s*\1\s*$/gm);
  return [...blocks].flatMap((block) => block[2].split("\n")
    .map((line) => line.trim()).filter((line) => /^(?:node|npm)\s/.test(line)));
}

test("extractors ignore fenced headings and non-command lines", () => {
  const sample = "# First\n```sh\n# Not a heading\nnode sample.mjs\necho ignored\n```\n";
  assert.deepEqual(headings(sample), ["first"]);
  assert.deepEqual(commands(sample), ["node sample.mjs"]);
});

for (const name of documents) {
  const text = readFileSync(join(root, name), "utf8");
  test(`${name}: relative markdown links resolve`, () => {
    const prose = withoutFences(text);
    for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      const [path, fragment] = target.split("#", 2);
      const file = path ? resolve(dirname(join(root, name)), decodeURIComponent(path)) : join(root, name);
      assert.ok(existsSync(file), `${name}: missing link target ${target}`);
      if (fragment && file.endsWith(".md")) {
        const slugs = headings(readFileSync(file, "utf8"))
          .map((heading) => heading.replace(/[^\p{L}\p{N}_\- ]/gu, "").replace(/ /g, "-"));
        assert.ok(slugs.includes(decodeURIComponent(fragment)), `${name}: missing anchor ${target}`);
      }
    }
  });

  test(`${name}: fenced node and npm commands reference existing files or scripts`, () => {
    for (const command of commands(text)) {
      const args = command.replace(/\s+#.*$/, "").match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
      const program = args.shift();
      if (program === "npm") {
        const script = args[0] === "run" ? args[1] : args[0];
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        assert.ok(pkg.scripts?.[script], `${name}: missing npm script in ${command}`);
      } else {
        const operands = args.filter((arg) => !arg.startsWith("-"));
        const paths = (args.includes("--test") ? operands : operands.slice(0, 1))
          .map((arg) => arg.replace(/^['"]|['"]$/g, ""));
        assert.ok(paths.length, `${name}: no file in ${command}`);
        for (const path of paths) {
          const matches = /[*?[]/.test(path) ? globSync(path, { cwd: root }) : [path].filter((p) => existsSync(join(root, p)));
          assert.ok(matches.length, `${name}: missing command target ${path}`);
        }
      }
    }
  });

  test(`${name}: no placeholder markers`, () => {
    assert.doesNotMatch(text, /\b(?:TODO|FIXME)\b/i);
  });

  test(`${name}: headings are unique`, () => {
    const found = headings(text);
    assert.equal(new Set(found).size, found.length, `${name}: duplicate heading`);
  });
}
