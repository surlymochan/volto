// Static tests for the page of the "Remote bots" panel.
//
// The page (client-ui/index.html) is the whole of the panel on the browser
// side: it names the language of the document, declares the character set
// and the viewport, carries the elements the sources look up by id and asks
// the dev server for the stylesheet and for the modules.
//
// Nothing here starts a server, opens a socket or reaches the network: the
// page, the sources and the server are read from the disk. The route function
// of client-ui/serve.mjs (resolveFile) is extracted from its source and
// evaluated, so the paths of the page are checked against the real mapping,
// not a mirror of it.
//
// Every name below is synthetic.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const panelDir = path.resolve(import.meta.dirname, "..");
const pagePath = path.join(panelDir, "index.html");
const page = readFileSync(pagePath, "utf8");

/** An element of the page. */
interface PageElement {
  /** The name of the tag, in lower case. */
  name: string;
  /** The attributes of the tag, in lower case. */
  attributes: Map<string, string>;
  /** The text of the element: the body of a script, the name of a title. */
  text: string;
}

/** An opening tag of the page. */
const TAG = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>`]+))?)*)\s*\/?>/g;

/** An attribute of an opening tag. */
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;

/** The id an element of the sources is looked up by. */
const LOOKED_UP = /getElementById\(\s*(["'`])([^"'`]+)\1\s*\)/g;

/** A static import or re-export, with or without bindings, whatever the spacing: `import{a}from"x"`, `import "x"`. */
const IMPORT = /\b(?:import|export)\b\s*(?:[^;"'()]*?\bfrom\s*)?["']([^"']+)["']/g;

/** A module the page imports at run time. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Every element of a page, with its attributes and its text.
 *
 * The page is written by hand and is small, so a scan of the markup is
 * enough: a comment is blanked out first, because a comment may hold
 * markup that is not part of the page.
 */
function elementsOf(markup: string): PageElement[] {
  const source = markup.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
  const elements: PageElement[] = [];
  const tags = new RegExp(TAG.source, "g");
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(source)) !== null) {
    const name = tag[1].toLowerCase();
    const attributes = new Map<string, string>();
    const attributePattern = new RegExp(ATTRIBUTE.source, "g");
    let attribute: RegExpExecArray | null;
    while ((attribute = attributePattern.exec(tag[2])) !== null) {
      attributes.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    const element: PageElement = { name, attributes, text: "" };
    elements.push(element);
    // The body of a script, a style or a title is text, not markup.
    if (name === "script" || name === "style" || name === "title") {
      const closing = source.indexOf(`</${name}`, tags.lastIndex);
      element.text = source.slice(tags.lastIndex, closing === -1 ? source.length : closing);
      if (closing !== -1) tags.lastIndex = closing;
    }
  }
  return elements;
}

const elements = elementsOf(page);

/** The scripts of the page. */
function scripts(): PageElement[] {
  return elements.filter((element) => element.name === "script");
}

/** The links of the page. */
function links(): PageElement[] {
  return elements.filter((element) => element.name === "link");
}

const serverSource = readFileSync(path.join(panelDir, "serve.mjs"), "utf8");

/** The route function of serve.mjs, evaluated without importing or starting the server. */
function loadResolveFile(source: string): (pathname: string) => { path: string; type: string } | null {
  const match = /^function resolveFile\(pathname\) \{\n[\s\S]*?^\}$/m.exec(source);
  assert.ok(match, "serve.mjs defines resolveFile(pathname)");
  return new Function("join", "here", `${match[0]}\nreturn resolveFile;`)(path.join, panelDir);
}

const resolveFile = loadResolveFile(serverSource);

/** The file the dev server answers a reference of the page with (the page is served at "/"), or null for a 404. */
function referencedFile(reference: string): string | null {
  const url = new URL(reference, "http://panel.test/");
  if (url.origin !== "http://panel.test") return null;
  return resolveFile(decodeURIComponent(url.pathname))?.path ?? null;
}

/** The ids the page carries. */
function pageIds(): string[] {
  return elements
    .filter((element) => element.attributes.has("id"))
    .map((element) => element.attributes.get("id") ?? "");
}

/** Every id the sources of the panel look up. */
function lookedUpIds(): string[] {
  const ids = new Set<string>();
  const srcDir = path.join(panelDir, "src");
  for (const entry of readdirSync(srcDir)) {
    if (!entry.endsWith(".ts")) continue;
    const source = readFileSync(path.join(srcDir, entry), "utf8");
    for (const match of source.matchAll(LOOKED_UP)) ids.add(match[2]);
  }
  return [...ids].sort();
}

test("the page declares the language of the document", () => {
  const html = elements.find((element) => element.name === "html");
  assert.ok(html, "the page has an html element");
  const language = html.attributes.get("lang") ?? "";
  assert.notEqual(language, "", "the html element carries a lang attribute");
  assert.match(language, /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]+)*$/, `the lang attribute names a language: ${language}`);
});

