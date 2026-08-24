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
import { mutedKeys } from './ads-suggestions.service.js'

export type RecCategory = 'bid' | 'negative' | 'graduate' | 'budget' | 'sov' | 'retail'
export type RecSeverity = 'high' | 'medium' | 'low'
export interface RecMetrics {
  impressions?: number; clicks?: number; ctr?: number | null
  spendCents?: number; salesCents?: number; orders?: number
  acos?: number | null; roas?: number | null; cvr?: number | null
}
/**
 * 🔴 SGX (2026-08-24) — what `estImpactCents` MEANS, per recommendation.
 *
 * The feed ranks on one number and the page renders it in one column labelled "Impact €/mo —
 * estimated monthly € impact if applied". But the builders below put five different things in
 * it, and one of them is not an impact at all: a `graduate` rec's figure is the sales the term
 * has ALREADY earned in its auto campaign, so €665.53 on screen read as "+€665.53/month" when
 * graduating only moves existing revenue into a managed target.
 *
 * The family tabs solved this exact problem years earlier — `StakeCell` marks pure waste with ♦
 * and its tooltip says a redirect is "a trade, not a saving". This is that distinction, made
 * available to the Recommendations tab so its one column can say which kind of number it is
 * holding instead of flattening all five into a promise.
 *
 *   recoverable  spend that bought nothing — cutting it costs no revenue
 *   redirect     spend that WOULD move; it is currently earning, so moving it trades
 *   atStake      revenue already flowing that the change takes over rather than adds
 *   budgetShift  a daily budget delta, annualised to a month
 *   estimate     a modelled guess, not a measurement
 */
export type RecImpactKind = 'recoverable' | 'redirect' | 'atStake' | 'budgetShift' | 'estimate'

export interface Recommendation {
  id: string
  category: RecCategory
  severity: RecSeverity
  title: string
  detail: string
  estImpactCents: number // ranking weight (potential saved/earned)
  /** SGX — how `estImpactCents` should be READ. Absent on rows that carry no figure. */
  impactKind?: RecImpactKind
  apply: { kind: string; payload: unknown } | null
  metrics?: RecMetrics // supporting data that justifies the recommendation
}

/**
 * 🔴 SGX — derive every ratio the primitives support, in ONE place.
 *
 * Each builder below hand-rolled its own metrics object and they disagreed about which ratios to
 * bother with: `negative` computed `ctr`, `graduate` did not — so the CTR column read "—" on all
 * ten graduate rows while Impressions (131,620) and Clicks (257) sat right beside it on the same
 * row. That is a column claiming "not reported" about a number two cells away.
 *
 * Only ever COMPUTES what is missing, and reproduces the same honest null when the denominator is
 * zero — an absent ratio and an unmeasurable one both render "—", but they must reach the page
 * for the same reason.
 */
function withDerived(m: RecMetrics): RecMetrics {
  const o: RecMetrics = { ...m }
  if (o.ctr == null && o.impressions != null && o.clicks != null) o.ctr = o.impressions > 0 ? o.clicks / o.impressions : null
  if (o.cvr == null && o.clicks != null && o.orders != null) o.cvr = o.clicks > 0 ? o.orders / o.clicks : null
  if (o.acos == null && o.spendCents != null && o.salesCents != null) o.acos = o.salesCents > 0 ? o.spendCents / o.salesCents : null
  if (o.roas == null && o.spendCents != null && o.salesCents != null) o.roas = o.spendCents > 0 ? o.salesCents / o.spendCents : null
  return o
}
export interface RecommendationsResult {
  generatedAt: string
  windowDays: number
  counts: Record<RecCategory, number>
  potentialMonthlyImpactCents: number
  recommendations: Recommendation[]
  /** SG.9 — how many recommendations the operator has muted (the Muted view's pill) */
  mutedCount?: number
}

