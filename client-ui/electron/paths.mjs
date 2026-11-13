import { join } from "node:path";

export function hostsPath(userData) {
  return join(userData, "hosts.json");
}

export function isValidAlias(alias) {
  return typeof alias === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(alias);
}

// An empty list requires users to add SSH aliases explicitly.
export function defaultHosts() {
  return [];
}

export function ensureHostsFile(fs, userData) {
  const path = hostsPath(userData);
  fs.mkdirSync(userData, { recursive: true });
  try {
    fs.writeFileSync(path, JSON.stringify(defaultHosts(), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return path;
}

export function parseHosts(contents) {
  const hosts = JSON.parse(contents);
  if (!Array.isArray(hosts) || hosts.some(host =>
    !host || typeof host !== "object" || Array.isArray(host) ||
    !isValidAlias(host.alias) ||
    Object.keys(host).some(key => key !== "alias" && key !== "label") ||
    (host.label !== undefined && typeof host.label !== "string")
  )) throw new Error("Hosts must be an array of SSH aliases");
  return hosts;
}
