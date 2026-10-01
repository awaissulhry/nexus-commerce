/**
 * Phase S1 (auth core) — server-side session store on UserSession.
 *
 * Sessions are the source of truth for human auth (not stateless JWTs)
 * so revocation is instant: delete/flag the row and the next request
 * fails. Postgres is authoritative (Redis is not required — see
 * docs/security/S0-AUDIT.md §3).
 *
 * Cookie carries a 256-bit opaque token; only sha256(token) is stored.
 * Each request:
 *   • look up the row by sessionTokenHash,
 *   • reject if revoked / past idleExpiry / past absoluteExpiry / user
 *     deactivated,
 *   • slide idleExpiry forward (throttled to ≤1 write/min/session).
 */

import prisma from '../../db.js'
import { generateToken, hashToken, tokenPrefix } from './tokens.js'
import { SESSION_TTL_ABSOLUTE_MS, SESSION_TTL_IDLE_MS } from './cookies.js'

/** Truncate an IP for privacy before storage: IPv4 → /24, IPv6 → /64. */
export function truncateIp(ip: string | undefined | null): string | null {
  if (!ip) return null
  const clean = ip.replace(/^::ffff:/, '') // unwrap IPv4-mapped IPv6
  if (clean.includes('.')) {
    const p = clean.split('.')
    if (p.length === 4) return `${p[0]}.${p[1]}.${p[2]}.0`
    return clean
  }
  if (clean.includes(':')) {
    // Expand any "::" first, else a compressed address like "2001:db8::1"
    // would yield a malformed "2001:db8::1::" and group inconsistently
    // (review finding L5). Normalise to the first 4 groups (/64).
    const [head, tail] = clean.split('::')
    const h = head ? head.split(':') : []
    const t = tail !== undefined && tail ? tail.split(':') : []
    const missing = Math.max(0, 8 - h.length - t.length)
    const full = [...h, ...Array(missing).fill('0'), ...t]
    const first4 = full.slice(0, 4).map((g) => g || '0')
    return first4.join(':') + '::'
  }
  return clean
}

export interface SessionUser {
  id: string
  email: string
  displayName: string
  status: string
  mfaRequired: boolean
  twoFactorEnabledAt: Date | null
  permissionsVersion: number
  roleKeys: string[]
}

export interface CreateSessionInput {
  userId: string
  userAgent?: string | null
  ip?: string | null
  mfaSatisfied?: boolean
}

/** Create a new session row; returns the RAW token (shown once). */
export async function createSession(
  input: CreateSessionInput,
): Promise<{ rawToken: string; sessionId: string }> {
  const rawToken = generateToken(32)
  const now = Date.now()
  const row = await (prisma as any).userSession.create({
    data: {
      userId: input.userId,
      sessionTokenHash: hashToken(rawToken),
      tokenPrefix: tokenPrefix(rawToken),
      userAgent: input.userAgent ?? null,
      ipAddress: truncateIp(input.ip),
      idleExpiry: new Date(now + SESSION_TTL_IDLE_MS),
      absoluteExpiry: new Date(now + SESSION_TTL_ABSOLUTE_MS),
      mfaSatisfied: input.mfaSatisfied ?? false,
    },
    select: { id: true },
  })
  return { rawToken, sessionId: row.id }
}

import {
  getCachedSession,
  setCachedSession,
  dropCachedSessions,
} from './session-cache.js'

/** One row of the session read: the session, its user, and the user's global role keys. */
interface SessionRow {
  id: string
  revokedAt: Date | null
  idleExpiry: Date | null
  absoluteExpiry: Date | null
  lastSeenAt: Date | null
  mfaSatisfied: boolean
  userId: string
  email: string
  displayName: string
  status: string
  mfaRequired: boolean
  twoFactorEnabledAt: Date | null
  permissionsVersion: number
  roleKeys: string[] | null
}

export interface ValidatedSession {
  sessionId: string
  user: SessionUser
  mfaSatisfied: boolean
}

/**
 * Validate a raw session token. Returns null when there is no valid,
 * live session (unknown / revoked / expired / user deactivated).
 * Slides idleExpiry forward, throttled to ≤1 write/min/session.
 */
