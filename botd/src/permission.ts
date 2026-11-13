// volto-botd permission policy.
//
// Pure, dependency-free decision function for the `permission` events the bot
// adapters normalize (see botd/src/adapter-types.ts). `decide()` answers one
// request with "allow", "deny" or "ask" and never performs I/O: the same
// (request, policy) pair always yields the same answer, which keeps the
// control plane reproducible and testable.
//
// A policy is an ordered list of rules plus a default:
//
//   { cwd, rules?, denyCommands?, allowCommands?, default? }
//
// A rule matches on the tool name (glob) and on the path scope of the
// request ("inside" | "outside" | "none"). The first matching rule decides.
// Command lists narrow a rule: `denyCommands` denies outright, `allowCommands`
// only lets the rule apply to the commands it lists.
//
// Precedence:
//
//   1. `policy.denyCommands`  -> deny   (hard deny, whatever the rules say)
//   2. first matching rule    -> the rule's decision
//   3. `policy.allowCommands` -> allow
//   4. `policy.default`       -> "ask" when unset
//
// Path scope is decided lexically against `cwd` (no filesystem access):
// "inside" when every path of the request resolves inside the working
// directory, "outside" when at least one path does not, "none" when the
// request mentions no path at all. A path that cannot be resolved (a shell
// variable, a home directory) counts as "outside"; a pattern is judged by its
// literal prefix, so "src/**" is inside and "/etc/**" is not.

import { isAbsolute, resolve, sep } from "node:path";

/** What to do with a permission request. */
export type PermissionDecision = "allow" | "deny" | "ask";

/** Where the paths of a request live relative to the policy's working directory. */
export type PathScope = "inside" | "outside" | "none";

/** A normalized permission request. */
export interface PermissionRequest {
  /** Tool name reported by the adapter ("Bash", "Read", "mcp__fs__write", ...). */
  tool: string;
  /** Filesystem paths the tool wants to touch. */
  paths?: string[];
  /** Shell command the tool wants to run (a string or an argv array). */
  command?: string | string[];
}

/** One rule of a policy. */
export interface PolicyRule {
  /** Glob over the tool name; omitted matches every tool. */
  tool?: string;
  /** Path scope the rule applies to; omitted matches every scope. */
  scope?: PathScope | "any";
  /** Command globs this rule denies (checked before `decision`). */
  denyCommands?: string[];
  /** Command globs this rule requires; a command matching none of them does not activate the rule. */
  allowCommands?: string[];
  /** Decision when the rule applies. */
  decision: PermissionDecision;
}

/** The policy a request is decided against. */
export interface PermissionPolicy {
  /** Working directory that bounds filesystem and shell access. */
  cwd: string;
  /** Rules, evaluated in order; the first matching rule decides. */
  rules?: PolicyRule[];
  /** Commands denied whatever the rules say. */
  denyCommands?: string[];
  /** Commands allowed when no rule matched. */
  allowCommands?: string[];
  /** Decision when nothing matched; defaults to "ask". */
  default?: PermissionDecision;
}

/** Keys a tool name can hide behind, most specific first. */
const TOOL_KEYS = ["tool_name", "toolName", "tool", "name"];

/** Keys of an ACP-style `toolCall` object, most specific first. */
const TOOL_CALL_KEYS = ["name", "kind", "title"];

/** Keys a file path can hide behind. */
const PATH_KEYS = [
  "file_path",
  "filePath",
  "abs_path",
  "absPath",
  "notebook_path",
  "notebookPath",
  "target_file",
  "targetFile",
  "file",
  "path",
];

/** Keys a list of file paths can hide behind. */
const PATH_LIST_KEYS = ["paths", "files", "file_paths", "filePaths"];

/** Keys a shell command can hide behind. */
const COMMAND_KEYS = ["command", "cmd", "script", "command_line", "commandLine"];

/** Keys that only carry other payload objects. */
const CONTAINER_KEYS = [
  "input",
  "rawInput",
  "raw_input",
  "params",
  "arguments",
  "args",
  "toolCall",
  "tool_call",
  "permissions",
  "edits",
];

/** How deep the payload walk follows nested objects. */
const MAX_DEPTH = 4;

/**
 * Decide what to do with one permission request.
 *
 * Pure: no I/O, no clock, no randomness. The same (request, policy) pair
 * always yields the same decision.
 */
