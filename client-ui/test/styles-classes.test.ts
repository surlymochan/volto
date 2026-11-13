import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import test from "node:test";

import { installDom, findByTestId } from "../test-support/dom.ts";
import type { StubElement } from "../test-support/dom.ts";
import { MockBotdClient } from "../src/mock-client.ts";
import { createPanel } from "../src/panel.ts";

const root = resolve(import.meta.dirname, "..");
const panelSource = readFileSync(resolve(root, "src/panel.ts"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const css = readFileSync(resolve(root, "styles.css"), "utf8");
const uncommentedCss = css.replace(/\/\*[\s\S]*?\*\//g, "");

// These identify individual metadata fields; their appearance is inherited from .bot-meta.
const hooks = new Map([
  ["bot-lease", "Identifies the lease metadata field."],
  ["bot-quota", "Identifies the quota metadata field."],
]);

function panelClasses(source: string): string[] {
  const classes = new Set<string>();
  // Include both arms of conditional expressions assigned to className.
  for (const assignment of source.matchAll(/\bclassName\s*[:=]\s*([^\n]+)/g)) {
    for (const literal of assignment[1].split(/[,;]/, 1)[0].matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g)) {
      for (const name of literal[2].replace(/\$\{[^}]*\}/g, "*").split(/\s+/)) {
        if (name) classes.add(name);
      }
    }
  }
  return [...classes];
}

function htmlClasses(source: string): string[] {
  return [...source.matchAll(/\bclass\s*=\s*["']([^"']*)["']/gi)]
    .flatMap((match) => match[1].split(/\s+/).filter(Boolean));
}

function cssClasses(source: string): Set<string> {
  const classes = new Set<string>();
  for (const block of source.matchAll(/([^{}]+)\{/g)) {
    const selector = block[1].trim();
    if (selector.startsWith("@")) continue;
    for (const match of selector.matchAll(/\.([a-zA-Z_][\w-]*)/g)) classes.add(match[1]);
  }
  return classes;
}

function matchesClass(pattern: string, name: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join("[^\\s]+")}$`).test(name);
}

test("panel and HTML classes have stylesheet rules or documented hooks", () => {
  const selectors = cssClasses(uncommentedCss);
  const used = [...new Set([...panelClasses(panelSource), ...htmlClasses(html)])];
  assert.ok(used.includes("host-selected") && used.includes("dot-*"), "extract conditional and template classes");
  assert.deepEqual(used.filter((name) => !hooks.has(name) && ![...selectors].some((selector) => matchesClass(name, selector))), []);
});

// Templated classes (`dot-${status}` etc.) cannot be checked by a wildcard: one surviving
// variant would mask a removed one. Every variant that has its own rule must be asserted.
test("every state variant of templated classes has its own stylesheet rule", () => {
  const selectors = cssClasses(uncommentedCss);
  const variants = [
    "dot-connected", "dot-connecting", "dot-error",
    "badge-idle", "badge-busy", "badge-down", "badge-running",
    "event-tool-end", "event-tool-error",
  ];
  assert.deepEqual(variants.filter((name) => !selectors.has(name)), []);
});

test("stylesheet braces are balanced outside comments and strings", () => {
  const structural = uncommentedCss.replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, "");
  let depth = 0;
  for (const char of structural) {
    if (char === "{") depth++;
    if (char === "}") depth--;
    assert.ok(depth >= 0, "closing brace has an opening brace");
  }
  assert.equal(depth, 0);
});

test("stylesheet does not import remote URLs", () => {
  assert.doesNotMatch(uncommentedCss, /@import\s+(?:url\(\s*)?["']?\s*(?:https?:)?\/\//i);
});

test("stylesheet does not load remote url() assets", () => {
  assert.doesNotMatch(uncommentedCss, /url\(\s*["']?\s*(?:https?:)?\/\//i);
});

test("HTML declares a language", () => {
  assert.match(html, /<html\b[^>]*\blang\s*=\s*["'][^"']+["']/i);
});

test("HTML declares a viewport", () => {
  assert.match(html, /<meta\b(?=[^>]*\bname\s*=\s*["']viewport["'])(?=[^>]*\bcontent\s*=\s*["'][^"']+["'])[^>]*>/i);
});

test("HTML script and link targets resolve to local files", () => {
  const targets = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  // Inline module imports are also browser-loaded script targets.
  targets.push(...[...html.matchAll(/\bimport\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]));
  assert.ok(targets.length > 0);
  for (const target of targets) {
    assert.doesNotMatch(target, /^(?:[a-z]+:)?\/\//i);
    const pathname = target.split(/[?#]/)[0].replace(/^\//, "");
    // serve.mjs maps /src/*.js requests to their TypeScript sources.
    const source = /^src\/[\w-]+\.js$/.test(pathname) ? pathname.replace(/\.js$/, ".ts") : pathname;
    const path = resolve(root, source);
    assert.ok(path.startsWith(root + sep) && existsSync(path), `${target} resolves to a local file`);
  }
});

test("data-testid values are unique in a rendered fixture", async () => {
  const { document } = installDom();
  // Register the real page's identified elements, including their static test IDs.
  for (const tag of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const testId = /\bdata-testid\s*=\s*["']([^"']+)["']/i.exec(tag[2])?.[1];
    // Elements with only a data-testid still count toward uniqueness; give them a synthetic id.
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag[2])?.[1] ?? (testId ? `__static-${document.elements.size}` : undefined);
    if (!id) continue;
    const node = document.register(id, tag[1]);
    if (testId) node.setAttribute("data-testid", testId);
  }
  const panel = createPanel({ client: new MockBotdClient({ hosts: [{ alias: "alpha" }], stepMs: 5 }), pollMs: 0 });
  try {
    await panel.mount();
    const hostList = document.getElementById("host-list")!;
    findByTestId(hostList, "connect-alpha")?.dispatch("click");
    const deadline = Date.now() + 2000;
    while (!findByTestId(document.getElementById("stream-panel")!, "event-0")) {
      if (Date.now() > deadline) throw new Error("timed out waiting for fixture events");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const ids: string[] = [];
    function collect(node: StubElement): void {
      const id = node.getAttribute("data-testid");
      if (id) ids.push(id);
      for (const child of node.children) collect(child);
    }
    for (const node of document.elements.values()) collect(node);
    assert.ok(ids.length > 10, "fixture includes static and rendered IDs");
    assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), []);
  } finally {
    panel.destroy();
  }
});
