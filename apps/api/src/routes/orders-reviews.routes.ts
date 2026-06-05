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
 *   POST   /api/review-engine/tick          trigger the worker once
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
  sendAmazonSolicitation as sharedSendAmazonSolicitation,
  amazonMarketplaceIdFor as sharedAmazonMarketplaceIdFor,
  isBenignFailure,
  benignSuppressedReason,
} from '../services/reviews/amazon-solicitations.service.js'

type RuleScope =
  | 'AMAZON_PER_MARKETPLACE'
  | 'AMAZON_GLOBAL'
  | 'EBAY'
  | 'SHOPIFY'
  | 'WOOCOMMERCE'
  | 'ETSY'
  | 'MANUAL'

const ACTIVE_RETURN_STATUSES = ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] as const

// RV.3.2 — Solicitations API + marketplace map moved to
// services/reviews/amazon-solicitations.service.ts. Both this file and
// the cron mailer import from there. The shared module also exports
// isBenignFailure / benignSuppressedReason for status classification.
const sendAmazonSolicitation = sharedSendAmazonSolicitation
const amazonMarketplaceIdFor = sharedAmazonMarketplaceIdFor

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
  return out
}

const ordersReviewsRoutes: FastifyPluginAsync = async (fastify) => {
  // ═══════════════════════════════════════════════════════════════════
  // RULES — CRUD
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/review-rules', async (_request, reply) => {
    try {
      const rules = await prisma.reviewRule.findMany({
        orderBy: [{ isActive: 'desc' }, { scope: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { requests: true } } },
      })
      return {
        items: rules.map((r) => ({
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

  // RX.6 — Export all rules as portable JSON (no ids / counts).
  fastify.get('/review-rules/export', async (_request, reply) => {
    const rules = await prisma.reviewRule.findMany({ orderBy: [{ scope: 'asc' }, { name: 'asc' }] })
    const exported = rules.map((r) => ({
      name: r.name,
      scope: r.scope,
      marketplace: r.marketplace,
      isActive: r.isActive,
      minDaysSinceDelivery: r.minDaysSinceDelivery,
      maxDaysSinceDelivery: r.maxDaysSinceDelivery,
      exclusions: r.exclusions,
      minOrderTotalCents: r.minOrderTotalCents,
      notes: r.notes,
      useSentimentDiversion: r.useSentimentDiversion,
      fallbackOnNoResponse: r.fallbackOnNoResponse,
    }))
    reply.header('Content-Disposition', 'attachment; filename="review-rules.json"')
    return { version: 1, exportedAt: new Date().toISOString(), rules: exported }
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
    const issues: { severity: 'error' | 'warn'; message: string; match?: string }[] = []
    const rules: { re: RegExp; severity: 'error' | 'warn'; message: string }[] = [
      { re: /\b(discount|coupon|voucher|refund|free|gift|reward|incentive|cashback|rebate|sconto|buono|omaggio|gratis)\b/i, severity: 'error', message: 'Possible incentive — offering anything in exchange for a review violates marketplace policy.' },
      { re: /\b(positive|5[- ]?star|five[- ]?star|good review|great review|recensione positiva|cinque stelle)\b/i, severity: 'error', message: 'Do not ask specifically for positive / 5-star reviews — requests must be neutral.' },
      { re: /(https?:\/\/|www\.)[^\s]+/i, severity: 'warn', message: 'External link — Amazon prohibits links to non-Amazon sites in buyer messages.' },
      { re: /\b(remove|change|update|edit)\b[^.]*\breview\b/i, severity: 'warn', message: 'Asking a customer to remove/change a review is against policy.' },
    ]
    for (const r of rules) {
      const m = text.match(r.re)
      if (m) issues.push({ severity: r.severity, message: r.message, match: m[0] })
    }
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
      return {
        rule: { id: rule.id, name: rule.name, scope: rule.scope, marketplace: rule.marketplace },
        matchCount: matches.length,
        sample: matches.slice(0, 25).map((m: any) => {
          const r = resolveSendTiming(
            { channel: m.channel, marketplace: m.marketplace, deliveredAt: m.deliveredAt, shippedAt: m.shippedAt, purchaseDate: m.purchaseDate, productType: m.items?.[0]?.product?.productType ?? null },
            rule,
            timingDefaults,
          )
          return {
            orderId: m.id, channelOrderId: m.channelOrderId, channel: m.channel, marketplace: m.marketplace,
            totalPrice: Number(m.totalPrice), customerEmail: m.customerEmail, deliveredAt: m.deliveredAt,
            scheduledFor: r.scheduledFor, anchorUsed: r.anchorUsed, effectiveDelayDays: r.effectiveDelayDays, source: r.source,
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
    const now = new Date()
    const previewRule = {
      sendDelayDays: b.sendDelayDays == null ? null : Math.max(1, Math.min(60, Math.floor(Number(b.sendDelayDays)))),
      anchor: ['DELIVERY', 'SHIP', 'PURCHASE'].includes(b.anchor) ? b.anchor : 'DELIVERY',
      sendHourLocal: b.sendHourLocal == null ? null : Math.max(0, Math.min(23, Math.floor(Number(b.sendHourLocal)))),
      skipWeekends: b.skipWeekends === true,
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
          where: { orderId_channel: { orderId: order.id, channel: order.channel } },
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
    try {
      const { id } = request.params as { id: string }
      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          returns: { select: { status: true } },
          financialTransactions: { where: { transactionType: 'Refund' }, select: { id: true } },
        },
      })
      if (!order) return reply.status(404).send({ error: 'Order not found' })
      // Eligibility checks
      if (!order.deliveredAt) return reply.status(400).send({ error: 'Order not yet delivered' })
      const days = (Date.now() - order.deliveredAt.getTime()) / (24 * 60 * 60 * 1000)
      if (days < 4) return reply.status(400).send({ error: 'Too soon — Amazon requires ≥4 days post-delivery' })
      if (days > 30) return reply.status(400).send({ error: 'Too late — Amazon blocks requests after 30 days' })
      if (order.returns.some((r) => ACTIVE_RETURN_STATUSES.includes(r.status as any))) {
        return reply.status(400).send({ error: 'Order has an active return — solicitation suppressed' })
      }
      if (order.financialTransactions.length > 0) {
        return reply.status(400).send({ error: 'Order has a refund — solicitation suppressed' })
      }
      // Dedup
      const existing = await prisma.reviewRequest.findUnique({
        where: { orderId_channel: { orderId: order.id, channel: order.channel } },
      })
      if (existing && (existing.status === 'SENT' || existing.status === 'SCHEDULED')) {
        return reply.status(409).send({ error: `Already ${existing.status}` })
      }

      // For Amazon: try the SP-API call now. For others: enqueue/skip.
      if (order.channel === 'AMAZON') {
        const amazonOrderId = extractAmazonOrderId(order)
        if (!amazonOrderId || !amazonMarketplaceIdFor(order.marketplace)) {
          return reply.status(400).send({ error: 'Missing amazonOrderId or unknown marketplace' })
        }
        const result = await sendAmazonSolicitation({ amazonOrderId, marketplaceCode: order.marketplace ?? '' })
        const benign = isBenignFailure(result.errorCode)
        const newStatus = result.ok ? 'SENT' as const : benign ? 'SKIPPED' as const : 'FAILED' as const
        const data = {
          orderId: order.id,
          channel: order.channel,
          marketplace: order.marketplace,
          status: newStatus,
          sentAt: result.ok ? new Date() : null,
          providerRequestId: result.providerRequestId ?? null,
          providerResponseCode: result.errorCode ?? null,
          errorMessage: benign ? null : result.errorMessage ?? null,
          suppressedReason: benignSuppressedReason(result.errorCode),
        }
        const upserted = existing
          ? await prisma.reviewRequest.update({ where: { id: existing.id }, data })
          : await prisma.reviewRequest.create({ data })
        return upserted
      }

      // Non-Amazon: track-only skeleton
      const data = {
        orderId: order.id,
        channel: order.channel,
        marketplace: order.marketplace,
        status: 'SKIPPED' as const,
        suppressedReason: 'Channel does not support native solicitation API — wire third-party app first',
      }
      const upserted = existing
        ? await prisma.reviewRequest.update({ where: { id: existing.id }, data })
        : await prisma.reviewRequest.create({ data })
      return upserted
    } catch (err: any) {
      logger.error('[REVIEW ENGINE] manual request failed', { message: err.message })
      return reply.status(500).send({ error: err.message })
    }
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
          if (days < 4 || days > 30) { skipped++; errors.push({ orderId, reason: `outside 4–30d window (${Math.round(days)}d)` }); continue }
          if (order.returns.some((r) => ACTIVE_RETURN_STATUSES.includes(r.status as any))) {
            skipped++; errors.push({ orderId, reason: 'active return' }); continue
          }
          if (order.financialTransactions.length > 0) {
            skipped++; errors.push({ orderId, reason: 'has refund' }); continue
          }
          const existing = await prisma.reviewRequest.findUnique({
            where: { orderId_channel: { orderId: order.id, channel: order.channel } },
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
  // ENGINE TICK — process SCHEDULED rows now
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/review-engine/tick', async (_request, reply) => {
    try {
      const due = await prisma.reviewRequest.findMany({
        where: { status: 'SCHEDULED', scheduledFor: { lte: new Date() } },
        take: 200,
        include: { order: true },
      })
      let sent = 0, failed = 0, suppressed = 0
      for (const req of due) {
        const order = req.order
        // Re-check eligibility before sending — state may have changed
        if (!order.deliveredAt) {
          await prisma.reviewRequest.update({ where: { id: req.id }, data: { status: 'SUPPRESSED', suppressedReason: 'not delivered' } })
          suppressed++; continue
        }
        const days = (Date.now() - order.deliveredAt.getTime()) / (24 * 60 * 60 * 1000)
        if (days < 4 || days > 30) {
          await prisma.reviewRequest.update({ where: { id: req.id }, data: { status: 'SUPPRESSED', suppressedReason: `outside 4–30d window (${Math.round(days)}d)` } })
          suppressed++; continue
        }
        const [activeReturn, refund] = await Promise.all([
          prisma.return.findFirst({ where: { orderId: order.id, status: { in: ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] } } }),
          prisma.financialTransaction.findFirst({ where: { orderId: order.id, transactionType: 'Refund' } }),
        ])
        if (activeReturn) {
          await prisma.reviewRequest.update({ where: { id: req.id }, data: { status: 'SUPPRESSED', suppressedReason: 'active return' } })
          suppressed++; continue
        }
        if (refund) {
          await prisma.reviewRequest.update({ where: { id: req.id }, data: { status: 'SUPPRESSED', suppressedReason: 'has refund' } })
          suppressed++; continue
        }
        if (order.channel === 'AMAZON') {
          const amazonOrderId = extractAmazonOrderId(order)
          if (!amazonOrderId || !amazonMarketplaceIdFor(order.marketplace)) {
            await prisma.reviewRequest.update({ where: { id: req.id }, data: { status: 'FAILED', errorMessage: 'missing amazonOrderId or marketplaceId' } })
            failed++; continue
          }
          const result = await sendAmazonSolicitation({ amazonOrderId, marketplaceCode: order.marketplace ?? '' })
          const benign = isBenignFailure(result.errorCode)
          const newStatus = result.ok ? 'SENT' : benign ? 'SKIPPED' : 'FAILED'
          await prisma.reviewRequest.update({
            where: { id: req.id },
            data: {
              status: newStatus,
              sentAt: result.ok ? new Date() : null,
              providerRequestId: result.providerRequestId ?? null,
              providerResponseCode: result.errorCode ?? null,
              errorMessage: benign ? null : result.errorMessage ?? null,
              suppressedReason: benignSuppressedReason(result.errorCode),
            },
          })
          if (result.ok) sent++
          else if (benign) suppressed++
          else failed++
        } else {
          await prisma.reviewRequest.update({ where: { id: req.id }, data: { status: 'SKIPPED', suppressedReason: 'non-Amazon — track-only' } })
          suppressed++
        }
      }
      return { processed: due.length, sent, failed, suppressed }
    } catch (err: any) {
      logger.error('[REVIEW ENGINE] tick failed', { message: err.message })
      return reply.status(500).send({ error: err.message })
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
        where: { pattern: f.pattern },
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
        where: { pattern: s.pattern },
        create: s,
        update: reset ? { label: s.label, delayDays: s.delayDays, sortOrder: s.sortOrder, isActive: true } : {},
      })
    }
    const items = await prisma.reviewTimingDefault.findMany({ orderBy: { sortOrder: 'asc' } })
    reply.header('Cache-Control', 'no-store')
    return { ok: true, action: reset ? 'reset' : 'seeded', items, count: items.length }
  })
}

// ────────────────────────────────────────────────────────────────────
// Rule matcher — finds Order rows that satisfy a ReviewRule.
// Single source of truth for both dry-run and the engine tick.
// ────────────────────────────────────────────────────────────────────
async function findOrdersMatchingRule(rule: any) {
  // Channel scope
  let channelClause: any = {}
  switch (rule.scope as RuleScope) {
    case 'AMAZON_GLOBAL':
      channelClause = { channel: 'AMAZON' }
      break
    case 'AMAZON_PER_MARKETPLACE':
      channelClause = { channel: 'AMAZON', marketplace: rule.marketplace }
      break
    case 'EBAY':       channelClause = { channel: 'EBAY' }; break
    case 'SHOPIFY':    channelClause = { channel: 'SHOPIFY' }; break
    case 'WOOCOMMERCE':channelClause = { channel: 'WOOCOMMERCE' }; break
    case 'ETSY':       channelClause = { channel: 'ETSY' }; break
    case 'MANUAL':     channelClause = { channel: 'MANUAL' }; break
  }

  const minDate = new Date(Date.now() - rule.maxDaysSinceDelivery * 24 * 60 * 60 * 1000)
  const maxDate = new Date(Date.now() - rule.minDaysSinceDelivery * 24 * 60 * 60 * 1000)

  const where: any = {
    ...channelClause,
    deliveredAt: { gte: minDate, lte: maxDate },
    // Already-sent or scheduled requests for this channel are excluded —
    // dedup via the unique constraint on (orderId, channel).
    reviewRequests: { none: { channel: channelClause.channel } },
  }

  const exclusions: string[] = rule.exclusions ?? []
  const ANDs: any[] = []

  if (exclusions.includes('has_active_return')) {
    ANDs.push({ returns: { none: { status: { in: ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] } } } })
  }
  if (exclusions.includes('has_refund')) {
    ANDs.push({ financialTransactions: { none: { transactionType: 'Refund' } } })
  }
  if (exclusions.includes('fba_only')) {
    ANDs.push({ fulfillmentMethod: 'FBA' })
  }
  if (exclusions.includes('fbm_only')) {
    ANDs.push({ fulfillmentMethod: 'FBM' })
  }
  if (rule.minOrderTotalCents != null) {
    ANDs.push({ totalPrice: { gte: rule.minOrderTotalCents / 100 } })
  }
  // RRT.3 — product-type targeting (case-insensitive substring on the order's
  // items' productType), consistent with the JS matcher's t.includes(pattern).
  const productTypes: string[] = rule.productTypes ?? []
  if (productTypes.length > 0) {
    ANDs.push({ OR: productTypes.map((p: string) => ({ items: { some: { product: { productType: { contains: String(p), mode: 'insensitive' } } } } })) })
  }
  if (ANDs.length > 0) where.AND = ANDs

  return prisma.order.findMany({
    where,
    select: {
      id: true, channel: true, marketplace: true, channelOrderId: true,
      totalPrice: true, customerEmail: true, deliveredAt: true,
      // RRT.6 — extra fields so dry-run can preview the resolved scheduledFor.
      shippedAt: true, purchaseDate: true,
      items: { take: 1, select: { product: { select: { productType: true } } } },
    },
    orderBy: { deliveredAt: 'asc' },
    take: 5000,
  })
}

export default ordersReviewsRoutes