export function decide(request: PermissionRequest, policy: PermissionPolicy): PermissionDecision {
  const facts = normalizeRequest(request);
  const scope = pathScope(facts.paths ?? [], policy.cwd);
  const commands = commandVariants(facts.command);

  // Hard denies win over every rule.
  if (matchesCommand(commands, policy.denyCommands)) return "deny";

  for (const rule of policy.rules ?? []) {
    if (!ruleMatches(rule, facts.tool, scope)) continue;
    if (matchesCommand(commands, rule.denyCommands)) return "deny";
    if (rule.allowCommands && rule.allowCommands.length > 0) {
      // The rule only speaks for the commands it allows.
      if (commands.length === 0) continue;
      if (!matchesCommand(commands, rule.allowCommands)) continue;
    }
    return rule.decision;
  }

  if (matchesCommand(commands, policy.allowCommands)) return "allow";

  return policy.default ?? "ask";
}

/**
 * Reduce a provider payload to the facts a decision needs.
 *
 * Accepts an already normalized request as well as the raw payloads the
 * adapters hand over (a Claude `can_use_tool` request, an ACP `toolCall`, a
 * Codex approval request). Unknown payloads degrade to an empty request, which
 * the policy answers with its default.
 */
export function normalizeRequest(raw: unknown): PermissionRequest {
  const root = asRecord(raw);
  if (!root) return { tool: "", paths: [] };

  // A normalized event ({kind:"permission", id, request}) is unwrapped.
  const payload =
    root.kind === "permission" && "request" in root ? asRecord(root.request) ?? root : root;

  const tool = findTool(payload);
  const command = findCommand(payload);
  const paths = findPaths(payload);
  if (command !== undefined) paths.push(...commandPaths(command));

  return { tool, paths, command };
}

/**
 * Classify paths against a working directory.
 *
 * "inside" when every path resolves inside `cwd`, "outside" when at least one
 * does not, "none" when there is no path at all. A path that cannot be
 * resolved lexically (shell variable, home directory) counts as "outside": it
 * is not provably inside the working directory. A pattern is judged by its
 * literal prefix, so "src/**" is inside and "/etc/**" is not.
 */
export function pathScope(paths: string[], cwd: string): PathScope {
  const root = resolveRoot(cwd);
  if (root === undefined) return "none";

  const prefix = root.endsWith(sep) ? root : root + sep;
  let inside = false;
  for (const path of paths) {
    const resolved = resolvePath(path, root);
    if (resolved === undefined) return "outside";
    if (resolved === root || resolved.startsWith(prefix)) inside = true;
    else return "outside";
  }
  return inside ? "inside" : "none";
}

/**
 * A reference policy: deny the dangerous commands, deny everything that
 * reaches outside the working directory, allow reads inside it and ask for
 * the rest.
 */
export function referencePolicy(cwd: string): PermissionPolicy {
  return {
    cwd,
    denyCommands: [
      "sudo*",
      "git push*",
      "curl*|sh*",
      "curl*|bash*",
      "wget*|sh*",
      "wget*|bash*",
    ],
    rules: [
      // Nothing reaches outside the working directory.
      { scope: "outside", decision: "deny" },
      // Reading inside the working directory is fine.
      { tool: "Read*", decision: "allow" },
      { tool: "Glob*", decision: "allow" },
      { tool: "Grep*", decision: "allow" },
    ],
    default: "ask",
  };
}

function ruleMatches(rule: PolicyRule, tool: string, scope: PathScope): boolean {
  if (rule.tool !== undefined && !globToRegExp(rule.tool, false).test(tool)) return false;
  const wanted = rule.scope ?? "any";
  if (wanted !== "any" && wanted !== scope) return false;
  return true;
}

function matchesCommand(commands: string[], patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0 || commands.length === 0) return false;
  return patterns.some((pattern) => {
    const expression = globToRegExp(canonicalCommand(pattern), true);
    return commands.some((command) => expression.test(command));
  });
}

/**
 * The strings a command is matched as.
 *
 * An argv command is matched as a whole ("bash -lc git push") and per part,
 * so a wrapper like `bash -lc` does not hide the command it runs.
 */
function commandVariants(command: string | string[] | undefined): string[] {
  if (command === undefined) return [];
  if (typeof command === "string") return [canonicalCommand(command)];
  const variants = [canonicalCommand(command.join(" "))];
  for (const part of command) variants.push(canonicalCommand(part));
  return variants;
}

