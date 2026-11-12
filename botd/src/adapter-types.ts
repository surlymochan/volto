// volto-botd adapter contract. Each bot adapter implements BotAdapter in botd/src/adapters/<kind>.ts
export type BotKind = "codex" | "claude" | "dsh" | "pi" | "agy" | "copilot";
export type ModelFamily = "gpt" | "claude" | "deepseek" | "minimax" | "gemini" | "other";

export interface SpawnSpec { command: string[]; env: Record<string, string>; cwd: string }
export interface OpenOptions { cwd: string; model?: string; effort?: string; resumeProviderSessionId?: string; systemPrompt?: string }

/** Normalized event emitted for every provider line; unknown lines map to kind:"raw". */
export type NormalizedEvent =
  | { kind: "ready"; providerSessionId?: string }
  | { kind: "text"; delta: string }
  | { kind: "tool"; name: string; status: "start" | "end" | "error"; summary?: string }
  | { kind: "permission"; id: string; request: unknown }
  | { kind: "turn_end"; status: "ok" | "error" | "cancelled"; usage?: { inputTokens?: number; outputTokens?: number } }
  | { kind: "error"; message: string }
  | { kind: "raw"; payload: unknown };

export interface BotAdapter {
  readonly kind: BotKind;
  readonly family: ModelFamily;
  /** Command to start the bot in its machine protocol (no shell, no secrets in argv). */
  spawn(opts: OpenOptions): SpawnSpec;
  /** Messages (already JSON-serializable) to write to stdin after spawn to initialize/open a session; may be empty. */
  handshake(opts: OpenOptions): unknown[];
  /** Wrap a user prompt into the provider's stdin message. */
  prompt(text: string, ctx: { providerSessionId?: string }): unknown;
  /** Provider-native cancel message(s), or [] if only signals work. */
  cancel(ctx: { providerSessionId?: string }): unknown[];
  /** Map one stdout JSON line to normalized events. Must never throw. */
  parse(line: string): NormalizedEvent[];
  /** Answer a permission request (auto-approve policy decided by caller). */
  answerPermission(id: string, allow: boolean): unknown | null;
}
