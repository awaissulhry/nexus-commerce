/**
 * F1 — server-side sessions (S1 pattern): opaque 256-bit token in an HttpOnly
 * cookie, sha256 hash in the DB (raw never stored), 7-day idle / 30-day
 * absolute expiry, slide throttled to ≥60s between writes. Single origin →
 * SameSite=Lax, no CHIPS apparatus (F0-ARCHITECTURE §RBAC).
 * FS4 (S-9) — the per-request 3-level session join now sits behind a 30 s
 * per-process cache (src/lib/auth/session-cache.ts): an authed GET is ≤1 DB
 * query steady-state. Logout/revoke/team mutations drop entries immediately;
 * the sliding-expiry write keeps its ≥60 s throttle because the slide only
 * runs on the (≤ every 30 s) DB read path, where the stored idleExpiry gates it.
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { SessionCache } from "./session-cache";

export const SESSION_COOKIE = "factory_session";
export const CSRF_COOKIE = "factory_csrf";
export const CSRF_HEADER = "x-factory-csrf";

const IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const SLIDE_THROTTLE_MS = 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  status: string;
  permissionsVersion: number;
  roleKeys: string[];
};

// FS4 — one cache per process, surviving Next dev HMR (the prisma-singleton idiom)
const globalForSessions = globalThis as unknown as { __factorySessionCache?: SessionCache<SessionUser> };
const sessionCache: SessionCache<SessionUser> = (globalForSessions.__factorySessionCache ??= new SessionCache<SessionUser>());

/** FS4 — team-service hook: role/status/permission changes evict a user's cached sessions. */
export const invalidateSessionCacheForUser = (userId: string): void => sessionCache.dropUser(userId);
/** FS4 — role-definition edits touch many members at once; drop everything. */
export const clearSessionCache = (): void => sessionCache.clear();

export async function createSession(userId: string, meta?: { userAgent?: string; ip?: string }) {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      idleExpiry: new Date(now + IDLE_MS),
      absoluteExpiry: new Date(now + ABSOLUTE_MS),
      userAgent: meta?.userAgent?.slice(0, 255),
      ip: meta?.ip?.slice(0, 64),
    },
  });
  return token;
}

export async function validateSessionToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const tokenHash = sha256(token);
  const now = Date.now();

  // FS4 — hot path: a fresh cached entry answers with zero queries
  const cached = sessionCache.get(tokenHash, now);
  if (cached) return cached.user;

  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: { include: { roleAssignments: { include: { role: { select: { key: true } } } } } } },
  });
  if (!session || session.revokedAt) return null;
  if (session.idleExpiry.getTime() < now || session.absoluteExpiry.getTime() < now) return null;
  if (session.user.status !== "active") return null;
  // sliding idle expiry, throttled (runs only on this DB-read path — the
  // stored idleExpiry gates it, so writes stay ≥60 s apart regardless of cache)
  const target = now + IDLE_MS;
  let idleExpiryMs = session.idleExpiry.getTime();
  if (target - idleExpiryMs > SLIDE_THROTTLE_MS) {
    idleExpiryMs = target;
    void prisma.session
      .update({ where: { id: session.id }, data: { idleExpiry: new Date(target) } })
      .catch(() => {});
  }
  const u = session.user;
  const user: SessionUser = {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    status: u.status,
    permissionsVersion: u.permissionsVersion,
    roleKeys: u.roleAssignments.map((a) => a.role.key),
  };
  sessionCache.set(tokenHash, u.id, u.permissionsVersion, {
    user,
    sessionId: session.id,
    idleExpiryMs,
    absoluteExpiryMs: session.absoluteExpiry.getTime(),
  });
  return user;
}

export async function revokeSession(token: string): Promise<void> {
  sessionCache.dropToken(sha256(token)); // FS4 — logout is immediate, not TTL-bounded
  await prisma.session.updateMany({
    where: { tokenHash: sha256(token) },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllSessions(userId: string): Promise<void> {
  sessionCache.dropUser(userId); // FS4 — same-process revoke is immediate
  await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export function sessionCookieHeader(token: string, maxAgeSec = ABSOLUTE_MS / 1000): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function csrfCookieHeader(token: string): string {
  // NOT HttpOnly — double-submit: the client reads it and mirrors it in the header
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=${ABSOLUTE_MS / 1000}`;
}

export const newCsrfToken = () => randomBytes(16).toString("hex");
