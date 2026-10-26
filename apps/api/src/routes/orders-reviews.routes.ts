import { workspaceKey } from '@nexus/database/workspace-context'
import { lintBuyerCopy } from '../services/comms/message-lint.js'
/**
 * D.7 — Review request engine + Amazon Solicitations bridge.
 *
 * Endpoint surface:
 *
 *   GET    /api/review-rules                list rules
 *   POST   /api/review-rules                create rule
 *   GET    /api/review-rules/:id            single rule
 *   PATCH  /api/review-rules/:id            update rule
 *   DELETE /api/review-rules/:id            delete rule
 *   POST   /api/review-rules/:id/dry-run    preview matching orders
 *   POST   /api/review-rules/:id/run        eagerly enqueue matches
 *
 *   GET    /api/review-requests             paginated list
 *   POST   /api/orders/:id/request-review   manual one-off
 *   POST   /api/orders/bulk-request-reviews bulk one-off
 *
 * Reviews area PR C (services/reviews/review-queue.service.ts; no database call here):
 *   GET    /api/review-queue                the queue: rows, tiles, failures of 7 days, facets
 *   GET    /api/review-queue/sending        paused?, next run, last run, what is due
 *   GET    /api/review-queue/:id            one request: window, Amazon's answer, timeline, held actions
 *   POST   /api/review-queue/run            the ONE sender now (held while paused)
 *   POST   /api/review-queue/pause|resume   the business's switch; the actor is the signed-in person
 *   POST   /api/review-queue/bulk           snooze / skip / send now
 *   GET    /api/review-emails/preview       the review e-mail as a buyer gets it (no send)
 *   POST   /api/review-emails/test          one real e-mail to the signed-in person
 *   GET    /api/review-rules?withStats=1    + sent30, rate30, matched30 per rule
 *   POST   /api/review-rules/bulk           on / off / delete, held rules in words
 *   GET    /api/review-rules/export?ids=    the chosen rules (all without ids)
 *
 * POST /api/review-engine/tick is gone (B9): it sent without the pause switch and the "How was it?" check and marked
 * every non-Amazon request skipped. "Run now" is POST /api/review-queue/run, the same sender as the hourly cron.
 *
 * The Amazon Solicitations API call is wrapped behind a stub function
 * (sendAmazonSolicitation) that the SP-API client wires into. When the
 * client is unavailable we return SKIPPED with a clear reason instead
 * of failing — keeps the engine safely idempotent.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import {
  AMAZON_SOLICITATION_MAX_DAYS,
  AMAZON_SOLICITATION_MIN_DAYS,
  sendAmazonSolicitation as sharedSendAmazonSolicitation,
  isBenignFailure,
  benignSuppressedReason,
} from '../services/reviews/amazon-solicitations.service.js'
import { requestReviewForOrder } from '../services/reviews/review-request.service.js'
import { findOrdersMatchingRule } from '../services/reviews/review-scheduler.service.js'
import { requestUserId } from '../lib/auth/request-permission.js'
import {
  bulkReviewQueue,
  bulkReviewRules,
  exportReviewRules,
  listReviewQueue,
  pauseReviewQueue,
  resumeReviewQueue,
  reviewEmailPreview,
  reviewQueueDetail,
  reviewSendingState,
  ruleStats,
  runReviewQueueNow,
  sendReviewEmailTest,
} from '../services/reviews/review-queue.service.js'

const ACTIVE_RETURN_STATUSES = ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] as const

// RV.3.2 — Solicitations API + marketplace map moved to
// services/reviews/amazon-solicitations.service.ts. Both this file and
// the cron mailer import from there. The shared module also exports
// isBenignFailure / benignSuppressedReason for status classification.
const sendAmazonSolicitation = sharedSendAmazonSolicitation

/** A service's refusal (statusCode 400/403 + words) as its status; anything else is a 500 with the message. */
function sendFailure(reply: any, err: any) {
  const status = typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500
  if (status === 500) logger.error('[REVIEW QUEUE] request failed', { message: err?.message })
  return reply.status(status).send({ error: err?.message ?? 'failed' })
}

// Extract the channel order id Amazon expects (Amazon Order ID).
function extractAmazonOrderId(order: any): string | null {
  // The Order.channelOrderId IS the Amazon-Order-Id when channel === 'AMAZON'.
  return order.channel === 'AMAZON' ? order.channelOrderId : null
}

