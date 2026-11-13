// volto-botd lease store.
//
// A small, crash-safe lease store used by botd to decide which controller
// owns a host and which bot session may run on it.
//
// Two levels:
//
//   host lease     exactly one controller may hold the lease of a host at a
//                  time;
//   session lease  a bot session running under a host lease.  A session lease
//                  is only valid while its host lease is valid: releasing or
//                  expiring the host lease kills the sessions underneath it.
//
// Resources are plain strings with two shapes:
//
//   host/<hostId>               the host lease of a host
//   session/<hostId>/<session>  a session lease underneath that host lease
//
// Every lease carries a fence: a number that strictly increases for the
// resource it guards and that is persisted next to the lease.  A holder that
// lost the resource (its lease was taken over, or it came back too late)
// presents an old fence and is rejected -- that is the point of the fence.
//
// The state lives in one JSON file below BOTD_HOME:
//
//   $BOTD_HOME/leases.json       current state
//   $BOTD_HOME/leases.json.bak   previous good state
//
// Writes go through a temporary file that is fsynced and then renamed over
// the target, so a crash never leaves a half written state file behind.  If
// the state file is damaged, the backup is used and the fences are bumped by
// a safety margin, because leases handed out between the backup and the
// crash would otherwise be able to reuse a fence.

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** A lease handed out by the store. */
export interface Lease {
  /** Unique id of the lease. */
  leaseId: string;
  /** Fencing token: strictly increasing per resource. */
  fence: number;
  /** Resource the lease guards. */
  resource: string;
  /** Owner (controller or session) that holds the lease. */
  owner: string;
  /** Wall clock time (ms since epoch) at which the lease stops being valid. */
  expiresAt: number;
}

/** Options for {@link LeaseStore}. */
export interface LeaseStoreOptions {
  /** Directory holding the state file. Defaults to `$BOTD_HOME`, else `~/.botd`. */
  home?: string;
  /** Injectable clock in milliseconds since the epoch. Defaults to `Date.now`. */
  clock?: () => number;
  /** Default time an `acquire` waits for a conflicting lease to go away. */
  waitMs?: number;
  /** Poll interval used while waiting for a conflicting lease. */
  pollIntervalMs?: number;
  /** Fences are bumped by this margin when the state file had to be recovered. */
  fenceSafetyMargin?: number;
}

/** Options for a single {@link LeaseStore.acquire} call. */
export interface AcquireOptions {
  /** How long to wait for a conflicting lease to expire (0 = fail right away). */
  waitMs?: number;
}

/** Error thrown by the lease store. `code` is stable, the message is not. */
export class LeaseStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LeaseStoreError";
    this.code = code;
  }
}

const STATE_VERSION = 1;
const STATE_FILE = "leases.json";
const BACKUP_FILE = "leases.json.bak";
const LOCK_FILE = "leases.lock";
const DEFAULT_FENCE_SAFETY_MARGIN = 1000;
const DEFAULT_WAIT_MS = 0;
const DEFAULT_POLL_INTERVAL_MS = 10;
// A lock that is older than the stale threshold belongs to a process that
// died, so it may be broken.  The timeout has to be larger than the stale
// threshold, otherwise a stale lock could never be broken.
const LOCK_STALE_MS = 5000;
const LOCK_TIMEOUT_MS = 15000;

/** Resource key of the host lease of `hostId`. */
export function hostResource(hostId: string): string {
  return `host/${hostId}`;
}

/** Resource key of the session lease of `sessionId` on `hostId`. */
export function sessionResource(hostId: string, sessionId: string): string {
  return `session/${hostId}/${sessionId}`;
}

