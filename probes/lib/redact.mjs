// probes/lib/redact.mjs
//
// Redaction helpers. Nothing that leaves the probe harness (transcripts,
// REPORT.md) may contain host names, IP addresses, credentials or tokens.

const SECRET_KEY = /(api[_-]?key|apikey|secret|password|passwd|token|authorization|credential|bearer|session[_-]?key|private[_-]?key)/i;
const IDENTITY_KEY = /^(installationid|deviceid|machineid|userid|username|user|email|servername|hostname|host|ip|ipaddress|clientip|fqdn)$/i;

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-key>"],
  [/\bsk-ant-[A-Za-z0-9_-]{12,}/g, "<redacted-key>"],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, "<redacted-key>"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "<redacted-token>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<redacted-token>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-key>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "<redacted-token>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<redacted-token>"],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<redacted-token>"],
  [/("(?:api[_-]?key|apikey|secret|password|token|access_token|refresh_token|id_token|authorization|credential)"\s*:\s*")[^"]{3,}(")/gi, '$1<redacted>$2'],
  [/\b([\w.+-]+)@([\w-]+\.[\w.-]+\.[A-Za-z]{2,})\b/g, "<email>"],
  [/\bhttps?:\/\/[^\s"'<>]+/gi, (m) => m.replace(/^(https?:\/\/)([^/\s:@]+)(:\d+)?/i, "$1<host>$3")],
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<ip>"],
  [/\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g, "<ip>"],
  [/\b(?:[0-9a-fA-F]{1,4}:){1,6}:(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b/g, "<ip>"],
  [/\b[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.(?:com|net|org|io|dev|ai|app|cloud|local|internal|lan|invalid|test|sh|so)\b/gi, "<host>"],
];

/**
 * @param {{ worktree?: string, home?: string }} [options]
 */
export function createRedactor(options = {}) {
  const worktree = options.worktree ?? process.cwd();
  const home = options.home ?? process.env.HOME ?? "";

  /** @param {string} input */
  function text(input) {
    if (typeof input !== "string" || input.length === 0) return input;
    let out = input;
    if (worktree) out = out.split(worktree).join("<worktree>");
    if (home && home !== "/") out = out.split(home).join("$HOME");
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
  }

  /**
   * @param {unknown} value
   * @param {string|null} [key]
   */
  function value(value_, key = null) {
    if (typeof value_ === "string") {
      if (key && SECRET_KEY.test(key)) return "<redacted>";
      if (key && IDENTITY_KEY.test(key)) return "<redacted>";
      return text(value_);
    }
    if (Array.isArray(value_)) return value_.map((entry) => value(entry));
    if (value_ && typeof value_ === "object") {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, v] of Object.entries(value_)) out[k] = value(v, k);
      return out;
    }
    return value_;
  }

  return { text, value };
}

/** Convenience wrapper for one-off strings. */
export function redactText(input, options = {}) {
  return createRedactor(options).text(input);
}
