// probes/lib/transcript.mjs
//
// Records every byte that crosses the probe <-> bot boundary, redacted, as
// JSONL. Transcripts live under probes/out/ which is git-ignored.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @param {{
 *   file: string,
 *   redactor: { text: (s: string) => string, value: (v: unknown) => unknown },
 *   now?: () => number,
 * }} options
 */
export function createTranscript(options) {
  const { file, redactor } = options;
  const now = options.now ?? (() => Date.now());
  const started = now();

  mkdirSync(dirname(file), { recursive: true });
  // Every run starts with a fresh transcript.
  writeFileSync(file, "");

  /**
   * @param {"in"|"out"|"err"|"meta"} direction
   * @param {string} kind
   * @param {unknown} data
   */
  function record(direction, kind, data) {
    const line = JSON.stringify({
      t: now() - started,
      dir: direction,
      kind,
      data: redactPayload(data),
    });
    try {
      writeFileSync(file, line + "\n", { flag: "a" });
    } catch {
      /* transcripts are best effort */
    }
  }

  /**
   * JSON lines are redacted structurally (so that fields such as `serverName`
   * are caught), everything else as plain text.
   *
   * @param {unknown} data
   */
  function redactPayload(data) {
    if (typeof data !== "string") return redactor.value(data);
    try {
      return redactor.value(JSON.parse(data));
    } catch {
      return redactor.text(data);
    }
  }

  return {
    file,
    record,
    /** @param {string} message */
    note(message) {
      record("meta", "note", message);
    },
    close() {
      record("meta", "closed", { totalMs: now() - started });
    },
  };
}
