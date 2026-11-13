/**
 * Lease management.
 *
 * The client holds a lease on the daemon: it has to renew it before the TTL
 * runs out. When the lease expires the daemon pauses the sessions (the
 * children stay alive but no input is forwarded); when it expires twice the
 * children are terminated.
 *
 * Every lease carries a fence. A takeover bumps the fence, so frames of the
 * previous client are rejected instead of interleaving with the new one.
 */
import { randomUUID } from "node:crypto";

/** Maximum lease TTL: one year in milliseconds. */
export const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** State of the lease at a given point in time. */
export type LeaseState = "none" | "ok" | "paused" | "dead";

export type Lease = {
  leaseId: string;
  /** Monotonically increasing number; bumped on every takeover. */
  fence: number;
  clientId: string;
  ttlMs: number;
  /** Last time the lease was taken or renewed. */
  renewedAt: number;
  /** renewedAt + ttl: after this the sessions are paused. */
  pauseAt: number;
  /** renewedAt + 2 * ttl: after this the children are terminated. */
  deadAt: number;
};

export type LeaseOk<T> = { ok: true; value: T };
export type LeaseFail = { ok: false; code: string; message: string };
export type LeaseResult<T> = LeaseOk<T> | LeaseFail;

export type LeaseOptions = {
  /** TTL used when the client does not ask for one. */
  defaultTtlMs: number;
  /** Lower bound for a client supplied TTL. */
  minTtlMs: number;
  now: () => number;
};

export class LeaseManager {
  private lease: Lease | null = null;
  private fenceCounter = 0;
  private options: LeaseOptions;

  constructor(options: LeaseOptions) {
    this.options = options;
  }

  /** The current lease, if any. */
  get current(): Lease | null {
    return this.lease;
  }

  /** The fence of the current lease (0 when there is no lease). */
  get fence(): number {
    return this.lease?.fence ?? 0;
  }

  /**
   * Take (or take over) the lease.
   *
   * The same client may reconnect and keeps its fence; a different client
   * can take an expired lease over and bumps the fence, which invalidates
   * every frame of the previous client.
   */
  hello(clientId: string, ttlMs?: number): LeaseResult<Lease> {
    const now = this.options.now();
    const ttl = this.resolveTtl(ttlMs);
    if (this.lease && this.lease.clientId === clientId) {
      this.lease = this.extend(this.lease, now, ttl);
      return { ok: true, value: this.lease };
    }
    if (this.lease && this.state(now) === "ok") {
      return { ok: false, code: "lease_conflict", message: "lease is held by another client" };
    }
    this.fenceCounter += 1;
    this.lease = {
      leaseId: randomUUID(),
      fence: this.fenceCounter,
      clientId,
      ttlMs: ttl,
      renewedAt: now,
      pauseAt: now + ttl,
      deadAt: now + 2 * ttl,
    };
    return { ok: true, value: this.lease };
  }

  /** Extend the lease. The lease id and the fence have to match. */
  renew(leaseId: string, fence: number): LeaseResult<Lease> {
    const lease = this.lease;
    if (!lease) {
      return { ok: false, code: "no_lease", message: "send hello before renewing" };
    }
    if (fence !== lease.fence) {
      return {
        ok: false,
        code: "stale_fence",
        message: `fence ${fence} is stale, the current fence is ${lease.fence}`,
      };
    }
    if (leaseId !== lease.leaseId) {
      return { ok: false, code: "stale_lease", message: `unknown lease ${leaseId}` };
    }
    const now = this.options.now();
    if (now >= lease.pauseAt) {
      return { ok: false, code: "lease_expired", message: "lease has expired" };
    }
    this.lease = this.extend(lease, now, lease.ttlMs);
    return { ok: true, value: this.lease };
  }

  /** True when the given fence is the current one. */
  isCurrentFence(fence: number | null | undefined): boolean {
    if (!this.lease) return false;
    return fence === this.lease.fence;
  }

  /** State of the lease at `now`. */
  state(now: number = this.options.now()): LeaseState {
    const lease = this.lease;
    if (!lease) return "none";
    if (now >= lease.deadAt) return "dead";
    if (now >= lease.pauseAt) return "paused";
    return "ok";
  }

  private extend(lease: Lease, now: number, ttlMs: number): Lease {
    return {
      ...lease,
      ttlMs,
      renewedAt: now,
      pauseAt: now + ttlMs,
      deadAt: now + 2 * ttlMs,
    };
  }

  private resolveTtl(ttlMs: number | undefined): number {
    const ttl = ttlMs === undefined || !Number.isFinite(ttlMs) ? this.options.defaultTtlMs : ttlMs;
    return Math.min(MAX_TTL_MS, Math.max(this.options.minTtlMs, ttl));
  }
}
