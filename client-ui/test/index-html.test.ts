// Static tests for the page of the "Remote bots" panel.
//
// The page (client-ui/index.html) is the whole of the panel on the browser
// side: it names the language of the document, declares the character set
// and the viewport, carries the elements the sources look up by id and asks
// the dev server for the stylesheet and for the modules.
//
// The page, the sources and the stylesheet are read from the disk. The paths
// the page asks for are requested from the real dev server of
// client-ui/serve.mjs (started on a local port, no network beyond loopback),
// so a route of the server cannot drift from what the page needs.
//
// Every name below is synthetic.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import { startServer } from "../serve.mjs";

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

/** The module the page imports. */
const IMPORT = /(?:^|[\s;])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;

/** A side-effect import: `import "/src/boot.js";`. */
const SIDE_EFFECT_IMPORT = /(?:^|[\s;])import\s*["']([^"']+)["']/g;

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

/** The dev server the page is served by, started once for the suite. */
const running = await startServer({ port: 0 });
after(() => new Promise<void>((resolve) => running.server.close(() => resolve())));

/** Requests a reference of the page exactly as a browser at the page URL would resolve it. */
async function request(reference: string): Promise<{ response: Response; sameOrigin: boolean }> {
  const url = new URL(reference, running.url);
  const sameOrigin = url.origin === new URL(running.url).origin;
  return { response: sameOrigin ? await fetch(url) : new Response(null, { status: 0 }), sameOrigin };
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

test("every script and every link of the page is served by the dev server", async () => {
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
    const { response, sameOrigin } = await request(reference);
    assert.ok(sameOrigin, `the ${kind} ${reference} is served by the panel`);
    assert.equal(response.status, 200, `the dev server does not serve the ${kind} ${reference}`);
    await response.arrayBuffer();
  }
});

test("the imports of the page are modules the dev server serves", async () => {
  const imports: string[] = [];
  for (const script of scripts()) {
    for (const match of script.text.matchAll(IMPORT)) imports.push(match[1]);
    for (const match of script.text.matchAll(SIDE_EFFECT_IMPORT)) imports.push(match[1]);
    for (const match of script.text.matchAll(DYNAMIC_IMPORT)) imports.push(match[1]);
  }
  assert.ok(imports.length > 0, "the page boots a module");
  for (const reference of imports) {
    const { response, sameOrigin } = await request(reference);
    assert.ok(sameOrigin, `the import ${reference} is a module of the panel`);
    assert.equal(response.status, 200, `the dev server does not serve the import ${reference}`);
    assert.match(response.headers.get("content-type") ?? "", /javascript/, `the import ${reference} is not served as JavaScript`);
    await response.arrayBuffer();
  }
});

test("the import patterns see every form of import", () => {
  const snippet = 'import { a } from "/src/a.js"; import "/src/side.js"; await import("/src/late.js");';
  assert.deepEqual([...snippet.matchAll(IMPORT)].map((m) => m[1]), ["/src/a.js"]);
  assert.deepEqual([...snippet.matchAll(SIDE_EFFECT_IMPORT)].map((m) => m[1]), ["/src/side.js"]);
  assert.deepEqual([...snippet.matchAll(DYNAMIC_IMPORT)].map((m) => m[1]), ["/src/late.js"]);
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

test("the dev server maps the routes of the page to the right files and nothing else", async () => {
  const body = async (route: string) => {
    const { response } = await request(route);
    return { status: response.status, type: response.headers.get("content-type") ?? "", text: await response.text() };
  };
  const index = await body("/");
  assert.equal(index.status, 200);
  assert.match(index.type, /html/);
  assert.equal(index.text, page);
  const styles = await body("/styles.css");
  assert.equal(styles.status, 200);
  assert.match(styles.type, /css/);
  assert.equal(styles.text, readFileSync(path.join(panelDir, "styles.css"), "utf8"));
  const module = await body("/src/panel.js");
  assert.equal(module.status, 200);
  assert.match(module.type, /javascript/);
  // A file that exists in the panel directory but is not a route is a 404, as the page would get.
  for (const route of ["/serve.mjs", "/README.md", "/src/panel.ts", "/test/index-html.test.ts", "/src/missing-module.js"]) {
    assert.equal((await body(route)).status, 404, `${route} must not be served`);
  }
});
