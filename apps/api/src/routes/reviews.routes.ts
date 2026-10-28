import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * SR.1 — Sentient Review Loop routes.
 *
 *   GET  /api/reviews/spikes               alerts (Reviews Insights, below)
 *   PATCH /api/reviews/spikes/:id          acknowledge / resolve / reopen
 *
 * Audit D1 sweep (2026-10-27): the endpoints nothing called any more are gone — the old list, one review, summary,
 * ratings, responses, by-product, a product's timeline, the manual cron triggers, the attribution run, the request
 * snooze (the queue's bulk snoozes), the raw Amazon insight rows and their roll-up, the filter options. Kept with no
 * page calling them: POST /reviews/insights/probe, GET /reviews/insights/debug, POST /reviews/insights/ingest — the
 * Owner's steps to switch Amazon topics on.
 *
 * Reviews Inbox (2026-10-26, PR B) — logic in services/reviews/review-inbox*.ts and review-detail.service.ts:
 *   GET   /api/reviews/inbox                   the list: filters, tab and tile counts, facets, read state
 *   GET   /api/reviews/inbox/:id               one review with order, return, buyer history, timeline, reply rules
 *   POST  /api/reviews/inbox/bulk              Assign · Tag · Set status · Draft with AI (≤ 200 ids, drafts ≤ 50)
 *   PATCH /api/reviews/:id/sentiment           the person's mood/themes
 *   POST  /api/reviews/:id/translate           language + English, kept on the review
 *   POST  /api/reviews/import/:batchId/undo    removes one import's rows, keeps the ones a person worked on
 * Every Review read behind these routes shows visible rows only (fixture rows never show): `visibleReviewWhere`.
 *
 * Reviews Settings (2026-10-26, PR D) — logic in services/reviews/review-settings.service.ts and review-settings-health.ts:
 *   GET    /api/reviews/settings                   voice, alerts (+ who), the sender (read-only), the team, templates to load
 *   PUT    /api/reviews/settings                   { voice?, alerts? } → the settings as saved, or why not (400, in words)
 *   GET    /api/reviews/settings/sources           each review source's state in words, and how many need a person
 *   GET    /api/reviews/settings/pipeline          each review job's schedule, last and next run and state
 *   GET    /api/reviews/reply-templates            ?channel= → a channel's templates and the every-channel ones
 *   POST   /api/reviews/reply-templates            { name, channel, bodies } → the template (409 on a taken name)
 *   PATCH  /api/reviews/reply-templates/:id        { name?, channel?, bodies? }
 *   DELETE /api/reviews/reply-templates/:id
 *   POST   /api/reviews/reply-templates/:id/use    a person picked it in the Inbox reply box (its "Used" count)
 *   PATCH  /api/reviews/automation-rules/:id       { enabled } — review automations only (404 for any other rule)
 *
 * Reviews Insights (2026-10-26, PR E) — logic in services/reviews/review-{themes,products,alerts,fix-plan,spotlight}*.ts:
 *   GET    /api/reviews/insights/themes            ?channel&market&period&sort → themes, summary, Amazon topic states
 *   GET    /api/reviews/insights/products          ?channel&market&period&page&pageSize&q&theme&… → families + tiles
 *   GET    /api/reviews/insights/products/:id      one product: rating per market (with its source words), themes, returns
 *   GET    /api/reviews/heatmap                    ?sinceDays|period&market&channel&metric=mentions|negativeShare
 *   GET    /api/reviews/spikes                     ?status&channel&market&productId&theme → alerts, counts, time to resolve
 *   PATCH  /api/reviews/spikes/:id                 { status: ACKNOWLEDGED | RESOLVED | REOPEN } — actor = signed-in person
 *   POST   /api/reviews/spikes/bulk                { ids ≤ 200, action: acknowledge | resolve | suggest (≤ 5) } → { changed, held }
 *   GET    /api/reviews/action-items               ?status&kind&productId&spikeId → fixes (each says why it cannot be sent;
 *                                                  size-guide fixes re-checked from fit by size first)
 *   PATCH  /api/reviews/action-items/:id           { status: OPEN | DISMISSED } or an edit of the proposal
 *   POST   /api/reviews/action-items/suggest       { productId } — AI fixes for one product
 *   POST   /api/reviews/action-items/:id/propose   ONE change plan (approved on the Approvals page); a Task without approval
 *   POST   /api/reviews/action-items/bulk          { ids ≤ 200, action: propose | dismiss } → { changed, held, sent?, tasks? }
 *   POST   /api/reviews/action-items/:id/withdraw  takes the waiting plan back
 *   POST   /api/reviews/action-items/:id/task      a task: no approval, nothing reaches a channel
 *   GET    /api/reviews/spotlight                  ?channel&marketplace&id · /history · /scopes
 *   POST   /api/reviews/spotlight/generate         { channel?, marketplace?, period? } — 20 reviews at least, 10 a day
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import prisma from '../db.js'
import { requestUserId } from '../lib/auth/request-permission.js'
import { listInbox, runInboxBulk } from '../services/reviews/review-inbox.service.js'
import { validateInboxBulk } from '../services/reviews/review-inbox-query.js'
import { editReviewSentiment, getInboxReview, translateReview } from '../services/reviews/review-detail.service.js'
import { logger } from '../utils/logger.js'
import { sendEmail } from '../services/email/transport.js'
import { triageReview } from '../services/reviews/review-triage.service.js'
import { seedReviewTemplates } from '../services/reviews/review-templates.js'
import {
  previewReviewImport,
  applyReviewImport,
  undoReviewImport,
  IMPORT_SOURCES,
  type CanonicalField,
  type ImportFileKind,
  type ImportSource,
} from '../services/reviews/review-import.service.js'
import { createReplyDraft } from '../services/reviews/review-reply.service.js'
import {
  generateSpotlight, getLatestSpotlight, spotlightHistory, spotlightScope, spotlightScopes, SpotlightHeldError,
} from '../services/reviews/review-spotlight.service.js'
import { generateActionItemsForSpike, suggestFixesForProduct } from '../services/reviews/review-actions.service.js'
import { bulkAlerts, decideAlert, listAlerts, parseDecision } from '../services/reviews/review-alerts.service.js'
import { insightsHeatmap, insightsThemes } from '../services/reviews/review-themes.service.js'
import { insightsProductDetail, insightsProducts } from '../services/reviews/review-products.service.js'
import {
  bulkFixes, createFixTask, listFixes, proposeFixes, updateFix, withdrawFix,
} from '../services/reviews/review-fix-plan.service.js'
import type { UserPrincipal } from '../services/agents/call-tool.js'
import { sendReviewReply } from '../services/reviews/review-reply-send.service.js'
import { sseResponseHeaders } from '../lib/sse.js'
import {
  createReplyTemplate, deleteReplyTemplate, listReplyTemplates, markReplyTemplateUsed, readReviewSettings, saveReviewSettings,
  setReviewAutomationEnabled, updateReplyTemplate,
} from '../services/reviews/review-settings.service.js'
import { readSettingsPipeline, readSettingsSources } from '../services/reviews/review-settings-health.js'

// SR.3 — register review action handlers (side-effect import)
import '../services/reviews/review-action-handlers.js'

/** A refusal in words: a 4xx error's own status and message; anything else is a 500, logged. */
function fail(reply: FastifyReply, err: unknown, what: string) {
  const status = typeof (err as { statusCode?: unknown })?.statusCode === 'number' ? (err as { statusCode: number }).statusCode : 500
  if (status >= 400 && status < 500) return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) })
  logger.error(`[reviews] ${what} failed`, { error: err instanceof Error ? err.message : String(err) })
  return reply.code(500).send({ error: `${what} failed`, message: err instanceof Error ? err.message : String(err) })
}

