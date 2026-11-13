// client-ui/transpile.mjs
//
// Turns the TypeScript sources of the panel into plain JavaScript for the
// browser. No bundler: every module is served on its own, exactly as the
// browser asks for it.
//
// Node 24 strips the types itself (`node:module`'s stripTypeScriptTypes),
// which is all this needs. When the runtime has no type-stripping support we
// fall back to `bun`, if it happens to be installed, so the panel can still
// be served by older runtimes.

import { spawnSync } from "node:child_process";
import module from "node:module";

/** Returns a function that strips types from TypeScript source, or null. */
export function createTranspiler() {
  const strip = module.stripTypeScriptTypes;
  if (typeof strip === "function") {
    const stripper = probeStripper(strip);
    if (stripper) return stripper;
  }
  const bun = findBun();
  if (bun) return (source) => stripWithBun(bun, source);
  return null;
}

/**
 * Finds the calling convention the runtime supports.
 *
 * `stripTypeScriptTypes` grew an options argument over time, so both shapes
 * are tried.
 */
function probeStripper(strip) {
  const probe = "const probe: number = 1;";
  try {
    strip(probe, { mode: "strip" });
    return (source) => strip(source, { mode: "strip" });
  } catch {
    // Older runtimes take the source only.
  }
  try {
    strip(probe);
    return (source) => strip(source);
  } catch {
    return null;
  }
}

/** Locates a bun binary, if there is one. */
function findBun() {
  const candidates = [process.env.BUN_PATH, "bun", "/usr/local/bin/bun", "/usr/bin/bun"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/** Strips types with bun's transpiler. */
function stripWithBun(bun, source) {
  const script = `
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const result = transpiler.transformSync(await Bun.stdin.text());
    process.stdout.write(typeof result === "string" ? result : result.code);
  `;
  const result = spawnSync(bun, ["-e", script], { input: source, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`bun failed to strip types: ${result.stderr || "unknown error"}`);
  }
  return result.stdout;
}

/**
 * Rewrites relative ".ts" import specifiers to ".js".
 *
 * The browser asks for the URLs the sources mention, so the served modules
 * have to agree on the extension. Every module specifier is rewritten: the
 * `import ... from "./x.ts"`, the bare `import "./x.ts"`, the
 * `export ... from "./x.ts"` and the dynamic `import("./x.ts")` form.
 *
 * Only the specifiers of an import are touched. The source is scanned
 * instead of matched blindly, so a string, a comment or a regular
 * expression that happens to hold an import is left alone.
 */
export function rewriteSpecifiers(source) {
  let out = "";
  let index = 0;
  let word = "";
  let lastWord = "";
  let previousWord = "";
  let lastChar = "";

  /** Ends the identifier that is being read. */
  const flush = () => {
    if (!word) return;
    previousWord = lastWord;
    lastWord = word;
    lastChar = word[word.length - 1];
    word = "";
  };

  while (index < source.length) {
    const char = source[index];
    if (!isWordChar(char)) flush();

    // A comment holds no import.
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop);
      index = stop;
      continue;
    }

    // A template holds no specifier either.
    if (char === "`") {
      const stop = findTemplateEnd(source, index);
      out += source.slice(index, stop + 1);
      index = stop + 1;
      lastChar = char;
      lastWord = "";
      previousWord = "";
      continue;
    }

    // A string is a specifier only when an import asks for it.
    if (char === '"' || char === "'") {
      const stop = findStringEnd(source, index);
      const content = source.slice(index + 1, stop);
      const rewritten = isSpecifier(lastWord, previousWord, lastChar)
        ? rewriteSpecifier(char, content)
        : null;
      out += rewritten ?? source.slice(index, stop + 1);
      index = stop + 1;
      lastChar = char;
      lastWord = "";
      previousWord = "";
      continue;
    }

    // A regular expression may hold anything.
    if (char === "/" && startsRegex(lastChar, lastWord)) {
      const stop = findRegexEnd(source, index);
      out += source.slice(index, stop + 1);
      index = stop + 1;
      lastChar = char;
      continue;
    }

    out += char;
    index += 1;
    if (isWordChar(char)) {
      word += char;
    } else if (!isSpace(char)) {
      lastChar = char;
    }
  }

  return out;
}

/** True when the character can be part of an identifier. */
function isWordChar(char) {
  return /[A-Za-z0-9_$]/.test(char);
}

/** True when the character is white space. */
function isSpace(char) {
  return /\s/.test(char);
}

/** The characters after which a "/" starts a regular expression. */
const REGEX_AFTER = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "^", "~", "<", ">",
]);

/** The keywords after which a "/" starts a regular expression. */
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else", "yield",
  "await",
]);

/** True when a "/" at this point starts a regular expression. */
function startsRegex(lastChar, lastWord) {
  if (lastChar === "") return true;
  if (REGEX_AFTER.has(lastChar)) return true;
  return REGEX_KEYWORDS.has(lastWord);
}

/**
 * True when the string that follows is a module specifier.
 *
 * The string of an `import` (bare or dynamic) and the string of a `from`
 * clause are specifiers; a string that only looks like one is not.
 */
function isSpecifier(lastWord, previousWord, lastChar) {
  // `{ import: "..." }` is a key, not an import.
  if (lastWord === "import") return lastChar !== ":";
  if (lastWord !== "from") return false;
  // `const from = "..."` and `{ from: "..." }` are not imports.
  if (previousWord === "const" || previousWord === "let" || previousWord === "var") return false;
  if (lastChar === ":" || lastChar === ".") return false;
  return true;
}

/** Rewrites a relative ".ts" specifier to ".js"; other strings stay. */
function rewriteSpecifier(quote, content) {
  if (!/^\.{1,2}\/[^?#]*\.ts$/.test(content)) return null;
  return `${quote}${content.slice(0, -2)}js${quote}`;
}

/** Returns the index of the quote that closes the string at `index`. */
function findStringEnd(source, index) {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === quote) return cursor;
    cursor += 1;
  }
  return source.length;
}

/** Returns the index of the backtick that closes the template at `index`. */
function findTemplateEnd(source, index) {
  let cursor = index + 1;
  let depth = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (depth === 0 && char === "`") return cursor;
    if (depth === 0 && char === "$" && source[cursor + 1] === "{") {
      depth = 1;
      cursor += 2;
      continue;
    }
    if (depth > 0) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (char === '"' || char === "'" || char === "`") {
        cursor = findStringEnd(source, cursor);
        continue;
      }
    }
    cursor += 1;
  }
  return source.length;
}

/** Returns the index of the "/" that closes the regular expression at `index`. */
function findRegexEnd(source, index) {
  let cursor = index + 1;
  let inClass = false;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "\n") return cursor;
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return cursor;
    cursor += 1;
  }
  return source.length;
}
