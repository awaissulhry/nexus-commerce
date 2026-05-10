/**
 * H.7 — AI usage analytics for the settings page.
 *
 *   GET /api/ai/providers
 *     → { providers: [{ name, configured, defaultModel }] }
 *
 *   GET /api/ai/usage/summary?days=7
 *     → { range, byProvider, byFeature, totals }
 *
 *     Aggregates AiUsageLog over the requested window. byProvider /
 *     byFeature each return rows of { name, calls, inputTokens,
 *     outputTokens, costUSD }. `totals` sums across providers.
 *
 *     Range cap: 90 days. Past that the table is large enough that an
 *     unindexed scan would hurt; we'd want to materialize a daily
 *     summary table first. The settings card only ever asks for 7 or
 *     30 days, so the cap is comfortable.
 *
 *   GET /api/ai/usage/recent?limit=50
 *     → { rows: AiUsageLog[] }
 *
 *     Last N rows, newest first. For the live tail in the settings
 *     page so you can see calls as they happen (refresh-on-poll).
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { readBudgetLimits } from '../services/ai/budget.service.js'
import {
  isAiKillSwitchOn,
  listProviders,
} from '../services/ai/providers/index.js'
import {
  listPromptTemplates,
  recordPromptTemplateEdit,
  type PromptTemplateStatus,
} from '../services/ai/prompt-template.service.js'
import { listBrandVoices } from '../services/ai/brand-voice.service.js'

const MAX_DAYS = 90

const aiUsageRoutes: FastifyPluginAsync = async (fastify) => {
  // AI-2.5 (list-wizard) — promote / archive / edit a single
  // PromptTemplate row. Drives the admin UI on /settings/ai.
  //
  // PATCH /api/ai/prompt-templates/:id
  //   body: { status?: 'DRAFT'|'ACTIVE'|'ARCHIVED', body?: string,
  //           description?: string, name?: string }
  //
  // No version bump on body edits in v1 — operators iterate on the
  // current version's body until they're happy. Cloning to a new
  // version (for A/B + history) lands in AI-2.4.
  fastify.patch<{
    Params: { id: string }
    Body: {
      status?: string
      body?: string
      description?: string
      name?: string
    }
  }>('/ai/prompt-templates/:id', async (request, reply) => {
    const id = request.params.id
    const allowedStatuses = new Set(['DRAFT', 'ACTIVE', 'ARCHIVED'])
    const data: Record<string, unknown> = {}
    if (typeof request.body?.status === 'string') {
      if (!allowedStatuses.has(request.body.status)) {
        return reply.code(400).send({
          error: `status must be one of ${[...allowedStatuses].join(', ')}`,
        })
      }
      data.status = request.body.status
    }
    if (typeof request.body?.body === 'string') {
      const trimmed = request.body.body.trim()
      if (trimmed.length === 0) {
        return reply.code(400).send({
          error: 'body cannot be empty — promotion would break AI calls',
        })
      }
      data.body = request.body.body
    }
    if (typeof request.body?.description === 'string') {
      data.description = request.body.description.slice(0, 500)
    }
    if (typeof request.body?.name === 'string') {
      const n = request.body.name.trim()
      if (n.length === 0) {
        return reply.code(400).send({ error: 'name cannot be empty' })
      }
      data.name = n.slice(0, 80)
    }
    if (Object.keys(data).length === 0) {
      return reply.code(400).send({
        error: 'no recognised fields in body — pass status / body / description / name',
      })
    }
    try {
      const updated = await prisma.promptTemplate.update({
        where: { id },
        data,
      })
      return {
        row: {
          ...updated,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
          lastUsedAt: updated.lastUsedAt
            ? updated.lastUsedAt.toISOString()
            : null,
        },
      }
    } catch (err) {
      // Prisma surfaces P2025 when the row doesn't exist.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'P2025'
      ) {
        return reply.code(404).send({ error: 'PromptTemplate not found' })
      }
      throw err
    }
  })

  // AI-2.4 (list-wizard) — clone a PromptTemplate as a DRAFT variant.
  //
  // POST /api/ai/prompt-templates/:id/clone
  //   body: { name?: string }
  //
  // Creates a new row with the source's body / description / scope but
  // status='DRAFT' and a fresh id. Default name is "<source-name>-
  // variant-N" where N counts sibling variants of the same feature.
  // Operators can override the name in the body.
  //
  // No traffic-routing in this v1 — operator promotes the variant
  // when ready (AI-2.5 admin UI). The matcher already supports
  // multiple ACTIVE rows per feature with distinct names, but at
  // most one will be picked per call (name='default' wins; the
  // matcher returns the most-recent updatedAt when multiple match
  // the same scope).
  fastify.post<{
    Params: { id: string }
    Body: { name?: string }
  }>(
    '/ai/prompt-templates/:id/clone',
    async (request, reply) => {
      const source = await prisma.promptTemplate.findUnique({
        where: { id: request.params.id },
      })
      if (!source) {
        return reply.code(404).send({ error: 'PromptTemplate not found' })
      }

      // Default name composition. Counts sibling rows for the same
      // feature so consecutive clones don't collide on the default
      // name ("variant-1", "variant-2", ...).
      let name: string
      if (typeof request.body?.name === 'string' && request.body.name.trim().length > 0) {
        name = request.body.name.trim().slice(0, 80)
      } else {
        const siblingCount = await prisma.promptTemplate.count({
          where: { feature: source.feature },
        })
        name = `variant-${siblingCount}`
      }

      try {
        const clone = await prisma.promptTemplate.create({
          data: {
            feature: source.feature,
            name,
            description:
              source.description != null
                ? `Variant of ${source.name} v${source.version}: ${source.description}`.slice(
                    0,
                    500,
                  )
                : `Variant of ${source.name} v${source.version}`,
            body: source.body,
            status: 'DRAFT',
            version: 1,
            language: source.language,
            marketplace: source.marketplace,
            createdBy: 'operator',
          },
        })
        reply.code(201)
        return {
          row: {
            ...clone,
            createdAt: clone.createdAt.toISOString(),
            updatedAt: clone.updatedAt.toISOString(),
            lastUsedAt: clone.lastUsedAt
              ? clone.lastUsedAt.toISOString()
              : null,
          },
        }
      } catch (err) {
        fastify.log.error({ err }, '[ai/prompt-templates] clone failed')
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  // AI-2.2 (list-wizard) — list PromptTemplate rows. Read-only v1
  // surface that the admin UI on /settings/ai (lands in AI-2.5) will
  // call to render the prompt list. Filterable by feature + status.
  fastify.get<{
    Querystring: { feature?: string; status?: string }
  }>('/ai/prompt-templates', async (request) => {
    const allowedStatuses = new Set(['DRAFT', 'ACTIVE', 'ARCHIVED'])
    const status =
      typeof request.query?.status === 'string' &&
      allowedStatuses.has(request.query.status)
        ? (request.query.status as PromptTemplateStatus)
        : undefined
    const feature =
      typeof request.query?.feature === 'string' && request.query.feature.length > 0
        ? request.query.feature
        : undefined
    const rows = await listPromptTemplates(prisma, { feature, status })
    return {
      rows: rows.map((r) => ({
        ...r,
        // Surface ISO timestamps so the client doesn't need a Date
        // parse step.
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      })),
    }
  })

  // AET.1 (list-wizard) — record an operator's accept-or-edit
  // decision after AI-generated content is saved. The wizard fires
  // this from Step 5 (and any other AI-generated-text save site)
  // with the {feature, scope, aiText, finalText} that produced the
  // generation. Server re-derives which template was used (AB.3
  // stickiness via stableSeed=productId) and bumps the right
  // counter on PromptTemplate. Best-effort; logging failures don't
  // 500 the operator's save.
  //
  // POST /api/ai/prompt-templates/record-edit
  //   body: {
  //     feature: string,
  //     language?: string,
  //     marketplace?: string,
  //     productId?: string,    // used as stableSeed
  //     aiText: string,
  //     finalText: string,
  //   }
  fastify.post<{
    Body: {
      feature?: string
      language?: string
      marketplace?: string
      productId?: string
      aiText?: string
      finalText?: string
    }
  }>('/ai/prompt-templates/record-edit', async (request, reply) => {
    const body = request.body ?? {}
    if (
      typeof body.feature !== 'string' ||
      body.feature.length === 0 ||
      typeof body.aiText !== 'string' ||
      typeof body.finalText !== 'string'
    ) {
      return reply
        .code(400)
        .send({ error: 'feature, aiText, finalText are required' })
    }
    const result = await recordPromptTemplateEdit(prisma, {
      feature: body.feature,
      scope: {
        language: body.language ?? null,
        marketplace: body.marketplace ?? null,
        stableSeed: body.productId ?? null,
      },
      aiText: body.aiText,
      finalText: body.finalText,
    })
    return { result }
  })

  // BV.3 (list-wizard) — BrandVoice CRUD for /settings/ai admin.
  //
  // GET    /api/ai/brand-voices             — list (active + inactive)
  // POST   /api/ai/brand-voices             — create
  // PATCH  /api/ai/brand-voices/:id         — edit body / scope / isActive
  // DELETE /api/ai/brand-voices/:id         — hard delete
  //
  // The matcher in renderBrandVoiceBlock picks the most-specific
  // ACTIVE row at AI call time; this admin surface lets the operator
  // create / promote / archive without going through SQL.
  fastify.get('/ai/brand-voices', async () => {
    const rows = await listBrandVoices(prisma, {})
    return {
      rows: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    }
  })

  fastify.post<{
    Body: {
      brand?: string | null
      marketplace?: string | null
      language?: string | null
      body?: string
      notes?: string | null
      isActive?: boolean
    }
  }>('/ai/brand-voices', async (request, reply) => {
    const b = request.body ?? {}
    if (typeof b.body !== 'string' || b.body.trim().length === 0) {
      return reply.code(400).send({ error: 'body is required' })
    }
    const row = await prisma.brandVoice.create({
      data: {
        brand: b.brand?.trim() || null,
        marketplace: b.marketplace?.trim().toUpperCase() || null,
        language: b.language?.trim().toLowerCase() || null,
        body: b.body.trim(),
        notes: b.notes?.trim() || null,
        isActive: typeof b.isActive === 'boolean' ? b.isActive : true,
        createdBy: 'default-user',
      },
    })
    return {
      row: {
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    }
  })

  fastify.patch<{
    Params: { id: string }
    Body: {
      brand?: string | null
      marketplace?: string | null
      language?: string | null
      body?: string
      notes?: string | null
      isActive?: boolean
    }
  }>('/ai/brand-voices/:id', async (request, reply) => {
    const b = request.body ?? {}
    const data: Record<string, unknown> = {}
    if (b.brand !== undefined) data.brand = b.brand?.trim() || null
    if (b.marketplace !== undefined)
      data.marketplace = b.marketplace?.trim().toUpperCase() || null
    if (b.language !== undefined)
      data.language = b.language?.trim().toLowerCase() || null
    if (b.body !== undefined) {
      if (typeof b.body !== 'string' || b.body.trim().length === 0) {
        return reply.code(400).send({ error: 'body cannot be blank' })
      }
      data.body = b.body.trim()
    }
    if (b.notes !== undefined) data.notes = b.notes?.trim() || null
    if (b.isActive !== undefined) data.isActive = !!b.isActive
    try {
      const row = await prisma.brandVoice.update({
        where: { id: request.params.id },
        data,
      })
      return {
        row: {
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      }
    } catch (err) {
      return reply.code(404).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  fastify.delete<{ Params: { id: string } }>(
    '/ai/brand-voices/:id',
    async (request, reply) => {
      try {
        await prisma.brandVoice.delete({ where: { id: request.params.id } })
        return { ok: true }
      } catch (err) {
        return reply.code(404).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  fastify.get('/ai/providers', async () => {
    // AI-1.2: response shape is { killSwitch, providers: [...] } so the
    // UI can render a banner when NEXUS_AI_KILL_SWITCH is on instead of
    // reaching every consumer that calls /ai/providers. Existing
    // consumers (Step4Attributes provider picker) only read
    // `j.providers` as an array so the change is backward-compatible.
    return listProviders()
  })

  fastify.get<{ Querystring: { days?: string } }>(
    '/ai/usage/summary',
    async (request, reply) => {
      const daysRaw = parseInt(request.query?.days ?? '7', 10) || 7
      const days = Math.min(Math.max(daysRaw, 1), MAX_DAYS)
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

      const [byProviderRows, byFeatureRows] = await Promise.all([
        prisma.aiUsageLog.groupBy({
          by: ['provider'],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
          _sum: { inputTokens: true, outputTokens: true, costUSD: true },
        }),
        prisma.aiUsageLog.groupBy({
          by: ['feature'],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
          _sum: { inputTokens: true, outputTokens: true, costUSD: true },
        }),
      ])

      const byProvider = byProviderRows.map((r) => ({
        name: r.provider,
        calls: r._count._all,
        inputTokens: r._sum.inputTokens ?? 0,
        outputTokens: r._sum.outputTokens ?? 0,
        costUSD: Number(r._sum.costUSD ?? 0),
      }))
      const byFeature = byFeatureRows.map((r) => ({
        name: r.feature ?? '(unknown)',
        calls: r._count._all,
        inputTokens: r._sum.inputTokens ?? 0,
        outputTokens: r._sum.outputTokens ?? 0,
        costUSD: Number(r._sum.costUSD ?? 0),
      }))
      const totals = byProvider.reduce(
        (acc, p) => {
          acc.calls += p.calls
          acc.inputTokens += p.inputTokens
          acc.outputTokens += p.outputTokens
          acc.costUSD += p.costUSD
          return acc
        },
        { calls: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 },
      )

      reply.header('Cache-Control', 'private, max-age=30')
      return {
        range: { days, since: since.toISOString() },
        byProvider,
        byFeature,
        totals,
      }
    },
  )

  // AI-1.7 — budget posture for the settings dashboard.
  //
  // Snapshot of every cost-safety lever in one round-trip:
  //   - kill switch on/off (NEXUS_AI_KILL_SWITCH)
  //   - configured limits across all four horizons
  //   - current spend in the rolling 24h + 30d windows
  //   - hitWarn signal for whichever horizon is in [90%, 100%) so the
  //     UI can render an amber banner without a second call
  //
  // Per-wizard horizon is NOT surfaced here — it's per-entity, so it
  // belongs in /usage/top-wizards (lands with AI-1.8 ROI). The card on
  // the settings page is global posture only.
  fastify.get('/ai/usage/budget-posture', async (_request, reply) => {
    const limits = readBudgetLimits()
    const now = new Date()
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    const [dayRow, monthRow] = await Promise.all([
      prisma.aiUsageLog.aggregate({
        where: { createdAt: { gte: dayAgo } },
        _sum: { costUSD: true },
        _count: { _all: true },
      }),
      prisma.aiUsageLog.aggregate({
        where: { createdAt: { gte: monthAgo } },
        _sum: { costUSD: true },
        _count: { _all: true },
      }),
    ])

    const perDay = Number(dayRow._sum.costUSD ?? 0)
    const perMonth = Number(monthRow._sum.costUSD ?? 0)

    // Mirror AiBudgetService.checkBudget()'s warn ordering — per-day
    // wins over per-month so the banner names the horizon that's
    // closer to running out. Per-wizard is omitted (global posture
    // only).
    const WARN_RATIO = 0.9
    let hitWarn: 'per_day' | 'per_month' | null = null
    if (limits.perDayUSD > 0 && perDay >= limits.perDayUSD * WARN_RATIO) {
      hitWarn = 'per_day'
    } else if (
      limits.perMonthUSD > 0 &&
      perMonth >= limits.perMonthUSD * WARN_RATIO
    ) {
      hitWarn = 'per_month'
    }

    reply.header('Cache-Control', 'private, max-age=15')
    return {
      killSwitch: isAiKillSwitchOn(),
      limits,
      current: {
        perDay,
        perDayCalls: dayRow._count._all,
        perMonth,
        perMonthCalls: monthRow._count._all,
      },
      hitWarn,
      asOf: now.toISOString(),
    }
  })

  // AI-1.8 — per-wizard ROI rollup. Caller picks the window (days,
  // capped to MAX_DAYS) and how many wizards to return (limit, capped
  // to 100). Response carries enough context to surface a Salesforce-
  // tier "this wizard cost $X in AI, saved Y minutes of manual work,
  // ROI Z×" card on the settings page without a second round-trip.
  //
  // Time saved is computed from two env-tunable knobs:
  //   NEXUS_OPERATOR_HOURLY_USD       — default $50/hr
  //   NEXUS_PUBLISH_MINUTES_PER_CHANNEL — default 30 minutes
  //
  // Both default to neutral values; raise the hourly to your actual
  // loaded operator cost + minutes to the actual time per channel
  // (Amazon Seller Central direct vs Nexus wizard) for accurate ROI.
  // Only SUBMITTED / LIVE wizards count toward time-saved (a DRAFT
  // wizard hasn't published anything, so AI spend on it is not yet
  // ROI-positive).
  fastify.get<{
    Querystring: { days?: string; limit?: string }
  }>('/ai/usage/top-wizards', async (request, reply) => {
    const daysRaw = parseInt(request.query?.days ?? '30', 10) || 30
    const days = Math.min(Math.max(daysRaw, 1), MAX_DAYS)
    const limitRaw = parseInt(request.query?.limit ?? '20', 10) || 20
    const limit = Math.min(Math.max(limitRaw, 1), 100)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const hourlyUSD = (() => {
      const raw = process.env.NEXUS_OPERATOR_HOURLY_USD
      if (raw == null || raw.trim() === '') return 50
      const n = Number(raw)
      return Number.isFinite(n) && n >= 0 ? n : 50
    })()
    const minutesPerChannel = (() => {
      const raw = process.env.NEXUS_PUBLISH_MINUTES_PER_CHANNEL
      if (raw == null || raw.trim() === '') return 30
      const n = Number(raw)
      return Number.isFinite(n) && n >= 0 ? n : 30
    })()

    // 1. Group AiUsageLog by entityId where entityType='ListingWizard'.
    const grouped = await prisma.aiUsageLog.groupBy({
      by: ['entityId'],
      where: {
        entityType: 'ListingWizard',
        createdAt: { gte: since },
        entityId: { not: null },
      },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, costUSD: true },
      orderBy: { _sum: { costUSD: 'desc' } },
      take: limit,
    })

    if (grouped.length === 0) {
      reply.header('Cache-Control', 'private, max-age=30')
      return {
        range: { days, since: since.toISOString() },
        rates: { hourlyUSD, minutesPerChannel },
        rows: [],
        totals: {
          aiCostUSD: 0,
          minutesSaved: 0,
          timeSavedUSD: 0,
        },
      }
    }

    // 2. Join with ListingWizard rows for status + channels count +
    //    product context. Channels is JSONB; we read it as JsonValue
    //    and array-length client-side rather than try to teach Prisma
    //    to count JSONB array elements.
    const wizardIds = grouped
      .map((g) => g.entityId)
      .filter((id): id is string => typeof id === 'string')
    const wizards = await prisma.listingWizard.findMany({
      where: { id: { in: wizardIds } },
      select: {
        id: true,
        productId: true,
        channels: true,
        status: true,
        currentStep: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
        product: { select: { sku: true, name: true } },
      },
    })
    const wizardById = new Map(wizards.map((w) => [w.id, w]))

    // 3. Compose rows in the groupBy order (already cost-desc).
    const rows = grouped.map((g) => {
      const w = g.entityId ? wizardById.get(g.entityId) : null
      const channels = Array.isArray(w?.channels)
        ? (w!.channels as unknown[]).length
        : 0
      const status = w?.status ?? 'UNKNOWN'
      const isPublished = status === 'SUBMITTED' || status === 'LIVE'
      const minutesSaved = isPublished ? channels * minutesPerChannel : 0
      const timeSavedUSD = (minutesSaved / 60) * hourlyUSD
      const aiCostUSD = Number(g._sum.costUSD ?? 0)
      const roi =
        aiCostUSD > 0 && timeSavedUSD > 0
          ? timeSavedUSD / aiCostUSD
          : null
      return {
        wizardId: g.entityId,
        productId: w?.productId ?? null,
        productSku: w?.product?.sku ?? null,
        productName: w?.product?.name ?? null,
        channels,
        status,
        currentStep: w?.currentStep ?? null,
        createdAt: w?.createdAt?.toISOString() ?? null,
        updatedAt: w?.updatedAt?.toISOString() ?? null,
        completedAt: w?.completedAt?.toISOString() ?? null,
        aiCalls: g._count._all,
        inputTokens: g._sum.inputTokens ?? 0,
        outputTokens: g._sum.outputTokens ?? 0,
        aiCostUSD,
        minutesSaved,
        timeSavedUSD,
        roi,
      }
    })

    const totals = rows.reduce(
      (acc, r) => {
        acc.aiCostUSD += r.aiCostUSD
        acc.minutesSaved += r.minutesSaved
        acc.timeSavedUSD += r.timeSavedUSD
        return acc
      },
      { aiCostUSD: 0, minutesSaved: 0, timeSavedUSD: 0 },
    )

    reply.header('Cache-Control', 'private, max-age=30')
    return {
      range: { days, since: since.toISOString() },
      rates: { hourlyUSD, minutesPerChannel },
      rows,
      totals,
    }
  })

  fastify.get<{ Querystring: { limit?: string } }>(
    '/ai/usage/recent',
    async (request) => {
      const limit = Math.min(
        Math.max(parseInt(request.query?.limit ?? '50', 10) || 50, 1),
        500,
      )
      const rows = await prisma.aiUsageLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          provider: true,
          model: true,
          feature: true,
          entityType: true,
          entityId: true,
          inputTokens: true,
          outputTokens: true,
          costUSD: true,
          latencyMs: true,
          ok: true,
          errorMessage: true,
          createdAt: true,
        },
      })
      return {
        rows: rows.map((r) => ({
          ...r,
          costUSD: Number(r.costUSD),
        })),
      }
    },
  )
}

export default aiUsageRoutes
