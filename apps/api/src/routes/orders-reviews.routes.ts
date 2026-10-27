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
 *   POST   /api/orders/:id/request-review   ask one order's buyer now, through the one sender
 *   POST   /api/orders/bulk-request-reviews the same for up to 200 orders
 *
 * Reviews area PR C (services/reviews/review-queue.service.ts; no database call here):
 *   GET    /api/review-queue                the queue: rows, tiles, failures of 7 days, facets
 *   GET    /api/review-queue/sending        paused?, next run, last run, what is due
 *   GET    /api/review-queue/:id            one request: window, Amazon's answer, timeline, held actions
 *   POST   /api/review-queue/run            the ONE sender now (held while paused)
 *   POST   /api/review-queue/pause|resume   the business's switch; the actor is the signed-in person
 *   POST   /api/review-queue/bulk           snooze / skip / send now
 *   GET    /api/review-emails/preview       the review e-mail as a buyer gets it (no send)
 *   POST   /api/review-emails/preview       the same with the rule editor's unsaved text (N3; checked, no send)
 *   POST   /api/review-emails/test          one real e-mail to the signed-in person
 *   GET    /api/review-rules?withStats=1    + sent30, rate30, matched30 per rule
 *   POST   /api/review-rules/bulk           on / off / delete, held rules in words
 *   GET    /api/review-rules/export?ids=    the chosen rules (all without ids)
 *
 * Reviews PR J — timing tests and A/B splits (services/reviews/review-timing-test.service.ts; no database call here):
 *   GET    /api/review-timing-tests                 every test: groups, counts, how sure, words (?kind=, ?ruleId=)
 *   GET    /api/review-timing-tests/estimate        the day in place now and a market's pace (New timing test)
 *   POST   /api/review-timing-tests                 a timing test: made, then sent for approval (it RUNS once approved)
 *   POST   /api/review-timing-tests/ab              an A/B split of a rule and its copy: made, then sent for approval
 *   POST   /api/review-timing-tests/:id/start       send a test that is not started for approval again
 *   POST   /api/review-timing-tests/:id/stop        Stop test / End test: at once, no approval (it only stops a test)
 *   POST   /api/review-timing-tests/:id/apply       Apply winner: sent for approval (an A/B split's: its winning side's
 *                                                   text and timing into rule A, and the split ends — N3)
 *   POST   /api/review-timing-tests/:id/keep        Keep the day in place: records the decision, changes nothing
 *
 * POST /api/review-engine/tick is gone (B9): it sent without the pause switch and the "How was it?" check and marked
 * every non-Amazon request skipped. "Run now" is POST /api/review-queue/run, the same sender as the hourly cron.
 *
 * No route here calls Amazon or sends an e-mail: every send goes through the ONE sender (jobs/review-request-mailer.job.ts),
 * also for the Orders page's "Request review" (services/reviews/review-request.service.ts).
 */

