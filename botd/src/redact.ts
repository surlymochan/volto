// botd/src/redact.ts
//
// Mask secrets before anything leaves the bot daemon.
//
// The rules are deliberately boring and explicit: a table of well known
// credential shapes, key/value pairs that look like secrets, and — when asked
// for — host names and addresses. Nothing here is clever enough to be clever
// on a bad day, and every rule has a matching false positive test.
//
// The module is pure and dependency free: the same input always yields the
// same output, and nothing is ever mutated in place. Objects are copied on
// the way out, so the caller's data stays untouched.

/** Placeholder used for every masked secret. */
export const REDACTED = "<redacted>";

/** Placeholder used for masked host names. */
export const REDACTED_HOST = "<host>";

/** Placeholder used for masked IP addresses. */
export const REDACTED_IP = "<ip>";

export interface RedactOptions {
  /** Also mask host names and IP addresses. Off by default. */
  hostMask?: boolean;
  /** Mask values stored under secret looking keys. On by default. */
  maskSecretKeys?: boolean;
}

/** One whitespace separated token of a command line. */
interface Token {
  value: string;
  start: number;
  end: number;
}

// --- secrets ---------------------------------------------------------------

/** PEM blocks, whatever the key type is (RSA, EC, OPENSSH, PGP, ...). */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;

/** User components of common home paths, leaving the rest readable. */
const HOME_PATH = /(?<![A-Za-z0-9_./\\-])((?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\))([^\s/\\<>"':;,]+)|(?<![A-Za-z0-9_./~-])(~)([A-Za-z0-9_][A-Za-z0-9_.-]*)(?=\/)/g;

/** Words that introduce a secret when used as a key. */
const SECRET_KEY_WORDS =
  "api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|" +
  "session[_-]?key|client[_-]?secret|private[_-]?key|authorization|credentials|" +
  "credential|passphrase|password|passwd|secret|token|pwd";

/** `password=…`, `"token": "…"`, `api-key = …` and friends. */
const KEY_VALUE_PAIR = new RegExp(
  `\\b(${SECRET_KEY_WORDS})(?![A-Za-z0-9_-])(["']?)(\\s*[:=]+\\s*)` +
    `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|` +
    `(?:bearer|basic|digest|negotiate)\\s+[^\\s,;&)\\]}]+|[^\\s,;&)\\]}]+)`,
  "gi",
);

/** `Authorization: Bearer <token>` outside of a key/value pair. */
const BEARER_TOKEN = /\b(bearer)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

/** Stand alone credential shapes. */
const SECRET_PATTERNS: readonly RegExp[] = [
  // `sk-…`, including the `sk-ant-…` flavour.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // GitHub personal access / OAuth / user / server tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  // GitHub fine grained personal access tokens.
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack tokens.
  /\bxox[baprse]-[A-Za-z0-9-]{10,}/g,
  // JSON web tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** Object keys whose value is a secret whatever the value looks like. */
const SECRET_KEY_NAMES = new Set([
  "apikey",
  "apisecret",
  "accesstoken",
  "auth",
  "authorization",
  "authtoken",
  "bearer",
  "clientsecret",
  "credential",
  "credentials",
  "idtoken",
  "passphrase",
  "passwd",
  "password",
  "privatekey",
  "pwd",
  "refreshtoken",
  "secret",
  "sessionkey",
  "token",
]);

// --- hosts -----------------------------------------------------------------

/** Top level domains that make a dotted name look like a host name. */
const HOST_TLDS = new Set([
  "ai",
  "app",
  "cloud",
  "com",
  "dev",
  "example",
  "internal",
  "invalid",
  "io",
  "lan",
  "local",
  "net",
  "org",
  "test",
]);

/** `scheme://user:pass@host:port/path`. */
const URL_AUTHORITY = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#"'<>]+)/gi;

/** Dotted quad. Validated before it is masked. */
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

/** Full form IPv6 (`8` groups). */
const IPV6_FULL = /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f:])/g;

/** Compressed form IPv6 (contains `::`). */
const IPV6_COMPRESSED =
  /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?(?![0-9A-Fa-f:])/g;

/** `ssh`, `scp`, `sftp` and `rsync` invocations. */
const SSH_COMMAND = /\b(ssh|scp|sftp|rsync)([ \t]+[^\n]*)/gi;

/** `Host name` / `Hostname name` lines of an ssh config. */
const SSH_CONFIG_HOST = /(^|\n)([ \t]*(?:Host|Hostname)[ \t]+)(\S+)/g;

/** A dotted name, e.g. `build-box.internal`. */
const DOTTED_NAME =
  /\b[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+\b/g;

/** Flags of `ssh` that swallow the next argument. */
const SSH_VALUE_FLAGS = new Set([
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-o",
  "-p",
  "-R",
  "-w",
  "-W",
]);

/** Words that are far more likely to be English than a host name. */
const NOT_A_HOST = new Set([
  "a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at",
  "back", "be", "because", "been", "before", "but", "by", "can", "do", "does",
  "for", "from", "get", "go", "he", "her", "here", "his", "how", "i", "if",
  "in", "into", "is", "it", "its", "just", "keep", "let", "like", "make", "me",
  "more", "my", "no", "not", "now", "of", "on", "once", "one", "only", "or",
  "other", "our", "out", "over", "please", "run", "same", "she", "should", "so",
  "some", "still", "such", "than", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "those", "through", "to", "too", "two",
  "up", "us", "use", "very", "was", "we", "were", "what", "when", "where",
  "which", "while", "who", "why", "will", "with", "would", "you", "your",
]);

/**
 * Mask the secrets in a piece of text.
 *
 * Everything that looks like a credential is replaced by {@link REDACTED};
 * host names and IP addresses are only touched when `options.hostMask` is
 * set, because a transcript often needs a usable host to stay useful.
 */
export function redactText(text: string, options: RedactOptions = {}): string {
  if (typeof text !== "string" || text.length === 0) return text;

  let out = text;
  // The PEM block goes first: it is the one secret that spans many lines.
  out = out.replace(PRIVATE_KEY_BLOCK, REDACTED);
  out = out.replace(KEY_VALUE_PAIR, maskKeyValuePair);
  out = out.replace(BEARER_TOKEN, `$1$2${REDACTED}`);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(HOME_PATH, (_match, prefix: string, _user: string, tilde: string) =>
    `${prefix ?? tilde}<user>`,
  );
  if (options.hostMask) out = maskHosts(out);
  return out;
}

/**
 * Mask the secrets in a value of any shape.
 *
 * Strings are masked with {@link redactText}, arrays and plain objects are
 * walked (and copied) recursively. The input is never modified: the returned
 * value is a fresh copy for every container it rebuilt.
 */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  return walk(value, options, new WeakMap<object, unknown>()) as T;
}

/** True when an object key names a secret, whatever the value looks like. */
export function isSecretKeyName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length === 0) return false;
  if (SECRET_KEY_NAMES.has(normalized)) return true;
  // `x-api-key`, `my_token`, `refreshToken`: a secret name at the end.
  for (const name of SECRET_KEY_NAMES) {
    if (normalized.length > name.length && normalized.endsWith(name)) return true;
  }
  return false;
}

