/**
 * FS4 — per-process TTL cache for validateSessionToken (S-9): the rbac
 * resolver cache pattern (`userId:permissionsVersion`, 30 s) extended one
 * layer down to the session join itself. Entries are keyed
 * `${tokenHash}:${user.permissionsVersion}` — a token index resolves the
 * current composite key (the version isn't knowable before the lookup), and a
 * user index powers revocation. Semantics, as accepted in FS4-SPEC §3:
 *   · permission changes bump `permissionsVersion` AND team-service drops the
 *     user's entries (same-process propagation stays immediate, as FP11 built);
 *   · explicit logout/revoke deletes the local entry;
 *   · cross-PROCESS revocation (worker never validates sessions; a second web
 *     process doesn't exist today) is bounded by the 30 s TTL — documented,
 *     accepted, single-web-process reality.
 * Expiry math is checked against the CACHED row on every hit, so a session
 * never outlives its idle/absolute expiry by being cached. Pure state — no db
 * import — so the key/usability semantics are unit-testable.
 */
import { TtlCache } from "@/lib/ttl-cache";

export const SESSION_CACHE_TTL_MS = 30_000;

export const sessionCacheKey = (tokenHash: string, permissionsVersion: number): string =>
  `${tokenHash}:${permissionsVersion}`;

export type CachedSession<U> = {
  user: U;
  sessionId: string;
  idleExpiryMs: number;
  absoluteExpiryMs: number;
};

/** A cached row is only usable while BOTH expiries are in the future. */
export function cachedSessionUsable(
  entry: Pick<CachedSession<unknown>, "idleExpiryMs" | "absoluteExpiryMs">,
  nowMs: number,
): boolean {
  return entry.idleExpiryMs > nowMs && entry.absoluteExpiryMs > nowMs;
}

export class SessionCache<U> {
  private cache = new TtlCache<CachedSession<U>>(SESSION_CACHE_TTL_MS, 2000);
  /** tokenHash → the composite key currently cached for it */
  private byToken = new Map<string, string>();
  /** userId → tokenHashes with live entries (revocation fan-out) */
  private byUser = new Map<string, Set<string>>();

  get(tokenHash: string, nowMs: number): CachedSession<U> | undefined {
    const key = this.byToken.get(tokenHash);
    if (!key) return undefined;
    const hit = this.cache.get(key);
    if (!hit) {
      this.byToken.delete(tokenHash); // TTL/LRU took it — prune the index
      return undefined;
    }
    if (!cachedSessionUsable(hit, nowMs)) {
      this.dropToken(tokenHash);
      return undefined;
    }
    return hit;
  }

  set(tokenHash: string, userId: string, permissionsVersion: number, entry: CachedSession<U>): void {
    const key = sessionCacheKey(tokenHash, permissionsVersion);
    const prior = this.byToken.get(tokenHash);
    if (prior && prior !== key) this.cache.delete(prior); // version moved — drop the stale generation
    this.cache.set(key, entry);
    this.byToken.set(tokenHash, key);
    const set = this.byUser.get(userId) ?? new Set<string>();
    set.add(tokenHash);
    this.byUser.set(userId, set);
  }

  /** Logout / single-session revoke. */
  dropToken(tokenHash: string): void {
    const key = this.byToken.get(tokenHash);
    if (key) this.cache.delete(key);
    this.byToken.delete(tokenHash);
  }

  /** Revoke-all / role or status change — every cached session of one user. */
  dropUser(userId: string): void {
    const tokens = this.byUser.get(userId);
    if (tokens) for (const t of tokens) this.dropToken(t);
    this.byUser.delete(userId);
  }

  clear(): void {
    this.cache.clear();
    this.byToken.clear();
    this.byUser.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