/** SGX — `withDerived` is pure and load-bearing for what every metric column shows; exported
 *  under a test-only name so the suite can pin it without widening the service's real surface. */
export const __test_withDerived = withDerived

export async function buildRecommendations(opts: { windowDays?: number; targetAcos?: number; includeMuted?: boolean } = {}): Promise<RecommendationsResult> {
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
      // a cut on a target with NO sales is pure recovery; a cut on one that sells is a trade;
      // a raise is a model's guess at what more spend would buy, and says so.
      impactKind: cut ? (p.salesCents === 0 ? 'recoverable' : 'redirect') : 'estimate',
      metrics: withDerived({ clicks: p.clicks, spendCents: p.spendCents, salesCents: p.salesCents, acos: p.acos }),
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
      // spend on a term the harvester judged wasteful — the one genuinely recoverable case
      impactKind: n.salesCents > 0 ? 'redirect' : 'recoverable',
      metrics: withDerived({ impressions: n.impressions, clicks: n.clicks, spendCents: n.costCents, salesCents: n.salesCents, orders: n.orders }),
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
      // 🔴 NOT an incremental gain: this revenue already exists in the auto campaign. Graduating
      // takes it over with a managed keyword — it does not add it.
      impactKind: 'atStake',
      metrics: withDerived({ impressions: g.impressions, clicks: g.clicks, spendCents: g.costCents, salesCents: g.salesCents, orders: g.orders }),
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
      impactKind: 'budgetShift',
      metrics: withDerived({ spendCents: p.spendCents, salesCents: p.salesCents, roas: p.roas }),
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
      impactKind: 'redirect',
      metrics: withDerived({ impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, spendCents: r.costCents, orders: r.orders, cvr: r.cvr }),
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
      impactKind: 'estimate',
      metrics: withDerived({ impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, spendCents: r.costCents, orders: r.orders }),
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

  /**
   * SG.9 — recommendations the operator muted ("stop suggesting this"). This feed is COMPUTED
   * from live data every call, so there is no row to mark: the mute is keyed on the
   * recommendation's own id, which is deterministic across reloads by construction. Dropped
   * here rather than in the route so the counts and the €/mo total describe what is actually
   * on screen. `opts.includeMuted` is how the Muted view lists them back.
   */
  const muted = await mutedKeys('recommendations')
  const visible = opts.includeMuted ? recs : recs.filter((r) => !muted.has(`RECOMMENDATION|${r.id}`))

  const counts: Record<RecCategory, number> = { bid: 0, negative: 0, graduate: 0, budget: 0, sov: 0, retail: 0 }
  for (const r of visible) counts[r.category]++
  const potentialMonthlyImpactCents = visible.reduce((s, r) => s + (r.category === 'sov' ? 0 : r.estImpactCents), 0)

  return {
    generatedAt: new Date().toISOString(), windowDays, counts, potentialMonthlyImpactCents,
    recommendations: opts.includeMuted ? visible.filter((r) => muted.has(`RECOMMENDATION|${r.id}`)) : visible,
    mutedCount: muted.size,
  }
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
    const { resolveModelForFeature } = await import('../ai/model-resolver.service.js')
    const provider = new AnthropicProvider()
    if (!provider.isConfigured()) return { tldr: deterministic, modelUsed: 'rules-only' }
    const model = await resolveModelForFeature('ads-recommendations', provider)
    const prompt = `You are an Amazon Ads strategist. Given these rule-derived recommendations, write a concise 3-4 sentence action brief (${language === 'it' ? 'in Italian' : 'in English'}) telling the operator what to prioritise and why. Be specific and confident. Recommendations:\n${top}`
    const r = await provider.generate({ prompt, model, maxOutputTokens: 400, temperature: 0.4 })
    return { tldr: (r.text || '').trim() || deterministic, modelUsed: 'anthropic' }
  } catch {
    return { tldr: deterministic, modelUsed: 'rules-only' }
  }
}
