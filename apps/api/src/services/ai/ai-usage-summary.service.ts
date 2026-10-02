/**
 * MCP full control P6 — AI usage, read in one place: the Settings › AI usage card (GET /api/ai/usage/summary,
 * ai-usage.routes.ts) and Claude's `ai-usage` read call these.
 *
 * Usage only: how many AI calls each provider and feature made over a window, their tokens and their cost (AiUsageLog).
 * Providers, models chosen per feature, budgets, the kill switch and prompt templates are settings a person changes in
 * Nexus and are not read here.
 *
 * `aiUsageSummary` was moved from the route without a change in behaviour (ai-usage-summary.service.vitest.test.ts
 * holds the route's answers byte for byte). `aiUsageByModel` is new, for Claude's read.
 */

import prisma from '../../db.js'

/** The longest window the summary reads: past it the table is large enough that an unindexed scan would hurt. */
export const AI_USAGE_MAX_DAYS = 90

/**
 * Calls, tokens and cost over the last `days` days (the caller clamps them to 1…AI_USAGE_MAX_DAYS), by provider and
 * by feature (a call with no feature is '(unknown)'), and the totals across providers.
 */
export async function aiUsageSummary(days: number) {
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

  return {
    range: { days, since: since.toISOString() },
    byProvider,
    byFeature,
    totals,
  }
}

/** Calls and failed calls per (provider, model) since `since`, most calls first. */
export async function aiUsageByModel(since: Date) {
  const [all, failed] = await Promise.all([
    prisma.aiUsageLog.groupBy({
      by: ['provider', 'model'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, costUSD: true },
    }),
    prisma.aiUsageLog.groupBy({
      by: ['provider', 'model'],
      where: { createdAt: { gte: since }, ok: false },
      _count: { _all: true },
    }),
  ])
  const failedBy = new Map(failed.map((r) => [`${r.provider}|${r.model}`, r._count._all]))
  return all
    .map((r) => ({
      provider: r.provider,
      model: r.model,
      calls: r._count._all,
      failed: failedBy.get(`${r.provider}|${r.model}`) ?? 0,
      inputTokens: r._sum.inputTokens ?? 0,
      outputTokens: r._sum.outputTokens ?? 0,
      costUSD: Number(r._sum.costUSD ?? 0),
    }))
    .sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
}