/** The signed-in person as the approval door needs them (an API key has no person: refused with 403, in words). */
async function personOf(request: FastifyRequest): Promise<UserPrincipal> {
  const { requestPrincipal } = await import('../services/agents/call-tool.js')
  return requestPrincipal(request)
}

/** A brief's window: the period picker's value (7d, 30d, 90d, 12m), or windowDays; 30 days by default. */
function windowDaysOf(period: unknown, windowDays: unknown): number {
  const byPeriod: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 }
  if (typeof period === 'string' && byPeriod[period]) return byPeriod[period]
  const n = Number(windowDays)
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.trunc(n), 365) : 30
}

const FIX_NOT_FOUND_WORDS = 'Not found in this business’s fixes.'

const reviewsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Reviews Inbox (PR B) ────────────────────────────────────────────
  // GET /reviews/inbox — one page of the Inbox, newest first, with tab/tile counts, facets and read state.
  fastify.get('/reviews/inbox', async (request, reply) => {
    const page = await listInbox((request.query ?? {}) as Record<string, unknown>)
    reply.header('Cache-Control', 'private, no-store')
    return page
  })

  // GET /reviews/inbox/:id — the review pop-up.
  fastify.get<{ Params: { id: string } }>('/reviews/inbox/:id', async (request, reply) => {
    const detail = await getInboxReview(request.params.id)
    if (!detail) {
      reply.code(404)
      return { error: 'not_found' }
    }
    reply.header('Cache-Control', 'private, no-store')
    return detail
  })

  // POST /reviews/inbox/bulk { ids, action: assign|tag|status|draft, value? } → { changed, skipped: {id, reason}[] }
  fastify.post('/reviews/inbox/bulk', async (request, reply) => {
    const valid = validateInboxBulk(request.body)
    if ('error' in valid) {
      reply.code(400)
      return { error: valid.error, message: valid.words }
    }
    return runInboxBulk(valid.request, requestUserId(request))
  })

  // PATCH /reviews/:id/sentiment { label?, categories? } — the person's mood and themes win over the AI's.
  fastify.patch<{ Params: { id: string }; Body: { label?: unknown; categories?: unknown } }>(
    '/reviews/:id/sentiment',
    async (request, reply) => {
      const result = await editReviewSentiment(request.params.id, request.body ?? {}, requestUserId(request))
      if ('error' in result) {
        reply.code(result.error === 'not_found' ? 404 : 400)
        return { error: result.error, message: result.words }
      }
      return result
    },
  )

  // POST /reviews/:id/translate → { language, english } (kept on the review; a second call reads it back).
  fastify.post<{ Params: { id: string } }>('/reviews/:id/translate', async (request, reply) => {
    const result = await translateReview(request.params.id)
    if ('error' in result) {
      if (result.error === 'not_found') {
        reply.code(404)
        return { error: 'not_found' }
      }
      reply.code(503)
      return { error: 'translation_unavailable', message: 'Nexus could not translate this review now. Try again later.' }
    }
    return result
  })

  // ── POST /reviews/import/preview (RX.1) ─────────────────────────────
  // Parse a pasted/uploaded CSV/TSV/JSON/XLSX, auto-detect the column
  // mapping, validate + dedup-check — without writing anything.
  // Inbox (PR B): `source` (amazon | shopify_app | etsy | other) sets the channel; e-mail/IP columns are never read.
  fastify.post<{
    Body: {
      text?: string
      bytesBase64?: string
      fileKind?: ImportFileKind
      source?: ImportSource
      channel?: string
      marketplace?: string | null
      columnMapping?: Partial<Record<CanonicalField, string>>
      includeUnlinked?: boolean
    }
  }>('/reviews/import/preview', async (request, reply) => {
    const b = request.body ?? {}
    if (!b.text && !b.bytesBase64) {
      reply.code(400)
      return { error: 'no_input', message: 'Provide text or bytesBase64.' }
    }
    if (b.source !== undefined && !IMPORT_SOURCES.includes(b.source)) {
      reply.code(400)
      return { error: 'invalid_source', message: 'Pick Amazon export, Shopify review app, Etsy or another file.' }
    }
    try {
      const preview = await previewReviewImport({
        text: b.text,
        bytesBase64: b.bytesBase64,
        fileKind: b.fileKind,
        source: b.source,
        channel: b.channel ?? 'AMAZON',
        marketplace: b.marketplace ?? null,
        columnMapping: b.columnMapping,
        includeUnlinked: b.includeUnlinked,
      })
      return { ok: true, preview }
    } catch (err) {
      reply.code(400)
      return { error: 'parse_failed', message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── POST /reviews/import/apply (RX.1) ───────────────────────────────
  // Ingest the validated rows through the shared sentiment pipeline.
  // Inbox (PR B): the result carries `batchId` — POST /reviews/import/:batchId/undo removes this import again.
  fastify.post<{
    Body: {
      text?: string
      bytesBase64?: string
      fileKind?: ImportFileKind
      source?: ImportSource
      channel?: string
      marketplace?: string | null
      columnMapping?: Partial<Record<CanonicalField, string>>
      force?: boolean
      includeUnlinked?: boolean
    }
  }>('/reviews/import/apply', async (request, reply) => {
    const b = request.body ?? {}
    if (!b.text && !b.bytesBase64) {
      reply.code(400)
      return { error: 'no_input', message: 'Provide text or bytesBase64.' }
    }
    if (b.source !== undefined && !IMPORT_SOURCES.includes(b.source)) {
      reply.code(400)
      return { error: 'invalid_source', message: 'Pick Amazon export, Shopify review app, Etsy or another file.' }
    }
    try {
      const result = await applyReviewImport({
        text: b.text,
        bytesBase64: b.bytesBase64,
        fileKind: b.fileKind,
        source: b.source,
        channel: b.channel ?? 'AMAZON',
        marketplace: b.marketplace ?? null,
        columnMapping: b.columnMapping,
        force: b.force,
        includeUnlinked: b.includeUnlinked,
      })
      return { ok: true, result, batchId: result.batchId }
    } catch (err) {
      reply.code(400)
      return { error: 'import_failed', message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── POST /reviews/import/:batchId/undo (Inbox, PR B) ────────────────
  // Removes the rows one import created; keeps (and names) the ones a person already worked on.
  fastify.post<{ Params: { batchId: string } }>('/reviews/import/:batchId/undo', async (request, reply) => {
    const result = await undoReviewImport(request.params.batchId)
    if ('error' in result) {
      reply.code(404)
      return { error: 'not_found', message: 'Nothing from this import is left to undo.' }
    }
    return result
  })

  // ── GET /reviews/events (RX.3) — SSE live stream ────────────────────
  fastify.get('/reviews/events', async (request, reply) => {
    reply.raw.writeHead(200, sseResponseHeaders(request.headers.origin as string | undefined))
    reply.raw.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: true })}\n\n`)

    const { subscribeReviewEvents, replayReviewEventsSince } = await import(
      '../services/review-events.service.js'
    )
    const send = (event: { type: string; ts: number }) => {
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      } catch {
        // connection dead — close handler cleans up
      }
    }

    const sinceRaw = (request.query as { since?: string })?.since
    const sinceMs = sinceRaw ? Number(sinceRaw) : NaN
    if (Number.isFinite(sinceMs) && sinceMs > 0) {
      const replayed = replayReviewEventsSince(sinceMs)
      for (const event of replayed) send(event)
      if (replayed.length > 0) {
        reply.raw.write(
          `event: replay.done\ndata: ${JSON.stringify({ ts: Date.now(), count: replayed.length })}\n\n`,
        )
      }
    }

    const unsubscribe = subscribeReviewEvents(send)
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`)
      } catch {
        // ignore
      }
    }, 25_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })

    await new Promise(() => {})
  })

  // ── PATCH /reviews/:id/triage (RX.2) ────────────────────────────────
  fastify.patch<{
    Params: { id: string }
    Body: { status?: string; assignee?: string | null; tags?: string[]; note?: string | null }
  }>('/reviews/:id/triage', async (request, reply) => {
    const { id } = request.params
    // 07 O7 — the triage lives in services/reviews/review-triage.service.ts (the desk and Claude write one way).
    const result = await triageReview(id, request.body ?? {})
    if ('error' in result) {
      reply.code(result.error === 'invalid_status' ? 400 : 404)
      return { error: result.error }
    }
    return { review: result.review }
  })

  // ── POST /reviews/:id/reply/draft (RX.2) ────────────────────────────
  // AI-draft a reply and persist it as a DRAFT ReviewResponse.
  fastify.post<{
    Params: { id: string }
    Body: { locale?: 'it' | 'de' | 'fr' | 'es' | 'en'; tone?: string; instructions?: string }
  }>('/reviews/:id/reply/draft', async (request, reply) => {
    const { id } = request.params
    const b = request.body ?? {}
    try {
      // Inbox (PR B): the draft is in the buyer's language; `englishText` is the same reply in English for the team.
      const draft = await createReplyDraft(id, { locale: b.locale, tone: b.tone, instructions: b.instructions })
      if ('error' in draft) {
        reply.code(404)
        return { error: 'not_found' }
      }
      return { ok: true, response: draft.response, usedAi: draft.usedAi, tone: draft.tone, englishText: draft.englishText }
    } catch (err) {
      reply.code(500)
      return { error: 'draft_failed', message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── POST /reviews/:id/reply/send (RX.2) ─────────────────────────────
  // eBay → real RespondToFeedback. Amazon seller feedback / Shopify → no public reply API, so the operator posts
  // manually and this records it (MANUAL) and marks the review RESPONDED. The reply is recorded as the signed-in
  // person's (audit E6): never a body field, never "anonymous".
  fastify.post<{
    Params: { id: string }
    Body: { body?: string; responseId?: string }
  }>('/reviews/:id/reply/send', async (request, reply) => {
    const actor = request.authUser?.id ? `user:${request.authUser.id}` : 'user:unknown'
    const { body, responseId } = request.body ?? {}
    const answer = await sendReviewReply(request.params.id, { body, responseId, actor })
    return reply.code(answer.status).send(answer.body)
  })

  // ── Reviews Insights › Alerts (PR E) — logic in services/reviews/review-alerts.service.ts ──
  // GET /reviews/spikes?status&channel&market&productId&theme&limit → { items, count, counts, timeToResolve, check }
  fastify.get('/reviews/spikes', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=15')
      return await listAlerts((request.query ?? {}) as Record<string, unknown>)
    } catch (err) {
      return fail(reply, err, 'spikes')
    }
  })

  // PATCH /reviews/spikes/:id { status: ACKNOWLEDGED | RESOLVED | REOPEN } — the actor is the signed-in person.
  fastify.patch<{ Params: { id: string }; Body: { status?: unknown } }>('/reviews/spikes/:id', async (request, reply) => {
    try {
      const actor = requestUserId(request)
      return await decideAlert(request.params.id, parseDecision(request.body?.status), actor)
    } catch (err) {
      return fail(reply, err, 'spike decide')
    }
  })

  // POST /reviews/spikes/bulk { ids ≤ 200, action: acknowledge | resolve | suggest (≤ 5) } → { changed, held, fixes? }
  fastify.post('/reviews/spikes/bulk', async (request, reply) => {
    try {
      const actor = requestUserId(request)
      return await bulkAlerts(request.body, actor, (spikeId, by) => generateActionItemsForSpike(spikeId, by))
    } catch (err) {
      return fail(reply, err, 'spikes bulk')
    }
  })

  // ── GET /reviews/heatmap (SR.2; PR E: + channel, metric=negativeShare) ──
  // Day × theme from the visible reviews (services/reviews/review-themes.service.ts insightsHeatmap). Each cell carries
  // total + per-label counts and `value` (the chosen metric); a day without reviews has no cell (drawn striped).
  fastify.get('/reviews/heatmap', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=120')
      return await insightsHeatmap((request.query ?? {}) as Record<string, unknown>)
    } catch (err) {
      return fail(reply, err, 'heatmap')
    }
  })

  // ── Reviews Insights › Themes and Products (PR E) — services/reviews/review-themes.service.ts, review-products.service.ts ──
  fastify.get('/reviews/insights/themes', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=60')
      return await insightsThemes((request.query ?? {}) as Record<string, unknown>)
    } catch (err) {
      return fail(reply, err, 'insights themes')
    }
  })

  fastify.get('/reviews/insights/products', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=60')
      return await insightsProducts((request.query ?? {}) as Record<string, unknown>)
    } catch (err) {
      return fail(reply, err, 'insights products')
    }
  })

  fastify.get<{ Params: { productId: string } }>('/reviews/insights/products/:productId', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=60')
      return await insightsProductDetail(request.params.productId, (request.query ?? {}) as Record<string, unknown>)
    } catch (err) {
      return fail(reply, err, 'insights product')
    }
  })

  // ── SR.3 — review-domain automation rules ──────────────────────────
  fastify.get('/reviews/automation-rules', async (request, _reply) => {
    const q = request.query as { limit?: string }
    const limit = Math.min(Number(q.limit) || 100, 500)
    const items = await prisma.automationRule.findMany({
      where: { domain: 'reviews' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return { items, count: items.length }
  })

  fastify.post('/reviews/automation-rules/seed-templates', async (_request, _reply) => {
    const result = await seedReviewTemplates()
    return { ok: true, ...result }
  })

  // PATCH /reviews/automation-rules/:id { enabled } — Reviews Settings › Automations' switch; review automations only.
  fastify.patch<{ Params: { id: string }; Body: { enabled?: unknown } }>('/reviews/automation-rules/:id', async (request, reply) => {
    const result = await setReviewAutomationEnabled(request.params.id, request.body?.enabled)
    if (result.ok === false) {
      reply.code(result.code)
      return { error: result.code === 404 ? 'not_found' : 'invalid', message: result.words }
    }
    return result
  })

  // ── Reviews Settings (PR D) ─────────────────────────────────────────
  fastify.get('/reviews/settings', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    return readReviewSettings()
  })

  fastify.put('/reviews/settings', async (request, reply) => {
    const result = await saveReviewSettings(request.body, requestUserId(request))
    if (result.ok === false) {
      reply.code(400)
      return { error: 'invalid', message: result.words }
    }
    return result.settings
  })

  fastify.get('/reviews/settings/sources', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    return readSettingsSources()
  })

  fastify.get('/reviews/settings/pipeline', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    return readSettingsPipeline()
  })

  fastify.get<{ Querystring: { channel?: string } }>('/reviews/reply-templates', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    return { items: await listReplyTemplates({ channel: request.query?.channel ?? null }) }
  })

  fastify.post('/reviews/reply-templates', async (request, reply) => {
    const result = await createReplyTemplate(request.body, requestUserId(request))
    if (result.ok === false) {
      reply.code(result.code)
      return { error: result.code === 409 ? 'name_taken' : 'invalid', message: result.words }
    }
    reply.code(201)
    return result.template
  })

  fastify.patch<{ Params: { id: string } }>('/reviews/reply-templates/:id', async (request, reply) => {
    const result = await updateReplyTemplate(request.params.id, request.body)
    if (result.ok === false) {
      reply.code(result.code)
      return { error: result.code === 404 ? 'not_found' : result.code === 409 ? 'name_taken' : 'invalid', message: result.words }
    }
    return result.template
  })

  fastify.delete<{ Params: { id: string } }>('/reviews/reply-templates/:id', async (request, reply) => {
    const result = await deleteReplyTemplate(request.params.id)
    if (result.ok === false) {
      reply.code(404)
      return { error: 'not_found', message: result.words }
    }
    return result
  })

  fastify.post<{ Params: { id: string } }>('/reviews/reply-templates/:id/use', async (request, reply) => {
    const result = await markReplyTemplateUsed(request.params.id)
    if (result.ok === false) {
      reply.code(404)
      return { error: 'not_found', message: result.words }
    }
    return result
  })

  // ── Review Spotlight (RX.4) — Reviews Insights › Brief (PR E): services/reviews/review-spotlight.service.ts ──
  // GET /reviews/spotlight?channel&marketplace|market&productId&id → the newest brief of exactly that scope (or one by id)
  fastify.get('/reviews/spotlight', async (request, reply) => {
    try {
      const q = (request.query ?? {}) as Record<string, unknown>
      const scope = spotlightScope(q)
      const latest = await getLatestSpotlight({
        productId: typeof q.productId === 'string' && q.productId ? q.productId : null,
        channel: scope.channel,
        marketplace: scope.market,
        id: typeof q.id === 'string' && q.id ? q.id : null,
      })
      reply.header('Cache-Control', 'private, max-age=60')
      return { spotlight: latest }
    } catch (err) {
      return fail(reply, err, 'spotlight')
    }
  })

  // GET /reviews/spotlight/history?channel&marketplace&limit → earlier briefs, newest first (read-only)
  fastify.get('/reviews/spotlight/history', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')
      return await spotlightHistory((request.query ?? {}) as Record<string, unknown>)
    } catch (err) {
      return fail(reply, err, 'spotlight history')
    }
  })

  // GET /reviews/spotlight/scopes?period → the "Brief for" options (each says whether a brief exists), today's limit
  fastify.get('/reviews/spotlight/scopes', async (request, reply) => {
    try {
      const q = (request.query ?? {}) as Record<string, unknown>
      reply.header('Cache-Control', 'private, max-age=30')
      return await spotlightScopes({ windowDays: windowDaysOf(q.period, q.windowDays) })
    } catch (err) {
      return fail(reply, err, 'spotlight scopes')
    }
  })

  // ── Review action items (RX.5) — Reviews Insights › Fixes (PR E): services/reviews/review-fix-plan.service.ts ──
  // GET /reviews/action-items?status&kind&productId&spikeId&limit → { items, count, counts } (Sent fixes follow their plan)
  fastify.get('/reviews/action-items', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=15')
      return await listFixes((request.query ?? {}) as Record<string, unknown>)
    } catch (err) {
      return fail(reply, err, 'fixes')
    }
  })

  // POST /reviews/spikes/:id/generate-actions — "Suggest fixes" for one alert; the actor is the signed-in person.
  fastify.post<{ Params: { id: string } }>('/reviews/spikes/:id/generate-actions', async (request, reply) => {
    const { id } = request.params
    try {
      const result = await generateActionItemsForSpike(id, requestUserId(request))
      return { ok: true, ...result }
    } catch (err) {
      if (err instanceof Error && err.message === 'spike not found') {
        reply.code(404)
        return { error: 'generate_failed', message: 'No alert with this id in this business.' }
      }
      return fail(reply, err, 'generate actions')
    }
  })

  // POST /reviews/action-items/suggest { productId } — the product pop-up's "Suggest a fix" (AI; changes nothing).
  fastify.post<{ Body: { productId?: unknown } }>('/reviews/action-items/suggest', async (request, reply) => {
    try {
      const actor = requestUserId(request)
      const productId = typeof request.body?.productId === 'string' ? request.body.productId.trim() : ''
      if (!productId) return reply.code(400).send({ error: 'productId: name the product.' })
      return { ok: true, ...(await suggestFixesForProduct(productId, actor)) }
    } catch (err) {
      return fail(reply, err, 'suggest fixes')
    }
  })

  // POST /reviews/action-items/bulk { ids ≤ 200, action: propose | dismiss } → { changed, held, sent?, tasks? }
  fastify.post('/reviews/action-items/bulk', async (request, reply) => {
    try {
      const person = await personOf(request)
      return await bulkFixes(request.body, person)
    } catch (err) {
      return fail(reply, err, 'fixes bulk')
    }
  })

  // POST /reviews/action-items/:id/propose — "Send for approval": ONE change plan (a Task is created instead).
  fastify.post<{ Params: { id: string } }>('/reviews/action-items/:id/propose', async (request, reply) => {
    try {
      const person = await personOf(request)
      const out = await proposeFixes([request.params.id], person)
      if (out.changed === 0 && out.held.length) return reply.code(out.held[0].words === FIX_NOT_FOUND_WORDS ? 404 : 409).send({ error: out.held[0].words, ...out })
      return out
    } catch (err) {
      return fail(reply, err, 'propose fix')
    }
  })

  // POST /reviews/action-items/:id/withdraw — takes the waiting change plan back; its fixes are Open again.
  fastify.post<{ Params: { id: string } }>('/reviews/action-items/:id/withdraw', async (request, reply) => {
    try {
      return await withdrawFix(request.params.id, requestUserId(request))
    } catch (err) {
      return fail(reply, err, 'withdraw fix')
    }
  })

  // POST /reviews/action-items/:id/task { assignee? } — "Create task": no approval, nothing reaches a channel.
  fastify.post<{ Params: { id: string }; Body: { assignee?: unknown } }>('/reviews/action-items/:id/task', async (request, reply) => {
    try {
      const assignee = typeof request.body?.assignee === 'string' && request.body.assignee.trim() ? request.body.assignee.trim().slice(0, 64) : null
      return await createFixTask(request.params.id, requestUserId(request), assignee)
    } catch (err) {
      return fail(reply, err, 'fix task')
    }
  })

  // PATCH /reviews/action-items/:id { status: OPEN | DISMISSED } or an edit of the proposal (no direct Apply).
  fastify.patch<{ Params: { id: string } }>('/reviews/action-items/:id', async (request, reply) => {
    try {
      requestUserId(request)
      return await updateFix(request.params.id, request.body)
    } catch (err) {
      return fail(reply, err, 'fix update')
    }
  })

  // POST /reviews/spotlight/generate { channel?, marketplace?, period? | windowDays? } — held (409 too few, 429 10 a day)
  fastify.post<{
    Body: { productId?: string | null; channel?: unknown; marketplace?: unknown; market?: unknown; windowDays?: unknown; period?: unknown }
  }>('/reviews/spotlight/generate', async (request, reply) => {
    const b = request.body ?? {}
    try {
      requestUserId(request)
      const scope = spotlightScope(b)
      const spotlight = await generateSpotlight({
        productId: typeof b.productId === 'string' && b.productId ? b.productId : null,
        channel: scope.channel,
        marketplace: scope.market,
        windowDays: windowDaysOf(b.period, b.windowDays),
      })
      return { ok: true, spotlight }
    } catch (err) {
      if (err instanceof SpotlightHeldError) return reply.code(err.statusCode).send({ error: err.message, held: true, reason: err.reason })
      return fail(reply, err, 'spotlight generate')
    }
  })

  // RV.9.2 — manual cron-orphan sweep trigger. The cron runs every 30
  // min on its own, but operators can poke it from the health banner.
  fastify.post('/reviews/pipeline/sweep-stuck-crons', async () => {
    const { runCronOrphanSweepOnce } = await import('../jobs/cron-orphan-sweeper.job.js')
    const result = await runCronOrphanSweepOnce()
    return { ok: true, ...result }
  })

  // RV.9.5 — Public unsubscribe endpoint (no auth — token authenticates
  // intent). Supports GET (the link in the email; renders a confirmation
  // page) and POST (RFC 8058 one-click). Both honor the request
  // immediately by inserting an EmailSuppression row.
  fastify.get<{ Querystring: { token?: string; channel?: string; email?: string } }>(
    '/email/unsubscribe',
    async (request, reply) => {
      const { token, channel, email } = request.query
      // Look up the email: token-derived (preferred) OR querystring fallback.
      const { emailFromUnsubscribeToken, addSuppression } = await import(
        '../services/reviews/email-suppression.service.js'
      )
      let resolvedEmail: string | null = null
      if (email) {
        // Validate token matches the email if both provided.
        const { verifyUnsubscribeToken } = await import(
          '../services/reviews/email-suppression.service.js'
        )
        if (!token || !verifyUnsubscribeToken(email, token)) {
          return reply.code(400).send({ error: 'token / email mismatch' })
        }
        resolvedEmail = email.trim().toLowerCase()
      } else if (token) {
        // Walk recent ReviewSentimentCheck rows + ReviewRequest rows for
        // candidate emails. Caps at 1000 to keep latency bounded.
        const candidates = await prisma.order.findMany({
          where: { customerEmail: { not: '' } },
          select: { customerEmail: true },
          orderBy: { createdAt: 'desc' },
          take: 1000,
          distinct: ['customerEmail'],
        })
        const emails = candidates.map((c) => c.customerEmail!).filter(Boolean)
        resolvedEmail = emailFromUnsubscribeToken(token, emails)
      }
      if (!resolvedEmail) {
        return reply.code(400).send({ error: 'invalid or expired unsubscribe link' })
      }
      const ch = channel ?? null
      const ipAddress = request.headers['x-forwarded-for']
        ? String(request.headers['x-forwarded-for']).split(',')[0].trim()
        : request.ip
      await addSuppression({
        email: resolvedEmail,
        channel: ch,
        source: 'UNSUBSCRIBE_LINK',
        ipAddress,
        userAgent: request.headers['user-agent'] ?? null,
      })
      // Redirect the GET to a friendly confirmation page on the web app.
      const webBase = (process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-web.up.railway.app').replace(/\/$/, '')
      reply.code(302).header(
        'location',
        `${webBase}/unsubscribed?channel=${encodeURIComponent(ch ?? 'all')}`,
      )
      return reply.send()
    },
  )

  fastify.post<{ Body: { token?: string; email?: string; channel?: string } }>(
    '/email/unsubscribe',
    async (request) => {
      // RFC 8058 one-click — same logic as GET, returns JSON.
      const body = request.body ?? {}
      const channel = body.channel ?? null
      const { emailFromUnsubscribeToken, addSuppression, verifyUnsubscribeToken } = await import(
        '../services/reviews/email-suppression.service.js'
      )
      let resolvedEmail: string | null = null
      if (body.email) {
        if (!body.token || !verifyUnsubscribeToken(body.email, body.token)) {
          return { ok: false, error: 'token / email mismatch' }
        }
        resolvedEmail = body.email.trim().toLowerCase()
      } else if (body.token) {
        const candidates = await prisma.order.findMany({
          where: { customerEmail: { not: '' } },
          select: { customerEmail: true },
          orderBy: { createdAt: 'desc' },
          take: 1000,
          distinct: ['customerEmail'],
        })
        const emails = candidates.map((c) => c.customerEmail!).filter(Boolean)
        resolvedEmail = emailFromUnsubscribeToken(body.token, emails)
      }
      if (!resolvedEmail) return { ok: false, error: 'invalid or expired unsubscribe link' }
      await addSuppression({
        email: resolvedEmail,
        channel,
        source: 'UNSUBSCRIBE_LINK',
      })
      return { ok: true }
    },
  )

  // RV.9.5 — Admin list + manual add/remove for the suppression table.
  fastify.get<{ Querystring: { search?: string } }>(
    '/email/suppressions',
    async (request) => {
      const search = request.query.search?.trim().toLowerCase()
      const rows = await prisma.emailSuppression.findMany({
        where: search ? { email: { contains: search } } : undefined,
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
      return { rows }
    },
  )

  fastify.post<{ Body: { email: string; channel?: string | null; reason?: string } }>(
    '/email/suppressions',
    async (request, reply) => {
      const body = request.body
      if (!body?.email) return reply.code(400).send({ error: 'email required' })
      const { addSuppression } = await import('../services/reviews/email-suppression.service.js')
      const result = await addSuppression({
        email: body.email,
        channel: body.channel ?? null,
        source: 'MANUAL',
        reason: body.reason ?? null,
      })
      return { ok: true, ...result }
    },
  )

  // Reviews Settings (2026-10-26): `{ ids }` removes the ticked rows; either form removes only bounced and hand-added
  // addresses — one a buyer unsubscribed (or complained, or asked by privacy request) stays: only the buyer can undo
  // that. `kept` counts those.
  fastify.delete<{ Body: { email?: string; channel?: string | null; ids?: string[] } }>(
    '/email/suppressions',
    async (request, reply) => {
      const body = request.body
      const { removeSuppression, removeSuppressionsById } = await import('../services/reviews/email-suppression.service.js')
      if (Array.isArray(body?.ids)) {
        const result = await removeSuppressionsById(body.ids)
        return { ok: true, ...result }
      }
      if (!body?.email) return reply.code(400).send({ error: 'email required' })
      const result = await removeSuppression({
        email: body.email,
        channel: body.channel ?? null,
      })
      if (result.removed === 0 && result.kept > 0) {
        return reply.code(409).send({ error: 'buyer_unsubscribed', message: 'The buyer put this address on the list. Only the buyer can undo that.' })
      }
      return { ok: true, ...result }
    },
  )

  // RV.4.3 — per-request unsuppress + snooze controls.
  fastify.post<{ Params: { id: string } }>(
    '/review-requests/:id/unsuppress',
    async (request, reply) => {
      // "Allow again": refused server-side (409, in words) for a request that was sent, or that may not be asked
      // (review-queue.service.ts allowRequestAgain → allowAgainHeldFor); the attempt counter starts again.
      try {
        const { allowRequestAgain } = await import('../services/reviews/review-queue.service.js')
        const updated = await allowRequestAgain(request.params.id)
        if (!updated) return reply.code(404).send({ error: 'Request not found' })
        return { ok: true, request: updated }
      } catch (error: any) {
        if (error?.statusCode === 409) return reply.code(409).send({ error: error.message })
        return reply.code(500).send({ error: error.message })
      }
    },
  )

  // RV.8.1 — Conversion-rate + per-mp + per-productType analytics.
  fastify.get<{ Querystring: { windowDays?: string; attributionWindowDays?: string } }>(
    '/reviews/analytics',
    async (request, reply) => {
      const q = request.query
      const windowDays = q.windowDays ? Math.max(7, Math.min(180, parseInt(q.windowDays, 10))) : 30
      const attributionWindowDays = q.attributionWindowDays
        ? Math.max(7, Math.min(60, parseInt(q.attributionWindowDays, 10)))
        : 21
      const { computeReviewAnalytics } = await import('../services/reviews/review-analytics.service.js')
      try {
        const result = await computeReviewAnalytics({ windowDays, attributionWindowDays })
        reply.header('Cache-Control', 'private, max-age=300')
        return result
      } catch (err: any) {
        return reply.code(500).send({ error: err.message })
      }
    },
  )

  // ────────────────────────────────────────────────────────────────────
  // RV.6.2 — Customer-facing sentiment check landing endpoints.
  //
  // These are public (token = authentication). The token is a 32-char
  // URL-safe cryptographically random string — not the row id, never
  // includes orderId. The frontend pages live at:
  //   /r/[token]/positive
  //   /r/[token]/negative
  //
  // Idempotent: re-clicking the same link after a response returns the
  // existing outcome instead of re-firing.
  // ────────────────────────────────────────────────────────────────────

  // GET — state lookup for the landing page render
  fastify.get<{ Params: { token: string } }>(
    '/r/:token',
    async (request, reply) => {
      const { token } = request.params
      // RV.9.6 — Test-mode short-circuit. The token '__test__' is used
      // by the dashboard's "send-test" action; render demo state.
      if (token === '__test__') {
        return {
          token,
          response: 'NONE',
          respondedAt: null,
          order: { customerName: 'Test Operator', channelOrderId: 'TEST', marketplace: 'IT' },
          testMode: true,
        }
      }
      const check = await prisma.reviewSentimentCheck.findUnique({
        where: { workspace_token: workspaceKey({ token: token }) },
        include: {
          order: { select: { customerName: true, channelOrderId: true, marketplace: true } },
        },
      })
      if (!check) return reply.code(404).send({ error: 'Not found' })
      return {
        token,
        response: check.response,
        respondedAt: check.respondedAt,
        order: {
          customerName: check.order.customerName,
          channelOrderId: check.order.channelOrderId,
          marketplace: check.order.marketplace,
        },
      }
    },
  )

  // POST positive — happy customer; fire downstream Solicitations.
  fastify.post<{ Params: { token: string } }>(
    '/r/:token/positive',
    async (request, reply) => {
      const { token } = request.params
      // RV.9.6 — Test-mode short-circuit: no DB writes, no Solicitations fire.
      if (token === '__test__') {
        return { ok: true, response: 'POSITIVE', testMode: true }
      }
      const ip = (request.headers['x-forwarded-for']?.toString().split(',')[0] ?? request.ip ?? '').slice(0, 64)
      const ua = (request.headers['user-agent'] ?? '').slice(0, 256)

      const check = await prisma.reviewSentimentCheck.findUnique({
        where: { workspace_token: workspaceKey({ token: token }) },
        include: {
          order: { select: { id: true, channel: true, channelOrderId: true, marketplace: true, deliveredAt: true } },
          reviewRequest: true,
        },
      })
      if (!check) return reply.code(404).send({ error: 'Not found' })
      // Idempotent — re-clicks just return the existing response.
      if (check.response !== 'NONE') {
        return { ok: true, response: check.response, alreadyResponded: true }
      }

      await prisma.reviewSentimentCheck.update({
        where: { id: check.id },
        data: {
          response: 'POSITIVE',
          respondedAt: new Date(),
          respondedFromIp: ip,
          respondedFromUserAgent: ua,
        },
      })

      // If the order is Amazon AND we have a linked ReviewRequest AND it's
      // still inside the 4-30d window, fire Solicitations now. Otherwise
      // mark SCHEDULED+now so the next mailer tick handles it.
      if (check.reviewRequest && check.order.channel === 'AMAZON') {
        await prisma.reviewRequest.update({
          where: { id: check.reviewRequest.id },
          data: { status: 'SCHEDULED', scheduledFor: new Date(), suppressedReason: null, errorMessage: null, attemptCount: 0, nextRetryAt: null },
        })
      }
      return { ok: true, response: 'POSITIVE' }
    },
  )

  // POST negative — unhappy customer; capture feedback, route to support.
  fastify.post<{ Params: { token: string }; Body: { feedback?: string; name?: string } }>(
    '/r/:token/negative',
    async (request, reply) => {
      const { token } = request.params
      // RV.9.6 — Test-mode short-circuit: no DB writes, no support email.
      if (token === '__test__') {
        return { ok: true, response: 'NEGATIVE', testMode: true }
      }
      const body = (request.body ?? {}) as { feedback?: string; name?: string }
      const feedback = (body.feedback ?? '').toString().slice(0, 4000)
      const ip = (request.headers['x-forwarded-for']?.toString().split(',')[0] ?? request.ip ?? '').slice(0, 64)
      const ua = (request.headers['user-agent'] ?? '').slice(0, 256)

      const check = await prisma.reviewSentimentCheck.findUnique({
        where: { workspace_token: workspaceKey({ token: token }) },
        include: {
          order: { select: { id: true, channel: true, channelOrderId: true, marketplace: true, customerName: true, customerEmail: true } },
          reviewRequest: true,
        },
      })
      if (!check) return reply.code(404).send({ error: 'Not found' })
      if (check.response !== 'NONE') {
        return { ok: true, response: check.response, alreadyResponded: true }
      }

      await prisma.reviewSentimentCheck.update({
        where: { id: check.id },
        data: {
          response: 'NEGATIVE',
          respondedAt: new Date(),
          respondedFromIp: ip,
          respondedFromUserAgent: ua,
          feedback: feedback || null,
        },
      })

      // Mark the downstream ReviewRequest as SKIPPED with a clear reason —
      // the operator can see in the dashboard why this order was diverted.
      if (check.reviewRequest) {
        await prisma.reviewRequest.update({
          where: { id: check.reviewRequest.id },
          data: {
            status: 'SKIPPED',
            suppressedReason: 'Diverted to support (negative sentiment check)',
            providerResponseCode: 'DIVERTED_NEGATIVE',
            errorMessage: null,
          },
        })
      }

      // Email the support inbox with the order context + customer feedback.
      // Best-effort; failure here doesn't block the response.
      try {
        const supportEmail = process.env.NEXUS_SUPPORT_INBOX ?? 'support@xavia.it'
        const subject = `[Reviews] Negative sentiment — order ${check.order.channelOrderId ?? check.order.id}`
        const html = `
          <h2>Negative sentiment check</h2>
          <p>Customer flagged an issue via the post-purchase review-funnel email.</p>
          <ul>
            <li><b>Order:</b> ${check.order.channelOrderId ?? check.order.id}</li>
            <li><b>Channel:</b> ${check.order.channel} ${check.order.marketplace ? `· ${check.order.marketplace}` : ''}</li>
            <li><b>Customer:</b> ${(check.order.customerName ?? '—').replace(/</g, '&lt;')} &lt;${check.order.customerEmail ?? '—'}&gt;</li>
          </ul>
          <h3>Customer feedback:</h3>
          <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444;">
            ${feedback ? feedback.replace(/</g, '&lt;').replace(/\n/g, '<br>') : '<i>(no feedback text — they clicked the negative button without typing)</i>'}
          </blockquote>
          <p>Reach out to resolve <b>before</b> they leave a public review.</p>
        `
        await sendEmail({
          to: supportEmail,
          subject,
          html,
          tag: 'review-diversion-support',
        })
      } catch (err) {
        logger.warn('[review-diversion] failed to email support', {
          orderId: check.order.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      return { ok: true, response: 'NEGATIVE' }
    },
  )

  // ── D.3 — Amazon official Customer Feedback API: access probe + debug ──
  // The honest gate: does the SP-API app hold the Brand Analytics / Selling
  // Partner Insights role? Mirrors /advertising/sqp/probe.
  fastify.post('/reviews/insights/probe', async (request, reply) => {
    const b = (request.body ?? {}) as { marketplace?: string }
    if (!b.marketplace) { reply.status(400); return { error: 'marketplace required' } }
    const { probeAmazonReviewInsightsAccess } = await import('../services/reviews/amazon-review-insights.service.js')
    reply.header('Cache-Control', 'no-store')
    return probeAmazonReviewInsightsAccess(b.marketplace)
  })

  // Last raw API shapes (topics/trends) — finalise the defensive parsers against
  // Amazon's real fields without needing Railway log access.
  fastify.get('/reviews/insights/debug', async (_request, reply) => {
    const { insightsDebugState } = await import('../services/reviews/amazon-review-insights.service.js')
    reply.header('Cache-Control', 'no-store')
    return insightsDebugState
  })

  // POST /api/reviews/insights/ingest { marketplace, limit } — fire-and-forget. Kept with the probe and the debug read:
  // the Owner's steps to switch Amazon topics on (audit D1 sweep, 2026-10-27).
  fastify.post('/reviews/insights/ingest', async (request, reply) => {
    const b = (request.body ?? {}) as { marketplace?: string; limit?: number }
    if (!b.marketplace) { reply.status(400); return { error: 'marketplace required' } }
    const { ingestAmazonReviewInsights } = await import('../services/reviews/amazon-review-insights.service.js')
    void ingestAmazonReviewInsights({ marketplaceCode: b.marketplace, limit: b.limit })
      .then((r) => fastify.log.info({ insights: r }, '[review-insights] manual ingest complete'))
      .catch((e) => fastify.log.error({ err: e }, '[review-insights] manual ingest failed'))
    reply.header('Cache-Control', 'no-store')
    return { ok: true, started: true, marketplace: b.marketplace, note: 'ingest running in background; the topics show on the Amazon page and in Reviews › Settings › Sources' }
  })
}

export default reviewsRoutes
