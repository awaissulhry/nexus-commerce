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

const MAX_DAYS = 90

const aiUsageRoutes: FastifyPluginAsync = async (fastify) => {
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
