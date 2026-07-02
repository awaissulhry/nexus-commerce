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
  const row = await (prisma as any).userSession.findUnique({
    where: { sessionTokenHash: hash },
    select: {
      id: true,
      revokedAt: true,
      idleExpiry: true,
      absoluteExpiry: true,
      lastSeenAt: true,
      mfaSatisfied: true,
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          mfaRequired: true,
          twoFactorEnabledAt: true,
          permissionsVersion: true,
          roleAssignments: { select: { role: { select: { key: true } } } },
        },
      },
    },
  })
  if (!row || !row.user) return null

  const now = Date.now()
  if (row.revokedAt) return null
  if (row.idleExpiry && row.idleExpiry.getTime() <= now) return null
  if (row.absoluteExpiry && row.absoluteExpiry.getTime() <= now) return null
  if (row.user.status !== 'active') return null

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

  return {
    sessionId: row.id,
    mfaSatisfied: !!row.mfaSatisfied,
    user: {
      id: row.user.id,
      email: row.user.email,
      displayName: row.user.displayName,
      status: row.user.status,
      mfaRequired: !!row.user.mfaRequired,
      twoFactorEnabledAt: row.user.twoFactorEnabledAt,
      permissionsVersion: row.user.permissionsVersion,
      roleKeys: (row.user.roleAssignments ?? []).map((a: any) => a.role.key),
    },
  }
}

/** Revoke a single session by its id. */
export async function revokeSession(sessionId: string): Promise<boolean> {
  const r = await (prisma as any).userSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return r.count > 0
}

/** Revoke the session identified by a raw token (logout). */
export async function revokeSessionByToken(rawToken: string): Promise<boolean> {
  const r = await (prisma as any).userSession.updateMany({
    where: { sessionTokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return r.count > 0
}

/** Revoke every live session for a user (optionally keep one). */
export async function revokeAllSessions(
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const r = await (prisma as any).userSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  })
  return r.count as number
}