function findTool(record: Record<string, unknown>): string {
  for (const key of TOOL_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  const call = asRecord(record.toolCall) ?? asRecord(record.tool_call);
  if (call) {
    for (const key of TOOL_CALL_KEYS) {
      const value = call[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  }
  return "unknown";
}

function findPaths(record: Record<string, unknown>, depth = 0): string[] {
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value !== "") paths.push(value);
  }
  for (const key of PATH_LIST_KEYS) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry !== "") paths.push(entry);
    }
  }
  if (depth >= MAX_DEPTH) return paths;

  for (const key of CONTAINER_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = asRecord(entry);
        if (nested) paths.push(...findPaths(nested, depth + 1));
      }
      continue;
    }
    const nested = asRecord(value);
    if (nested) paths.push(...findPaths(nested, depth + 1));
  }
  return paths;
}

function findCommand(record: Record<string, unknown>, depth = 0): string | string[] | undefined {
  for (const key of COMMAND_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
    if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string")) {
      return value as string[];
    }
  }
  if (depth >= MAX_DEPTH) return undefined;

  for (const key of CONTAINER_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = asRecord(entry);
        if (!nested) continue;
        const command = findCommand(nested, depth + 1);
        if (command !== undefined) return command;
      }
      continue;
    }
    const nested = asRecord(value);
    if (!nested) continue;
    const command = findCommand(nested, depth + 1);
    if (command !== undefined) return command;
  }
  return undefined;
}

/**
 * Path-like tokens of a shell command.
 *
 * Flags, `KEY=value` pairs and urls are ignored; a variable that looks like a
 * path is kept so it counts as unresolvable (and therefore outside).
 */
function commandPaths(command: string | string[]): string[] {
  const text = Array.isArray(command) ? command.join(" ") : command;
  const paths: string[] = [];
  for (const token of text.split(/[\s"'`;|&<>()]+/)) {
    if (token === "") continue;
    if (token.startsWith("-")) continue;
    if (token.includes("://")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (token.startsWith("$") && !token.includes("/") && !token.includes("~")) continue;
    paths.push(token);
  }
  return paths;
}

/** Collapse whitespace and drop the spaces around shell separators. */
function canonicalCommand(command: string | string[]): string {
  const text = Array.isArray(command) ? command.join(" ") : command;
  return text.replace(/\s+/g, " ").replace(/\s*([|;&])\s*/g, "$1").trim();
}

function resolveRoot(cwd: string): string | undefined {
  if (typeof cwd !== "string" || cwd.trim() === "") return undefined;
  try {
    return resolve(cwd);
  } catch {
    return undefined;
  }
}

function resolvePath(path: string, root: string): string | undefined {
  if (typeof path !== "string" || path.trim() === "") return undefined;
  const value = path.trim();
  // A variable and a home directory cannot be resolved lexically.
  if (value.includes("$")) return undefined;
  if (value.startsWith("~")) return undefined;

  // A pattern is judged by its literal prefix.
  const wildcard = value.search(/[*?]/);
  const literal = wildcard === -1 ? value : value.slice(0, wildcard);
  if (literal === "") {
    // Only a relative pattern has no literal prefix; it stays in the work
    // tree unless it can climb out of it.
    if (isAbsolute(value) || hasParentSegment(value)) return undefined;
    return root;
  }
  try {
    return isAbsolute(literal) ? resolve(literal) : resolve(root, literal);
  } catch {
    return undefined;
  }
}

/** True when a path can climb out of its base directory. */
function hasParentSegment(value: string): boolean {
  return value.split("/").some((segment) => segment === "..");
}

/**
 * Glob to regular expression.
 *
 * `*` matches any run of characters except a path separator, `**` matches
 * everything, `?` matches a single character. Command patterns are matched
 * with `crossSlash` enabled because commands carry urls and paths.
 */
function globToRegExp(pattern: string, crossSlash: boolean): RegExp {
  const any = crossSlash ? ".*" : "[^/]*";
  const single = crossSlash ? "." : "[^/]";
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        source += ".*";
      } else {
        source += any;
      }
    } else if (char === "?") {
      source += single;
    } else if ("\\^$.|+()[]{}".includes(char)) {
      source += "\\" + char;
    } else {
      source += char;
    }
  }
  return new RegExp("^" + source + "$");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