test("the page declares the character set of the document", () => {
  const charset = elements.find((element) => element.name === "meta" && element.attributes.has("charset"));
  assert.ok(charset, "the page has a meta with a charset");
  assert.equal((charset.attributes.get("charset") ?? "").toLowerCase(), "utf-8");
});

test("the page declares the viewport of the document", () => {
  const viewport = elements.find(
    (element) =>
      element.name === "meta" && (element.attributes.get("name") ?? "").toLowerCase() === "viewport",
  );
  assert.ok(viewport, "the page has a viewport meta");
  const content = viewport.attributes.get("content") ?? "";
  assert.match(content, /width\s*=\s*device-width/, `the viewport is the width of the device: ${content}`);
});

test("the page has a title", () => {
  const titles = elements.filter((element) => element.name === "title");
  assert.equal(titles.length, 1, "the page has exactly one title");
  assert.notEqual(titles[0].text.trim(), "", "the title names the page");
});

test("every script and every link of the page is a file the dev server serves", () => {
  const references: Array<{ kind: string; reference: string }> = [];
  for (const script of scripts()) {
    const src = script.attributes.get("src");
    if (src) references.push({ kind: "script", reference: src });
  }
  for (const link of links()) {
    const href = link.attributes.get("href");
    if (href) references.push({ kind: "link", reference: href });
  }
  assert.ok(references.length > 0, "the page asks for a stylesheet or for a script");
  for (const { kind, reference } of references) {
    const file = referencedFile(reference);
    assert.ok(file, `the ${kind} ${reference} is not a route of the dev server`);
    assert.ok(existsSync(file), `the ${kind} ${reference} points at ${path.relative(panelDir, file)}, which is not there`);
  }
});

test("the imports of the page are routes of the dev server", () => {
  const imports: string[] = [];
  for (const script of scripts()) {
    for (const match of script.text.matchAll(IMPORT)) imports.push(match[1]);
    for (const match of script.text.matchAll(DYNAMIC_IMPORT)) imports.push(match[1]);
  }
  assert.ok(imports.length > 0, "the page boots a module");
  for (const reference of imports) {
    const file = referencedFile(reference);
    assert.ok(file, `the import ${reference} is not a route of the dev server`);
    assert.ok(existsSync(file), `the import ${reference} points at ${path.relative(panelDir, file)}, which is not there`);
  }
});

test("the import pattern sees every form of static import", () => {
  const forms = 'import { a } from "/src/a.js"; import "/src/side.js"; import{b}from"/src/b.js"; export * from "/src/c.js"; import x from\n"/src/d.js";';
  assert.deepEqual([...forms.matchAll(IMPORT)].map((m) => m[1]), ["/src/a.js", "/src/side.js", "/src/b.js", "/src/c.js", "/src/d.js"]);
  assert.deepEqual([...'await import("/src/late.js")'.matchAll(DYNAMIC_IMPORT)].map((m) => m[1]), ["/src/late.js"]);
  assert.deepEqual([...'const important = "x";'.matchAll(IMPORT)], []);
});

test("every element the sources look up by id is in the page", () => {
  const ids = pageIds();
  const lookedUp = lookedUpIds();
  assert.ok(lookedUp.length > 0, "the sources look up elements by id");
  for (const id of lookedUp) {
    assert.ok(ids.includes(id), `the page has an element with the id ${id}`);
  }
});

test("the page has no inline event handler", () => {
  const handlers: string[] = [];
  for (const element of elements) {
    for (const name of element.attributes.keys()) {
      if (/^on[a-z]+$/i.test(name)) handlers.push(`${element.name}[${name}]`);
    }
  }
  assert.deepEqual(handlers, [], "the page binds no handler in the markup");
});

test("the ids of the page are unique", () => {
  const ids = pageIds();
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicates, [], "no id of the page is used twice");
});

test("the dev server routes only the page, the stylesheet and the modules, to the right files", () => {
  const file = (route: string) => resolveFile(route)?.path ?? null;
  assert.equal(file("/"), path.join(panelDir, "index.html"));
  assert.equal(file("/index.html"), path.join(panelDir, "index.html"));
  assert.equal(file("/styles.css"), path.join(panelDir, "styles.css"));
  assert.equal(file("/src/panel.js"), path.join(panelDir, "src", "panel.ts"));
  // A file that exists in the panel directory but is not a route is a 404.
  for (const route of ["/serve.mjs", "/README.md", "/src/panel.ts", "/test/index-html.test.ts", "/src/../serve.mjs", "/src/a/b.js"]) {
    assert.equal(file(route), null, `${route} must not be routed`);
  }
  // The request handler answers 404 for an unrouted path and serves the routed file.
  assert.match(serverSource, /const file = resolveFile\(pathname\);\s*if \(!file\) \{\s*send\(response, 404/);
});