// --- internals -------------------------------------------------------------

function maskKeyValuePair(
  match: string,
  key: string,
  quote: string,
  separator: string,
  value: string,
): string {
  const masked = maskSecretValue(value);
  if (masked === null) return match;
  return `${key}${quote}${separator}${masked}`;
}

/** Mask the value of a `key=value` pair, keeping quotes and scheme. */
function maskSecretValue(value: string): string | null {
  if (value.length === 0) return null;

  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    if (inner.length === 0) return null;
    return `${quote}${REDACTED}${quote}`;
  }

  const scheme = /^(bearer|basic|digest|negotiate)\s+\S/i.exec(value);
  if (scheme) return `${scheme[1]} ${REDACTED}`;

  return REDACTED;
}

function walk(
  value: unknown,
  options: RedactOptions,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") return redactText(value, options);

  if (Array.isArray(value)) {
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    const out: unknown[] = [];
    seen.set(value, out);
    for (const entry of value) out.push(walk(entry, options, seen));
    return out;
  }

  if (value !== null && typeof value === "object") {
    if (!isPlainObject(value)) return value;
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    const maskKeys = options.maskSecretKeys !== false;
    for (const [key, entry] of Object.entries(value)) {
      if (maskKeys && isSecretKeyName(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = walk(entry, options, seen);
    }
    return out;
  }

  return value;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function maskHosts(text: string): string {
  let out = text;
  out = out.replace(URL_AUTHORITY, maskUrlAuthority);
  out = out.replace(IPV4, (match) => (isIpv4(match) ? REDACTED_IP : match));
  out = out.replace(IPV6_FULL, REDACTED_IP);
  out = out.replace(IPV6_COMPRESSED, REDACTED_IP);
  out = out.replace(SSH_COMMAND, maskSshCommand);
  out = out.replace(SSH_CONFIG_HOST, (_match, lead: string, directive: string) =>
    `${lead}${directive}${REDACTED_HOST}`,
  );
  out = out.replace(DOTTED_NAME, (match) => (isHostName(match) ? REDACTED_HOST : match));
  return out;
}

function maskUrlAuthority(match: string, scheme: string, authority: string): string {
  let host = authority;
  const at = host.lastIndexOf("@");
  if (at !== -1) host = host.slice(at + 1);

  let port = "";
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close !== -1) {
      port = host.slice(close + 1);
      host = host.slice(1, close);
    }
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1 && /^\d*$/.test(host.slice(colon + 1))) {
      port = host.slice(colon);
      host = host.slice(0, colon);
    }
  }

  if (host.length === 0) return match;
  const masked = isIpv4(host) || isIpv6(host) ? REDACTED_IP : REDACTED_HOST;
  return `${scheme}${masked}${port}`;
}

