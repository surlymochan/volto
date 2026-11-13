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

interface Command { cwd: string; command: string }

// Lines may chain steps (`cd botd && npm test`); a leading `cd <dir>` sets the directory of later steps.
function commands(text: string): Command[] {
  const blocks = text.matchAll(/^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\s*\1\s*$/gm);
  const found: Command[] = [];
  for (const block of blocks) {
    // The working directory persists across the lines of one fenced block, like in a shell session.
    let cwd = "";
    for (const line of block[2].split("\n")) {
      for (const step of line.replace(/\s+#.*$/, "").split("&&").map((part) => part.trim())) {
        const cd = /^cd\s+(\S+)$/.exec(step);
        if (cd) cwd = join(cwd, cd[1].replace(/^['"]|['"]$/g, ""));
        else if (/^(?:node|npm)\s/.test(step)) found.push({ cwd, command: step });
      }
    }
  }
  return found;
}

test("extractors ignore fenced headings and non-command lines", () => {
  const sample = "# First\n```sh\n# Not a heading\nnode sample.mjs\necho ignored\n```\n";
  assert.deepEqual(headings(sample), ["first"]);
  assert.deepEqual(commands(sample), [{ cwd: "", command: "node sample.mjs" }]);
});

test("extractor keeps the directory of a cd line for later lines of the block only", () => {
  assert.deepEqual(commands("```sh\ncd botd\nnpm test\n```\n```sh\nnpm start\n```\n"), [
    { cwd: "botd", command: "npm test" },
    { cwd: "", command: "npm start" },
  ]);
});

test("extractor follows cd chains", () => {
  assert.deepEqual(commands("```sh\ncd botd && npm test\n```\n"), [{ cwd: "botd", command: "npm test" }]);
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
    const found = commands(text);
    assert.ok(found.some((entry) => entry.cwd === "botd" && entry.command === "npm test") || name !== "README.md", "README.md: cd botd && npm test is checked");
    for (const { cwd, command } of found) {
      const args = command.replace(/\s+#.*$/, "").match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
      const program = args.shift();
      if (program === "npm") {
        const script = args[0] === "run" ? args[1] : args[0];
        const pkg = JSON.parse(readFileSync(join(root, cwd, "package.json"), "utf8"));
        assert.ok(pkg.scripts?.[script], `${name}: missing npm script in ${command}`);
      } else {
        const operands = args.filter((arg) => !arg.startsWith("-"));
        const paths = (args.includes("--test") ? operands : operands.slice(0, 1))
          .map((arg) => arg.replace(/^['"]|['"]$/g, ""));
        assert.ok(paths.length, `${name}: no file in ${command}`);
        for (const path of paths) {
          const matches = /[*?[]/.test(path) ? globSync(path, { cwd: join(root, cwd) }) : [path].filter((p) => existsSync(join(root, cwd, p)));
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
