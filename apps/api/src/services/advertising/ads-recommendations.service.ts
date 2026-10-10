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
 *
 * C5 (2026-10-10) — suggest for what runs, and the Owner keeps control. Scope `running` (the default) offers a line only
 * for an ENABLED campaign; a bid line only toward a target ACoS he set (auto-bid's OWNER_TARGET_SOURCES: never the 30 %
 * fallback or a profit-worked target); never on a lever a product's brain owns or he locked (the bid brain's keyword
 * bids, a product brain's negatives, harvest, budgets — readLeverHolds, as rank-defend reads them: the brain's own views
 * carry those levers); share of voice per market, over its enabled campaigns; and nothing in a market he muted
 * (AdsSuggestionMute entity MARKETPLACE). What it leaves out is counted (`leftOut`), and scope `all` (read only) lists
 * every line as before, each one the running scope leaves out saying why (`outOfScope`), so nothing is hidden from him.
 */

import { previewBidOptimization, applyBidOptimization } from './ads-bid-optimizer.service.js'
import { previewHarvest, applyHarvest, type HarvestCandidate, type HarvestCriteriaUsed } from './ads-harvest.service.js'
import { previewPacing, applyPacing } from './ads-budget-pacing.service.js'
import { analyzeShareOfVoice } from './ads-impression-share.service.js'
import { analyzeRetailReadiness, applyRetailGuard } from './ads-retail-readiness.service.js'
import { recommendationMuteKeys } from './ads-recommendation-mutes.service.js'
import prisma from '../../db.js'
import type { TargetAcosSource } from './ads-target-acos-resolver.js'
import type { BrainLever } from './brain/levers.js'

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
  /** C5 — scope `all` only: why the running scope leaves this line out (absent: it is in the running scope). */
  outOfScope?: string
}

/**
 * C5 — which lines the feed offers: `running` (the default) only what runs and is his to decide; `all` every line, read
 * only (each line the running scope leaves out says why).
 */
export const REC_SCOPES = ['running', 'all'] as const
export type RecScope = (typeof REC_SCOPES)[number]
/** C5 — why the running scope leaves a line out. */
export type LeftOutReason = 'notEnabled' | 'marketMuted' | 'noTargetSetByYou' | 'leverHeld'

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
  /**
   * W1-7 — which numbers chose the search terms to negate and graduate: the ads strategy's groups where set (each row
   * names it), `windowDays` and the harvest defaults elsewhere; and the protected products' ASINs left out.
   */
  searchTerms?: { criteria: HarvestCriteriaUsed; protectedAsins: number }
  /** C5 — the lines offered: `running` or `all`. */
  scope?: RecScope
  /** C5 — scope `running`: the lines it left out (not muted), by why; scope `all` lists them. */
  leftOut?: { total: number; byReason: Partial<Record<LeftOutReason, number>> }
  /** C5 — the markets whose lines the Owner muted (mute-ad-recommendations with markets). */
  mutedMarkets?: string[]
}

/** C5 — what one line is about, for the running scope: its campaign (null: not in Nexus), its market, the lever it moves. */
interface LineFacts { campaignId: string | null; status: string | null; market: string | null; lever: BrainLever | null; target?: { source: TargetAcosSource; pct: number } }

/**
 * C5 — the share-of-voice markets, each read on its own (a query in two markets is not two campaigns competing): scope
 * `running` — each market with an enabled Sponsored Products campaign, over those campaigns (their Amazon ids); scope
 * `all` — each market with any Sponsored Products campaign, over every campaign (null).
 */
async function sovMarkets(scope: RecScope): Promise<Array<[string, string[] | null]>> {
  const rows = await prisma.campaign.findMany({
    where: { adProduct: 'SPONSORED_PRODUCTS', marketplace: { not: null }, externalCampaignId: { not: null }, ...(scope === 'running' ? { status: 'ENABLED' } : {}) },
    select: { marketplace: true, externalCampaignId: true },
  })
  const out = new Map<string, string[]>()
  for (const r of rows) out.set(r.marketplace!, [...(out.get(r.marketplace!) ?? []), r.externalCampaignId!])
  return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([market, ids]) => [market, scope === 'running' ? ids : null])
}

/** W1-7 — when the ads strategy's group chose a search term: over which window, and whose numbers (else nothing). */
const chosenBy = (c: HarvestCandidate) =>
  c.strategy ? ` Over ${c.strategy.windowDays} days, by the ads strategy's thresholds (${c.strategy.label}, version ${c.strategy.version}).` : ''