function maskSshCommand(match: string, command: string, tail: string): string {
  const verb = command.toLowerCase();
  const tokens = splitTokens(tail);
  if (tokens.length === 0) return match;

  let target: Token | undefined;
  if (verb === "ssh") {
    target = sshTarget(tokens);
  } else {
    // scp, sftp and rsync only talk to a remote host when the last argument
    // carries one (`user@host:path`, `host::path`, ...).
    const last = tokens[tokens.length - 1];
    if (last.value.includes("@") || last.value.includes(":")) target = last;
  }
  if (target === undefined) return match;

  const masked = maskHostToken(target.value);
  if (masked === target.value) return match;
  return `${command}${tail.slice(0, target.start)}${masked}${tail.slice(target.end)}`;
}

function splitTokens(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ value: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** The host of an `ssh` invocation, skipping the flags. */
function sshTarget(tokens: Token[]): Token | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.value.startsWith("-")) {
      if (SSH_VALUE_FLAGS.has(token.value) && i + 1 < tokens.length) i++;
      continue;
    }
    if (token.value.includes("=")) continue;
    return token;
  }
  return undefined;
}

/** Mask the host part of `user@host:port/path`. */
function maskHostToken(token: string): string {
  let prefix = "";
  let rest = token;

  const at = rest.lastIndexOf("@");
  if (at !== -1) {
    prefix = rest.slice(0, at + 1);
    rest = rest.slice(at + 1);
  }

  let path = "";
  const slash = rest.indexOf("/");
  if (slash !== -1) {
    path = rest.slice(slash);
    rest = rest.slice(0, slash);
  }

  let port = "";
  const colon = rest.indexOf(":");
  if (colon !== -1) {
    const tail = rest.slice(colon + 1);
    if (/^\d+$/.test(tail)) {
      // `host:port`
      port = rest.slice(colon);
      rest = rest.slice(0, colon);
    } else {
      // `host:path`
      path = `:${tail}${path}`;
      rest = rest.slice(0, colon);
    }
  }

  if (rest.length === 0) return token;
  if (!looksLikeHost(rest)) return token;

  const masked = isIpv4(rest) || isIpv6(rest) ? REDACTED_IP : REDACTED_HOST;
  return `${prefix}${masked}${port}${path}`;
}

/** True when a token is worth masking as a host name. */
function looksLikeHost(token: string): boolean {
  if (isIpv4(token) || isIpv6(token)) return true;
  if (token.includes("@")) return true;
  if (token.includes(".")) return isHostName(token);
  return !NOT_A_HOST.has(token.toLowerCase());
}

/** True when a dotted name ends in a top level domain we treat as a host. */
function isHostName(name: string): boolean {
  const labels = name.split(".");
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1].toLowerCase();
  return HOST_TLDS.has(tld);
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isIpv6(value: string): boolean {
  if (value.includes(":::")) return false;
  if (value.includes("::")) return true;
  return (value.match(/:/g) ?? []).length === 7;
}