import type { FastifyPluginAsync } from 'fastify'
import type { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { askForReviews, askSummaryWords } from '../services/reviews/review-request.service.js'
import { FEATURES } from '@nexus/shared/permissions'
import { findOrdersMatchingRule, queueOrdersForRule } from '../services/reviews/review-scheduler.service.js'
import { EBAY_RULE_WORDS } from '../services/reviews/review-queue-words.js'
import { emailTextForSave, storedEmailText } from '../services/reviews/review-rule-text.js'
import { assertAnyRequestPermission, requestUserId } from '../lib/auth/request-permission.js'
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
import {
  applyTimingWinner,
  createAbTest,
  createTimingTest,
  estimateTimingTest,
  keepCurrentDay,
  listTimingTests,
  startTimingTest,
  stopTimingTest,
} from '../services/reviews/review-timing-test.service.js'

/** A service's refusal (statusCode 400/403 + words) as its status; anything else is a 500 with the message. */
function sendFailure(reply: any, err: any) {
  const status = typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500
  if (status === 500) logger.error('[REVIEW QUEUE] request failed', { message: err?.message })
  return reply.status(status).send({ error: err?.message ?? 'failed' })
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
        ...(withStats ? { statsError, statsAll: stats?.all ?? null } : {}),
        items: rules.map((r) => ({
          ...(stats ? (stats.byRule.get(r.id) ?? { sent30: 0, rate30: null, rateWords: null, matched30: 0 }) : {}),
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
          // N3 — the rule's own e-mail text per language (null = the standard text).
          emailText: storedEmailText(r.emailText),
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
      // N3 — the rule's own e-mail text, checked (refused in words, nothing saved).
      const emailText = emailTextForSave(body.emailText)
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
          ...(emailText !== undefined ? { emailText } : {}),
          // The signed-in person (audit E6), never a fixed "default-user".
          createdBy: requestUserId(request),
        },
      })
      return created
    } catch (err: any) {
      if (err.code === 'P2002') return reply.status(409).send({ error: 'A rule with this name and scope already exists' })
      return sendFailure(reply, err)
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
      // N3 — the rule's own e-mail text per language: checked by the editor's own check; a refusal is a 400 in words.
      const emailText = emailTextForSave(body.emailText)
      if (emailText !== undefined) data.emailText = emailText
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
      return sendFailure(reply, err)
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
          // N3 — the rule's own e-mail text, checked as a save checks it (a refused text skips the rule, in words).
          ...(r.emailText !== undefined ? { emailText: emailTextForSave(r.emailText) } : {}),
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
        // Every timing field, so the copy sends on the same days (audit C10).
        shiftToBestDay: src.shiftToBestDay,
        // N3 — and the same e-mail text, so B starts as A and the person changes what B tests.
        ...(storedEmailText(src.emailText) ? { emailText: storedEmailText(src.emailText) as unknown as Prisma.InputJsonValue } : {}),
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

  // RV.9.1 — Seed the recommended default rule (idempotent).
  // POST /api/review-rules/seed-default
  //   Creates "Amazon Italy" if no IT rule exists yet. If a rule
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
          // Turned on only: its "How was it?" check and every other setting stay as a person left them (audit E2).
          const updated = await prisma.reviewRule.update({
            where: { id: existingGlobal.id },
            data: { isActive: true },
          })
          return { ok: true, rule: updated, action: 'existing-activated' }
        }
        const created = await prisma.reviewRule.create({
          data: {
            name: 'All Amazon markets',
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
        // Turned on only: its "How was it?" check and every other setting stay as a person left them (audit E2).
        const updated = await prisma.reviewRule.update({
          where: { id: existingIt.id },
          data: { isActive: true },
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
          },
        })
        return { ok: true, rule: fixed, action: 'repaired' }
      }
      // Fresh create.
      const created = await prisma.reviewRule.create({
        data: {
          name: 'Amazon Italy',
          scope: 'AMAZON_PER_MARKETPLACE',
          marketplace: 'IT',
          isActive: true,
          minDaysSinceDelivery: 7,
          maxDaysSinceDelivery: 25,
          exclusions: ['has_active_return', 'has_refund'],
          useSentimentDiversion: true,
          notes: 'Recommended starting point, made by “Seed defaults”. Change the timing or what it skips, or duplicate it for another market.',
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
        // An eBay rule asks nobody (Owner, 2026-10-27): the Test run says why it lists no order.
        held: rule.scope === 'EBAY' ? EBAY_RULE_WORDS : null,
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
    // The rule's own product type; none = an order of any type (live audit D03: an Italian "casco" stood in before).
    const productType: string | null = typeof b.productType === 'string' && b.productType.trim() ? b.productType.trim() : null
    const r = resolveSendTiming(
      { channel, marketplace, deliveredAt: now, shippedAt: now, purchaseDate: now, productType },
      previewRule,
      timingDefaults,
      sendWindows,
    )
    reply.header('Cache-Control', 'no-store')
    return { ...r, tz: timezoneForMarketplace(marketplace), productType, channel }
  })

  // "Queue these N" (the Test run): queued as the scheduler queues them — the rule's timing, its "How was it?" check,
  // only the orders this rule decides (services/reviews/review-scheduler.service.ts queueOrdersForRule; audit E7).
  fastify.post('/review-rules/:id/run', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const queued = await queueOrdersForRule(id)
      if (!queued) return reply.status(404).send({ error: 'Rule not found' })
      return queued
    } catch (err: any) {
      logger.error('[REVIEW ENGINE] run failed', { message: err.message })
      return reply.status(500).send({ error: err.message })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // REQUESTS — manual one-offs
  // ═══════════════════════════════════════════════════════════════════
  // The Orders page's "Request review" (one order) and "Request reviews" (bulk): the ONE sender
  // (review-request.service.ts askForReviews) — held while sending is paused, the rule's "How was it?" first, Shopify
  // buyers get the rules' review e-mail; an eBay order is held (eBay asks its buyers for feedback itself). A review action: reviews.manage, or orders.edit as the Orders page
  // always allowed (the manifest maps both to orders.view; this checks one of the two).
  fastify.post('/orders/:id/request-review', async (request, reply) => {
    try {
      await assertAnyRequestPermission(request, [FEATURES.reviewsManage, FEATURES.ordersEdit])
      const { id } = request.params as { id: string }
      const { results } = await askForReviews([id])
      const one = results[0]
      if (one.outcome === 'held') return reply.status(one.words === 'Order not found.' ? 404 : 409).send({ error: one.words, held: true, result: one })
      return { ...one, status: one.outcome }
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  fastify.post('/orders/bulk-request-reviews', async (request, reply) => {
    try {
      await assertAnyRequestPermission(request, [FEATURES.reviewsManage, FEATURES.ordersEdit])
      const answer = await askForReviews((request.body as { orderIds?: unknown } | undefined)?.orderIds)
      return { ...answer, words: askSummaryWords(answer.counts) }
    } catch (err: any) {
      return sendFailure(reply, err)
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

  // N3 — the same preview with the rule editor's unsaved text for the language shown (`draft: true`, `text`: the
  // subject and text, or null for the standard text). The text is checked as a save checks it; nothing is sent.
  fastify.post('/review-emails/preview', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await reviewEmailPreview((request.body ?? {}) as Record<string, unknown>)
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
  // PR J — TIMING TESTS and A/B SPLITS (no database call here)
  // ═══════════════════════════════════════════════════════════════════
  const actorOf = async (request: any): Promise<string | null> => {
    const { requestPrincipal } = await import('../services/agents/call-tool.js')
    return (await requestPrincipal(request).catch(() => null))?.label ?? requestUserId(request) ?? null
  }
  const personOf = async (request: any) => {
    const { requestPrincipal } = await import('../services/agents/call-tool.js')
    return requestPrincipal(request)
  }

  fastify.get('/review-timing-tests', async (request, reply) => {
    try {
      const q = (request.query ?? {}) as { kind?: string; ruleId?: string }
      reply.header('Cache-Control', 'private, no-store')
      return await listTimingTests({ kind: q.kind, ruleId: q.ruleId })
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  fastify.get('/review-timing-tests/estimate', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, no-store')
      return await estimateTimingTest((request.query ?? {}) as Record<string, string>)
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  fastify.post('/review-timing-tests', async (request, reply) => {
    try {
      return await createTimingTest(request.body, await personOf(request))
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  fastify.post('/review-timing-tests/ab', async (request, reply) => {
    try {
      return await createAbTest(request.body, await personOf(request))
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  fastify.post('/review-timing-tests/:id/start', async (request, reply) => {
    try {
      return await startTimingTest((request.params as { id: string }).id, await personOf(request))
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  fastify.post('/review-timing-tests/:id/stop', async (request, reply) => {
    try {
      return { test: await stopTimingTest((request.params as { id: string }).id, await actorOf(request)) }
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  fastify.post('/review-timing-tests/:id/apply', async (request, reply) => {
    try {
      return await applyTimingWinner((request.params as { id: string }).id, await personOf(request))
    } catch (err: any) {
      return sendFailure(reply, err)
    }
  })

  fastify.post('/review-timing-tests/:id/keep', async (request, reply) => {
    try {
      return { test: await keepCurrentDay((request.params as { id: string }).id, await actorOf(request)) }
    } catch (err: any) {
      return sendFailure(reply, err)
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