// RRT.4 — validate + normalize the operator-configurable timing fields shared by
// POST/PATCH. anchor is advisory (the resolver forces Amazon→DELIVERY at send).
function timingFieldsFromBody(body: any): Record<string, any> {
  const out: Record<string, any> = {}
  if (Array.isArray(body.productTypes)) out.productTypes = body.productTypes.map((p: any) => String(p).trim()).filter(Boolean)
  if (body.sendDelayDays !== undefined) out.sendDelayDays = body.sendDelayDays == null ? null : Math.max(1, Math.min(60, Math.floor(Number(body.sendDelayDays))))
  if (body.anchor !== undefined) out.anchor = ['DELIVERY', 'SHIP', 'PURCHASE'].includes(body.anchor) ? body.anchor : 'DELIVERY'
  if (body.sendHourLocal !== undefined) out.sendHourLocal = body.sendHourLocal == null ? null : Math.max(0, Math.min(23, Math.floor(Number(body.sendHourLocal))))
  if (body.skipWeekends !== undefined) out.skipWeekends = body.skipWeekends === true
  if (body.shiftToBestDay !== undefined) out.shiftToBestDay = body.shiftToBestDay === true
  return out
}

const ordersReviewsRoutes: FastifyPluginAsync = async (fastify) => {
  // ═══════════════════════════════════════════════════════════════════
  // RULES — CRUD
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/review-rules', async (request, reply) => {
    try {
      const rules = await prisma.reviewRule.findMany({
        orderBy: [{ isActive: 'desc' }, { scope: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { requests: true } } },
      })
      // PR C — `?withStats=1`: sent in 30 days, review rate (estimate), orders the rule decided in 30 days.
      const withStats = (request.query as { withStats?: string })?.withStats === '1'
      let stats: Awaited<ReturnType<typeof ruleStats>> | null = null
      let statsError: string | null = null
      if (withStats) {
        stats = await ruleStats().catch((err) => {
          logger.warn('[REVIEW ENGINE] rule stats failed', { message: err?.message })
          statsError = 'The numbers of the last 30 days could not be read'
          return null
        })
      }
      return {
        ...(withStats ? { statsError } : {}),
        items: rules.map((r) => ({
          ...(stats ? (stats.get(r.id) ?? { sent30: 0, rate30: null, matched30: 0 }) : {}),
          id: r.id, name: r.name, scope: r.scope, marketplace: r.marketplace,
          isActive: r.isActive,
          minDaysSinceDelivery: r.minDaysSinceDelivery,
          maxDaysSinceDelivery: r.maxDaysSinceDelivery,
          exclusions: r.exclusions,
          minOrderTotalCents: r.minOrderTotalCents,
          notes: r.notes,
          useSentimentDiversion: r.useSentimentDiversion,
          fallbackOnNoResponse: r.fallbackOnNoResponse,
          productTypes: r.productTypes,
          sendDelayDays: r.sendDelayDays,
          anchor: r.anchor,
          sendHourLocal: r.sendHourLocal,
          skipWeekends: r.skipWeekends,
          shiftToBestDay: r.shiftToBestDay,
          requestCount: r._count.requests,
          updatedAt: r.updatedAt,
        })),
      }
    } catch (err: any) {
      return reply.status(500).send({ error: err.message })
    }
  })

  fastify.post('/review-rules', async (request, reply) => {
    try {
      const body = request.body as any
      if (!body?.name?.trim() || !body?.scope) {
        return reply.status(400).send({ error: 'name + scope required' })
      }
      if (body.scope === 'AMAZON_PER_MARKETPLACE' && !body.marketplace) {
        return reply.status(400).send({ error: 'marketplace required for AMAZON_PER_MARKETPLACE scope' })
      }
      const created = await prisma.reviewRule.create({
        data: {
          name: body.name.trim(),
          scope: body.scope,
          marketplace: body.marketplace ?? null,
          isActive: body.isActive ?? true,
          minDaysSinceDelivery: Math.max(4, Math.floor(body.minDaysSinceDelivery ?? 7)),
          maxDaysSinceDelivery: Math.min(30, Math.floor(body.maxDaysSinceDelivery ?? 25)),
          exclusions: Array.isArray(body.exclusions) ? body.exclusions : [],
          minOrderTotalCents: body.minOrderTotalCents ?? null,
          notes: body.notes ?? null,
          useSentimentDiversion: body.useSentimentDiversion === true,
          fallbackOnNoResponse: body.fallbackOnNoResponse !== false,
          ...timingFieldsFromBody(body),
          createdBy: 'default-user',
        },
      })
      return created
    } catch (err: any) {
      if (err.code === 'P2002') return reply.status(409).send({ error: 'A rule with this name and scope already exists' })
      return reply.status(500).send({ error: err.message })
    }
  })

  fastify.get('/review-rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const rule = await prisma.reviewRule.findUnique({ where: { id } })
    if (!rule) return reply.status(404).send({ error: 'Rule not found' })
    return rule
  })

  fastify.patch('/review-rules/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as any
      const data: any = {}
      if (body.name != null) data.name = body.name
      // RV.9.1 follow-up — scope was missing from the allowlist, so
      // flipping AMAZON_PER_MARKETPLACE → AMAZON_GLOBAL silently no-op'd
      // and left the rule broken (scope unchanged, marketplace cleared).
      if (body.scope != null) {
        data.scope = body.scope
        // Server-side guard: scopes other than per-marketplace must NOT
        // carry a marketplace value (defensive — even if the client
        // sends one, ignore it).
        if (body.scope !== 'AMAZON_PER_MARKETPLACE') data.marketplace = null
      }
      if (body.isActive != null) data.isActive = body.isActive
      if (body.minDaysSinceDelivery != null) data.minDaysSinceDelivery = Math.max(4, Math.floor(body.minDaysSinceDelivery))
      if (body.maxDaysSinceDelivery != null) data.maxDaysSinceDelivery = Math.min(30, Math.floor(body.maxDaysSinceDelivery))
      if (Array.isArray(body.exclusions)) data.exclusions = body.exclusions
      if (body.minOrderTotalCents !== undefined) data.minOrderTotalCents = body.minOrderTotalCents
      if (body.notes !== undefined) data.notes = body.notes
      // RV.9.1 follow-up — only honor marketplace updates when the new
      // (or current) scope is AMAZON_PER_MARKETPLACE. The `data.scope`
      // branch above already cleared it for other scopes; this protects
      // the case where only marketplace is sent.
      if (body.marketplace !== undefined && data.marketplace === undefined) {
        data.marketplace = body.scope === 'AMAZON_PER_MARKETPLACE' || body.scope == null
          ? body.marketplace
          : null
      }
      if (body.useSentimentDiversion !== undefined) data.useSentimentDiversion = body.useSentimentDiversion === true
      if (body.fallbackOnNoResponse !== undefined) data.fallbackOnNoResponse = body.fallbackOnNoResponse === true
      Object.assign(data, timingFieldsFromBody(body)) // RRT.4 — timing fields
      // RV.9.1 follow-up — surface the (name, scope, marketplace) unique
      // violation as a 409 with a useful message; this used to bubble up
      // as a plain 500.
      try {
        const rule = await prisma.reviewRule.update({ where: { id }, data })
        return rule
      } catch (err: any) {
        if (err.code === 'P2002') {
          return reply.status(409).send({
            error: 'Another rule with this name and scope already exists',
          })
        }
        throw err
      }
    } catch (err: any) {
      return reply.status(500).send({ error: err.message })
    }
  })

  fastify.delete('/review-rules/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await prisma.reviewRule.delete({ where: { id } })
      return { ok: true }
    } catch (err: any) {
      return reply.status(500).send({ error: err.message })
    }
  })

  // RX.6 — Export rules as portable JSON (no ids / counts). PR C — `?ids=a,b` exports only those (the bulk bar).
  fastify.get('/review-rules/export', async (request, reply) => {
    try {
      const exported = await exportReviewRules((request.query as { ids?: string })?.ids)
      reply.header('Content-Disposition', 'attachment; filename="review-rules.json"')
      return exported
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  // PR C (ruling 13) — the Rules page's bulk bar: { ids ≤ 200, action: 'on' | 'off' | 'delete' } → { changed, held }.
  fastify.post('/review-rules/bulk', async (request, reply) => {
    try {
      return await bulkReviewRules(request.body)
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  // RX.6 — Import rules from JSON. Upserts on (name, scope, marketplace);
  // existing rules are updated, new ones created. Skips invalid rows.
  fastify.post('/review-rules/import', async (request, reply) => {
    const body = request.body as { rules?: any[] } | any[]
    const incoming = Array.isArray(body) ? body : body?.rules
    if (!Array.isArray(incoming)) {
      return reply.status(400).send({ error: 'expected { rules: [...] } or an array' })
    }
    let created = 0
    let updated = 0
    let skipped = 0
    const errors: string[] = []
    for (const r of incoming) {
      try {
        if (!r?.name?.trim() || !r?.scope) {
          skipped += 1
          continue
        }
        if (r.scope === 'AMAZON_PER_MARKETPLACE' && !r.marketplace) {
          skipped += 1
          errors.push(`${r.name}: per-marketplace rule needs a marketplace`)
          continue
        }
        const data = {
          name: String(r.name).trim(),
          scope: r.scope,
          marketplace: r.marketplace ?? null,
          isActive: r.isActive ?? true,
          minDaysSinceDelivery: Math.max(4, Math.floor(r.minDaysSinceDelivery ?? 7)),
          maxDaysSinceDelivery: Math.min(30, Math.floor(r.maxDaysSinceDelivery ?? 25)),
          exclusions: Array.isArray(r.exclusions) ? r.exclusions : [],
          minOrderTotalCents: r.minOrderTotalCents ?? null,
          notes: r.notes ?? null,
          ...timingFieldsFromBody(r), // RRT.8 — round-trip timing fields

          useSentimentDiversion: r.useSentimentDiversion === true,
          fallbackOnNoResponse: r.fallbackOnNoResponse !== false,
        }
        const existing = await prisma.reviewRule.findFirst({
          where: { name: data.name, scope: data.scope, marketplace: data.marketplace },
          select: { id: true },
        })
        if (existing) {
          await prisma.reviewRule.update({ where: { id: existing.id }, data })
          updated += 1
        } else {
          await prisma.reviewRule.create({ data: { ...data, createdBy: 'import' } })
          created += 1
        }
      } catch (err: any) {
        skipped += 1
        errors.push(`${r?.name ?? 'unknown'}: ${err.message}`)
      }
    }
    return { ok: true, created, updated, skipped, errors }
  })

  // RX.6 — Duplicate a rule as an A/B variant (cloned with a name suffix,
  // inactive by default so the operator tweaks timing then activates).
  // Per-rule conversion analytics (RV.9.4) then compares the variants.
  fastify.post('/review-rules/:id/duplicate', async (request, reply) => {
    const { id } = request.params as { id: string }
    const src = await prisma.reviewRule.findUnique({ where: { id } })
    if (!src) return reply.status(404).send({ error: 'Rule not found' })
    // Find an available "(variant N)" name.
    let suffix = 1
    let name = `${src.name} (variant ${suffix})`
    // eslint-disable-next-line no-constant-condition
    while (
      await prisma.reviewRule.findFirst({
        where: { name, scope: src.scope, marketplace: src.marketplace },
        select: { id: true },
      })
    ) {
      suffix += 1
      name = `${src.name} (variant ${suffix})`
    }
    const clone = await prisma.reviewRule.create({
      data: {
        name,
        scope: src.scope,
        marketplace: src.marketplace,
        isActive: false,
        minDaysSinceDelivery: src.minDaysSinceDelivery,
        maxDaysSinceDelivery: src.maxDaysSinceDelivery,
        exclusions: src.exclusions,
        minOrderTotalCents: src.minOrderTotalCents,
        notes: src.notes,
        useSentimentDiversion: src.useSentimentDiversion,
        fallbackOnNoResponse: src.fallbackOnNoResponse,
        productTypes: src.productTypes,
        sendDelayDays: src.sendDelayDays,
        anchor: src.anchor,
        sendHourLocal: src.sendHourLocal,
        skipWeekends: src.skipWeekends,
        createdBy: 'ab-variant',
      },
    })
    return { ok: true, rule: clone }
  })

  // RX.6 — ToS-compliance linter for custom copy (rule notes / messages).
  // Amazon/eBay forbid incentivising reviews, external links, and asking
  // for positive reviews. Returns warnings (never blocks).
  fastify.post('/review-rules/lint', async (request, reply) => {
    const text = String((request.body as { text?: string })?.text ?? '')
    if (!text.trim()) return { ok: true, issues: [] }
    // 07 O11 — the rules live in services/comms/message-lint.ts (the buyer-message door lints with them too).
    const issues = lintBuyerCopy(text)
    reply.header('Cache-Control', 'no-store')
    return { ok: true, issues, clean: issues.length === 0 }
  })

  // RV.9.1 — Seed Xavia recommended-default rule (idempotent).
  // POST /api/review-rules/seed-default
  //   Creates "Xavia IT default" if no IT rule exists yet. If a rule
  //   with scope=AMAZON_PER_MARKETPLACE has marketplace=null (broken
  //   from earlier RV.3 testing), patches it to mp='IT' instead of
  //   creating a duplicate. Returns the rule that's now active.
  fastify.post<{ Querystring: { scope?: string } }>('/review-rules/seed-default', async (request, reply) => {
    try {
      const variant = (request.query?.scope ?? '').toUpperCase()

      // RV.9.1 (+follow-up) — "Amazon — all markets" variant. Covers every
      // Amazon marketplace with a single AMAZON_GLOBAL rule.
      if (variant === 'AMAZON_GLOBAL') {
        const existingGlobal = await prisma.reviewRule.findFirst({
          where: { scope: 'AMAZON_GLOBAL' },
        })
        if (existingGlobal) {
          const updated = await prisma.reviewRule.update({
            where: { id: existingGlobal.id },
            data: { isActive: true, useSentimentDiversion: true },
          })
          return { ok: true, rule: updated, action: 'existing-activated' }
        }
        const created = await prisma.reviewRule.create({
          data: {
            name: 'Xavia all-markets default',
            scope: 'AMAZON_GLOBAL',
            marketplace: null,
            isActive: true,
            minDaysSinceDelivery: 7,
            maxDaysSinceDelivery: 25,
            exclusions: ['has_active_return', 'has_refund'],
            useSentimentDiversion: true,
            notes: 'Covers IT + DE + FR + ES + UK + every other Amazon marketplace. One rule fits all.',
            createdBy: 'system-seed',
          },
        })
        return { ok: true, rule: created, action: 'created' }
      }

      const existingIt = await prisma.reviewRule.findFirst({
        where: { scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'IT' },
      })
      if (existingIt) {
        // Make sure it's active + has sane settings.
        const updated = await prisma.reviewRule.update({
          where: { id: existingIt.id },
          data: {
            isActive: true,
            useSentimentDiversion: true,
          },
        })
        return { ok: true, rule: updated, action: 'existing-activated' }
      }
      // Detect + repair a broken AMAZON_PER_MARKETPLACE rule with null marketplace.
      const broken = await prisma.reviewRule.findFirst({
        where: { scope: 'AMAZON_PER_MARKETPLACE', marketplace: null },
      })
      if (broken) {
        const fixed = await prisma.reviewRule.update({
          where: { id: broken.id },
          data: {
            marketplace: 'IT',
            isActive: true,
            useSentimentDiversion: true,
          },
        })
        return { ok: true, rule: fixed, action: 'repaired' }
      }
      // Fresh create.
      const created = await prisma.reviewRule.create({
        data: {
          name: 'Xavia IT default',
          scope: 'AMAZON_PER_MARKETPLACE',
          marketplace: 'IT',
          isActive: true,
          minDaysSinceDelivery: 7,
          maxDaysSinceDelivery: 25,
          exclusions: ['has_active_return', 'has_refund'],
          useSentimentDiversion: true,
          notes: 'Recommended starting point — created automatically by /api/review-rules/seed-default. Tweak timing, exclusions, or duplicate for other marketplaces.',
          createdBy: 'system-seed',
        },
      })
      return { ok: true, rule: created, action: 'created' }
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // RULES — DRY-RUN + RUN (eager enqueue)
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/review-rules/:id/dry-run', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const rule = await prisma.reviewRule.findUnique({ where: { id } })
      if (!rule) return reply.status(404).send({ error: 'Rule not found' })
      const matches = await findOrdersMatchingRule(rule)
      // RRT.6 — compute the real scheduledFor per sample so the preview shows WHEN.
      const { resolveSendTiming } = await import('../services/reviews/review-timing.service.js')
      const timingDefaults = await prisma.reviewTimingDefault.findMany({ where: { isActive: true } })
      const sendWindows = await prisma.reviewSendWindow.findMany({ where: { isActive: true } })
      return {
        rule: { id: rule.id, name: rule.name, scope: rule.scope, marketplace: rule.marketplace },
        matchCount: matches.length,
        sample: matches.slice(0, 25).map((m: any) => {
          const r = resolveSendTiming(
            { channel: m.channel, marketplace: m.marketplace, deliveredAt: m.deliveredAt, shippedAt: m.shippedAt, purchaseDate: m.purchaseDate, productType: m.items?.[0]?.product?.productType ?? null },
            rule,
            timingDefaults,
            sendWindows,
          )
          return {
            orderId: m.id, channelOrderId: m.channelOrderId, channel: m.channel, marketplace: m.marketplace,
            totalPrice: Number(m.totalPrice), customerEmail: m.customerEmail, deliveredAt: m.deliveredAt,
            scheduledFor: r.scheduledFor, anchorUsed: r.anchorUsed, effectiveDelayDays: r.effectiveDelayDays, source: r.source,
            sendHour: r.sendHour, sendHourSource: r.sendHourSource,
          }
        }),
      }
    } catch (err: any) {
      logger.error('[REVIEW ENGINE] dry-run failed', { message: err.message })
      return reply.status(500).send({ error: err.message })
    }
  })

  // RRT.6 — stateless timing preview for the rule editor's live line. Synthesizes
  // an order delivered/shipped/purchased "now" and resolves the send date for the
  // in-flight (unsaved) rule fields.
  fastify.post('/review-rules/preview-timing', async (request, reply) => {
    const b = (request.body ?? {}) as any
    const { resolveSendTiming, timezoneForMarketplace } = await import('../services/reviews/review-timing.service.js')
    const timingDefaults = await prisma.reviewTimingDefault.findMany({ where: { isActive: true } })
    const sendWindows = await prisma.reviewSendWindow.findMany({ where: { isActive: true } })
    const now = new Date()
    const previewRule = {
      sendDelayDays: b.sendDelayDays == null ? null : Math.max(1, Math.min(60, Math.floor(Number(b.sendDelayDays)))),
      anchor: ['DELIVERY', 'SHIP', 'PURCHASE'].includes(b.anchor) ? b.anchor : 'DELIVERY',
      sendHourLocal: b.sendHourLocal == null ? null : Math.max(0, Math.min(23, Math.floor(Number(b.sendHourLocal)))),
      skipWeekends: b.skipWeekends === true,
      shiftToBestDay: b.shiftToBestDay === true,
      minDaysSinceDelivery: Math.max(4, Math.floor(b.minDaysSinceDelivery ?? 7)),
      maxDaysSinceDelivery: Math.min(30, Math.floor(b.maxDaysSinceDelivery ?? 25)),
    }
    const channel = b.scope === 'EBAY' ? 'EBAY' : b.scope === 'SHOPIFY' ? 'SHOPIFY' : 'AMAZON'
    const marketplace = b.marketplace ?? 'IT'
    const productType = b.productType ?? 'casco'
    const r = resolveSendTiming(
      { channel, marketplace, deliveredAt: now, shippedAt: now, purchaseDate: now, productType },
      previewRule,
      timingDefaults,
      sendWindows,
    )
    reply.header('Cache-Control', 'no-store')
    return { ...r, tz: timezoneForMarketplace(marketplace), productType, channel }
  })

  fastify.post('/review-rules/:id/run', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const rule = await prisma.reviewRule.findUnique({ where: { id } })
      if (!rule) return reply.status(404).send({ error: 'Rule not found' })
      const matches = await findOrdersMatchingRule(rule)

      let enqueued = 0, skipped = 0
      for (const order of matches) {
        // Dedup: one ReviewRequest per (orderId, channel)
        const existing = await prisma.reviewRequest.findUnique({
          where: { orderId_channel: workspaceKey({ orderId: order.id, channel: order.channel }) },
        })
        if (existing) { skipped++; continue }
        await prisma.reviewRequest.create({
          data: {
            orderId: order.id,
            channel: order.channel,
            marketplace: order.marketplace,
            status: 'SCHEDULED',
            scheduledFor: new Date(),
            ruleId: rule.id,
          },
        })
        enqueued++
      }
      return { enqueued, skipped, totalMatches: matches.length }
    } catch (err: any) {
      logger.error('[REVIEW ENGINE] run failed', { message: err.message })
      return reply.status(500).send({ error: err.message })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // REQUESTS — list + manual one-offs
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/review-requests', async (request, reply) => {
    try {
      const q = request.query as any
      const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1)
      const pageSize = Math.min(200, parseInt(q.pageSize ?? '50', 10) || 50)
      const where: any = {}
      if (q.status) where.status = q.status
      if (q.channel) where.channel = q.channel
      const [total, items] = await Promise.all([
        prisma.reviewRequest.count({ where }),
        prisma.reviewRequest.findMany({
          where,
          include: {
            order: { select: { id: true, channelOrderId: true, customerEmail: true, deliveredAt: true } },
            rule: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ])
      return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
    } catch (err: any) {
      return reply.status(500).send({ error: err.message })
    }
  })

  fastify.post('/orders/:id/request-review', async (request, reply) => {
    const { id } = request.params as { id: string }
    const answer = await requestReviewForOrder(id, logger)
    return reply.status(answer.status).send(answer.body)
  })

  fastify.post('/orders/bulk-request-reviews', async (request, reply) => {
    try {
      const body = request.body as { orderIds?: string[] }
      const ids = Array.isArray(body.orderIds) ? body.orderIds : []
      if (ids.length === 0) return reply.status(400).send({ error: 'orderIds[] required' })
      let sent = 0, skipped = 0, failed = 0
      const errors: Array<{ orderId: string; reason: string }> = []
      for (const orderId of ids) {
        try {
          const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: { returns: true, financialTransactions: { where: { transactionType: 'Refund' } } },
          })
          if (!order) { skipped++; errors.push({ orderId, reason: 'not found' }); continue }
          if (!order.deliveredAt) { skipped++; errors.push({ orderId, reason: 'not delivered' }); continue }
          const days = (Date.now() - order.deliveredAt.getTime()) / (24 * 60 * 60 * 1000)
          if (days < AMAZON_SOLICITATION_MIN_DAYS || days > AMAZON_SOLICITATION_MAX_DAYS) { skipped++; errors.push({ orderId, reason: `outside 4–30d window (${Math.round(days)}d)` }); continue }
          if (order.returns.some((r) => ACTIVE_RETURN_STATUSES.includes(r.status as any))) {
            skipped++; errors.push({ orderId, reason: 'active return' }); continue
          }
          if (order.financialTransactions.length > 0) {
            skipped++; errors.push({ orderId, reason: 'has refund' }); continue
          }
          const existing = await prisma.reviewRequest.findUnique({
            where: { orderId_channel: workspaceKey({ orderId: order.id, channel: order.channel }) },
          })
          if (existing) { skipped++; errors.push({ orderId, reason: `already ${existing.status}` }); continue }
          if (order.channel === 'AMAZON') {
            const result = await sendAmazonSolicitation({
              amazonOrderId: extractAmazonOrderId(order)!,
              marketplaceCode: order.marketplace ?? '',
            })
            const benign = isBenignFailure(result.errorCode)
            const newStatus = result.ok ? 'SENT' : benign ? 'SKIPPED' : 'FAILED'
            await prisma.reviewRequest.create({
              data: {
                orderId: order.id, channel: order.channel, marketplace: order.marketplace,
                status: newStatus,
                sentAt: result.ok ? new Date() : null,
                providerRequestId: result.providerRequestId ?? null,
                providerResponseCode: result.errorCode ?? null,
                errorMessage: benign ? null : result.errorMessage ?? null,
                suppressedReason: benignSuppressedReason(result.errorCode),
              },
            })
            if (result.ok) sent++
            else if (benign) skipped++
            else failed++
          } else {
            await prisma.reviewRequest.create({
              data: { orderId: order.id, channel: order.channel, status: 'SKIPPED', suppressedReason: 'non-Amazon channel' },
            })
            skipped++
          }
        } catch (e: any) {
          failed++
          errors.push({ orderId, reason: e.message })
        }
      }
      return { sent, skipped, failed, errors }
    } catch (err: any) {
      return reply.status(500).send({ error: err.message })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // REVIEW QUEUE — Reviews area PR C (logic in review-queue.service.ts)
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/review-queue', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await listReviewQueue((request.query ?? {}) as Record<string, unknown>)
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  fastify.get('/review-queue/sending', async (_request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await reviewSendingState()
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  fastify.get('/review-queue/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const detail = await reviewQueueDetail(id)
      if (!detail) return reply.status(404).send({ error: 'Request not found' })
      reply.header('Cache-Control', 'no-store')
      return detail
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  // "Run now": the ONE sender (jobs/review-request-mailer.job.ts runReviewMailerOnce), held while sending is paused.
  fastify.post('/review-queue/run', async (_request, reply) => {
    try {
      const ran = await runReviewQueueNow()
      if ('held' in ran) return reply.status(409).send({ held: ran.held, error: ran.held })
      return { result: ran.result }
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  fastify.post('/review-queue/pause', async (request, reply) => {
    try {
      const actor = requestUserId(request)
      const sending = await pauseReviewQueue((request.body as { reason?: unknown } | undefined)?.reason, actor)
      return { ok: true, sending }
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  fastify.post('/review-queue/resume', async (request, reply) => {
    try {
      const actor = requestUserId(request)
      const sending = await resumeReviewQueue(actor)
      return { ok: true, sending }
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  // { ids ≤ 200, action: 'snooze' | 'skip' | 'send-now', days?: 1 | 3 | 7 } → { changed, held: {id, words}[], result? }
  fastify.post('/review-queue/bulk', async (request, reply) => {
    try {
      return await bulkReviewQueue(request.body)
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  fastify.get('/review-emails/preview', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await reviewEmailPreview((request.query ?? {}) as Record<string, unknown>)
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  // One real e-mail to the signed-in person's own address (never a buyer's; no order is touched).
  fastify.post('/review-emails/test', async (request, reply) => {
    try {
      requestUserId(request)
      return await sendReviewEmailTest((request.body ?? {}) as Record<string, unknown>, request.authUser?.email)
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // BACKFILL — D.8 stub, re-pulls last N days from each channel.
  // Real implementation hits SP-API GetOrders / Fulfillment API / etc.
  // For now, this just updates purchaseDate where null using createdAt.
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/orders/historical-backfill', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { days?: number }
      const days = Math.min(180, Math.max(7, body.days ?? 30))
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      // For now: only the local fixup. Channel re-pulls plug in here.
      const result = await prisma.$executeRaw`
        UPDATE "Order"
           SET "purchaseDate" = COALESCE("purchaseDate", "createdAt")
         WHERE "createdAt" >= ${since}
           AND "purchaseDate" IS NULL
      `
      return {
        ok: true,
        days,
        rowsUpdated: result,
        note: 'Local fixup only. SP-API + eBay Fulfillment + Shopify webhooks plug into this endpoint to re-pull authoritative timestamps.',
      }
    } catch (err: any) {
      logger.error('[ORDERS API] backfill failed', { message: err.message })
      return reply.status(500).send({ error: err.message })
    }
  })

  // ── RRT.1 — ReviewTimingDefault CRUD (the editable per-product-type baseline) ──
  // GET list (ordered by sortOrder).
  fastify.get('/review-timing-defaults', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=30')
    const items = await prisma.reviewTimingDefault.findMany({ orderBy: { sortOrder: 'asc' } })
    return { items, count: items.length }
  })

  // PUT — whole-list upsert + delete (drives the inline grid in one round-trip).
  // Empty list is allowed (operator empties the table → resolver falls back to the
  // hardcoded TIMING_RULES). delayDays clamped 1–60; pattern unique + lowercased.
  fastify.put('/review-timing-defaults', async (request, reply) => {
    const b = (request.body ?? {}) as { items?: Array<{ pattern?: string; label?: string; delayDays?: number; sortOrder?: number; isActive?: boolean }> }
    const clean = (Array.isArray(b.items) ? b.items : []).map((it) => ({
      pattern: String(it.pattern ?? '').trim().toLowerCase(),
      label: String(it.label ?? '').trim(),
      delayDays: Math.max(1, Math.min(60, Math.floor(Number(it.delayDays) || 1))),
      sortOrder: Math.floor(Number(it.sortOrder) || 0),
      isActive: it.isActive !== false,
    })).filter((it) => it.pattern && it.label)
    const byPattern = new Map(clean.map((it) => [it.pattern, it]))
    const final = [...byPattern.values()]
    const patterns = final.map((f) => f.pattern)
    await prisma.$transaction([
      patterns.length ? prisma.reviewTimingDefault.deleteMany({ where: { pattern: { notIn: patterns } } }) : prisma.reviewTimingDefault.deleteMany({}),
      ...final.map((f) => prisma.reviewTimingDefault.upsert({
        where: { workspace_pattern: workspaceKey({ pattern: f.pattern }) },
        create: f,
        update: { label: f.label, delayDays: f.delayDays, sortOrder: f.sortOrder, isActive: f.isActive },
      })),
    ])
    const items = await prisma.reviewTimingDefault.findMany({ orderBy: { sortOrder: 'asc' } })
    reply.header('Cache-Control', 'no-store')
    return { ok: true, items, count: items.length }
  })

  // POST /seed — idempotent seed from the canonical TIMING_RULES; ?reset=1 also
  // overwrites existing rows back to canonical ("Reset to defaults").
  fastify.post<{ Querystring: { reset?: string } }>('/review-timing-defaults/seed', async (request, reply) => {
    const reset = request.query.reset === '1' || request.query.reset === 'true'
    const existing = await prisma.reviewTimingDefault.count()
    if (existing > 0 && !reset) { reply.header('Cache-Control', 'no-store'); return { ok: true, action: 'noop', count: existing } }
    const SEED = [
      { pattern: 'casco', label: 'Helmets (casco)', delayDays: 21, sortOrder: 10 },
      { pattern: 'helmet', label: 'Helmets', delayDays: 21, sortOrder: 11 },
      { pattern: 'combinat', label: 'Suits (combinato)', delayDays: 16, sortOrder: 20 },
      { pattern: 'tuta', label: 'Suits (tuta)', delayDays: 16, sortOrder: 21 },
      { pattern: 'suit', label: 'Suits', delayDays: 16, sortOrder: 22 },
      { pattern: 'giacca', label: 'Jackets (giacca)', delayDays: 14, sortOrder: 30 },
      { pattern: 'giubbotto', label: 'Jackets (giubbotto)', delayDays: 14, sortOrder: 31 },
      { pattern: 'jacket', label: 'Jackets', delayDays: 14, sortOrder: 32 },
      { pattern: 'stival', label: 'Boots (stivali)', delayDays: 14, sortOrder: 40 },
      { pattern: 'scarpe', label: 'Shoes (scarpe)', delayDays: 14, sortOrder: 41 },
      { pattern: 'boot', label: 'Boots', delayDays: 14, sortOrder: 42 },
      { pattern: 'pantalon', label: 'Trousers (pantaloni)', delayDays: 12, sortOrder: 50 },
      { pattern: 'trouser', label: 'Trousers', delayDays: 12, sortOrder: 51 },
      { pattern: 'guant', label: 'Gloves (guanti)', delayDays: 10, sortOrder: 60 },
      { pattern: 'glove', label: 'Gloves', delayDays: 10, sortOrder: 61 },
    ]
    for (const s of SEED) {
      await prisma.reviewTimingDefault.upsert({
        where: { workspace_pattern: workspaceKey({ pattern: s.pattern }) },
        create: s,
        update: reset ? { label: s.label, delayDays: s.delayDays, sortOrder: s.sortOrder, isActive: true } : {},
      })
    }
    const items = await prisma.reviewTimingDefault.findMany({ orderBy: { sortOrder: 'asc' } })
    reply.header('Cache-Control', 'no-store')
    return { ok: true, action: reset ? 'reset' : 'seeded', items, count: items.length }
  })
}

// Rule matcher — services/reviews/review-scheduler.service.ts findOrdersMatchingRule (PR C: honours the same
// "Skip when" boxes as the scheduler).

export default ordersReviewsRoutes