export async function validateSession(
  rawToken: string | undefined | null,
): Promise<ValidatedSession | null> {
  if (!rawToken) return null
  const hash = hashToken(rawToken)

  // SC.1 — the global rbacHook calls this on EVERY request, so an uncached lookup put a Neon
  // round trip in front of every authenticated response (~600ms, measured). A hit skips the
  // query entirely; a miss, a timeout or a Redis outage falls through to the database below and
  // answers correctly, only slower. Only VALID sessions are cached — never a negative result.
  const cached = process.env.NEXUS_WORKSPACES_ENABLED === '1' ? null : await getCachedSession(hash)
  if (cached) return cached

  // P2 (2026-09-30) — ONE statement. The nested Prisma read was four (UserSession, UserProfile, UserRole, Role), and
  // with profiles on this runs uncached on every request. Same rows and fields; role keys in a stable order.
  const [row] = await prisma.$queryRaw<SessionRow[]>`
    SELECT s.id, s."revokedAt", s."idleExpiry", s."absoluteExpiry", s."lastSeenAt", s."mfaSatisfied",
      u.id AS "userId", u.email, u."displayName", u.status, u."mfaRequired", u."twoFactorEnabledAt", u."permissionsVersion",
      ARRAY(SELECT r.key FROM "public"."UserRole" ur JOIN "public"."Role" r ON r.id = ur."roleId" WHERE ur."userId" = u.id ORDER BY r.key) AS "roleKeys"
    FROM "public"."UserSession" s JOIN "public"."UserProfile" u ON u.id = s."userId"
    WHERE s."sessionTokenHash" = ${hash}`
  if (!row) return null

  const now = Date.now()
  if (row.revokedAt) return null
  if (row.idleExpiry && row.idleExpiry.getTime() <= now) return null
  if (row.absoluteExpiry && row.absoluteExpiry.getTime() <= now) return null
  if (row.status !== 'active') return null

  // Slide the idle window forward — but only write if the last touch
  // was >60s ago, to avoid a DB write on every single request.
  const lastSeen = row.lastSeenAt ? row.lastSeenAt.getTime() : 0
  if (now - lastSeen > 60_000) {
    const nextIdle = new Date(now + SESSION_TTL_IDLE_MS)
    // Never slide past the absolute cap.
    const capped =
      row.absoluteExpiry && nextIdle.getTime() > row.absoluteExpiry.getTime()
        ? row.absoluteExpiry
        : nextIdle
    void (prisma as any).userSession
      .update({
        where: { id: row.id },
        data: { lastSeenAt: new Date(now), idleExpiry: capped },
      })
      .catch(() => undefined)
  }

  const validated: ValidatedSession = {
    sessionId: row.id,
    mfaSatisfied: !!row.mfaSatisfied,
    user: {
      id: row.userId,
      email: row.email,
      displayName: row.displayName,
      status: row.status,
      mfaRequired: !!row.mfaRequired,
      twoFactorEnabledAt: row.twoFactorEnabledAt,
      permissionsVersion: row.permissionsVersion,
      roleKeys: row.roleKeys ?? [],
    },
  }

  // Not awaited: the write is time-boxed internally and swallows its own errors, so awaiting it
  // would only add latency to the very request the cache exists to speed up.
  void setCachedSession(hash, validated)
  return validated
}

/**
 * Revoke a single session by its id.
 *
 * SC.1 — the token hash is read BEFORE the update, because `updateMany` returns a count, not
 * rows, and the cache is keyed by hash. One extra read on a rare operation is the price of
 * revocation staying immediate for the constant one.
 */
export async function revokeSession(sessionId: string, userId?: string): Promise<boolean> {
  const row = await (prisma as any).userSession.findUnique({
    where: { id: sessionId },
    select: { sessionTokenHash: true },
  })
  const r = await (prisma as any).userSession.updateMany({
    where: { id: sessionId, revokedAt: null, ...(userId ? { userId } : {}) },
    data: { revokedAt: new Date() },
  })
  if (row?.sessionTokenHash) void dropCachedSessions([row.sessionTokenHash])
  return r.count > 0
}

/**
 * The second factor was just proved on THIS session (the person set up two-factor and entered a valid code): mark it
 * done, and drop its cached copy so the very next request reads it. Before, setting up two-factor left the session
 * that did it "not done" — and every business page then refused it with "Complete two-factor authentication" until
 * the person signed out and in again (2026-10-01). Only a live session of this user changes.
 */
export async function markSessionMfaSatisfied(sessionId: string, userId: string): Promise<boolean> {
  const row = await (prisma as any).userSession.findUnique({
    where: { id: sessionId },
    select: { sessionTokenHash: true },
  })
  const r = await (prisma as any).userSession.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { mfaSatisfied: true },
  })
  if (row?.sessionTokenHash) await dropCachedSessions([row.sessionTokenHash])
  return r.count > 0
}

/** Revoke the session identified by a raw token (logout). */
export async function revokeSessionByToken(rawToken: string): Promise<boolean> {
  const hash = hashToken(rawToken)
  const r = await (prisma as any).userSession.updateMany({
    where: { sessionTokenHash: hash, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  void dropCachedSessions([hash])
  return r.count > 0
}

/** Revoke every live session for a user (optionally keep one). */
export async function revokeAllSessions(
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const where = {
    userId,
    revokedAt: null,
    ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
  }
  // Hashes first — this is what keeps `deactivateUser`'s "instant lockout: kill every live
  // session" literally true rather than true-within-a-TTL.
  const rows = await (prisma as any).userSession.findMany({
    where,
    select: { sessionTokenHash: true },
  })
  const r = await (prisma as any).userSession.updateMany({ where, data: { revokedAt: new Date() } })
  void dropCachedSessions(rows.map((x: any) => x.sessionTokenHash).filter(Boolean))
  return r.count as number
}

/**
 * Drop every cached session for a user WITHOUT revoking anything.
 *
 * For permission changes: `rbac.ts` keys its permission cache on `permissionsVersion`, so a role
 * edit propagates immediately there — but the version is also carried inside the cached session,
 * so that copy has to go too or the new permissions would not be seen until the TTL lapsed.
 * Called from `bumpUserPermissionVersion`.
 */
export async function dropCachedSessionsForUser(userId: string): Promise<void> {
  const rows = await (prisma as any).userSession.findMany({
    where: { userId, revokedAt: null },
    select: { sessionTokenHash: true },
  })
  await dropCachedSessions(rows.map((x: any) => x.sessionTokenHash).filter(Boolean))
}
