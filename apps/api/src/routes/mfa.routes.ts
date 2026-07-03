/**
 * Phase S5 — self-service TOTP 2FA (operates on the CURRENT user).
 *
 * Distinct from the legacy singleton-scoped /api/settings/2fa endpoints:
 * these use req.authUser (set by the RBAC gate) so every signed-in user
 * manages their OWN 2FA. Mapped to pages.dashboard in the manifest, i.e.
 * "any authenticated user" (unauthenticated → 401).
 *
 *   GET  /api/auth/2fa/status
 *   POST /api/auth/2fa/enroll/start           → secret + QR (not yet enabled)
 *   POST /api/auth/2fa/enroll/verify {code}   → enable + return recovery codes
 *   POST /api/auth/2fa/disable {password}     → step-up, disable
 *   POST /api/auth/2fa/recovery-codes {password} → regenerate
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { verifyPassword } from '../lib/auth/password.js'
import { verifyTotp, generateEnrollment, generateRecoveryCodes } from '../lib/auth/mfa.js'
import { writeAuthAudit } from '../lib/auth/audit.js'
import { truncateIp } from '../lib/auth/session.js'

const mfaRoutes: FastifyPluginAsync = async (fastify) => {
  const me = (req: any) => req.authUser?.id as string | undefined
  const audit = (req: any, action: string, meta?: any) =>
    writeAuthAudit({ actorUserId: me(req) ?? null, ip: truncateIp(req.ip), userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 256) ?? null, entityType: 'User', entityId: me(req) ?? 'unknown', action, metadata: meta })

  fastify.get('/api/auth/2fa/status', async (req, reply) => {
    const id = me(req); if (!id) return reply.code(401).send({ error: 'unauthenticated' })
    const u = await (prisma as any).userProfile.findUnique({ where: { id }, select: { twoFactorEnabledAt: true } })
    const remaining = await (prisma as any).twoFactorRecoveryCode.count({ where: { userId: id, usedAt: null } })
    return { enabled: !!u?.twoFactorEnabledAt, enrolledAt: u?.twoFactorEnabledAt ?? null, recoveryCodesRemaining: remaining }
  })

  fastify.post('/api/auth/2fa/enroll/start', async (req, reply) => {
    const id = me(req); if (!id) return reply.code(401).send({ error: 'unauthenticated' })
    const u = await (prisma as any).userProfile.findUnique({ where: { id }, select: { email: true, twoFactorEnabledAt: true } })
    if (u?.twoFactorEnabledAt) return reply.code(409).send({ error: '2FA already enabled — disable it first to re-enrol.' })
    const { secret, otpauth, qrDataUrl } = await generateEnrollment(u?.email || id)
    await (prisma as any).userProfile.update({ where: { id }, data: { twoFactorSecret: secret, twoFactorEnabledAt: null } })
    return { ok: true, secret, otpauth, qrDataUrl }
  })

  fastify.post<{ Body: { code?: string } }>('/api/auth/2fa/enroll/verify', async (req, reply) => {
    const id = me(req); if (!id) return reply.code(401).send({ error: 'unauthenticated' })
    const u = await (prisma as any).userProfile.findUnique({ where: { id }, select: { twoFactorSecret: true } })
    if (!u?.twoFactorSecret) return reply.code(400).send({ error: 'No enrolment in progress — start first.' })
    if (!verifyTotp(u.twoFactorSecret, req.body?.code ?? '')) return reply.code(401).send({ error: 'Code did not match. Check your authenticator app.' })
    const { raw, hashed } = await generateRecoveryCodes()
    await prisma.$transaction(async (tx: any) => {
      await tx.userProfile.update({ where: { id }, data: { twoFactorEnabledAt: new Date() } })
      await tx.twoFactorRecoveryCode.deleteMany({ where: { userId: id } })
      await tx.twoFactorRecoveryCode.createMany({ data: hashed.map((codeHash) => ({ userId: id, codeHash })) })
    })
    await audit(req, 'mfa.enabled')
    return { ok: true, recoveryCodes: raw }
  })

  fastify.post<{ Body: { password?: string } }>('/api/auth/2fa/disable', async (req, reply) => {
    const id = me(req); if (!id) return reply.code(401).send({ error: 'unauthenticated' })
    const u = await (prisma as any).userProfile.findUnique({ where: { id }, select: { passwordHash: true, twoFactorEnabledAt: true } })
    if (!u?.twoFactorEnabledAt) return reply.code(409).send({ error: '2FA is not enabled.' })
    if (u.passwordHash && !(await verifyPassword(req.body?.password ?? '', u.passwordHash)).ok) {
      return reply.code(401).send({ error: 'Password did not match.' })
    }
    await prisma.$transaction(async (tx: any) => {
      await tx.userProfile.update({ where: { id }, data: { twoFactorSecret: null, twoFactorEnabledAt: null } })
      await tx.twoFactorRecoveryCode.deleteMany({ where: { userId: id } })
    })
    await audit(req, 'mfa.disabled')
    return { ok: true }
  })

  fastify.post<{ Body: { password?: string } }>('/api/auth/2fa/recovery-codes', async (req, reply) => {
    const id = me(req); if (!id) return reply.code(401).send({ error: 'unauthenticated' })
    const u = await (prisma as any).userProfile.findUnique({ where: { id }, select: { passwordHash: true, twoFactorEnabledAt: true } })
    if (!u?.twoFactorEnabledAt) return reply.code(409).send({ error: 'Enable 2FA first.' })
    if (u.passwordHash && !(await verifyPassword(req.body?.password ?? '', u.passwordHash)).ok) {
      return reply.code(401).send({ error: 'Password did not match.' })
    }
    const { raw, hashed } = await generateRecoveryCodes()
    await prisma.$transaction(async (tx: any) => {
      await tx.twoFactorRecoveryCode.deleteMany({ where: { userId: id } })
      await tx.twoFactorRecoveryCode.createMany({ data: hashed.map((codeHash) => ({ userId: id, codeHash })) })
    })
    await audit(req, 'mfa.recovery_codes_regenerated')
    return { ok: true, recoveryCodes: raw }
  })
}

export default mfaRoutes
