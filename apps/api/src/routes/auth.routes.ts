/**
 * Phase S1 (auth core) — human authentication endpoints.
 *
 *   Public:
 *     GET  /api/auth/csrf                     mint + set the CSRF cookie
 *     POST /api/auth/login                    credentials → session cookie
 *     POST /api/auth/logout                   revoke current session
 *     GET  /api/auth/me                       resolve the current session
 *     GET  /api/auth/invitations/accept/:token  preview an invite
 *     POST /api/auth/invitations/accept       set password, activate
 *     POST /api/auth/password/reset-request   email a reset link
 *     POST /api/auth/password/reset           consume token, set password
 *   Owner-gated (S1's coarse guard; S2 → requirePermission):
 *     POST /api/auth/logout-all               revoke all my sessions
 *     POST /api/auth/invitations              create an invite
 *     GET  /api/auth/invitations              list invites
 *     POST /api/auth/invitations/:id/revoke   revoke an invite
 *
 * This plugin protects only its own surface. Flipping the rest of the
 * API to deny-by-default is S2. See docs/security/.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  hashPassword,
  verifyPassword,
  checkPasswordStrength,
} from '../lib/auth/password.js'
import {
  createSession,
  revokeSessionByToken,
  revokeAllSessions,
  truncateIp,
} from '../lib/auth/session.js'
import { generateToken, hashToken } from '../lib/auth/tokens.js'
import {
  sessionCookieName,
  sessionCookieOptions,
  csrfCookieName,
  csrfCookieOptions,
  clearedCookieOptions,
} from '../lib/auth/cookies.js'
import { issueCsrfToken } from '../lib/auth/csrf.js'
import {
  requireAuth,
  requireOwner,
  requireCsrf,
  loadSession,
} from '../lib/auth/guards.js'
import {
  accountLockState,
  registerLoginFailure,
  clearLoginFailures,
  ipRecentFailureCount,
  IP_MAX_FAILURES,
} from '../lib/auth/lockout.js'
import { writeAuthAudit } from '../lib/auth/audit.js'
import {
  sendInvitationEmail,
  sendPasswordResetEmail,
  invitationLink,
  passwordResetLink,
} from '../services/email/auth-emails.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVITE_TTL_MS = 72 * 60 * 60 * 1000
const RESET_TTL_MS = 60 * 60 * 1000

// Constant dummy hash so an unknown-email login does the same argon2
// work as a known one — closes the timing side-channel for enumeration.
let DUMMY_HASH: string | null = null
async function dummyHash(): Promise<string> {
  if (!DUMMY_HASH) DUMMY_HASH = await hashPassword('nexus-timing-equalizer-not-a-real-secret')
  return DUMMY_HASH
}

interface PublicUser {
  id: string
  email: string
  displayName: string
  roleKeys: string[]
  mfaEnabled: boolean
}
function publicUser(u: {
  id: string
  email: string
  displayName: string
  twoFactorEnabledAt: Date | null
  roleAssignments?: { role: { key: string } }[]
}): PublicUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    roleKeys: (u.roleAssignments ?? []).map((a) => a.role.key),
    mfaEnabled: !!u.twoFactorEnabledAt,
  }
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const ua = (req: any): string | null =>
    (req.headers['user-agent'] as string | undefined)?.slice(0, 256) ?? null

  // ── CSRF token mint ────────────────────────────────────────────
  fastify.get('/api/auth/csrf', async (_req, reply) => {
    const token = issueCsrfToken()
    reply.setCookie(csrfCookieName(), token, csrfCookieOptions())
    return { csrfToken: token }
  })

  // ── Login ──────────────────────────────────────────────────────
  fastify.post<{ Body: { email?: string; password?: string } }>(
    '/api/auth/login',
    { preHandler: requireCsrf },
    async (req, reply) => {
      const email = (req.body?.email ?? '').trim().toLowerCase()
      const password = req.body?.password ?? ''
      const ipTrunc = truncateIp(req.ip)
      const GENERIC = { error: 'Invalid email or password', code: 'invalid_credentials' }

      // Per-IP throttle (distributed guessing across accounts).
      if ((await ipRecentFailureCount(ipTrunc)) > IP_MAX_FAILURES) {
        return reply.code(429).send({
          error: 'Too many failed attempts from this network. Try again later.',
          code: 'rate_limited',
        })
      }

      if (!email || !password) return reply.code(401).send(GENERIC)

      const user = await (prisma as any).userProfile.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          displayName: true,
          passwordHash: true,
          status: true,
          lockedUntil: true,
          twoFactorEnabledAt: true,
          roleAssignments: { select: { role: { select: { key: true } } } },
        },
      })

      // Unknown email → equalize timing, log, uniform error.
      if (!user) {
        await verifyPassword(password, await dummyHash())
        await (prisma as any).loginEvent.create({
          data: { emailTried: email, outcome: 'bad_password', ipAddress: ipTrunc, userAgent: ua(req) },
        })
        return reply.code(401).send(GENERIC)
      }

      const locked = accountLockState(user)
      const verify = user.passwordHash
        ? await verifyPassword(password, user.passwordHash)
        : { ok: false, needsRehash: false }

      // Wrong password (or no password set): register failure, uniform error.
      if (!verify.ok) {
        await registerLoginFailure(user.id)
        await (prisma as any).loginEvent.create({
          data: { userId: user.id, emailTried: email, outcome: 'bad_password', ipAddress: ipTrunc, userAgent: ua(req) },
        })
        return reply.code(401).send(GENERIC)
      }

      // Correct password but account deactivated → reveal nothing extra.
      if (user.status !== 'active') {
        await (prisma as any).loginEvent.create({
          data: { userId: user.id, emailTried: email, outcome: 'locked', ipAddress: ipTrunc, userAgent: ua(req), metadata: { reason: 'deactivated' } },
        })
        return reply.code(403).send({ error: 'This account is deactivated.', code: 'deactivated' })
      }

      // Correct password but currently locked → only the real user
      // (who knows the password) learns about the lock.
      if (locked.locked) {
        await (prisma as any).loginEvent.create({
          data: { userId: user.id, emailTried: email, outcome: 'locked', ipAddress: ipTrunc, userAgent: ua(req) },
        })
        return reply.code(423).send({
          error: `Account temporarily locked after repeated failures. Try again after ${locked.until?.toUTCString()}.`,
          code: 'locked',
          until: locked.until,
        })
      }

      // Success. Rehash legacy hashes to argon2id opportunistically.
      if (verify.needsRehash) {
        try {
          const newHash = await hashPassword(password)
          await (prisma as any).userProfile.update({ where: { id: user.id }, data: { passwordHash: newHash } })
        } catch { /* non-fatal */ }
      }
      await clearLoginFailures(user.id)

      // NOTE: MFA verification is enforced in S5. Until then a valid
      // password fully satisfies login and mfaSatisfied is set true so
      // S5 can distinguish pre-enforcement sessions.
      const { rawToken } = await createSession({
        userId: user.id,
        userAgent: ua(req),
        ip: req.ip,
        mfaSatisfied: true,
      })
      // Rotate the CSRF token on login and RETURN it in the body: the
      // web origin can't read the API-origin cookie, so the client
      // keeps this value in memory and echoes it in x-nexus-csrf.
      const csrfToken = issueCsrfToken()
      reply.setCookie(sessionCookieName(), rawToken, sessionCookieOptions())
      reply.setCookie(csrfCookieName(), csrfToken, csrfCookieOptions())

      await (prisma as any).loginEvent.create({
        data: { userId: user.id, emailTried: email, outcome: 'success', ipAddress: ipTrunc, userAgent: ua(req) },
      })
      await writeAuthAudit({
        actorUserId: user.id, ip: ipTrunc, userAgent: ua(req),
        entityType: 'Auth', entityId: user.id, action: 'login.success',
      })

      return { ok: true, user: publicUser(user), csrfToken }
    },
  )

  // ── Logout (current session) ───────────────────────────────────
  fastify.post('/api/auth/logout', { preHandler: requireCsrf }, async (req, reply) => {
    const token = (req.cookies as Record<string, string | undefined>)?.[sessionCookieName()]
    if (token) await revokeSessionByToken(token)
    reply.clearCookie(sessionCookieName(), clearedCookieOptions(true))
    reply.clearCookie(csrfCookieName(), clearedCookieOptions(false))
    return { ok: true }
  })

  // ── Logout everywhere ──────────────────────────────────────────
  fastify.post('/api/auth/logout-all', { preHandler: [requireAuth, requireCsrf] }, async (req, reply) => {
    const n = await revokeAllSessions(req.authUser!.id)
    reply.clearCookie(sessionCookieName(), clearedCookieOptions(true))
    reply.clearCookie(csrfCookieName(), clearedCookieOptions(false))
    await writeAuthAudit({
      actorUserId: req.authUser!.id, ip: truncateIp(req.ip), userAgent: ua(req),
      entityType: 'Session', entityId: req.authUser!.id, action: 'logout.all', metadata: { revoked: n },
    })
    return { ok: true, revoked: n }
  })

  // ── Who am I ───────────────────────────────────────────────────
  fastify.get('/api/auth/me', { preHandler: loadSession }, async (req, reply) => {
    if (!req.authUser) return reply.code(401).send({ error: 'Not authenticated', code: 'unauthenticated' })
    return {
      user: {
        id: req.authUser.id,
        email: req.authUser.email,
        displayName: req.authUser.displayName,
        roleKeys: req.authUser.roleKeys,
        mfaEnabled: !!req.authUser.twoFactorEnabledAt,
        mfaRequired: req.authUser.mfaRequired,
      },
    }
  })

  // ── Create invitation (owner) ──────────────────────────────────
  fastify.post<{ Body: { email?: string; roleKey?: string; channelScope?: unknown } }>(
    '/api/auth/invitations',
    { preHandler: [requireOwner, requireCsrf] },
    async (req, reply) => {
      const email = (req.body?.email ?? '').trim().toLowerCase()
      const roleKey = (req.body?.roleKey ?? '').trim()
      if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'Valid email required', code: 'bad_email' })

      const role = await (prisma as any).role.findUnique({ where: { key: roleKey }, select: { id: true, name: true, key: true } })
      if (!role) return reply.code(400).send({ error: `Unknown role "${roleKey}"`, code: 'bad_role' })

      // If the email already maps to an active account, don't invite.
      const existing = await (prisma as any).userProfile.findUnique({ where: { email }, select: { id: true, status: true } })
      if (existing && existing.status === 'active') {
        return reply.code(409).send({ error: 'A user with this email already exists', code: 'user_exists' })
      }

      const raw = generateToken(32)
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
      const invite = await (prisma as any).invitation.create({
        data: {
          email, roleId: role.id, tokenHash: hashToken(raw),
          channelScope: (req.body?.channelScope as any) ?? undefined,
          invitedByUserId: req.authUser!.id, expiresAt,
        },
        select: { id: true, email: true, expiresAt: true },
      })

      const link = invitationLink(raw)
      const mail = await sendInvitationEmail({ to: email, roleName: role.name, link, expiresAt })
      await writeAuthAudit({
        actorUserId: req.authUser!.id, ip: truncateIp(req.ip), userAgent: ua(req),
        entityType: 'Invitation', entityId: invite.id, action: 'invitation.create',
        after: { email, roleKey: role.key }, metadata: { emailDelivered: mail.ok && !mail.dryRun },
      })

      // The raw link is returned to the OWNER so they can copy it even
      // when outbound email is in dry-run mode.
      return { ok: true, invitation: invite, link, emailSent: mail.ok && !mail.dryRun }
    },
  )

  // ── List invitations (owner) ───────────────────────────────────
  fastify.get('/api/auth/invitations', { preHandler: requireOwner }, async (_req, reply) => {
    const rows = await (prisma as any).invitation.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, email: true, expiresAt: true, acceptedAt: true, revokedAt: true, createdAt: true,
        role: { select: { key: true, name: true } },
      },
    })
    return reply.send({ invitations: rows })
  })

  // ── Revoke invitation (owner) ──────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/api/auth/invitations/:id/revoke',
    { preHandler: [requireOwner, requireCsrf] },
    async (req, reply) => {
      const r = await (prisma as any).invitation.updateMany({
        where: { id: req.params.id, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      if (r.count === 0) return reply.code(404).send({ error: 'Invitation not found or already used/revoked', code: 'not_found' })
      await writeAuthAudit({
        actorUserId: req.authUser!.id, ip: truncateIp(req.ip), userAgent: ua(req),
        entityType: 'Invitation', entityId: req.params.id, action: 'invitation.revoke',
      })
      return { ok: true }
    },
  )

  // ── Preview an invitation (public — for the accept page) ───────
  fastify.get<{ Params: { token: string } }>(
    '/api/auth/invitations/accept/:token',
    async (req, reply) => {
      const invite = await (prisma as any).invitation.findUnique({
        where: { tokenHash: hashToken(req.params.token) },
        select: { email: true, expiresAt: true, acceptedAt: true, revokedAt: true, role: { select: { name: true } } },
      })
      if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt.getTime() <= Date.now()) {
        return reply.code(404).send({ error: 'This invitation is invalid or has expired.', code: 'invalid_invite' })
      }
      return { email: invite.email, roleName: invite.role.name, expiresAt: invite.expiresAt }
    },
  )

  // ── Accept an invitation (public) ──────────────────────────────
  fastify.post<{ Body: { token?: string; password?: string; displayName?: string } }>(
    '/api/auth/invitations/accept',
    async (req, reply) => {
      const token = req.body?.token ?? ''
      const password = req.body?.password ?? ''
      const displayName = (req.body?.displayName ?? '').trim()
      if (!token) return reply.code(400).send({ error: 'Missing token', code: 'bad_token' })

      const invite = await (prisma as any).invitation.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { id: true, email: true, roleId: true, channelScope: true, acceptedAt: true, revokedAt: true, expiresAt: true },
      })
      if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt.getTime() <= Date.now()) {
        return reply.code(404).send({ error: 'This invitation is invalid or has expired.', code: 'invalid_invite' })
      }

      const strength = checkPasswordStrength(password, [invite.email, displayName])
      if (!strength.ok) return reply.code(400).send({ error: strength.message, code: 'weak_password' })

      const passwordHash = await hashPassword(password)

      // Adopt an existing (e.g. deactivated / bootstrap) row for this
      // email, else create the account. Then assign the invited role
      // and mark the invite consumed — atomically.
      const userId = await prisma.$transaction(async (tx: any) => {
        const existing = await tx.userProfile.findUnique({ where: { email: invite.email }, select: { id: true } })
        const u = existing
          ? await tx.userProfile.update({
              where: { id: existing.id },
              data: { passwordHash, status: 'active', deactivatedAt: null, ...(displayName ? { displayName } : {}) },
              select: { id: true },
            })
          : await tx.userProfile.create({
              data: { email: invite.email, passwordHash, displayName: displayName || invite.email.split('@')[0] },
              select: { id: true },
            })
        await tx.userRole.upsert({
          where: { userId_roleId: { userId: u.id, roleId: invite.roleId } },
          create: { userId: u.id, roleId: invite.roleId, channelScope: invite.channelScope ?? undefined },
          update: {},
        })
        await tx.invitation.update({ where: { id: invite.id }, data: { acceptedAt: new Date(), acceptedUserId: u.id } })
        return u.id as string
      })

      // Auto-login the new user (session + fresh CSRF token in the body).
      const { rawToken } = await createSession({ userId, userAgent: ua(req), ip: req.ip, mfaSatisfied: true })
      const csrfToken = issueCsrfToken()
      reply.setCookie(sessionCookieName(), rawToken, sessionCookieOptions())
      reply.setCookie(csrfCookieName(), csrfToken, csrfCookieOptions())
      await writeAuthAudit({
        actorUserId: userId, ip: truncateIp(req.ip), userAgent: ua(req),
        entityType: 'Invitation', entityId: invite.id, action: 'invitation.accept', after: { email: invite.email },
      })
      return { ok: true, csrfToken }
    },
  )

  // ── Password reset — request (public, no enumeration) ──────────
  fastify.post<{ Body: { email?: string } }>(
    '/api/auth/password/reset-request',
    async (req, reply) => {
      const email = (req.body?.email ?? '').trim().toLowerCase()
      // Always 200 regardless of whether the account exists.
      if (EMAIL_RE.test(email)) {
        const user = await (prisma as any).userProfile.findUnique({ where: { email }, select: { id: true, status: true } })
        if (user && user.status === 'active') {
          const raw = generateToken(32)
          const expiresAt = new Date(Date.now() + RESET_TTL_MS)
          await (prisma as any).passwordResetToken.create({ data: { userId: user.id, tokenHash: hashToken(raw), expiresAt } })
          const link = passwordResetLink(raw)
          await sendPasswordResetEmail({ to: email, link, expiresAt })
          await writeAuthAudit({
            actorUserId: user.id, ip: truncateIp(req.ip), userAgent: ua(req),
            entityType: 'PasswordReset', entityId: user.id, action: 'password.reset.request',
          })
        }
      }
      return { ok: true }
    },
  )

  // ── Password reset — confirm (public, token-bearing) ───────────
  fastify.post<{ Body: { token?: string; password?: string } }>(
    '/api/auth/password/reset',
    async (req, reply) => {
      const token = req.body?.token ?? ''
      const password = req.body?.password ?? ''
      if (!token) return reply.code(400).send({ error: 'Missing token', code: 'bad_token' })

      const row = await (prisma as any).passwordResetToken.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { id: true, userId: true, usedAt: true, expiresAt: true, user: { select: { email: true } } },
      })
      if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
        return reply.code(404).send({ error: 'This reset link is invalid or has expired.', code: 'invalid_token' })
      }

      const strength = checkPasswordStrength(password, [row.user?.email ?? ''])
      if (!strength.ok) return reply.code(400).send({ error: strength.message, code: 'weak_password' })

      const passwordHash = await hashPassword(password)
      await prisma.$transaction(async (tx: any) => {
        await tx.userProfile.update({
          where: { id: row.userId },
          data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
        })
        await tx.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } })
      })
      // Invalidate every session — a reset means "lock everyone out".
      await revokeAllSessions(row.userId)
      await writeAuthAudit({
        actorUserId: row.userId, ip: truncateIp(req.ip), userAgent: ua(req),
        entityType: 'PasswordReset', entityId: row.userId, action: 'password.reset.complete',
      })
      return { ok: true }
    },
  )
}

export default authRoutes
