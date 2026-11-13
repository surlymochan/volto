/**
 * NDJSON framing helpers.
 *
 * A frame is one JSON object per line. The reader is line oriented and
 * tolerant of chunk boundaries: a line may arrive in several chunks and one
 * chunk may carry several lines.
 */
import type { Readable, Writable } from "node:stream";

/** Longest accepted line; longer lines are rejected instead of buffered. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export type FrameReader = {
  /** Stop reading and release the listeners. */
  close(): void;
};

/**
 * Read NDJSON frames from `input`. Malformed JSON is reported through
 * `onError`; the stream stays in sync because the offending line is dropped.
 */
export function readFrames(
  input: Readable,
  onFrame: (frame: unknown) => void,
  onError: (error: Error) => void,
): FrameReader {
  let buffer = "";

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (buffer.length > MAX_FRAME_BYTES) {
      buffer = "";
      onError(new Error("frame exceeds the maximum frame size"));
      return;
    }
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      try {
        onFrame(JSON.parse(line));
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  const onEnd = (): void => {
    const line = buffer.trim();
    buffer = "";
    if (line.length === 0) return;
    try {
      onFrame(JSON.parse(line));
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", (err: Error) => onError(err));

  return {
    close(): void {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
    },
  };
}

/** Write one frame as a single NDJSON line. */
export function writeFrame(output: Writable, frame: unknown): void {
  output.write(`${JSON.stringify(frame)}\n`);
}
