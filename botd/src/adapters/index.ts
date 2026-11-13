// botd/src/adapters/index.ts
//
// Registry of the bot adapters.
//
// This module is the single place that knows every adapter kind the control
// plane can drive. For each kind it records the metadata the control plane
// needs before it starts a session (model family, machine protocol, whether
// the provider supports resuming and cancelling) and whether the adapter is
// enabled at all.
//
//   ADAPTER_CAPABILITIES  -> the capability table (one row per known kind)
//   listAdapters()        -> the same table as plain copies
//   getAdapter(kind)      -> a fresh adapter instance for that kind
//
// Adapters keep per-session state (session ids, pending permissions, token
// usage), so one instance belongs to one session: callers ask for a new
// instance per session instead of sharing a singleton.
//
// The `pi` adapter is optional: its module is not necessarily part of this
// build. It is therefore loaded lazily and defensively -- when the module is
// missing the kind stays in the table with `enabled: false` and `getAdapter`
// hands out a placeholder that refuses to talk to a provider.

import { createRequire } from "node:module";

import type {
  BotAdapter,
  BotKind,
  ModelFamily,
  NormalizedEvent,
  OpenOptions,
  SpawnSpec,
} from "../adapter-types.ts";

import { createAgyAdapter, detectAgyProtocol } from "./agy.ts";
import type { AgyProtocol } from "./agy.ts";
import { createClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";
import { CopilotAdapter, copilotUnavailableReason } from "./copilot.ts";
import { DshAdapter } from "./dsh.ts";

/** Machine protocol an adapter speaks to its provider. */
export type AdapterProtocol = "acp" | "stream-json" | "json-rpc" | "rpc";

/** What the control plane can expect from one adapter kind. */
export interface AdapterCapability {
  /** Adapter kind this row describes. */
  readonly kind: BotKind;
  /** Model family the provider belongs to. */
  readonly family: ModelFamily;
  /** Machine protocol spoken on the provider's wire. */
  readonly protocol: AdapterProtocol;
  /** The provider session can be resumed after a restart. */
  readonly supportsResume: boolean;
  /** The provider offers a native cancel (not only a signal). */
  readonly supportsCancel: boolean;
  /** The adapter may be used as-is. */
  readonly enabled: boolean;
}

const codexRow: AdapterCapability = {
  kind: "codex",
  family: "gpt",
  protocol: "json-rpc",
  supportsResume: true,
  supportsCancel: true,
  enabled: true,
};

const claudeRow: AdapterCapability = {
  kind: "claude",
  family: "claude",
  protocol: "stream-json",
  supportsResume: true,
  supportsCancel: true,
  enabled: true,
};

const dshRow: AdapterCapability = {
  kind: "dsh",
  family: "deepseek",
  protocol: "acp",
  supportsResume: false,
  supportsCancel: true,
  enabled: true,
};

// `agy` speaks ACP when its binary advertises it and falls back to the
// Claude-compatible stream-json protocol otherwise (see adapters/agy.ts).
// The row states the capabilities of the ACP protocol; the stream-json
// fallback can only be cancelled with a signal.
const agyRow: AdapterCapability = {
  kind: "agy",
  family: "gemini",
  protocol: "acp",
  supportsResume: true,
  supportsCancel: true,
  enabled: true,
};

const copilotRow: AdapterCapability = {
  kind: "copilot",
  family: "other",
  protocol: "acp",
  supportsResume: true,
  supportsCancel: true,
  // The Copilot CLI needs a paid seat, so the adapter ships disabled: it only
  // becomes usable when the operator opts in with COPILOT_ENABLED=1. The
  // adapter checks the very same thing when it is spawned (see
  // adapters/copilot.ts).
  get enabled(): boolean {
    return copilotUnavailableReason() === undefined;
  },
};

// The `pi` row is filled in lazily: the module is optional, so the row is
// only completed when it is actually read. The family falls back to the one
// the pi CLI reports (see probes/REPORT.md); once the module is part of the
// build the adapter itself names the family.
const piRow: AdapterCapability = {
  kind: "pi",
  get family(): ModelFamily {
    return piState().adapter?.family ?? "minimax";
  },
  protocol: "rpc",
  supportsResume: true,
  supportsCancel: true,
  get enabled(): boolean {
    return piState().enabled;
  },
};

/**
 * The capability table: one row per adapter kind the control plane knows.
 */
export const ADAPTER_CAPABILITIES: readonly AdapterCapability[] = Object.freeze([
  codexRow,
  claudeRow,
  dshRow,
  agyRow,
  copilotRow,
  piRow,
].map((row) => Object.freeze(row)));

/** The capability table as plain copies, one row per adapter kind. */
export function listAdapters(): AdapterCapability[] {
  return ADAPTER_CAPABILITIES.map((row) => ({ ...row }));
}

/**
 * Build a fresh adapter instance for `kind`.
 *
 * Every kind of the capability table resolves; an unknown kind throws.
 */
export function getAdapter(kind: BotKind): BotAdapter {
  switch (kind) {
    case "codex":
      return new CodexAdapter();
    case "claude":
      return createClaudeAdapter();
    case "dsh":
      return new DshAdapter();
    case "agy":
      // The protocol is detected once (ACP when the binary advertises it, the
      // stream-json fallback otherwise) and then reused for every adapter.
      return createAgyAdapter({ protocol: agyProtocol() });
    case "copilot":
      return new CopilotAdapter();
    case "pi": {
      const adapter = piState().adapter;
      return adapter ?? new UnavailableAdapter(piRow);
    }
    default:
      throw new Error(
        `unknown adapter kind "${String(kind)}"; known kinds: ${knownKinds().join(", ")}`,
      );
  }
}

// ---------------------------------------------------------------- optional pi

/** Loader for the optional `pi` module. */
const requireOptional = createRequire(import.meta.url);

interface PiState {
  /** The real adapter, when the module could be loaded. */
  adapter?: BotAdapter;
  /** True when the module is present and does not disable itself. */
  enabled: boolean;
}

let piCache: PiState | undefined;

/**
 * Load the optional `pi` adapter once.
 *
 * The module may be absent (this build ships without it) or may disable
 * itself the way the copilot adapter does; both cases report `enabled: false`.
 */
function piState(): PiState {
  if (piCache) return piCache;

  piCache = { enabled: false };

  let module: Record<string, unknown>;
  try {
    module = requireOptional("./pi.ts") as Record<string, unknown>;
  } catch (error) {
    // A missing module is the expected case for an optional adapter. An async
    // module cannot be required synchronously either; both mean the adapter
    // is not usable. Anything else is a real bug and is not hidden.
    const code = (error as { code?: string } | null)?.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_REQUIRE_ASYNC_MODULE") throw error;
    return piCache;
  }

  const adapter = instantiatePi(module);
  if (!adapter) return piCache;

  // A module may disable itself the way the copilot adapter does.
  const disabled = module.enabled as boolean | undefined;
  piCache = { adapter, enabled: disabled !== false };
  return piCache;
}

/** Pick an adapter instance out of the optional module's exports. */
function instantiatePi(module: Record<string, unknown>): BotAdapter | undefined {
  const factory = module.createPiAdapter as (() => unknown) | undefined;
  if (typeof factory === "function") {
    const made = callSafely(() => factory());
    if (isAdapter(made)) return made;
  }

  const klass = module.PiAdapter as (new () => unknown) | undefined;
  if (typeof klass === "function") {
    const made = callSafely(() => new klass());
    if (isAdapter(made)) return made;
  }

  const fallback = module.default;
  if (typeof fallback === "function") {
    const made = callSafely(() => new (fallback as new () => unknown)());
    if (isAdapter(made)) return made;
  } else if (isAdapter(fallback)) {
    return fallback;
  }

  const instance = module.piAdapter;
  if (isAdapter(instance)) return instance;

  return undefined;
}

/** Run a constructor or factory without letting it break the registry. */
function callSafely<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

/** True when the value looks like a bot adapter. */
function isAdapter(value: unknown): value is BotAdapter {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BotAdapter>;
  return typeof candidate.kind === "string" && typeof candidate.spawn === "function";
}

// ------------------------------------------------------------------- helpers

/** The `agy` protocol is detected once and then reused. */
let agyProtocolCache: AgyProtocol | undefined;

function agyProtocol(): AgyProtocol {
  if (!agyProtocolCache) agyProtocolCache = detectAgyProtocol();
  return agyProtocolCache;
}

/** Every kind the registry knows about. */
function knownKinds(): string[] {
  return ADAPTER_CAPABILITIES.map((row) => row.kind).sort();
}

/**
 * Placeholder for an adapter whose module is not part of this build.
 *
 * It satisfies the adapter contract so the control plane can list and plan
 * work, but every call that would touch a provider fails with a clear error.
 */
class UnavailableAdapter implements BotAdapter {
  readonly kind: BotKind;
  readonly family: ModelFamily;

  constructor(row: AdapterCapability) {
    this.kind = row.kind;
    this.family = row.family;
  }

  #unavailable(): never {
    throw new Error(
      `the ${this.kind} adapter is not available in this build ` +
        `(botd/src/adapters/${this.kind}.ts is missing)`,
    );
  }

  spawn(_opts: OpenOptions): SpawnSpec {
    return this.#unavailable();
  }

  handshake(_opts: OpenOptions): unknown[] {
    return this.#unavailable();
  }

  prompt(_text: string, _ctx: { providerSessionId?: string }): unknown {
    return this.#unavailable();
  }

  cancel(_ctx: { providerSessionId?: string }): unknown[] {
    return this.#unavailable();
  }

  parse(_line: string): NormalizedEvent[] {
    return [];
  }

  answerPermission(_id: string, _allow: boolean): unknown | null {
    return this.#unavailable();
  }
}
