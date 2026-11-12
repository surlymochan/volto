// probes/lib/binary.mjs
//
// Locate the CLI of a bot. A probe never installs anything: if the binary is
// not present the probe skips cleanly.

import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Directories that are searched in addition to PATH. */
export const FALLBACK_DIRS = [
  join(homedir(), ".local", "bin"),
  "/usr/local/bin",
  "/usr/bin",
  "/runtime/node_modules/.bin",
  join(process.cwd(), "node_modules", ".bin"),
];

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv, extraDirs?: string[] }} [options]
 * @returns {{ path: string|null, source: string, searched: string[] }}
 */
export function resolveBinary(name, options = {}) {
  const env = options.env ?? process.env;
  const searched = [];

  const overrideKey = `VOLTO_PROBE_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BIN`;
  const override = env[overrideKey];
  if (override) {
    searched.push(override);
    // An explicit override is authoritative: never fall back to PATH.
    if (isExecutable(override)) return { path: override, source: `env:${overrideKey}`, searched };
    return { path: null, source: "missing", searched };
  }

  const dirs = [...(env.PATH ?? "").split(":").filter(Boolean), ...(options.extraDirs ?? FALLBACK_DIRS)];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    searched.push(candidate);
    if (isExecutable(candidate)) return { path: candidate, source: "path", searched };
  }
  return { path: null, source: "missing", searched };
}
