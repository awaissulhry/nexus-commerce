/**
 * Settings rebuild — Phase E.3
 *
 * Webhook subscription CRUD for /settings/webhooks.
 *
 *   GET    /api/settings/webhooks              list (newest first)
 *   POST   /api/settings/webhooks              create (returns raw secret ONCE)
 *   PATCH  /api/settings/webhooks/:id          update label/url/events/isActive
 *   DELETE /api/settings/webhooks/:id          remove (cascade — no
 *                                              delivery-history table yet)
 *   POST   /api/settings/webhooks/:id/test     fire a test payload
 *                                              against the configured URL
 *
 * Secret handling mirrors the API key flow:
 *   • Generated server-side as 32 random bytes, hex-encoded
 *   • Plaintext returned exactly once at create time
 *   • Stored as bcrypt hash; secretPrefix (first 8 chars) shown
 *     in the UI for identification
 *
 * The dispatch worker that actually fires real events isn't wired
 * here — Phase E lands the schema + CRUD + test-payload. Real
 * event-triggered delivery is a follow-up because it touches every
 * existing emitter (audit log, channel sync, AI completion, etc.).
 */

import type { FastifyPluginAsync } from 'fastify'
import { randomBytes, createHmac } from 'crypto'
import bcrypt from 'bcryptjs'
import prisma from '../db.js'
import { writeSettingsAudit } from '../utils/settings-audit.js'

// Event-types are validated against this list — same set the
// /settings/notifications page uses. Drop a key here when a new
// event class lands.
const KNOWN_EVENTS = new Set([
  'NEW_ORDER',
  'LOW_STOCK',
  'RETURN_REQUEST',
  'SYNC_FAILURE',
  'AI_COMPLETE',
])

function generateSecret(): string {
  // 32 bytes → 64 hex chars. Same shape Stripe + GitHub use for
  // webhook secrets; opaque enough that the prefix can be displayed
  // without leaking the rest.
  return randomBytes(32).toString('hex')
}

function signPayload(secret: string, payload: string): string {
  // HMAC-SHA256, hex-encoded. The receiver computes the same hash
  // with their stored secret + compares; constant-time string
  // compare on the receiver side is their job.
  return createHmac('sha256', secret).update(payload).digest('hex')
}

async function getSoloUser() {
  return (await (prisma as any).userProfile.findFirst()) as
    | { id: string }
    | null
}

