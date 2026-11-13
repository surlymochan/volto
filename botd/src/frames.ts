/**
 * NDJSON framing helpers.
 *
 * A frame is one JSON object per line. The reader is line oriented and
 * tolerant of chunk boundaries: a line may arrive in several chunks and one
 * chunk may carry several lines.
 */
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

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
  let bytes = 0;
  let discarding = false;
  const decoder = new StringDecoder("utf8");

  const parseLine = (line: string): void => {
    line = line.trim();
    if (line.length === 0) return;
    try {
      onFrame(JSON.parse(line));
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const consume = (text: string): void => {
    let start = 0;
    for (;;) {
      const index = text.indexOf("\n", start);
      const part = text.slice(start, index === -1 ? undefined : index);
      if (!discarding) {
        bytes += Buffer.byteLength(part, "utf8");
        if (bytes > MAX_FRAME_BYTES) {
          buffer = "";
          bytes = 0;
          discarding = true;
          onError(new Error("frame exceeds the maximum frame size"));
        } else {
          buffer += part;
        }
      }
      if (index === -1) break;
      if (!discarding) parseLine(buffer);
      buffer = "";
      bytes = 0;
      discarding = false;
      start = index + 1;
    }
  };

  const onData = (chunk: Buffer | string): void => {
    consume(typeof chunk === "string" ? decoder.end() + chunk : decoder.write(chunk));
  };

  const onEnd = (): void => {
    consume(decoder.end());
    if (!discarding) parseLine(buffer);
    buffer = "";
  };

  const onInputError = (err: Error): void => onError(err);

  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", onInputError);

  return {
    close(): void {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onInputError);
    },
  };
}

/** Write one frame as a single NDJSON line. */
export function writeFrame(output: Writable, frame: unknown): void {
  output.write(`${JSON.stringify(frame)?.replace(/\u2028/g, "\\u2028")}\n`);
}
