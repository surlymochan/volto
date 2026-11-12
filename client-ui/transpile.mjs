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
 * have to agree on the extension. Both `import ... from "./x.ts"` and the
 * bare `import "./x.ts"` form are rewritten.
 *
 * Only relative specifiers are touched, so a string or a regular expression
 * that happens to end in ".ts" is left alone.
 */
export function rewriteSpecifiers(source) {
  return source.replace(
    /(\bfrom\s*|\bimport\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/g,
    "$1$2$3.js$2",
  );
}