/** SGX — `withDerived` is pure and load-bearing for what every metric column shows; exported
 *  under a test-only name so the suite can pin it without widening the service's real surface. */
export const __test_withDerived = withDerived

/**
 * C5 — `scope` (default `running`; `all` when `includeMuted` names none, so the Muted view lists every muted line). Share
 * of voice is read per market in both: a query in two markets is not two campaigns competing.
 */
export async function buildRecommendations(opts: { windowDays?: number; targetAcos?: number; includeMuted?: boolean; scope?: RecScope } = {}): Promise<RecommendationsResult> {
  const windowDays = opts.windowDays ?? 30
  const scope: RecScope = opts.scope ?? (opts.includeMuted ? 'all' : 'running')
  // C5 — share of voice per market: over its enabled campaigns in the running scope, over every campaign in `all`.
  const markets = await sovMarkets(scope)
  const [bid, harvest, pacing, retail, sovByMarket] = await Promise.all([
    previewBidOptimization({ targetAcos: opts.targetAcos }),
    // ADS AUTONOMY W1-7 — the feed's window is a fallback for the search terms, not a threshold: the ads strategy's
    // harvest and negate groups decide wherever the Owner set them (each over its own window, named in the detail),
    // the feed's window and the harvest defaults everywhere else. A protected product's ASIN is never a negative here.
    previewHarvest({ defaults: { windowDays } }),
    previewPacing(),
    analyzeRetailReadiness({}),
    Promise.all(markets.map(async ([market, campaignIds]) => ({ market, sov: await analyzeShareOfVoice({ windowDays, limit: 500, marketplace: market, ...(campaignIds ? { campaignIds } : {}) }) }))),
  ])

  const recs: Recommendation[] = []
  /** C5 — each line's facts for the running scope, and the id an older mute knew it by (share of voice before C5). */
  const facts = new Map<Recommendation, LineFacts>()
  const legacyId = new Map<Recommendation, string>()

  // C5 — where each bid and search-term line lives: its campaign's status and market (one read each).
  const bidProposals = bid.proposals.slice(0, 100)
  const terms = [...harvest.negatives.slice(0, 100), ...harvest.graduations.slice(0, 100)]
  const [bidTargets, termCampaigns] = await Promise.all([
    bidProposals.length
      ? prisma.adTarget.findMany({ where: { id: { in: bidProposals.map((p) => p.targetId) } }, select: { id: true, adGroup: { select: { campaign: { select: { id: true, status: true, marketplace: true } } } } } })
      : [],
    terms.length
      ? prisma.campaign.findMany({ where: { externalCampaignId: { in: [...new Set(terms.map((t) => t.externalCampaignId))] } }, select: { id: true, status: true, marketplace: true, externalCampaignId: true } })
      : [],
  ])
  type Where = { id: string; status: string; marketplace: string | null }
  const campaignOfTarget = new Map<string, Where>(bidTargets.map((t) => [t.id, t.adGroup.campaign] as [string, Where]))
  const campaignOfExternal = new Map<string, Where>(termCampaigns.map((c) => [c.externalCampaignId!, c] as [string, Where]))
  const termFacts = (t: HarvestCandidate, lever: BrainLever): LineFacts => {
    const c = campaignOfExternal.get(t.externalCampaignId)
    return { campaignId: c?.id ?? null, status: c?.status ?? null, market: c?.marketplace ?? t.market ?? null, lever }
  }

  for (const p of bidProposals) {
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
    const c = campaignOfTarget.get(p.targetId)
    facts.set(recs[recs.length - 1], { campaignId: c?.id ?? null, status: c?.status ?? null, market: c?.marketplace ?? null, lever: 'bids', target: { source: p.targetSource, pct: Math.round(p.targetAcosUsed * 100) } })
  }

  for (const n of harvest.negatives.slice(0, 100)) {
    recs.push({
      id: `neg:${n.externalAdGroupId}:${n.query}`,
      category: 'negative',
      severity: n.costCents >= 3000 ? 'high' : 'medium',
      title: `Negate wasteful search term “${n.query}”`,
      // W1-7 — a strategy's negate group may allow a few orders: then the spend did return something, and the line says so.
      detail: `${n.clicks} clicks, ${n.orders} orders, €${(n.costCents / 100).toFixed(2)} spent${n.orders === 0 ? ' with no return' : ''}.${chosenBy(n)}`,
      estImpactCents: n.costCents,
      // spend on a term the harvester judged wasteful — the one genuinely recoverable case
      impactKind: n.salesCents > 0 ? 'redirect' : 'recoverable',
      metrics: withDerived({ impressions: n.impressions, clicks: n.clicks, spendCents: n.costCents, salesCents: n.salesCents, orders: n.orders }),
      apply: { kind: 'harvest-negative', payload: { negatives: [n] } },
    })
    facts.set(recs[recs.length - 1], termFacts(n, 'negatives'))
  }
  for (const g of harvest.graduations.slice(0, 100)) {
    recs.push({
      id: `grad:${g.externalAdGroupId}:${g.query}`,
      category: 'graduate',
      severity: 'medium',
      title: `Graduate converting term “${g.query}” to exact`,
      detail: `${g.orders} orders, €${(g.salesCents / 100).toFixed(2)} sales — promote to a managed exact-match keyword.${chosenBy(g)}`,
      estImpactCents: g.salesCents,
      // 🔴 NOT an incremental gain: this revenue already exists in the auto campaign. Graduating
      // takes it over with a managed keyword — it does not add it.
      impactKind: 'atStake',
      metrics: withDerived({ impressions: g.impressions, clicks: g.clicks, spendCents: g.costCents, salesCents: g.salesCents, orders: g.orders }),
      apply: { kind: 'harvest-graduate', payload: { graduations: [g] } },
    })
    facts.set(recs[recs.length - 1], termFacts(g, 'harvest'))
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
    // previewPacing reads ENABLED campaigns only.
    facts.set(recs[recs.length - 1], { campaignId: p.campaignId, status: 'ENABLED', market: p.marketplace, lever: 'budgets' })
  }

  // SOV intel — informational (the actionable parts already surface as bid recs).
  // C5 — per market (`sov:outbid:<market>:<query>`; a mute of the query made before C5 still hides it in every market).
  for (const { market, sov } of sovByMarket) {
    for (const r of sov.rows.filter((x) => x.flag === 'outbid').slice(0, 25)) {
      recs.push({
        id: `sov:outbid:${market}:${r.query}`,
        category: 'sov',
        severity: 'low',
        title: `Likely outbid on “${r.query}” in ${market}`,
        detail: `High CPC (€${((r.cpcCents ?? 0) / 100).toFixed(2)}) but low impressions — raise the bid or add the term where it isn't yet targeted.`,
        estImpactCents: r.costCents,
        impactKind: 'redirect',
        metrics: withDerived({ impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, spendCents: r.costCents, orders: r.orders, cvr: r.cvr }),
        apply: null,
      })
      legacyId.set(recs[recs.length - 1], `sov:outbid:${r.query}`)
      facts.set(recs[recs.length - 1], { campaignId: null, status: 'ENABLED', market, lever: null })
    }
    for (const r of sov.rows.filter((x) => x.cannibalized).slice(0, 25)) {
      recs.push({
        id: `sov:cannib:${market}:${r.query}`,
        category: 'sov',
        severity: 'low',
        title: `${r.campaignCount} campaigns competing on “${r.query}” in ${market}`,
        detail: `Consolidate or negate overlapping campaigns to stop bidding against yourself.`,
        estImpactCents: Math.round(r.costCents * 0.2),
        impactKind: 'estimate',
        metrics: withDerived({ impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, spendCents: r.costCents, orders: r.orders }),
        apply: null,
      })
      legacyId.set(recs[recs.length - 1], `sov:cannib:${r.query}`)
      facts.set(recs[recs.length - 1], { campaignId: null, status: 'ENABLED', market, lever: null })
    }
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
    // analyzeRetailReadiness reads ENABLED campaigns only; a stop floor passes every lever (a forced lowering).
    facts.set(recs[recs.length - 1], { campaignId: c.campaignId, status: c.status, market: c.marketplace, lever: null })
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
   * W3-1 — a recommendation a request carried out by its id is dropped the same way (settled), until the data the
   * engines read is a day past the change (ads-recommendation-mutes.service.ts). A settle is not a mute: the Muted
   * view and its count list the mutes alone.
   */
  const { hidden, muted, mutedMarkets } = await recommendationMuteKeys()
  const key = (id: string) => `RECOMMENDATION|${id}`
  const isIn = (set: Set<string>, r: Recommendation) => set.has(key(r.id)) || (legacyId.has(r) && set.has(key(legacyId.get(r)!)))
  const unmuted = opts.includeMuted ? recs : recs.filter((r) => !isIn(hidden, r))

  // C5 — the running scope: why each line is left out (null: it stays). Scope `all` keeps every line and says why.
  const why = await scopeReasons(unmuted, facts, mutedMarkets)
  const leftOut: Partial<Record<LeftOutReason, number>> = {}
  const inScope = scope === 'running' ? unmuted.filter((r) => !why.get(r)) : unmuted
  if (scope === 'running') for (const r of unmuted) { const w = why.get(r); if (w) leftOut[w.code] = (leftOut[w.code] ?? 0) + 1 }
  const said = (r: Recommendation): Recommendation => { const w = scope === 'all' ? why.get(r) : null; return w ? { ...r, outOfScope: w.words } : r }
  const visible = inScope.map(said)

  const counts: Record<RecCategory, number> = { bid: 0, negative: 0, graduate: 0, budget: 0, sov: 0, retail: 0 }
  for (const r of visible) counts[r.category]++
  const potentialMonthlyImpactCents = visible.reduce((s, r) => s + (r.category === 'sov' ? 0 : r.estImpactCents), 0)
  const leftOutTotal = Object.values(leftOut).reduce((n, v) => n + (v ?? 0), 0)

  return {
    generatedAt: new Date().toISOString(), windowDays, counts, potentialMonthlyImpactCents,
    searchTerms: { criteria: harvest.criteria, protectedAsins: harvest.protectedAsins.length },
    recommendations: opts.includeMuted ? inScope.filter((r) => isIn(muted, r)).map(said) : visible,
    mutedCount: muted.size,
    scope,
    ...(scope === 'running' ? { leftOut: { total: leftOutTotal, byReason: leftOut } } : {}),
    ...(mutedMarkets.size ? { mutedMarkets: [...mutedMarkets].sort() } : {}),
  }
}

const TARGET_WORDS: Partial<Record<TargetAcosSource, string>> = { flat: 'the 30 % fallback', profit: 'a target worked out from profit data' }

/**
 * C5 — why the running scope leaves each line out, first that applies: its campaign does not run, he muted its market,
 * a bid line moves toward no target he set, or a product's brain owns (or he locked) the lever it moves. One read of
 * who holds the levers for every campaign in play (readLeverHolds, as rank-defend; the bid brain's keyword bids by
 * brainOwnedCampaignIds), as an automatic writer: a hold refuses it at the gate, so it is never suggested.
 */
async function scopeReasons(recs: Recommendation[], facts: Map<Recommendation, LineFacts>, mutedMarkets: Set<string>): Promise<Map<Recommendation, { code: LeftOutReason; words: string } | null>> {
  const campaignIds = [...new Set(recs.map((r) => facts.get(r)).filter((f) => f?.lever && f.campaignId && f.status === 'ENABLED').map((f) => f!.campaignId!))]
  const [{ readLeverHolds, bidBrainSkip }, { brainOwnedCampaignIds }, { OWNER_TARGET_SOURCES }] = await Promise.all([
    import('./brain/engine-skips.js'), import('./bid-brain/live.js'), import('./ads-auto-bid.service.js'),
  ])
  const [holds, bidBrain] = await Promise.all([
    readLeverHolds(campaignIds, { actor: 'automation:ads-recommendations' }, 'ads-recommendations'),
    brainOwnedCampaignIds(campaignIds),
  ])
  const out = new Map<Recommendation, { code: LeftOutReason; words: string } | null>()
  for (const r of recs) {
    const f = facts.get(r)
    if (!f) { out.set(r, null); continue }
    if (f.status !== 'ENABLED') {
      out.set(r, { code: 'notEnabled', words: f.status ? `its campaign is ${f.status.toLowerCase()}: only running campaigns get suggestions` : 'its campaign is not in Nexus: only running campaigns get suggestions' })
    } else if (f.market && mutedMarkets.has(f.market)) {
      out.set(r, { code: 'marketMuted', words: `you muted suggestions in ${f.market}` })
    } else if (f.target && !OWNER_TARGET_SOURCES.has(f.target.source)) {
      out.set(r, { code: 'noTargetSetByYou', words: `no target ACoS you set: it aimed at ${f.target.pct} % (${TARGET_WORDS[f.target.source] ?? f.target.source}); set a target to get bid suggestions here` })
    } else if (f.lever && f.campaignId && f.lever === 'bids' && bidBrain.has(f.campaignId)) {
      out.set(r, { code: 'leverHeld', words: `${bidBrainSkip(f.campaignId).reason}: its own views carry them` })
    } else {
      const held = f.lever && f.campaignId ? holds.peek(f.campaignId, f.lever) : null
      out.set(r, held ? { code: 'leverHeld', words: `${held.reason}: its own views carry it` } : null)
    }
  }
  return out
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
