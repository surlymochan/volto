import type { BotKind, NormalizedEvent } from "./adapter-types.ts";

type Totals = { turns: number; ok: number; error: number; cancelled: number; inputTokens: number; outputTokens: number; unknownUsageTurns: number; estimatedCostUsd: number };
type Price = { input: number; output: number };
type Options = { maxTotalTokens?: number; price?: Partial<Record<BotKind, Price>> };
type Counts = { turns: bigint; ok: bigint; error: bigint; cancelled: bigint; inputTokens: bigint; outputTokens: bigint; unknownUsageTurns: bigint; costNumerator: bigint };
const empty = (): Counts => ({ turns: 0n, ok: 0n, error: 0n, cancelled: 0n, inputTokens: 0n, outputTokens: 0n, unknownUsageTurns: 0n, costNumerator: 0n });
const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const safe = (n: bigint): number => Number(n > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : n);
const microPrice = (n: number | undefined): bigint => typeof n === "number" && Number.isFinite(n) && n >= 0 ? BigInt(Math.round(Math.min(n * 1_000_000, Number.MAX_SAFE_INTEGER))) : 0n;
const view = (c: Counts): Totals => ({ turns: safe(c.turns), ok: safe(c.ok), error: safe(c.error), cancelled: safe(c.cancelled), inputTokens: safe(c.inputTokens), outputTokens: safe(c.outputTokens), unknownUsageTurns: safe(c.unknownUsageTurns), estimatedCostUsd: Number((c.costNumerator + 500_000n) / 1_000_000n) / 1_000_000 });
const add = (a: Counts, b: Counts) => { for (const key of Object.keys(a) as (keyof Counts)[]) a[key] += b[key]; };

/** In-memory accounting. Token totals saturate at MAX_SAFE_INTEGER in snapshots. */
export class UsageTracker {
  private sessions = new Map<string, Map<BotKind, Counts>>();
  private options: Options;
  constructor(options: Options = {}) { this.options = options; }

  record(sessionId: string, botKind: BotKind, event: NormalizedEvent): void {
    if (event.kind !== "turn_end") return;
    let bots = this.sessions.get(sessionId);
    if (!bots) this.sessions.set(sessionId, bots = new Map());
    let c = bots.get(botKind);
    if (!c) bots.set(botKind, c = empty());
    c.turns++; c[event.status]++;
    const input = event.usage?.inputTokens, output = event.usage?.outputTokens;
    if (!valid(input) || !valid(output)) c.unknownUsageTurns++;
    const i = valid(input) ? BigInt(input) : 0n, o = valid(output) ? BigInt(output) : 0n;
    c.inputTokens += i; c.outputTokens += o;
    const price = this.options.price?.[botKind];
    c.costNumerator += i * microPrice(price?.input) + o * microPrice(price?.output);
  }

  snapshot(): { sessions: Record<string, Totals>; bots: Record<string, Totals> } {
    const sessions: Record<string, Totals> = Object.create(null), bots: Record<string, Totals> = Object.create(null);
    const botCounts = new Map<string, Counts>();
    for (const [id, entries] of [...this.sessions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const total = empty();
      for (const [kind, c] of entries) {
        add(total, c);
        let bot = botCounts.get(kind);
        if (!bot) botCounts.set(kind, bot = empty());
        add(bot, c);
      }
      sessions[id] = view(total);
    }
    for (const [kind, c] of [...botCounts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) bots[kind] = view(c);
    return { sessions, bots };
  }

  forget(sessionId: string): void { this.sessions.delete(sessionId); }

  check(sessionId: string): { exceeded: boolean; remaining: number | null } {
    const limit = this.options.maxTotalTokens;
    if (!valid(limit)) return { exceeded: false, remaining: null };
    let used = 0n;
    for (const c of this.sessions.get(sessionId)?.values() ?? []) used += c.inputTokens + c.outputTokens;
    const remaining = BigInt(limit) - used;
    return { exceeded: remaining <= 0n, remaining: remaining > 0n ? safe(remaining) : 0 };
  }
}
