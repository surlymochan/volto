// Checks for documentation gaps not covered by protocol-doc.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const protocol = readFileSync(new URL("../src/protocol.ts", import.meta.url), "utf8");
const frames = readFileSync(new URL("../src/frames.ts", import.meta.url), "utf8");
const doc = readFileSync(new URL("../PROTOCOL.md", import.meta.url), "utf8");

/** Literal code properties and named error-code unions, if present. */
function errorCodes(source: string): string[] {
  const codes = new Set<string>();
  for (const match of source.matchAll(/\bcode\s*:\s*["']([a-z][a-z0-9_]*)["']/g)) {
    codes.add(match[1] as string);
  }
  for (const union of source.matchAll(/\b(?:export\s+)?type\s+\w*ErrorCode\s*=\s*([^;]+);/g)) {
    for (const match of (union[1] as string).matchAll(/["']([a-z][a-z0-9_]*)["']/g)) {
      codes.add(match[1] as string);
    }
  }
  return [...codes];
}

/** ATX heading text outside fenced code blocks, normalized for comparison. */
function headings(markdown: string): string[] {
  const result: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) result.push((heading[1] as string).trim().replace(/\s+/g, " ").toLowerCase());
  }
  return result;
}

/**
 * Text of an object type declaration at brace depth 1 only: the members of each top-level
 * `{ ... }`, without the contents of nested objects, so `op` is found in any position
 * but a nested `{ op: ... }` payload is not mistaken for the frame's own `op`.
 */
function topLevelMembers(declaration: string): string {
  let depth = 0;
  let out = "";
  for (const char of declaration) {
    if (char === "{") { depth++; if (depth === 1) out += "{"; continue; }
    if (char === "}") { if (depth === 1) out += "}"; depth--; continue; }
    if (depth === 1) out += char;
  }
  return out;
}

/** Exported `*Frame` types whose declaration has an object member with an `op` property, at any position. */
function frameTypes(source: string): string[] {
  const heads = [...source.matchAll(/\bexport\s+type\s+(\w*Frame)\s*=/g)];
  return heads.filter((head) => {
    const rest = source.slice((head.index as number) + head[0].length);
    const end = rest.search(/^(?:export\s+|declare\s+)?(?:type|interface|const|let|function|class)\b/m);
    return /\{[^{}]*?\b(?:readonly\s+)?op\??\s*:/.test(topLevelMembers(end === -1 ? rest : rest.slice(0, end)));
  }).map((head) => head[1] as string);
}

test("extracts literal error codes from properties and named unions", () => {
  const source = `type ErrorCode = "sample_error" | 'other_error';
    const frame = { code: "third_error" }; const text = "unrelated";`;
  assert.deepEqual(new Set(errorCodes(source)), new Set(["sample_error", "other_error", "third_error"]));
});

test("error codes defined in the protocol modules appear in the document", () => {
  for (const code of errorCodes(`${protocol}\n${frames}`)) {
    assert.ok(doc.includes(code), `error code ${code} is missing from PROTOCOL.md`);
  }
});

test("finds exported wire frame type names without matching helper types", () => {
  assert.deepEqual(frameTypes(`export type ExampleFrame = | { op: "example" };
    export type FrameReader = { close(): void };`), ["ExampleFrame"]);
});

test("the names of wire frame types are documented", () => {
  const names = frameTypes(`${protocol}\n${frames}`);
  assert.ok(names.includes("ClientFrame") && names.includes("ServerFrame"), "wire frame types were not found");
  for (const name of names) assert.ok(doc.includes(name), `frame type ${name} is missing from PROTOCOL.md`);
});

test("finds frame types whose op property is not the first member", () => {
  assert.deepEqual(frameTypes(`export type LateFrame = { sid: string; op: "late" };
    export type PlainFrame = { sid: string };`), ["LateFrame"]);
  assert.deepEqual(frameTypes(`export type NestedFrame = { payload: { id: string }; op: "nested" };
    export type InnerOnlyFrame = { payload: { op: string } };`), ["NestedFrame"]);
});

test("heading extraction ignores fenced examples and normalizes headings", () => {
  assert.deepEqual(headings("# Sample  heading ##\n```md\n# ignored\n```\n## Other"), ["sample heading", "other"]);
});

test("the protocol document has no duplicate headings", () => {
  const seen = new Set<string>();
  const all = headings(doc);
  assert.ok(all.length > 0, "no headings found in PROTOCOL.md");
  for (const heading of all) {
    assert.ok(!seen.has(heading), `duplicate heading: ${heading}`);
    seen.add(heading);
  }
});
