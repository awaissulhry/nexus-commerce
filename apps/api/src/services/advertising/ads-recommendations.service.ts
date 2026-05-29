/**
 * AX2.7 — Unified AI + rules recommendations feed.
 *
 * The ease-of-use centrepiece: one ranked list of "do this next" actions,
 * each with a one-click apply, aggregated from the rule engines we already
 * have — bid optimizer (target-ACOS), harvesting (negatives + graduations),
 * budget pacing, and Share-of-Voice intel. An optional Anthropic brief
 * narrates the feed in plain language (degrades silently when no API key).
 *
 * Rules produce the candidates (deterministic, auditable); AI summarises and
 * prioritises. Apply routes back through the existing audited apply paths —
 * nothing here writes to Amazon directly.
 */

import { previewBidOptimization, applyBidOptimization } from './ads-bid-optimizer.service.js'
import { previewHarvest, applyHarvest, type HarvestCandidate } from './ads-harvest.service.js'
import { previewPacing, applyPacing } from './ads-budget-pacing.service.js'
import { analyzeShareOfVoice } from './ads-impression-share.service.js'
import { analyzeRetailReadiness, applyRetailGuard } from './ads-retail-readiness.service.js'

export type RecCategory = 'bid' | 'negative' | 'graduate' | 'budget' | 'sov' | 'retail'
export type RecSeverity = 'high' | 'medium' | 'low'
export interface Recommendation {
  id: string
  category: RecCategory
  severity: RecSeverity
  title: string
  detail: string
  estImpactCents: number // ranking weight (potential saved/earned)
  apply: { kind: string; payload: unknown } | null
}
export interface RecommendationsResult {
  generatedAt: string
  windowDays: number
  counts: Record<RecCategory, number>
  potentialMonthlyImpactCents: number
  recommendations: Recommendation[]
}

export async function buildRecommendations(opts: { windowDays?: number; targetAcos?: number } = {}): Promise<RecommendationsResult> {
  const windowDays = opts.windowDays ?? 30
  const [bid, harvest, pacing, sov, retail] = await Promise.all([
    previewBidOptimization({ targetAcos: opts.targetAcos }),
    previewHarvest({ windowDays }),
    previewPacing(),
    analyzeShareOfVoice({ windowDays, limit: 500 }),
    analyzeRetailReadiness({}),
  ])

  const recs: Recommendation[] = []

  for (const p of bid.proposals.slice(0, 100)) {
    const cut = p.deltaCents < 0
    recs.push({
      id: `bid:${p.targetId}`,
      category: 'bid',
      severity: p.salesCents === 0 ? 'high' : cut ? 'medium' : 'low',
      title: `${cut ? 'Lower' : 'Raise'} bid on “${p.expression}” (${p.matchType})`,
      detail: `${p.reason}. €${(p.currentBidCents / 100).toFixed(2)} → €${(p.proposedBidCents / 100).toFixed(2)}.`,
      estImpactCents: cut ? Math.abs(p.spendCents) : Math.round(p.salesCents * 0.1),
      apply: { kind: 'bid', payload: { changes: [{ targetId: p.targetId, proposedBidCents: p.proposedBidCents }] } },
    })
  }

  for (const n of harvest.negatives.slice(0, 100)) {
    recs.push({
      id: `neg:${n.externalAdGroupId}:${n.query}`,
      category: 'negative',
      severity: n.costCents >= 3000 ? 'high' : 'medium',
      title: `Negate wasteful search term “${n.query}”`,
      detail: `${n.clicks} clicks, ${n.orders} orders, €${(n.costCents / 100).toFixed(2)} spent with no return.`,
      estImpactCents: n.costCents,
      apply: { kind: 'harvest-negative', payload: { negatives: [n] } },
    })
  }
  for (const g of harvest.graduations.slice(0, 100)) {
    recs.push({
      id: `grad:${g.externalAdGroupId}:${g.query}`,
      category: 'graduate',
      severity: 'medium',
      title: `Graduate converting term “${g.query}” to exact`,
      detail: `${g.orders} orders, €${(g.salesCents / 100).toFixed(2)} sales — promote to a managed exact-match keyword.`,
      estImpactCents: g.salesCents,
      apply: { kind: 'harvest-graduate', payload: { graduations: [g] } },
    })
  }

  for (const p of pacing.proposals.slice(0, 100)) {
    const up = p.proposedBudgetCents > p.currentBudgetCents
    recs.push({
      id: `budget:${p.campaignId}`,
      category: 'budget',
      severity: p.outOfBudget && up ? 'high' : 'medium',
      title: `${up ? 'Raise' : 'Cut'} budget for ${p.name}`,
      detail: `${p.reason}. €${(p.currentBudgetCents / 100).toFixed(2)} → €${(p.proposedBudgetCents / 100).toFixed(2)}/day.`,
      estImpactCents: Math.abs(p.proposedBudgetCents - p.currentBudgetCents) * 30,
      apply: { kind: 'budget', payload: { changes: [{ campaignId: p.campaignId, proposedBudgetCents: p.proposedBudgetCents }] } },
    })
  }

  // SOV intel — informational (the actionable parts already surface as bid recs).
  for (const r of sov.rows.filter((x) => x.flag === 'outbid').slice(0, 25)) {
    recs.push({
      id: `sov:outbid:${r.query}`,
      category: 'sov',
      severity: 'low',
      title: `Likely outbid on “${r.query}”`,
      detail: `High CPC (€${((r.cpcCents ?? 0) / 100).toFixed(2)}) but low impressions — raise the bid or add the term where it isn't yet targeted.`,
      estImpactCents: r.costCents,
      apply: null,
    })
  }
  for (const r of sov.rows.filter((x) => x.cannibalized).slice(0, 25)) {
    recs.push({
      id: `sov:cannib:${r.query}`,
      category: 'sov',
      severity: 'low',
      title: `${r.campaignCount} campaigns competing on “${r.query}”`,
      detail: `Consolidate or negate overlapping campaigns to stop bidding against yourself.`,
      estImpactCents: Math.round(r.costCents * 0.2),
      apply: null,
    })
  }

  // Retail readiness — campaigns advertising only unsellable products (the
  // "Inventory Shortage Optimization" strategy). High severity: pure waste.
  for (const c of retail.campaigns.filter((x) => x.verdict === 'pause').slice(0, 50)) {
    recs.push({
      id: `retail:${c.campaignId}`,
      category: 'retail',
      severity: 'high',
      title: `Pause ${c.name} — unsellable`,
      detail: c.reason,
      estImpactCents: 0,
      apply: { kind: 'retail-pause', payload: { campaignIds: [c.campaignId] } },
    })
  }

  recs.sort((a, b) => {
    const sev = { high: 0, medium: 1, low: 2 }
    if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity]
    return b.estImpactCents - a.estImpactCents
  })

  const counts: Record<RecCategory, number> = { bid: 0, negative: 0, graduate: 0, budget: 0, sov: 0, retail: 0 }
  for (const r of recs) counts[r.category]++
  const potentialMonthlyImpactCents = recs.reduce((s, r) => s + (r.category === 'sov' ? 0 : r.estImpactCents), 0)

  return { generatedAt: new Date().toISOString(), windowDays, counts, potentialMonthlyImpactCents, recommendations: recs }
}

