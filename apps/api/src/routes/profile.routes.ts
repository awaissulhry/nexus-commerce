/**
 * Settings rebuild — Phase C
 *
 * Server endpoints for /settings/profile + /settings/security.
 *
 *   POST   /api/settings/profile/avatar     Cloudinary upload
 *   POST   /api/settings/2fa/enroll/start   generate secret + QR
 *   POST   /api/settings/2fa/enroll/verify  confirm with first TOTP
 *   POST   /api/settings/2fa/disable        revoke (requires password)
 *   POST   /api/settings/2fa/recovery-codes/regenerate  new 10-set
 *   GET    /api/settings/sessions           list active sessions
 *   POST   /api/settings/sessions/:id/revoke
 *   POST   /api/settings/sessions/revoke-all
 *   GET    /api/settings/login-history      last 30 login events
 *
 * Single-tenant: every endpoint operates on the singleton UserProfile
 * row. Phase I adds the multi-user gate; until then these endpoints
 * are intentionally unauthenticated (workspace is private).
 */

import type { FastifyPluginAsync } from 'fastify'
import { generateSecret, generateURI, verifySync } from 'otplib'
import QRCode from 'qrcode'
import bcrypt from 'bcryptjs'
import prisma from '../db.js'
import {
  isCloudinaryConfigured,
  uploadBufferToCloudinary,
} from '../services/cloudinary.service.js'
import { writeSettingsAudit } from '../utils/settings-audit.js'

// otplib v13 functional API. 6 digits, 30s step matches Google
// Authenticator / 1Password / Authy. Window of 1 = accept the
// previous + next 30s codes so a sluggish clock doesn't lock the
// user out.
const TOTP_OPTIONS = { digits: 6, step: 30, window: 1 as const }
const TOTP_ISSUER = 'Nexus Commerce'

async function getSoloUser() {
  return (await (prisma as any).userProfile.findFirst()) as
    | {
        id: string
        email: string
        avatarUrl: string | null
        passwordHash: string | null
        twoFactorSecret: string | null
        twoFactorEnabledAt: Date | null
      }
    | null
}

/**
 * Phase C — backwards-compatible password verifier. The legacy
 * implementation hashed with raw sha256 (changePassword in
 * actions.ts before the upgrade); new hashes are bcrypt. Detect by
 * prefix ("$2") and route to the right comparator.
 */
async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!stored) return false
  if (stored.startsWith('$2')) {
    return bcrypt.compare(plain, stored)
  }
  // Legacy sha256: hex(64). Constant-time-ish compare.
  const { createHash, timingSafeEqual } = await import('crypto')
  const hex = createHash('sha256').update(plain).digest('hex')
  if (hex.length !== stored.length) return false
  try {
    return timingSafeEqual(Buffer.from(hex), Buffer.from(stored))
  } catch {
    return false
  }
}

/**
 * Generate 10 recovery codes for an enrollment / regenerate cycle.
 * Format: XXXX-XXXX (8 base32-ish alphanumeric characters split
 * with a dash — same shape Stripe + GitHub use). Returned as
 * (raw[], hashed[]) where raw is shown to the operator ONCE.
 */
async function generateRecoveryCodes(): Promise<{
  raw: string[]
  hashed: string[]
}> {
  const { randomBytes } = await import('crypto')
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I
  const raw: string[] = []
  for (let i = 0; i < 10; i++) {
    const bytes = randomBytes(8)
    let s = ''
    for (let j = 0; j < 8; j++) s += ALPHABET[bytes[j] % ALPHABET.length]
    raw.push(`${s.slice(0, 4)}-${s.slice(4, 8)}`)
  }
  const hashed = await Promise.all(raw.map((c) => bcrypt.hash(c, 10)))
  return { raw, hashed }
}

const profileRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Avatar upload ──────────────────────────────────────────────
  fastify.post('/settings/profile/avatar', async (request, reply) => {
    try {
      if (!isCloudinaryConfigured()) {
        return reply.code(503).send({
          error:
            'Cloudinary not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET on the API server.',
        })
      }
      let data: any
      try {
        data = await (request as any).file?.()
      } catch {
        return reply.code(400).send({
          error:
            'multipart upload required (Content-Type: multipart/form-data, field name: "file")',
        })
      }
      if (!data) {
        return reply
          .code(400)
          .send({ error: 'multipart upload required (field name: "file")' })
      }
      const buffer = await data.toBuffer()
      // Avatars are small — cap at 4 MB. Cloudinary will further
      // re-encode + crop downstream.
      if (buffer.length > 4 * 1024 * 1024) {
        return reply
          .code(413)
          .send({ error: 'avatar too large (4 MB limit)' })
      }

      const user = await getSoloUser()
      const uploaded = await uploadBufferToCloudinary(buffer, {
        folder: 'avatars',
        // Stable per-user public_id so re-uploads overwrite — keeps
        // the URL the same for any embedded references.
        publicId: user ? `user-${user.id}` : 'user-singleton',
      })

      const before = user
      let next = user
      if (next) {
        next = await (prisma as any).userProfile.update({
          where: { id: next.id },
          data: { avatarUrl: uploaded.url },
        })
      } else {
        next = await (prisma as any).userProfile.create({
          data: { avatarUrl: uploaded.url, displayName: '', email: '' },
        })
      }
      await writeSettingsAudit({
        key: 'profile',
        action: before ? 'update' : 'create',
        before: before ? { avatarUrl: before.avatarUrl } : null,
        after: { avatarUrl: uploaded.url },
        metadata: {
          event: 'avatar_uploaded',
          width: uploaded.width,
          height: uploaded.height,
          bytes: uploaded.bytes,
        },
      })

      return {
        ok: true,
        avatarUrl: uploaded.url,
        width: uploaded.width,
        height: uploaded.height,
        bytes: uploaded.bytes,
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/profile/avatar] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ── 2FA: start enrollment ──────────────────────────────────────
  // Generates a fresh TOTP secret, stores it on the user (but does
  // NOT mark 2FA enabled), and returns the secret + QR data URL so
  // the client can render the enrollment QR. Verify with the next
  // endpoint to lock it in.
  fastify.post('/settings/2fa/enroll/start', async (_request, reply) => {
    try {
      const user = await getSoloUser()
      if (!user) {
        return reply.code(404).send({ error: 'No user profile yet' })
      }
      if (user.twoFactorEnabledAt) {
        return reply.code(409).send({
          error: '2FA is already enabled — disable it first to re-enroll.',
        })
      }
      const secret = generateSecret()
      const accountName = user.email || user.id
      const otpauth = generateURI({
        strategy: 'totp',
        label: accountName,
        issuer: TOTP_ISSUER,
        secret,
        digits: TOTP_OPTIONS.digits,
        period: TOTP_OPTIONS.step,
      })
      // Persist the candidate secret so the verify step can find it
      // without trusting the client to round-trip it. enabledAt stays
      // null until verify succeeds.
      await (prisma as any).userProfile.update({
        where: { id: user.id },
        data: { twoFactorSecret: secret, twoFactorEnabledAt: null },
      })
      const qrDataUrl = await QRCode.toDataURL(otpauth, {
        margin: 1,
        width: 240,
      })
      return { ok: true, secret, otpauth, qrDataUrl }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/2fa/enroll/start] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ── 2FA: verify the first code, complete enrollment ────────────
  fastify.post<{ Body: { code?: string } }>(
    '/settings/2fa/enroll/verify',
    async (request, reply) => {
      try {
        const user = await getSoloUser()
        if (!user || !user.twoFactorSecret) {
          return reply.code(400).send({
            error: 'No enrollment in progress — call enroll/start first.',
          })
        }
        const code = (request.body?.code ?? '').replace(/\s/g, '')
        if (!/^\d{6}$/.test(code)) {
          return reply
            .code(400)
            .send({ error: 'Six-digit numeric code required' })
        }
        // verifySync returns { valid: true, delta } or { valid: false } —
        // the window option lives at the option-shape level via the
        // epochTolerance (TOTP) / window (HOTP) field; for TOTP we
        // accept ±1 step by setting epochTolerance to step seconds.
        const result = verifySync({
          token: code,
          secret: user.twoFactorSecret,
          digits: TOTP_OPTIONS.digits,
          period: TOTP_OPTIONS.step,
          epochTolerance: TOTP_OPTIONS.step,
        })
        if (!result.valid) {
          return reply.code(401).send({
            error:
              'Code did not match. Check your authenticator app — the secret may be misaligned, or the device clock is off.',
          })
        }
        // Lock in: mark enabled + issue 10 recovery codes.
        const { raw, hashed } = await generateRecoveryCodes()
        await prisma.$transaction(async (tx: any) => {
          await tx.userProfile.update({
            where: { id: user.id },
            data: { twoFactorEnabledAt: new Date() },
          })
          // Wipe any prior recovery codes from a previous enrollment;
          // a successful re-enroll always starts with a fresh set.
          await tx.twoFactorRecoveryCode.deleteMany({
            where: { userId: user.id },
          })
          await tx.twoFactorRecoveryCode.createMany({
            data: hashed.map((codeHash) => ({
              userId: user.id,
              codeHash,
            })),
          })
        })
        await writeSettingsAudit({
          key: 'profile.password', // grouped under the security key
          action: 'update',
          before: { twoFactorEnabled: false },
          after: { twoFactorEnabled: true },
          metadata: { event: 'two_factor_enabled' },
        })
        return { ok: true, recoveryCodes: raw }
      } catch (err: any) {
        fastify.log.error({ err }, '[settings/2fa/enroll/verify] failed')
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    },
  )

  // ── 2FA: disable ───────────────────────────────────────────────
  // Requires the user's current password as a step-up check. Without
  // this, an attacker with a session cookie could turn off 2FA
  // unobserved. Returns a clean 401 on bad password so the client
  // can surface a useful error.
  fastify.post<{ Body: { password?: string } }>(
    '/settings/2fa/disable',
    async (request, reply) => {
      try {
        const user = await getSoloUser()
        if (!user) {
          return reply.code(404).send({ error: 'No user profile yet' })
        }
        if (!user.twoFactorEnabledAt) {
          return reply.code(409).send({ error: '2FA is not enabled' })
        }
        const password = request.body?.password ?? ''
        if (!user.passwordHash) {
          // No password set — skip the check. Single-tenant
          // bootstrap convenience; will become a hard error in Phase I.
        } else if (!password || !(await verifyPassword(password, user.passwordHash))) {
          return reply.code(401).send({ error: 'Password did not match' })
        }
        await prisma.$transaction(async (tx: any) => {
          await tx.userProfile.update({
            where: { id: user.id },
            data: { twoFactorSecret: null, twoFactorEnabledAt: null },
          })
          await tx.twoFactorRecoveryCode.deleteMany({
            where: { userId: user.id },
          })
        })
        await writeSettingsAudit({
          key: 'profile.password',
          action: 'update',
          before: { twoFactorEnabled: true },
          after: { twoFactorEnabled: false },
          metadata: { event: 'two_factor_disabled' },
        })
        return { ok: true }
      } catch (err: any) {
        fastify.log.error({ err }, '[settings/2fa/disable] failed')
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    },
  )

  // ── 2FA: regenerate recovery codes ──────────────────────────────
  fastify.post('/settings/2fa/recovery-codes/regenerate', async (_request, reply) => {
    try {
      const user = await getSoloUser()
      if (!user) {
        return reply.code(404).send({ error: 'No user profile yet' })
      }
      if (!user.twoFactorEnabledAt) {
        return reply.code(409).send({
          error: 'Enable 2FA first — recovery codes only exist for enrolled accounts.',
        })
      }
      const { raw, hashed } = await generateRecoveryCodes()
      await prisma.$transaction(async (tx: any) => {
        await tx.twoFactorRecoveryCode.deleteMany({
          where: { userId: user.id },
        })
        await tx.twoFactorRecoveryCode.createMany({
          data: hashed.map((codeHash) => ({
            userId: user.id,
            codeHash,
          })),
        })
      })
      await writeSettingsAudit({
        key: 'profile.password',
        action: 'update',
        before: { recoveryCodesRotated: false },
        after: { recoveryCodesRotated: true },
        metadata: { event: 'recovery_codes_regenerated' },
      })
      return { ok: true, recoveryCodes: raw }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/2fa/recovery-codes/regenerate] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ── 2FA: status (used by the page server-load to decide which UI to render)
  fastify.get('/settings/2fa/status', async (_request, reply) => {
    try {
      const user = await getSoloUser()
      if (!user) return { enabled: false, enrolledAt: null, recoveryCodesRemaining: 0 }
      const remaining = await (prisma as any).twoFactorRecoveryCode.count({
        where: { userId: user.id, usedAt: null },
      })
      return {
        enabled: !!user.twoFactorEnabledAt,
        enrolledAt: user.twoFactorEnabledAt
          ? (user.twoFactorEnabledAt as Date).toISOString()
          : null,
        recoveryCodesRemaining: remaining,
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/2fa/status] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ── Sessions ───────────────────────────────────────────────────
  fastify.get('/settings/sessions', async (_request, reply) => {
    try {
      const user = await getSoloUser()
      if (!user) return { sessions: [] }
      const rows = await (prisma as any).userSession.findMany({
        where: { userId: user.id },
        orderBy: [{ revokedAt: 'asc' }, { lastSeenAt: 'desc' }],
        take: 50,
      })
      return { sessions: rows }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/sessions GET] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post<{ Params: { id: string } }>(
    '/settings/sessions/:id/revoke',
    async (request, reply) => {
      try {
        const updated = await (prisma as any).userSession.updateMany({
          where: { id: request.params.id, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        if (updated.count === 0) {
          return reply.code(404).send({ error: 'Session not found or already revoked' })
        }
        return { ok: true }
      } catch (err: any) {
        fastify.log.error({ err }, '[settings/sessions/revoke] failed')
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    },
  )

  fastify.post('/settings/sessions/revoke-all', async (_request, reply) => {
    try {
      const user = await getSoloUser()
      if (!user) return { ok: true, revoked: 0 }
      const r = await (prisma as any).userSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      return { ok: true, revoked: r.count }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/sessions/revoke-all] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ── Login history ──────────────────────────────────────────────
  fastify.get('/settings/login-history', async (_request, reply) => {
    try {
      const user = await getSoloUser()
      if (!user) return { events: [] }
      const rows = await (prisma as any).loginEvent.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      })
      return { events: rows }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/login-history GET] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })
}

export default profileRoutes
