/**
 * Provider host policy. This is not wired into the daemon or router: the
 * daemon config loader does not contain provider-to-host assignments.
 */

export function checkHostPolicy({ kind, host }: { kind: string; host: string }):
  | { ok: true }
  | { ok: false; code: "HOST_POLICY"; message: string } {
  if (kind === "claude") {
    return host === "local"
      ? { ok: true }
      : { ok: false, code: "HOST_POLICY", message: "Claude must run on the local host." };
  }

  if (host === "local") {
    return { ok: false, code: "HOST_POLICY", message: "Non-Claude providers must run on a remote host." };
  }
  if (typeof host !== "string" || host.length === 0 || /[^A-Za-z0-9_.-]/.test(host)) {
    return { ok: false, code: "HOST_POLICY", message: "Host must be a non-empty SSH alias containing only letters, digits, underscores, dots, and hyphens." };
  }
  return { ok: true };
}
