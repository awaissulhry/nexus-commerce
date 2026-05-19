/**
 * Settings rebuild — Phase H
 *
 * Privacy + consent + retention + workspace export for /settings/privacy.
 *
 *   POST   /api/settings/privacy/export              create + run an export job
 *   GET    /api/settings/privacy/exports             list past requests
 *   GET    /api/settings/privacy/exports/:id/download  stream the JSON
 *
 *   GET    /api/settings/privacy/retention           current policies
 *   PATCH  /api/settings/privacy/retention           update policies
 *
 *   GET    /api/settings/privacy/consent             latest consent state
 *   POST   /api/settings/privacy/consent             record an accept/opt-out
 *
 *   POST   /api/settings/privacy/delete-account-dry-run
 *       Returns the cascade preview — what would be deleted if a
 *       real delete fired. NOTHING is actually deleted in this
 *       phase; the destructive action belongs to Phase I (when
 *       multi-user auth ships).
 *
 * Synchronous JSON export is sufficient for GDPR Article 20
 * portability requirements. A real ZIP / async-worker variant is a
 * follow-up; the schema supports it via DataExportRequest.format.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { writeSettingsAudit } from '../utils/settings-audit.js'

// ─── Retention defaults ──────────────────────────────────────────
// Italian fiscal law mandates 7 years (~2555 days) for invoiced
// orders. We bake that as a floor server-side; the UI exposes a
// slider that can't go lower.
const DEFAULT_POLICIES: Record<string, number> = {
  orders: 2555, // 7y — IT fiscal minimum
  auditLog: 730, // 2y
  loginEvents: 180,
  webhookEvents: 90,
  stockLogs: 365,
  exports: 7, // hard floor; download links expire after 7 days
}

const RETENTION_FLOORS: Record<string, number> = {
  orders: 2555,
  auditLog: 30,
  loginEvents: 30,
  webhookEvents: 7,
  stockLogs: 30,
  exports: 1,
}

const RETENTION_CEILINGS: Record<string, number> = {
  orders: 3650, // 10y cap
  auditLog: 3650,
  loginEvents: 3650,
  webhookEvents: 365,
  stockLogs: 3650,
  exports: 30,
}

const CONSENT_KINDS = new Set([
  'DPA',
  'TOS',
  'PRIVACY_POLICY',
  'COOKIE_ANALYTICS',
  'COOKIE_MARKETING',
  'MARKETING_EMAIL',
  'MARKETING_SMS',
])

async function getSoloUser() {
  return (await (prisma as any).userProfile.findFirst()) as
    | { id: string; email: string }
    | null
}

async function getOrCreateRetentionRow() {
  const existing = await (prisma as any).dataRetentionPolicy.findFirst()
  if (existing) return existing
  return (prisma as any).dataRetentionPolicy.create({
    data: { policies: DEFAULT_POLICIES },
  })
}

const settingsPrivacyRoutes: FastifyPluginAsync = async (fastify) => {
  // ────────────────────────────────────────────────────────────
  // EXPORT
  // ────────────────────────────────────────────────────────────

  fastify.post<{ Body: { scope?: string[]; format?: string } }>(
    '/settings/privacy/export',
    async (request, reply) => {
      try {
        const body = request.body ?? {}
        const requestedScope =
          Array.isArray(body.scope) && body.scope.length > 0
            ? body.scope
            : ['all']
        const format = body.format === 'zip' ? 'zip' : 'json'
        if (format === 'zip') {
          return reply.code(501).send({
            error:
              'ZIP export is queued for a follow-up. Use format=json for the synchronous workspace dump.',
          })
        }

        const user = await getSoloUser()
        // Create the request row first — we'll fill in downloadUrl
        // and status synchronously below.
        const req = await (prisma as any).dataExportRequest.create({
          data: {
            userId: user?.id ?? null,
            status: 'RUNNING',
            format,
            scope: requestedScope,
          },
        })

        try {
          const dump = await buildWorkspaceDump(requestedScope)
          const payload = JSON.stringify(dump, null, 2)
          const bytes = Buffer.byteLength(payload, 'utf8')
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

          // For Phase H we don't actually upload to Cloudinary/S3;
          // the download endpoint regenerates the same dump on
          // demand. downloadUrl points back at /:id/download. This
          // keeps the request idempotent — two clicks of the same
          // history row produce the same content.
          const updated = await (prisma as any).dataExportRequest.update({
            where: { id: req.id },
            data: {
              status: 'COMPLETED',
              bytes,
              expiresAt,
              completedAt: new Date(),
              downloadUrl: `/api/settings/privacy/exports/${req.id}/download`,
            },
          })

          await writeSettingsAudit({
            // No dedicated key yet; sits under 'company' (workspace).
            key: 'company',
            action: 'create',
            before: null,
            after: {
              id: updated.id,
              format,
              bytes,
              scope: requestedScope,
            },
            metadata: { event: 'data_export_completed' },
          })

          return {
            ok: true,
            request: {
              id: updated.id,
              status: updated.status,
              format: updated.format,
              scope: updated.scope,
              bytes: updated.bytes,
              expiresAt: updated.expiresAt?.toISOString() ?? null,
              downloadUrl: updated.downloadUrl,
              createdAt: updated.createdAt.toISOString(),
            },
          }
        } catch (genErr: any) {
          await (prisma as any).dataExportRequest.update({
            where: { id: req.id },
            data: {
              status: 'FAILED',
              error: genErr?.message ?? String(genErr),
              completedAt: new Date(),
            },
          })
          throw genErr
        }
      } catch (err: any) {
        fastify.log.error({ err }, '[settings/privacy/export POST] failed')
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    },
  )

  fastify.get('/settings/privacy/exports', async (_request, reply) => {
    try {
      const rows = await (prisma as any).dataExportRequest.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
      return {
        exports: rows.map((r: any) => ({
          id: r.id,
          status: r.status,
          format: r.format,
          scope: r.scope,
          bytes: r.bytes,
          expiresAt: r.expiresAt?.toISOString() ?? null,
          downloadUrl: r.downloadUrl,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
        })),
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/privacy/exports GET] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.get<{ Params: { id: string } }>(
    '/settings/privacy/exports/:id/download',
    async (request, reply) => {
      try {
        const row = await (prisma as any).dataExportRequest.findUnique({
          where: { id: request.params.id },
        })
        if (!row) return reply.code(404).send({ error: 'Export not found' })
        if (row.status !== 'COMPLETED') {
          return reply.code(409).send({
            error: `Export is ${row.status} — try again once it completes.`,
          })
        }
        if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
          return reply.code(410).send({
            error:
              'This export download link has expired. Re-run the export to generate a fresh one.',
          })
        }
        // Regenerate. Idempotent because the request's scope+format
        // are stored on the row.
        const dump = await buildWorkspaceDump(row.scope ?? ['all'])
        reply.header('Content-Type', 'application/json')
        reply.header(
          'Content-Disposition',
          `attachment; filename="nexus-export-${row.id}.json"`,
        )
        return JSON.stringify(dump, null, 2)
      } catch (err: any) {
        fastify.log.error({ err }, '[settings/privacy/exports/download] failed')
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    },
  )

  // ────────────────────────────────────────────────────────────
  // RETENTION
  // ────────────────────────────────────────────────────────────

  fastify.get('/settings/privacy/retention', async (_request, reply) => {
    try {
      const row = await getOrCreateRetentionRow()
      return {
        policies: (row.policies as Record<string, number>) ?? DEFAULT_POLICIES,
        floors: RETENTION_FLOORS,
        ceilings: RETENTION_CEILINGS,
        defaults: DEFAULT_POLICIES,
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/privacy/retention GET] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.patch<{
    Body: { policies?: Record<string, number> }
  }>('/settings/privacy/retention', async (request, reply) => {
    try {
      const incoming = request.body?.policies ?? {}
      const row = await getOrCreateRetentionRow()
      const current = (row.policies as Record<string, number>) ?? {}
      // Validate + clamp each incoming value. Unknown keys are
      // dropped quietly to avoid letting clients seed arbitrary
      // policies; floors + ceilings enforce the fiscal/security
      // minimums.
      const next: Record<string, number> = { ...current }
      const fieldErrors: Record<string, string> = {}
      for (const [k, v] of Object.entries(incoming)) {
        if (!(k in DEFAULT_POLICIES)) continue
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          fieldErrors[k] = 'must be a number of days'
          continue
        }
        const floor = RETENTION_FLOORS[k]
        const ceil = RETENTION_CEILINGS[k]
        if (v < floor) {
          fieldErrors[k] = `minimum is ${floor} days`
          continue
        }
        if (v > ceil) {
          fieldErrors[k] = `maximum is ${ceil} days`
          continue
        }
        next[k] = Math.floor(v)
      }
      if (Object.keys(fieldErrors).length > 0) {
        return reply.code(400).send({ error: 'Validation failed', fieldErrors })
      }
      const updated = await (prisma as any).dataRetentionPolicy.update({
        where: { id: row.id },
        data: { policies: next },
      })
      await writeSettingsAudit({
        key: 'company',
        action: 'update',
        before: current,
        after: next,
        metadata: { event: 'retention_policy_updated' },
      })
      return { policies: updated.policies }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/privacy/retention PATCH] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ────────────────────────────────────────────────────────────
  // CONSENT
  // ────────────────────────────────────────────────────────────

  fastify.get('/settings/privacy/consent', async (_request, reply) => {
    try {
      const user = await getSoloUser()
      // Latest accept-or-opt-out per kind. Cheap because the table
      // is small per user; we do it client-side rather than with a
      // window function for portability across SQL flavours.
      const rows = await (prisma as any).consentRecord.findMany({
        where: { userId: user?.id ?? null },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
      const latest: Record<string, any> = {}
      for (const r of rows) {
        if (!latest[r.kind]) {
          latest[r.kind] = {
            accepted: r.accepted,
            version: r.version,
            at: r.createdAt.toISOString(),
          }
        }
      }
      return { latest }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/privacy/consent GET] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post<{
    Body: { kind?: string; version?: string; accepted?: boolean }
  }>('/settings/privacy/consent', async (request, reply) => {
    try {
      const body = request.body ?? {}
      const kind = String(body.kind ?? '').toUpperCase()
      const version = String(body.version ?? '').trim()
      const accepted = !!body.accepted
      if (!CONSENT_KINDS.has(kind)) {
        return reply.code(400).send({
          error: `kind must be one of: ${Array.from(CONSENT_KINDS).join(', ')}`,
        })
      }
      if (!version) {
        return reply.code(400).send({ error: 'version is required' })
      }
      const user = await getSoloUser()
      const row = await (prisma as any).consentRecord.create({
        data: {
          userId: user?.id ?? null,
          kind,
          version,
          accepted,
          ip: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
        },
      })
      await writeSettingsAudit({
        key: 'company',
        action: 'update',
        before: null,
        after: { kind, version, accepted },
        metadata: { event: 'consent_recorded', consentId: row.id },
      })
      return { ok: true, consentId: row.id, createdAt: row.createdAt.toISOString() }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/privacy/consent POST] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ────────────────────────────────────────────────────────────
  // DELETE-ACCOUNT DRY RUN
  // ────────────────────────────────────────────────────────────

  fastify.post(
    '/settings/privacy/delete-account-dry-run',
    async (_request, reply) => {
      try {
        const user = await getSoloUser()
        if (!user) {
          return { wouldDelete: { user: 0 }, blockedBy: ['No user profile.'] }
        }
        // Build a cascade preview WITHOUT deleting anything.
        // Numbers come from counts on every table that FK to
        // UserProfile (Phase C + E added these).
        const [
          sessions,
          recoveryCodes,
          loginEvents,
          notificationPrefs,
          notificationWebhooks,
          consents,
          exportRequests,
        ] = await Promise.all([
          (prisma as any).userSession.count({ where: { userId: user.id } }),
          (prisma as any).twoFactorRecoveryCode.count({
            where: { userId: user.id },
          }),
          (prisma as any).loginEvent.count({ where: { userId: user.id } }),
          (prisma as any).notificationPreference.count({
            where: { userId: user.id },
          }),
          (prisma as any).notificationWebhook.count({
            where: { userId: user.id },
          }),
          (prisma as any).consentRecord.count({ where: { userId: user.id } }),
          (prisma as any).dataExportRequest.count({
            where: { userId: user.id },
          }),
        ])
        // The Workspace-level data (Products, Orders, BrandSettings,
        // AccountSettings, audit log) is NOT user-scoped today.
        // Honest about that — the dry-run lists what would survive
        // so the operator can plan a separate workspace teardown.
        const survives = [
          'Products + listings + orders (workspace-scoped, not user-scoped)',
          'AccountSettings + BrandSettings (workspace singleton rows)',
          'AuditLog entries (kept for trail integrity; userId set to NULL on delete)',
        ]
        return {
          wouldDelete: {
            userProfile: 1,
            sessions,
            recoveryCodes,
            loginEvents,
            notificationPrefs,
            notificationWebhooks,
            consents,
            exportRequests,
          },
          wouldSurvive: survives,
          blockedBy: [
            'Phase I — actual deletion lands when multi-user auth ships. This endpoint is preview-only.',
          ],
        }
      } catch (err: any) {
        fastify.log.error(
          { err },
          '[settings/privacy/delete-account-dry-run] failed',
        )
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    },
  )
}

// ─── Workspace dump assembly ────────────────────────────────────
// Pulls every row across the user-facing tables + sanitises sensitive
// fields (keyHash on ApiKey, secretHash on NotificationWebhook,
// passwordHash on UserProfile, codeHash on TwoFactorRecoveryCode).
// Scope can include 'all' (default) or specific data-types.

interface WorkspaceDump {
  generatedAt: string
  schemaVersion: string
  scope: string[]
  workspace?: unknown
  user?: unknown
  products?: unknown[]
  channelListings?: unknown[]
  orders?: unknown[]
  notifications?: unknown
  webhooks?: unknown[]
  apiKeys?: unknown[]
  consents?: unknown[]
  auditLog?: unknown[]
}

async function buildWorkspaceDump(scope: string[]): Promise<WorkspaceDump> {
  const wants = (k: string) => scope.includes('all') || scope.includes(k)
  const dump: WorkspaceDump = {
    generatedAt: new Date().toISOString(),
    schemaVersion: '2026-05-19',
    scope,
  }

  // Workspace singletons.
  if (wants('workspace')) {
    const [account, brand] = await Promise.all([
      (prisma as any).accountSettings.findFirst(),
      (prisma as any).brandSettings.findFirst(),
    ])
    dump.workspace = { account, brand }
  }

  // User. Never include passwordHash / twoFactorSecret in exports.
  if (wants('user')) {
    const u = await (prisma as any).userProfile.findFirst()
    if (u) {
      const { passwordHash, twoFactorSecret, ...safe } = u
      void passwordHash
      void twoFactorSecret
      dump.user = safe
    }
  }

  if (wants('products')) {
    dump.products = await (prisma as any).product.findMany({
      take: 10_000,
    })
  }

  if (wants('listings')) {
    dump.channelListings = await (prisma as any).channelListing.findMany({
      take: 20_000,
    })
  }

  if (wants('orders')) {
    dump.orders = await (prisma as any).order.findMany({
      take: 10_000,
      include: { items: true },
    })
  }

  if (wants('notifications')) {
    const [prefs, webhooks] = await Promise.all([
      (prisma as any).notificationPreference.findMany(),
      (prisma as any).notificationWebhook.findMany(),
    ])
    dump.notifications = prefs
    // Strip secretHash; expose label/url/events/lastFire only.
    dump.webhooks = webhooks.map((w: any) => {
      const { secretHash, ...safe } = w
      void secretHash
      return safe
    })
  }

  if (wants('apiKeys')) {
    const keys = await (prisma as any).apiKey.findMany()
    dump.apiKeys = keys.map((k: any) => {
      const { keyHash, ...safe } = k
      void keyHash
      return safe
    })
  }

  if (wants('consents')) {
    dump.consents = await (prisma as any).consentRecord.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
  }

  if (wants('auditLog')) {
    dump.auditLog = await (prisma as any).auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5_000,
    })
  }

  return dump
}

export default settingsPrivacyRoutes
