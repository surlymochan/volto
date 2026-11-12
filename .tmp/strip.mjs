// Emulate Node's type stripping: transpile each .ts file to .mjs (types only
// removed) so the suite can run under `node --test` on hosts without TS.
import { readdirSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.argv[2];
const out = process.argv[3];

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) entries.push(...walk(full));
    else if (full.endsWith(".ts")) entries.push(full);
  }
  return entries;
}

const transpiler = new Bun.Transpiler({ loader: "ts", target: "node" });
for (const file of walk(root)) {
  const rel = path.relative(root, file).replace(/\.ts$/, ".mjs");
  const dest = path.join(out, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  let code = transpiler.transformSync(readFileSync(file, "utf8"));
  code = code.replace(/(from\s*")(\.[^"]*)\.ts"/g, '$1$2.mjs"');
  writeFileSync(dest, code);
  console.log(dest);
}
