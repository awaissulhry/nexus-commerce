/**
 * Settings rebuild — Phase B.4
 *
 * GET /api/settings/audit
 *   List settings change history. Backed by AuditLog rows where
 *   entityType = 'Settings'. Queryable by key, action, and date range.
 *   Always paginated; default page size 50, max 200.
 *
 * GET /api/settings/audit/keys
 *   Lightweight aggregation — count of audit rows per key for the
 *   last 30 days. Drives the filter-chip count badges on the
 *   /settings/audit page.
 *
 * POST /api/settings/audit/:id/revert
 *   Restore the `before` snapshot from a specific audit row. Only
 *   accepts the `update` action (create/delete reverts would need
 *   per-key resurrection logic that we'd rather encode as Phase I
 *   work). Writes a new audit row of its own so the revert itself
 *   is auditable.
 *
 * No auth gate yet — single-tenant. When auth lands, wrap with
 * the standard requireAuth() middleware.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { writeSettingsAudit, type SettingsAuditKey } from '../utils/settings-audit.js'

const KNOWN_KEYS: ReadonlyArray<SettingsAuditKey> = [
  'account',
  'profile',
  'profile.password',
  'notifications',
  'api-keys',
  'company',
  'terminology',
]

const settingsAuditRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /api/settings/audit ─────────────────────────────────────
  fastify.get<{
    Querystring: {
      key?: string
      action?: string
      since?: string
      until?: string
      limit?: string
      offset?: string
    }
  }>('/settings/audit', async (request, reply) => {
    try {
      const q = request.query
      const limit = Math.min(
        Math.max(parseInt(q.limit ?? '50', 10) || 50, 1),
        200,
      )
      const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0)

      const where: any = { entityType: 'Settings' }
      if (q.key && q.key !== 'all') {
        // Allow comma-separated list ("key=account,profile").
        const keys = q.key.split(',').map((k) => k.trim()).filter(Boolean)
        if (keys.length === 1) where.entityId = keys[0]
        else if (keys.length > 1) where.entityId = { in: keys }
      }
      if (q.action) {
        where.action = q.action
      }
      if (q.since) {
        const d = new Date(q.since)
        if (!Number.isNaN(d.getTime())) {
          where.createdAt = { ...(where.createdAt ?? {}), gte: d }
        }
      }
      if (q.until) {
        const d = new Date(q.until)
        if (!Number.isNaN(d.getTime())) {
          where.createdAt = { ...(where.createdAt ?? {}), lte: d }
        }
      }

      const [total, rows] = await Promise.all([
        prisma.auditLog.count({ where }),
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          select: {
            id: true,
            entityId: true,
            action: true,
            before: true,
            after: true,
            metadata: true,
            createdAt: true,
            userId: true,
          },
        }),
      ])

      return {
        total,
        limit,
        offset,
        items: rows.map((r) => ({
          id: r.id,
          key: r.entityId,
          action: r.action,
          before: r.before,
          after: r.after,
          metadata: r.metadata,
          createdAt: r.createdAt.toISOString(),
          userId: r.userId,
        })),
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/audit GET] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ── GET /api/settings/audit/keys ────────────────────────────────
  // 30-day rollup. Cheap groupBy; one query, no joins.
  fastify.get('/settings/audit/keys', async (_request, reply) => {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const rows = await prisma.auditLog.groupBy({
        by: ['entityId'],
        where: { entityType: 'Settings', createdAt: { gte: cutoff } },
        _count: { _all: true },
      })
      const byKey: Record<string, number> = {}
      for (const r of rows) byKey[r.entityId] = r._count._all
      return { byKey, since: cutoff.toISOString() }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/audit/keys] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ── POST /api/settings/audit/:id/revert ─────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/settings/audit/:id/revert',
    async (request, reply) => {
      try {
        const row = await prisma.auditLog.findUnique({
          where: { id: request.params.id },
        })
        if (!row || row.entityType !== 'Settings') {
          return reply.code(404).send({ error: 'Audit row not found' })
        }
        if (row.action !== 'update') {
          return reply.code(400).send({
            error:
              'Only `update` rows can be reverted. Reverting `create` (delete the row) or `delete` (recreate the row) is not supported.',
          })
        }
        const key = row.entityId as SettingsAuditKey
        if (!KNOWN_KEYS.includes(key)) {
          return reply.code(400).send({ error: `Unknown settings key: ${key}` })
        }
        const before = row.before as Record<string, unknown> | null
        if (!before || Object.keys(before).length === 0) {
          return reply.code(400).send({
            error: 'Audit row has no `before` snapshot to restore from.',
          })
        }

        const applied = await applyRevert(key, before)
        if (!applied.ok) {
          return reply.code(applied.code ?? 500).send({ error: applied.error })
        }

        // The revert itself is auditable — log it so the trail
        // shows "reverted from <auditId>".
        await writeSettingsAudit({
          key,
          action: 'update',
          before: applied.before ?? null,
          after: applied.after ?? null,
          metadata: { event: 'reverted', fromAuditId: row.id },
        })

        return {
          ok: true,
          key,
          fieldsRestored: Object.keys(before).length,
        }
      } catch (err: any) {
        fastify.log.error({ err }, '[settings/audit/revert] failed')
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    },
  )
}

/**
 * Per-key revert dispatcher. Each settings page that supports
 * revert has its own entry — we apply ONLY the fields present in
 * the `before` snapshot, so a revert is precise: if the user
 * changed only "currency" and reverts, only currency rolls back.
 *
 * Returns the new (before, after) snapshot so the audit row for
 * the revert itself diffs cleanly.
 */