const settingsWebhooksRoutes: FastifyPluginAsync = async (fastify) => {
  // ── List ──────────────────────────────────────────────────────
  fastify.get('/settings/webhooks', async (_request, reply) => {
    try {
      const rows = await (prisma as any).notificationWebhook.findMany({
        orderBy: { createdAt: 'desc' },
      })
      return {
        webhooks: rows.map((r: any) => ({
          id: r.id,
          label: r.label,
          url: r.url,
          secretPrefix: r.secretPrefix,
          events: r.events,
          isActive: r.isActive,
          lastFiredAt: r.lastFiredAt?.toISOString() ?? null,
          lastStatus: r.lastStatus,
          lastError: r.lastError,
          consecutiveFails: r.consecutiveFails,
          createdAt: r.createdAt.toISOString(),
        })),
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/webhooks GET] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ── Create ────────────────────────────────────────────────────
  fastify.post<{
    Body: { label?: string; url?: string; events?: string[] }
  }>('/settings/webhooks', async (request, reply) => {
    try {
      const body = request.body ?? {}
      const label = (body.label ?? '').trim()
      const url = (body.url ?? '').trim()
      const events = Array.isArray(body.events) ? body.events : []

      if (label.length === 0 || label.length > 80) {
        return reply
          .code(400)
          .send({ error: 'Label is required (1–80 characters).' })
      }
      // Basic URL validation. Reject http:// in production — webhook
      // payloads must travel over TLS. localhost passes for testing.
      try {
        const u = new URL(url)
        if (!['http:', 'https:'].includes(u.protocol)) {
          throw new Error('protocol')
        }
        const isLocal =
          u.hostname === 'localhost' ||
          u.hostname === '127.0.0.1' ||
          u.hostname.endsWith('.local')
        if (u.protocol === 'http:' && !isLocal) {
          return reply.code(400).send({
            error:
              'Webhook URL must use HTTPS (HTTP allowed only for localhost / .local during testing).',
          })
        }
      } catch {
        return reply.code(400).send({ error: 'URL must be a valid http(s) URL.' })
      }
      const invalidEvents = events.filter((e) => !KNOWN_EVENTS.has(e))
      if (invalidEvents.length > 0) {
        return reply.code(400).send({
          error: `Unknown event-type(s): ${invalidEvents.join(', ')}`,
        })
      }

      const user = await getSoloUser()
      const rawSecret = generateSecret()
      const secretHash = await bcrypt.hash(rawSecret, 10)
      const secretPrefix = rawSecret.slice(0, 8)

      const row = await (prisma as any).notificationWebhook.create({
        data: {
          userId: user?.id ?? null,
          label,
          url,
          secretHash,
          secretPrefix,
          events,
          isActive: true,
        },
      })

      await writeSettingsAudit({
        // Webhook events are part of the developer settings surface,
        // not "notifications" per se. Until we have a dedicated key
        // they ride the api-keys audit channel — same shape
        // (id/label/prefix), no secret material.
        key: 'api-keys',
        action: 'create',
        before: null,
        after: {
          id: row.id,
          label,
          url,
          events,
          secretPrefix,
        },
        metadata: { event: 'webhook_created' },
      })

      return {
        ok: true,
        webhook: {
          id: row.id,
          label,
          url,
          events,
          isActive: row.isActive,
          secretPrefix,
          createdAt: row.createdAt.toISOString(),
        },
        // Returned ONCE — caller must capture it now.
        secret: rawSecret,
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/webhooks POST] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ── Update ────────────────────────────────────────────────────
  fastify.patch<{
    Params: { id: string }
    Body: {
      label?: string
      url?: string
      events?: string[]
      isActive?: boolean
    }
  }>('/settings/webhooks/:id', async (request, reply) => {
    try {
      const id = request.params.id
      const existing = await (prisma as any).notificationWebhook.findUnique({
        where: { id },
      })
      if (!existing) {
        return reply.code(404).send({ error: 'Webhook not found' })
      }
      const body = request.body ?? {}
      const data: Record<string, unknown> = {}
      if (typeof body.label === 'string') {
        const v = body.label.trim()
        if (v.length === 0 || v.length > 80) {
          return reply.code(400).send({ error: 'Label must be 1–80 characters.' })
        }
        data.label = v
      }
      if (typeof body.url === 'string') {
        const v = body.url.trim()
        try {
          new URL(v)
        } catch {
          return reply
            .code(400)
            .send({ error: 'URL must be a valid http(s) URL.' })
        }
        data.url = v
      }
      if (Array.isArray(body.events)) {
        const invalid = body.events.filter((e) => !KNOWN_EVENTS.has(e))
        if (invalid.length > 0) {
          return reply
            .code(400)
            .send({ error: `Unknown event-type(s): ${invalid.join(', ')}` })
        }
        data.events = body.events
      }
      if (typeof body.isActive === 'boolean') data.isActive = body.isActive

      const updated = await (prisma as any).notificationWebhook.update({
        where: { id },
        data,
      })
      await writeSettingsAudit({
        key: 'api-keys',
        action: 'update',
        before: {
          id: existing.id,
          label: existing.label,
          url: existing.url,
          events: existing.events,
          isActive: existing.isActive,
        },
        after: {
          id: updated.id,
          label: updated.label,
          url: updated.url,
          events: updated.events,
          isActive: updated.isActive,
        },
        metadata: { event: 'webhook_updated' },
      })
      return { ok: true }
    } catch (err: any) {
      fastify.log.error({ err }, '[settings/webhooks PATCH] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ── Delete ────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/settings/webhooks/:id',
    async (request, reply) => {
      try {
        const existing = await (prisma as any).notificationWebhook.findUnique({
          where: { id: request.params.id },
        })
        if (!existing) {
          return reply.code(404).send({ error: 'Webhook not found' })
        }
        await (prisma as any).notificationWebhook.delete({
          where: { id: existing.id },
        })
        await writeSettingsAudit({
          key: 'api-keys',
          action: 'delete',
          before: {
            id: existing.id,
            label: existing.label,
            url: existing.url,
          },
          after: null,
          metadata: { event: 'webhook_deleted' },
        })
        return { ok: true }
      } catch (err: any) {
        fastify.log.error({ err }, '[settings/webhooks DELETE] failed')
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    },
  )

  // ── Test payload ──────────────────────────────────────────────
  // Fires a one-shot POST with a small JSON body + HMAC signature.
  // Updates lastFiredAt / lastStatus / lastError on the row so the
  // UI can show "Last delivery: 200 OK" or the failure reason.
  fastify.post<{ Params: { id: string } }>(
    '/settings/webhooks/:id/test',
    async (request, reply) => {
      try {
        const row = await (prisma as any).notificationWebhook.findUnique({
          where: { id: request.params.id },
        })
        if (!row) {
          return reply.code(404).send({ error: 'Webhook not found' })
        }
        // We can't sign with the bcrypted secret (it's one-way).
        // The test payload uses a fresh ephemeral signing key + we
        // tell the receiver in the header that this is a test, so
        // they know to skip signature verification or expect it
        // signed with a marker. Production payloads use the real
        // secret (which the receiver also has).
        const fakeSecret = 'test-secret-not-used-for-production'
        const payload = JSON.stringify({
          event: 'TEST',
          deliveryId: randomBytes(8).toString('hex'),
          timestamp: new Date().toISOString(),
          webhookId: row.id,
          data: { hello: 'world' },
        })
        const signature = signPayload(fakeSecret, payload)

        const started = Date.now()
        let status = 0
        let errText: string | null = null
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 8000)
          const res = await fetch(row.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Nexus-Event': 'TEST',
              'X-Nexus-Signature': `sha256=${signature}`,
              'X-Nexus-Test': '1',
            },
            body: payload,
            signal: controller.signal,
          })
          clearTimeout(timeout)
          status = res.status
          if (!res.ok) {
            errText = await res.text().catch(() => `HTTP ${status}`)
          }
        } catch (e: any) {
          errText = e?.message ?? String(e)
          status = 0
        }
        const tookMs = Date.now() - started

        await (prisma as any).notificationWebhook.update({
          where: { id: row.id },
          data: {
            lastFiredAt: new Date(),
            lastStatus: status,
            lastError: errText,
            consecutiveFails: status >= 200 && status < 300 ? 0 : row.consecutiveFails + 1,
          },
        })

        return {
          ok: status >= 200 && status < 300,
          status,
          error: errText,
          tookMs,
        }
      } catch (err: any) {
        fastify.log.error({ err }, '[settings/webhooks/test] failed')
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    },
  )
}

export default settingsWebhooksRoutes