export async function applyRecommendation(args: { kind: string; payload: Record<string, unknown>; userId?: string }): Promise<{ ok: boolean; result: unknown }> {
  switch (args.kind) {
    case 'bid':
      return { ok: true, result: await applyBidOptimization({ changes: args.payload.changes as Array<{ targetId: string; proposedBidCents: number }>, actor: args.userId, dryRun: false }) }
    case 'budget':
      return { ok: true, result: await applyPacing({ changes: args.payload.changes as Array<{ campaignId: string; proposedBudgetCents: number }>, actor: args.userId }) }
    case 'harvest-negative':
      return { ok: true, result: await applyHarvest({ negatives: args.payload.negatives as HarvestCandidate[], userId: args.userId }) }
    case 'harvest-graduate':
      return { ok: true, result: await applyHarvest({ graduations: args.payload.graduations as Array<HarvestCandidate & { bidEur?: number }>, userId: args.userId }) }
    case 'retail-pause':
      return { ok: true, result: await applyRetailGuard({ campaignIds: args.payload.campaignIds as string[], actor: args.userId }) }
    default:
      throw new Error(`unknown recommendation kind: ${args.kind}`)
  }
}

/** Optional Anthropic narrative over the feed. Degrades to a deterministic
 *  summary when ANTHROPIC_API_KEY is absent. */
export async function generateAdsBrief(result: RecommendationsResult, language: 'en' | 'it' = 'en'): Promise<{ tldr: string; modelUsed: string }> {
  const top = result.recommendations.slice(0, 15).map((r) => `- [${r.severity}/${r.category}] ${r.title} — ${r.detail}`).join('\n')
  const deterministic = `${result.recommendations.length} recommendations across ${Object.entries(result.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}. Potential ~€${(result.potentialMonthlyImpactCents / 100).toFixed(0)}/mo at stake. Start with the high-severity items.`
  try {
    const { AnthropicProvider } = await import('../ai/providers/anthropic.provider.js')
    const provider = new AnthropicProvider()
    if (!provider.isConfigured()) return { tldr: deterministic, modelUsed: 'rules-only' }
    const prompt = `You are an Amazon Ads strategist. Given these rule-derived recommendations, write a concise 3-4 sentence action brief (${language === 'it' ? 'in Italian' : 'in English'}) telling the operator what to prioritise and why. Be specific and confident. Recommendations:\n${top}`
    const r = await provider.generate({ prompt, maxOutputTokens: 400, temperature: 0.4 })
    return { tldr: (r.text || '').trim() || deterministic, modelUsed: 'anthropic' }
  } catch {
    return { tldr: deterministic, modelUsed: 'rules-only' }
  }
}