async function applyRevert(
  key: SettingsAuditKey,
  before: Record<string, unknown>,
): Promise<{
  ok: boolean
  code?: number
  error?: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
}> {
  switch (key) {
    case 'account': {
      const row = await (prisma as any).accountSettings.findFirst()
      if (!row) {
        return { ok: false, code: 404, error: 'AccountSettings row not found' }
      }
      const beforeSnapshot: Record<string, unknown> = {}
      for (const k of Object.keys(before)) beforeSnapshot[k] = row[k] ?? null
      const updated = await (prisma as any).accountSettings.update({
        where: { id: row.id },
        data: before,
      })
      const afterSnapshot: Record<string, unknown> = {}
      for (const k of Object.keys(before)) afterSnapshot[k] = updated[k] ?? null
      return { ok: true, before: beforeSnapshot, after: afterSnapshot }
    }
    case 'profile': {
      const row = await (prisma as any).userProfile.findFirst()
      if (!row) {
        return { ok: false, code: 404, error: 'UserProfile row not found' }
      }
      // We never write to passwordHash via revert — that's password.* events.
      const safe: Record<string, unknown> = {}
      const beforeSnapshot: Record<string, unknown> = {}
      for (const k of Object.keys(before)) {
        if (k === 'passwordHash') continue
        safe[k] = before[k]
        beforeSnapshot[k] = row[k] ?? null
      }
      const updated = await (prisma as any).userProfile.update({
        where: { id: row.id },
        data: safe,
      })
      const afterSnapshot: Record<string, unknown> = {}
      for (const k of Object.keys(safe)) afterSnapshot[k] = updated[k] ?? null
      return { ok: true, before: beforeSnapshot, after: afterSnapshot }
    }
    case 'notifications': {
      // Notifications snapshot is flattened ("NEW_ORDER.email": true).
      // Split back into per-eventType updates.
      const grouped: Record<string, Record<string, boolean>> = {}
      for (const flat of Object.keys(before)) {
        const [eventType, channel] = flat.split('.')
        if (!eventType || !channel) continue
        grouped[eventType] ??= {}
        grouped[eventType][channel] = !!before[flat]
      }
      for (const [eventType, data] of Object.entries(grouped)) {
        await (prisma as any).notificationPreference.upsert({
          where: { eventType },
          update: data,
          create: { eventType, email: false, sms: false, inApp: false, ...data },
        })
      }
      return { ok: true, before: {}, after: before }
    }
    case 'company': {
      const row = await prisma.brandSettings.findFirst()
      if (!row) {
        return { ok: false, code: 404, error: 'BrandSettings row not found' }
      }
      const beforeSnapshot: Record<string, unknown> = {}
      for (const k of Object.keys(before))
        beforeSnapshot[k] = (row as any)[k] ?? null
      const updated = await prisma.brandSettings.update({
        where: { id: row.id },
        data: before,
      })
      const afterSnapshot: Record<string, unknown> = {}
      for (const k of Object.keys(before))
        afterSnapshot[k] = (updated as any)[k] ?? null
      return { ok: true, before: beforeSnapshot, after: afterSnapshot }
    }
    case 'terminology':
    case 'api-keys':
    case 'profile.password':
      // These pages have row-identity (terminology by id, api-keys by
      // id, password is a write-only event). Reverting them would
      // need per-row resurrect / unrevoke logic that's out of scope
      // for Phase B. Surfaced as 400 so the UI can hide the revert
      // button for these keys.
      return {
        ok: false,
        code: 400,
        error: `Revert is not supported for the "${key}" page (yet).`,
      }
    default:
      return { ok: false, code: 400, error: `Unknown key: ${key}` }
  }
}

export default settingsAuditRoutes
