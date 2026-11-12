// probes/lib/jsonl.mjs
//
// Strict JSONL framing: records are separated by LF only. A trailing CR is
// stripped. No other character (U+2028 / U+2029) is treated as a delimiter.

/**
 * @param {(line: string) => void} onLine
 */
export function createLineSplitter(onLine) {
  let buffer = "";

  function emit(line) {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  return {
    /** @param {string} chunk */
    push(chunk) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        emit(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer.length > 0) {
        emit(buffer);
        buffer = "";
      }
    },
  };
}

/**
 * Parse a JSONL blob, ignoring blank lines. Unparseable lines are returned as
 * `{ raw }` so callers can still record them.
 *
 * @param {string} blob
 */
export function parseJsonl(blob) {
  const records = [];
  for (const raw of blob.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      records.push({ raw: line });
    }
  }
  return records;
}
