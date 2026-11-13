/**
 * Bounded per-session event ring buffer.
 *
 * The buffer is bounded by a maximum number of events and by a maximum
 * number of bytes. When a bound is exceeded the oldest events are dropped;
 * the highest dropped sequence number is remembered so that a resume can
 * report the hole it has to bridge.
 */

export type BufferedEvent = {
  seq: number;
  payload: unknown;
  bytes: number;
};

/** The events between `fromSeq` and `toSeq` (both inclusive) were lost. */
export type RingGap = { fromSeq: number; toSeq: number };

/** Rough wire size of a payload, used for the byte budget. */
export function estimateBytes(payload: unknown): number {
  let text: string;
  try {
    text = JSON.stringify(payload) ?? "null";
  } catch {
    text = String(payload);
  }
  return Buffer.byteLength(text, "utf8") + 16; // + framing overhead
}

export class EventRing {
  private events: BufferedEvent[] = [];
  private bytes = 0;
  private evictedThrough = 0;
  private lastSeqValue = 0;
  private maxEvents: number;
  private maxBytes: number;

  constructor(maxEvents: number, maxBytes: number) {
    this.maxEvents = Math.max(1, maxEvents);
    this.maxBytes = Math.max(256, maxBytes);
  }

  /** Highest sequence number handed to the ring. */
  get lastSeq(): number {
    return this.lastSeqValue;
  }

  /** Highest sequence number that was evicted from the ring. */
  get evictedThroughSeq(): number {
    return this.evictedThrough;
  }

  /** Number of buffered events. */
  get size(): number {
    return this.events.length;
  }

  /** Bytes currently held by the buffer. */
  get byteSize(): number {
    return this.bytes;
  }

  /** Append an event, evicting the oldest entries when over budget. */
  push(seq: number, payload: unknown): BufferedEvent {
    const event: BufferedEvent = { seq, payload, bytes: estimateBytes(payload) };
    this.events.push(event);
    this.bytes += event.bytes;
    if (seq > this.lastSeqValue) this.lastSeqValue = seq;
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
      const dropped = this.events.shift();
      if (!dropped) break;
      this.bytes -= dropped.bytes;
      if (dropped.seq > this.evictedThrough) this.evictedThrough = dropped.seq;
    }
    return event;
  }

  /**
   * Events from `fromSeq` onwards (inclusive). When events between `fromSeq`
   * and the oldest buffered event were dropped, the matching gap is returned
   * together with the events that survived.
   */
  since(fromSeq: number): { events: BufferedEvent[]; gap: RingGap | null } {
    const gap = fromSeq <= this.evictedThrough ? { fromSeq, toSeq: this.evictedThrough } : null;
    const start = Math.max(fromSeq, this.evictedThrough + 1);
    const events = this.events.filter((event) => event.seq >= start);
    return { events, gap };
  }

  /** Forget everything; the evicted marker moves to the last sequence. */
  clear(): void {
    this.events = [];
    this.bytes = 0;
    this.evictedThrough = this.lastSeqValue;
  }
}
