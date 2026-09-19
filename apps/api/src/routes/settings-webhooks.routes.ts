import { currentProfileUser } from '../lib/auth/current-user.js'
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
 * Secret handling:
 *   • Generated server-side as 32 random bytes, hex-encoded
 *   • Plaintext returned exactly once at create time
 *   • P0.3 — stored as an AES-GCM v1 envelope (lib/outbound-webhook.ts)
 *     in the column still named `secretHash`; the dispatcher opens it
 *     to sign (bcrypt would be one-way). A missing key refuses the
 *     save. Pre-P0.3 plain-text rows still sign and are re-sealed on
 *     their next delivery. secretPrefix is the first 8 chars, shown in
 *     the UI for identification.
 *
 * URL handling (P0.3, S14): HTTPS to a public address only, no
 * redirects, 8 s, a capped reply — see lib/outbound-webhook.ts.
 *
 * The dispatch worker that actually fires real events isn't wired
 * here — Phase E lands the schema + CRUD + test-payload. Real
 * event-triggered delivery is a follow-up because it touches every
 * existing emitter (audit log, channel sync, AI completion, etc.).
 */

import type { FastifyPluginAsync } from 'fastify'
import { randomBytes, createHmac } from 'crypto'
import prisma from '../db.js'
import { writeSettingsAudit } from '../utils/settings-audit.js'
import {
  capWebhookError,
  deliverWebhook,
  openWebhookSecret,
  resealIfLegacy,
  sealWebhookSecret,
  webhookUrlProblem,
} from '../lib/outbound-webhook.js'

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
  return (await currentProfileUser()) as
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
      // P0.3 — HTTPS to a public address only (no localhost, private
      // network or metadata host). Re-checked at connect time.
      const urlProblem = webhookUrlProblem(url)
      if (urlProblem) return reply.code(400).send({ error: urlProblem })
      const invalidEvents = events.filter((e) => !KNOWN_EVENTS.has(e))
      if (invalidEvents.length > 0) {
        return reply.code(400).send({
          error: `Unknown event-type(s): ${invalidEvents.join(', ')}`,
        })
      }

      const user = await getSoloUser()
      const rawSecret = generateSecret()
      const secretPrefix = rawSecret.slice(0, 8)

      // P0.3 — the column is still named `secretHash` (Phase E), but it
      // holds a sealed envelope the dispatcher can open to HMAC-sign.
      // Without the encryption key, refuse: never store plain text.
      let sealedSecret: string
      try {
        sealedSecret = sealWebhookSecret(rawSecret)
      } catch {
        return reply.code(503).send({
          error:
            'Webhook secrets cannot be stored safely: the encryption key is not configured. Nothing was saved.',
        })
      }
      const row = await (prisma as any).notificationWebhook.create({
        data: {
          userId: user?.id ?? null,
          label,
          url,
          secretHash: sealedSecret,
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
        // P0.3 — the same rule as create (it accepted any URL before).
        const urlProblem = webhookUrlProblem(v)
        if (urlProblem) return reply.code(400).send({ error: urlProblem })
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
        // Sign with the row's stored secret — same key the receiver
        // verifies with. Rows created in the brief Phase E window hold
        // a one-way bcrypt hash and can never sign: say so instead of
        // firing a payload the receiver can never verify.
        let opened: ReturnType<typeof openWebhookSecret>
        try {
          opened = openWebhookSecret(String(row.secretHash ?? ''))
        } catch {
          return reply.code(409).send({
            error:
              'The signing secret for this webhook cannot be read. Recreate the webhook to generate a fresh signing key.',
          })
        }
        if (opened.kind === 'legacy-bcrypt') {
          return reply.code(409).send({
            error:
              'This subscription was created before the secret-format upgrade and cannot be signed. Recreate the webhook to generate a fresh signing key.',
          })
        }
        const payload = JSON.stringify({
          event: 'TEST',
          deliveryId: randomBytes(8).toString('hex'),
          timestamp: new Date().toISOString(),
          webhookId: row.id,
          data: { hello: 'world' },
        })
        const signature = signPayload(opened.secret, payload)

        // P0.3 — public HTTPS only, no redirects, 8 s, capped reply.
        const delivery = await deliverWebhook({
          url: row.url,
          body: payload,
          headers: {
            'Content-Type': 'application/json',
            'X-Nexus-Event': 'TEST',
            // sha256=<hex> — same convention GitHub + Stripe use.
            'X-Nexus-Signature': `sha256=${signature}`,
            'X-Nexus-Test': '1',
          },
        })
        const resealed = resealIfLegacy(opened)

        await (prisma as any).notificationWebhook.update({
          where: { id: row.id },
          data: {
            lastFiredAt: new Date(),
            lastStatus: delivery.status,
            lastError: capWebhookError(delivery.error),
            consecutiveFails: delivery.ok ? 0 : row.consecutiveFails + 1,
            ...(resealed ? { secretHash: resealed } : {}),
          },
        })

        return {
          ok: delivery.ok,
          status: delivery.status,
          error: delivery.error,
          tookMs: delivery.tookMs,
        }
      } catch (err: any) {
        fastify.log.error({ err }, '[settings/webhooks/test] failed')
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    },
  )
}

export default settingsWebhooksRoutes