/** Parent resource of a session resource, `undefined` for host resources. */
export function parentResource(resource: string): string | undefined {
  if (!resource.startsWith("session/")) return undefined;
  const rest = resource.slice("session/".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  return `host/${rest.slice(0, slash)}`;
}

/** A lease as it is written to disk (a {@link Lease} plus bookkeeping). */
interface StoredLease extends Lease {
  /** Wall clock time (ms since epoch) at which the lease was granted. */
  acquiredAt: number;
  /** Time to live the lease was granted with, in milliseconds. */
  ttlMs: number;
  /** Resource of the host lease this session lease lives under. */
  parentResource?: string;
  /** Lease id of the host lease this session lease was granted under. */
  parentLeaseId?: string;
}

/** The whole persisted state. */
interface StoreState {
  version: number;
  /** Lowest fence any resource may use (raised after a recovery). */
  floor: number;
  /** Highest fence ever handed out, per resource. Never decreases. */
  fences: Record<string, number>;
  /** Live leases, keyed by lease id. */
  leases: Record<string, StoredLease>;
}

function emptyState(): StoreState {
  return { version: STATE_VERSION, floor: 0, fences: {}, leases: {} };
}

function isErrno(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

/** Validate and normalize a parsed state file. Throws when unusable. */
function normalizeState(parsed: unknown): StoreState {
  if (typeof parsed !== "object" || parsed === null) throw new Error("state is not an object");
  const raw = parsed as Partial<StoreState>;
  if (raw.version !== STATE_VERSION) {
    throw new Error(`unsupported state version ${String(raw.version)}`);
  }

  const state = emptyState();
  if (typeof raw.floor === "number" && Number.isFinite(raw.floor)) state.floor = raw.floor;

  if (typeof raw.fences === "object" && raw.fences !== null) {
    for (const [resource, fence] of Object.entries(raw.fences)) {
      if (typeof fence === "number" && Number.isFinite(fence)) state.fences[resource] = fence;
    }
  }

  if (typeof raw.leases === "object" && raw.leases !== null) {
    for (const [leaseId, lease] of Object.entries(raw.leases)) {
      if (typeof lease !== "object" || lease === null) continue;
      const stored = lease as Partial<StoredLease>;
      if (typeof stored.leaseId !== "string") continue;
      if (typeof stored.resource !== "string") continue;
      if (typeof stored.owner !== "string") continue;
      if (typeof stored.fence !== "number" || !Number.isFinite(stored.fence)) continue;
      if (typeof stored.expiresAt !== "number" || !Number.isFinite(stored.expiresAt)) continue;
      const entry: StoredLease = {
        leaseId: stored.leaseId,
        fence: stored.fence,
        resource: stored.resource,
        owner: stored.owner,
        expiresAt: stored.expiresAt,
        acquiredAt: typeof stored.acquiredAt === "number" ? stored.acquiredAt : stored.expiresAt,
        ttlMs: typeof stored.ttlMs === "number" ? stored.ttlMs : 0,
      };
      if (typeof stored.parentResource === "string") entry.parentResource = stored.parentResource;
      if (typeof stored.parentLeaseId === "string") entry.parentLeaseId = stored.parentLeaseId;
      state.leases[leaseId] = entry;
    }
  }

  return state;
}

type ReadResult =
  | { kind: "ok"; state: StoreState }
  | { kind: "missing" }
  | { kind: "corrupt" };

async function readStateFile(file: string): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try {
    return { kind: "ok", state: normalizeState(JSON.parse(raw)) };
  } catch {
    return { kind: "corrupt" };
  }
}

/**
 * Raise every known fence by `margin` and drop the leases.
 *
 * After a recovery the state on disk may be older than what was handed out
 * before the crash, so the counters are pushed up by a safety margin: a fence
 * that may have been used in the meantime is never handed out again.  The
 * leases are dropped because their holders cannot know that they survived:
 * everybody has to acquire again.
 */
function applySafetyMargin(state: StoreState, margin: number): StoreState {
  const next = emptyState();
  next.floor = Math.max(state.floor, margin);
  for (const [resource, fence] of Object.entries(state.fences)) {
    next.fences[resource] = fence + margin;
  }
  return next;
}

function leaseExpired(lease: StoredLease, now: number): boolean {
  return lease.expiresAt <= now;
}

/** True when the parent (host) lease of `lease` is still around and alive. */
function parentAlive(state: StoreState, lease: StoredLease, now: number): boolean {
  if (!lease.parentLeaseId) return true;
  const parent = state.leases[lease.parentLeaseId];
  if (!parent) return false;
  if (leaseExpired(parent, now)) return false;
  return parent.fence === (state.fences[parent.resource] ?? parent.fence);
}

/** Remove a lease and every lease that lives underneath it. */
function removeLease(state: StoreState, leaseId: string): StoredLease[] {
  const removed: StoredLease[] = [];
  const pending = [leaseId];
  while (pending.length > 0) {
    const id = pending.shift() as string;
    const lease = state.leases[id];
    if (!lease) continue;
    delete state.leases[id];
    removed.push(lease);
    for (const child of Object.values(state.leases)) {
      if (child.parentLeaseId === id) pending.push(child.leaseId);
    }
  }
  return removed;
}

/** The lease currently held for `resource`, if any. */
function leaseForResource(state: StoreState, resource: string): StoredLease | undefined {
  for (const lease of Object.values(state.leases)) {
    if (lease.resource === resource) return lease;
  }
  return undefined;
}

function toPublic(lease: StoredLease): Lease {
  return {
    leaseId: lease.leaseId,
    fence: lease.fence,
    resource: lease.resource,
    owner: lease.owner,
    expiresAt: lease.expiresAt,
  };
}

/**
 * A small, crash-safe lease store with fencing.
 *
 * All operations are serialized in-process and guarded by a lock file, so
 * several botd processes can share one `BOTD_HOME` safely.
 */
export class LeaseStore {
  readonly #home: string;
  readonly #statePath: string;
  readonly #backupPath: string;
  readonly #lockPath: string;
  readonly #clock: () => number;
  readonly #waitMs: number;
  readonly #pollIntervalMs: number;
  readonly #fenceSafetyMargin: number;
  /** Serializes the operations of this instance. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: LeaseStoreOptions = {}) {
    this.#home = options.home ?? process.env["BOTD_HOME"] ?? path.join(os.homedir(), ".botd");
    this.#statePath = path.join(this.#home, STATE_FILE);
    this.#backupPath = path.join(this.#home, BACKUP_FILE);
    this.#lockPath = path.join(this.#home, LOCK_FILE);
    this.#clock = options.clock ?? Date.now;
    this.#waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#fenceSafetyMargin = options.fenceSafetyMargin ?? DEFAULT_FENCE_SAFETY_MARGIN;
  }

  /** Directory the store keeps its state in. */
  get home(): string {
    return this.#home;
  }

  /** Path of the state file. */
  get statePath(): string {
    return this.#statePath;
  }

  /** Path of the backup of the state file. */
  get backupPath(): string {
    return this.#backupPath;
  }

  /**
   * Take the lease of `resource` for `owner`.
   *
   * The fence of the returned lease is strictly greater than every fence
   * handed out for that resource before, including across restarts.  When
   * another owner holds a live lease the call waits for it to expire (see
   * {@link AcquireOptions.waitMs}) and fails with a `conflict` error if it
   * does not go away in time.
   *
   * A session resource (`session/<host>/<session>`) needs a live host lease
   * (`host/<host>`); acquiring it without one fails with `no-host-lease`.
   */
  async acquire(
    resource: string,
    owner: string,
    ttlMs: number,
    options: AcquireOptions = {},
  ): Promise<Lease> {
    if (typeof resource !== "string" || resource.length === 0) {
      throw new LeaseStoreError("invalid-resource", "a resource is required");
    }
    if (typeof owner !== "string" || owner.length === 0) {
      throw new LeaseStoreError("invalid-owner", "an owner is required");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new LeaseStoreError("invalid-ttl", "ttlMs must be a positive number");
    }

    const waitMs = options.waitMs ?? this.#waitMs;
    // Waiting is a wall clock activity, so it is measured with the real
    // clock even when the lease clock is injected.
    const deadline = Date.now() + waitMs;

    for (;;) {
      const outcome = await this.#run((state, dirty) => {
        const now = this.#clock();
        let held = leaseForResource(state, resource);
        if (held && (leaseExpired(held, now) || !parentAlive(state, held, now))) {
          // An expired lease -- or one whose host lease died -- blocks
          // nobody: drop it and carry on.
          removeLease(state, held.leaseId);
          dirty();
          held = undefined;
        }
        if (held && held.owner !== owner) {
          return { granted: false as const, held };
        }

        const parent = parentResource(resource);
        let parentLeaseId: string | undefined;
        if (parent) {
          const parentLease = leaseForResource(state, parent);
          if (!parentLease || leaseExpired(parentLease, now)) {
            throw new LeaseStoreError(
              "no-host-lease",
              `session ${resource} needs a live lease of ${parent}`,
            );
          }
          parentLeaseId = parentLease.leaseId;
        }

        // A new grant supersedes whatever was held before.
        if (held) removeLease(state, held.leaseId);

        const fence = Math.max(state.fences[resource] ?? 0, state.floor) + 1;
        state.fences[resource] = fence;

        const lease: StoredLease = {
          leaseId: `lease-${randomUUID()}`,
          fence,
          resource,
          owner,
          expiresAt: now + ttlMs,
          acquiredAt: now,
          ttlMs,
        };
        if (parent) {
          lease.parentResource = parent;
          lease.parentLeaseId = parentLeaseId;
        }
        state.leases[lease.leaseId] = lease;
        dirty();

        return { granted: true as const, lease };
      });

      if (outcome.granted) return toPublic(outcome.lease);

      if (Date.now() >= deadline) {
        throw new LeaseStoreError(
          "conflict",
          `resource ${resource} is leased by ${outcome.held.owner} until ${outcome.held.expiresAt}`,
        );
      }
      await delay(this.#pollIntervalMs);
    }
  }

  /**
   * Extend a lease.
   *
   * Returns `null` when the lease is unknown, when the fence does not match
   * the lease that is stored (a stale holder must not be able to renew) or
   * when the lease (or its host lease) is no longer alive.
   */
  async renew(leaseId: string, fence: number, ttlMs?: number): Promise<Lease | null> {
    return this.#run((state, dirty) => {
      const lease = state.leases[leaseId];
      if (!lease) return null;
      if (lease.fence !== fence) return null;
      if (lease.fence !== (state.fences[lease.resource] ?? lease.fence)) return null;

      const now = this.#clock();
      if (leaseExpired(lease, now)) return null;
      if (!parentAlive(state, lease, now)) return null;

      const ttl = ttlMs ?? lease.ttlMs;
      if (!Number.isFinite(ttl) || ttl <= 0) {
        throw new LeaseStoreError("invalid-ttl", "ttlMs must be a positive number");
      }
      lease.expiresAt = now + ttl;
      dirty();
      return toPublic(lease);
    });
  }

  /**
   * Release a lease.
   *
   * Releasing a host lease also releases every session lease underneath it.
   * When `fence` is given, the release only happens if the stored lease still
   * carries that fence.
   */
  async release(leaseId: string, fence?: number): Promise<boolean> {
    return this.#run((state, dirty) => {
      const lease = state.leases[leaseId];
      if (!lease) return false;
      if (fence !== undefined && lease.fence !== fence) return false;
      removeLease(state, leaseId);
      dirty();
      return true;
    });
  }

  /** True when the lease is alive and the presented fence is the current one. */
  async isValid(leaseId: string, fence: number): Promise<boolean> {
    return this.#run((state) => {
      const lease = state.leases[leaseId];
      if (!lease) return false;
      if (lease.fence !== fence) return false;
      if (lease.fence !== (state.fences[lease.resource] ?? lease.fence)) return false;
      const now = this.#clock();
      if (leaseExpired(lease, now)) return false;
      if (!parentAlive(state, lease, now)) return false;
      return true;
    });
  }

  /**
   * Drop every lease that expired at `now` (the clock by default) and return
   * them.  An expired host lease takes the session leases underneath it with
   * it: those are dropped as well, so they stop being valid right away.
   */
  async expire(now: number = this.#clock()): Promise<Lease[]> {
    return this.#run((state, dirty) => {
      const expired: StoredLease[] = [];
      for (const lease of Object.values(state.leases)) {
        if (leaseExpired(lease, now)) expired.push(lease);
      }
      if (expired.length === 0) return [];

      // Removing a host lease takes its session leases with it.
      for (const lease of expired) removeLease(state, lease.leaseId);
      dirty();

      return expired.map(toPublic);
    });
  }

  /** Run `fn` under the store lock with the current state. */
  async #run<T>(fn: (state: StoreState, dirty: () => void) => T | Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      const release = await this.#acquireFileLock();
      try {
        const state = await this.#loadState();
        let changed = false;
        try {
          return await fn(state, () => {
            changed = true;
          });
        } finally {
          if (changed) await this.#persistState(state);
        }
      } finally {
        await release();
      }
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Load the state, recovering from the backup when the state file is
   * damaged.  A recovery bumps the fences by the safety margin, because
   * leases handed out after the backup was taken are not known any more.
   */
  async #loadState(): Promise<StoreState> {
    const main = await readStateFile(this.#statePath);
    if (main.kind === "ok") return main.state;

    const backup = await readStateFile(this.#backupPath);
    if (backup.kind === "ok") {
      const recovered = applySafetyMargin(backup.state, this.#fenceSafetyMargin);
      await this.#persistState(recovered);
      return recovered;
    }

    if (main.kind === "missing" && backup.kind === "missing") return emptyState();

    // Damaged beyond repair: start over, but never hand out a low fence.
    const fresh = emptyState();
    fresh.floor = this.#fenceSafetyMargin;
    await this.#persistState(fresh);
    return fresh;
  }

  /**
   * Write the state file and its backup, atomically.
   *
   * The backup holds the previous good generation: it is written before the
   * state file is replaced, so a state file that gets damaged later on can
   * still be recovered from it.
   */
  async #persistState(state: StoreState): Promise<void> {
    await mkdir(this.#home, { recursive: true, mode: 0o700 });
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    const previous = await this.#readGoodState();
    await writeFileAtomic(this.#backupPath, previous ?? contents);
    await writeFileAtomic(this.#statePath, contents);
  }

  /** The raw bytes of the current state file, when they are still readable. */
  async #readGoodState(): Promise<string | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#statePath, "utf8");
    } catch {
      return undefined;
    }
    try {
      normalizeState(JSON.parse(raw));
      return raw;
    } catch {
      return undefined;
    }
  }

  /** Take the cross-process lock; returns the release function. */
  async #acquireFileLock(): Promise<() => Promise<void>> {
    await mkdir(this.#home, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        const handle = await open(this.#lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${process.pid}\n`, "utf8");
        } finally {
          await handle.close();
        }
        return async () => {
          await unlink(this.#lockPath).catch(() => undefined);
        };
      } catch (error) {
        if (!isErrno(error) || error.code !== "EEXIST") throw error;

        const info = await stat(this.#lockPath).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(this.#lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new LeaseStoreError("lock-timeout", `cannot lock ${this.#lockPath}`);
        }
        await delay(10);
      }
    }
  }
}

/** Write `contents` to `file` through a temporary file that is fsynced. */
async function writeFileAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await syncDirectory(path.dirname(file));
}

/** Best effort fsync of a directory so a rename survives a crash. */
async function syncDirectory(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not supported everywhere; the rename is still atomic.
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}
