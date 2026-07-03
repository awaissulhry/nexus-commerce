/**
 * E5 (eBay Ads) — the automation engine + weekly digest.
 *
 * Rules: conditions over EbayAdsDailyPerformance windows → clamped actions.
 * Modes: rule PROPOSE (queue EbayAdsProposal) | AUTOPILOT (apply via the E4
 * write service). The GLOBAL dial (MarketingAutomationState, channel EBAY)
 * overrides everything: OFF = evaluator skips; SUGGEST = proposals only
 * (AUTOPILOT rules downgrade); AUTO = rule mode decides. Halted state +
 * MarketingSpendCeiling kill switches block all applies (checked again
 * inside the write service — defense in depth).
 *
 * Hard automation guardrails (§4.2, stricter than operators):
 *  - a rate action NEVER exceeds break-even (no override path exists here)
 *  - entities with unknown economics (MISSING_COGS/PRICE) are SKIPPED
 *  - per-entity dedupe (one PENDING proposal per kind+entity) + cooldown
 *    after an APPLIED change
 * Every applied change is reversible: rollbackProposal() applies the inverse
 * through the same audited write path.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import * as writes from './ebay-ads-write.service.js'

const AUTOMATION_ACTOR = 'automation:ebay-ads'

// ── Trigger/action DSL ───────────────────────────────────────────────────────
export type Metric = 'ad_fees_cents' | 'sales_cents' | 'clicks' | 'impressions' | 'sold_qty' | 'acos_pct' | 'ctr_pct' | 'fee_pct_of_sales' | 'rate_minus_breakeven'
// ER3.2 — benchmark-relative conditions (Pacvue adopt; break_even is ours alone):
// when `benchmark` is set the comparison value is benchmark × multiplier and
// `threshold` is ignored. Absent ⇒ absolute threshold, exactly as before.
export type Benchmark = 'account_avg' | 'campaign_avg' | 'break_even'
export interface Condition {
  metric: Metric; windowDays: number; op: 'gt' | 'gte' | 'lt' | 'lte'; threshold?: number
  benchmark?: Benchmark; multiplier?: number
  excludeRecentDays?: number // ER3.2 window honesty — eBay reconciles attribution for ~72h
}
export interface RuleTrigger { scope: 'CPS_AD' | 'CPC_KEYWORD'; all: Condition[] }
export interface RuleAction {
  type: 'adjust_ad_rate' | 'set_rate_to_breakeven_factor' | 'pause_ad' | 'reactivate_ad' | 'pause_keyword' | 'bid_down_keyword' | 'alert'
  deltaPct?: number       // adjust_ad_rate: signed % change of the rate
  factor?: number         // set_rate_to_breakeven_factor: rate = BE × factor
  minRatePct?: number     // floor for downward moves (default 2)
  bidDeltaPct?: number    // bid_down_keyword
}

export interface EntityFacts { impressions: number; clicks: number; adFeesCents: number; salesCents: number; soldQty: number }
/** ER3.2 — population aggregate for account/campaign benchmarks: summed facts
 *  over the eligible entity set + how many entities that set holds. */
export interface BenchFacts { sums: EntityFacts; entities: number }

/** ER3.2 pure — [since, until) day bounds for a window that excludes the most
 *  recent `excludeRecentDays` calendar days (today counts as day 1 of the
 *  exclusion). exclude=0 reproduces the original open-ended behaviour. */
export function windowBounds(windowDays: number, excludeRecentDays = 0, now = new Date()): { since: Date; until: Date | null } {
  if (excludeRecentDays <= 0) {
    const since = new Date(now); since.setUTCDate(since.getUTCDate() - windowDays)
    return { since, until: null }
  }
  const until = new Date(now); until.setUTCHours(0, 0, 0, 0)
  until.setUTCDate(until.getUTCDate() - (excludeRecentDays - 1)) // rows are day-grain: date < until drops the last N days incl. today
  const since = new Date(until); since.setUTCDate(since.getUTCDate() - windowDays)
  return { since, until }
}

/** Pure: one metric over aggregated facts (+per-entity economics). Null = not computable. */
export function metricValue(metric: Metric, f: EntityFacts, ratePct: number | null, breakEvenPct: number | null): number | null {
  switch (metric) {
    case 'ad_fees_cents': return f.adFeesCents
    case 'sales_cents': return f.salesCents
    case 'clicks': return f.clicks
    case 'impressions': return f.impressions
    case 'sold_qty': return f.soldQty
    case 'acos_pct': return f.salesCents > 0 ? (f.adFeesCents / f.salesCents) * 100 : null
    case 'ctr_pct': return f.impressions > 0 ? (f.clicks / f.impressions) * 100 : null
    case 'fee_pct_of_sales': return f.salesCents > 0 ? (f.adFeesCents / f.salesCents) * 100 : null
    case 'rate_minus_breakeven': return ratePct != null && breakEvenPct != null ? ratePct - breakEvenPct : null
  }
}

/** ER3.2 pure — the value a benchmark condition compares against. Ratio metrics
 *  come from population sums (aggregate ratio); count metrics are per-entity
 *  means. break_even compares against the entity's own BE%. Null ⇒ fail-safe. */
export function benchmarkValue(c: Condition, breakEvenPct: number | null, bench: BenchFacts | null | undefined): number | null {
  const mult = c.multiplier ?? 1
  if (c.benchmark === 'break_even') return breakEvenPct != null ? breakEvenPct * mult : null
  if (!bench || bench.entities <= 0) return null
  if (c.metric === 'rate_minus_breakeven') return null // per-entity economics — population average is meaningless
  const ratio = c.metric === 'acos_pct' || c.metric === 'ctr_pct' || c.metric === 'fee_pct_of_sales'
  const v = ratio
    ? metricValue(c.metric, bench.sums, null, null)
    : (metricValue(c.metric, bench.sums, null, null)! / bench.entities)
  return v != null ? v * mult : null
}

export interface ConditionResult { pass: boolean | null; value: number | null; cmp: number | null }

/** ER3.2 pure — detailed evaluation: the entity's value, the comparison value
 *  (threshold or resolved benchmark) and the verdict. Null pass = fail-safe skip. */
export function evalConditionDetailed(
  c: Condition, f: EntityFacts, ratePct: number | null, breakEvenPct: number | null,
  bench?: { account?: BenchFacts | null; campaign?: BenchFacts | null },
): ConditionResult {
  const value = metricValue(c.metric, f, ratePct, breakEvenPct)
  const cmp = c.benchmark
    ? benchmarkValue(c, breakEvenPct, c.benchmark === 'campaign_avg' ? bench?.campaign : bench?.account)
    : (c.threshold ?? null)
  if (value == null || cmp == null) return { pass: null, value, cmp } // not computable → condition not satisfied (fail-safe)
  switch (c.op) {
    case 'gt': return { pass: value > cmp, value, cmp }
    case 'gte': return { pass: value >= cmp, value, cmp }
    case 'lt': return { pass: value < cmp, value, cmp }
    case 'lte': return { pass: value <= cmp, value, cmp }
  }
}

/** Pure: evaluate one condition against aggregated facts (+economics). */
export function evalCondition(
  c: Condition, f: EntityFacts, ratePct: number | null, breakEvenPct: number | null,
  bench?: { account?: BenchFacts | null; campaign?: BenchFacts | null },
): boolean | null {
  return evalConditionDetailed(c, f, ratePct, breakEvenPct, bench).pass
}

/** Pure: clamp a proposed rate for AUTOMATIONS — never above break-even,
 *  never outside eBay bounds, floored by the action's minRatePct. */
export function clampAutoRate(targetPct: number, breakEvenPct: number | null, minRatePct = 2): { rate: number | null; note: string | null } {
  if (breakEvenPct == null) return { rate: null, note: 'no break-even — automation skips (manual only)' }
  let rate = Math.min(targetPct, breakEvenPct)
  rate = Math.max(rate, minRatePct, 2)
  rate = Math.min(rate, 100)
  rate = Math.round(rate * 10) / 10
  if (rate !== targetPct) return { rate, note: `clamped from ${targetPct}% (break-even ${breakEvenPct}%)` }
  return { rate, note: null }
}

// ── Global posture ───────────────────────────────────────────────────────────
export async function getAutomationState() {
  return prisma.marketingAutomationState.upsert({
    where: { channel: 'EBAY' },
    create: { channel: 'EBAY', globalMode: 'OFF' },
    update: {},
  })
}

async function effectiveMode(ruleMode: string): Promise<'skip' | 'propose' | 'apply'> {
  const s = await getAutomationState()
  if (s.halted || s.globalMode === 'OFF') return 'skip'
  if (s.globalMode === 'SUGGEST') return 'propose'
  return ruleMode === 'AUTOPILOT' ? 'apply' : 'propose'
}

// ── Evaluation ───────────────────────────────────────────────────────────────
interface CandidateChange {
  kind: string
  entityRef: { campaignId: string; externalCampaignId: string; campaignName: string; listingId?: string; keywordId?: string; keywordText?: string; marketplace: string }
  from: unknown
  to: unknown
  reasoning: object
  apply: () => Promise<{ ok: boolean; detail: string }>
  inverse: object // stored for rollback
  forcePropose?: boolean // ER1 — campaign posture SUGGEST downgrades apply→propose
}

// ER1 — per-campaign automation policy (EbayCampaignAutomationPolicy).
// Protected or posture=OFF campaigns are excluded from evaluation entirely;
// SUGGEST forces PROPOSE; caps/floors clamp after the break-even clamp.
export interface CampaignPolicy { posture: string; protected: boolean; rateCapPct: number | null; rateFloorPct: number | null; bidCapCents: number | null; bidFloorCents: number | null }

const POLICY_ALLOWS = {
  OR: [
    { automationPolicy: null },
    { automationPolicy: { protected: false, posture: { not: 'OFF' } } },
  ],
}

async function policiesFor(campaignIds: string[]): Promise<Map<string, CampaignPolicy>> {
  if (!campaignIds.length) return new Map()
  const rows = await prisma.ebayCampaignAutomationPolicy.findMany({ where: { campaignId: { in: [...new Set(campaignIds)] } } })
  return new Map(rows.map((r) => [r.campaignId, {
    posture: r.posture, protected: r.protected,
    rateCapPct: r.rateCapPct != null ? Number(r.rateCapPct.toString()) : null,
    rateFloorPct: r.rateFloorPct != null ? Number(r.rateFloorPct.toString()) : null,
    bidCapCents: r.bidCapCents, bidFloorCents: r.bidFloorCents,
  }]))
}

async function factsFor(entityType: 'LISTING' | 'KEYWORD', ids: string[], windowDays: number, excludeRecentDays = 0): Promise<Map<string, EntityFacts>> {
  if (!ids.length) return new Map()
  const { since, until } = windowBounds(windowDays, excludeRecentDays)
  const rows = await prisma.ebayAdsDailyPerformance.groupBy({
    by: ['entityId'],
    where: { entityType, entityId: { in: ids }, date: { gte: since, ...(until ? { lt: until } : {}) } },
    _sum: { impressions: true, clicks: true, adFeesCents: true, salesCents: true, soldQty: true },
  })
  return new Map(rows.map((r) => [r.entityId, {
    impressions: r._sum.impressions ?? 0, clicks: r._sum.clicks ?? 0,
    adFeesCents: r._sum.adFeesCents ?? 0, salesCents: r._sum.salesCents ?? 0, soldQty: r._sum.soldQty ?? 0,
  }]))
}

const zeroFacts: EntityFacts = { impressions: 0, clicks: 0, adFeesCents: 0, salesCents: 0, soldQty: 0 }

async function candidatesForRule(rule: { id: string; marketplace: string | null; trigger: unknown; action: unknown; scope?: unknown }): Promise<{ evaluated: number; candidates: CandidateChange[] }> {
  const trigger = rule.trigger as RuleTrigger
  const action = rule.action as RuleAction
  // E7 — campaign-scoped rule packs: rules bound at launch carry
  // scope.campaignIds and evaluate ONLY those campaigns.
  const scopeCampaignIds = ((rule.scope as { campaignIds?: string[] } | null)?.campaignIds ?? []).filter(Boolean)
  const campaignScope = scopeCampaignIds.length ? { id: { in: scopeCampaignIds } } : {}
  const ctx = { actorUserId: AUTOMATION_ACTOR }
  const candidates: CandidateChange[] = []
  let evaluated = 0
  // ER3.2 — each condition is evaluated against ITS OWN window (v1 fetched one
  // max-window and evaluated every condition against it; harmless while the
  // starter rules used uniform windows, wrong once the editor allows mixing).
  const wkey = (c: Condition) => `${c.windowDays}:${c.excludeRecentDays ?? 0}`
  const windowSpecs = [...new Map(trigger.all.map((c) => [wkey(c), { windowDays: c.windowDays, exclude: c.excludeRecentDays ?? 0 }])).entries()]
  const maxWindowDays = Math.max(...trigger.all.map((c) => c.windowDays), 1)
  const maxKey = wkey(trigger.all.reduce((a, b) => (b.windowDays > a.windowDays ? b : a), trigger.all[0] ?? { windowDays: 1 } as Condition))
  const needsBench = trigger.all.some((c) => c.benchmark === 'account_avg' || c.benchmark === 'campaign_avg')
  const buildBench = (entityIds: Array<{ id: string; campaignId: string }>, facts: Map<string, EntityFacts>) => {
    const zero = (): EntityFacts => ({ impressions: 0, clicks: 0, adFeesCents: 0, salesCents: 0, soldQty: 0 })
    const add = (into: EntityFacts, f: EntityFacts) => { into.impressions += f.impressions; into.clicks += f.clicks; into.adFeesCents += f.adFeesCents; into.salesCents += f.salesCents; into.soldQty += f.soldQty }
    const account: BenchFacts = { sums: zero(), entities: entityIds.length }
    const campaign = new Map<string, BenchFacts>()
    for (const e of entityIds) {
      const f = facts.get(e.id) ?? zeroFacts
      add(account.sums, f)
      let cb = campaign.get(e.campaignId)
      if (!cb) { cb = { sums: zero(), entities: 0 }; campaign.set(e.campaignId, cb) }
      cb.entities++; add(cb.sums, f)
    }
    return { account, campaign }
  }

  if (trigger.scope === 'CPS_AD') {
    const ads = await prisma.ebayAd.findMany({
      where: {
        listingId: { not: null },
        status: { in: action.type === 'reactivate_ad' ? ['STALE'] : ['ACTIVE'] },
        campaign: { fundingModel: 'COST_PER_SALE', status: 'RUNNING', ...(rule.marketplace ? { marketplace: rule.marketplace } : {}), ...campaignScope, ...POLICY_ALLOWS },
      },
      include: { campaign: { select: { id: true, externalCampaignId: true, name: true, marketplace: true, bidPercentage: true } } },
    })
    const policies = await policiesFor(ads.map((a) => a.campaignId))
    const short = (m: string) => ({ EBAY_IT: 'IT', EBAY_DE: 'DE', EBAY_FR: 'FR', EBAY_ES: 'ES' } as Record<string, string>)[m] ?? 'IT'
    const listingIds = ads.map((a) => a.listingId!)
    const factsByWindow = new Map<string, Map<string, EntityFacts>>()
    for (const [k, w] of windowSpecs) factsByWindow.set(k, await factsFor('LISTING', listingIds, w.windowDays, w.exclude))
    const benchByWindow = new Map<string, { account: BenchFacts; campaign: Map<string, BenchFacts> }>()
    if (needsBench) for (const [k] of windowSpecs) benchByWindow.set(k, buildBench(ads.map((a) => ({ id: a.listingId!, campaignId: a.campaignId })), factsByWindow.get(k)!))
    const eco = new Map((await prisma.ebayListingEconomics.findMany({ where: { itemId: { in: listingIds } }, select: { itemId: true, breakEvenAdRatePct: true, dataStatus: true } }))
      .map((e) => [e.itemId, { be: e.breakEvenAdRatePct != null ? Number(e.breakEvenAdRatePct.toString()) : null, status: e.dataStatus }]))
    const liveIdx = new Map((await prisma.ebayListingIndex.findMany({ where: { itemId: { in: listingIds } }, select: { itemId: true, endedAt: true, quantity: true } })).map((l) => [l.itemId, l]))

    for (const ad of ads) {
      evaluated++
      const ratePct = ad.bidPercentage != null ? Number(ad.bidPercentage.toString()) : ad.campaign.bidPercentage != null ? Number(ad.campaign.bidPercentage.toString()) : null
      const e = eco.get(ad.listingId!)
      // manual-only: automations skip unknown economics for RATE actions
      const needsEconomics = action.type === 'adjust_ad_rate' || action.type === 'set_rate_to_breakeven_factor'
      if (needsEconomics && (e?.be == null)) continue
      const factsAt = (c: Condition) => factsByWindow.get(wkey(c))!.get(ad.listingId!) ?? zeroFacts
      const benchAt = (c: Condition) => { const b = benchByWindow.get(wkey(c)); return b ? { account: b.account, campaign: b.campaign.get(ad.campaignId) ?? null } : undefined }
      const detailed = trigger.all.map((c) => evalConditionDetailed(c, factsAt(c), ratePct, e?.be ?? null, benchAt(c)))
      if (!detailed.every((r) => r.pass === true)) continue
      const f = factsByWindow.get(maxKey)!.get(ad.listingId!) ?? zeroFacts

      const base = {
        entityRef: { campaignId: ad.campaign.id, externalCampaignId: ad.campaign.externalCampaignId, campaignName: ad.campaign.name, listingId: ad.listingId!, marketplace: ad.campaign.marketplace },
        reasoning: {
          rule: rule.id, windowDays: maxWindowDays, facts: f, ratePct, breakEven: e?.be ?? null, conditions: trigger.all,
          conditionResults: trigger.all.map((c, i) => ({ ...c, value: detailed[i].value, cmp: detailed[i].cmp, pass: detailed[i].pass })),
        },
      }
      const policy = policies.get(ad.campaignId)
      const forcePropose = policy?.posture === 'SUGGEST'
      if (action.type === 'adjust_ad_rate' || action.type === 'set_rate_to_breakeven_factor') {
        if (ratePct == null) continue
        const target = action.type === 'adjust_ad_rate' ? ratePct * (1 + (action.deltaPct ?? -10) / 100) : (e!.be!) * (action.factor ?? 0.8)
        const clamped = clampAutoRate(target, e?.be ?? null, action.minRatePct)
        if (clamped.rate == null) continue
        // ER1 — per-campaign guardrail overrides clamp AFTER break-even
        let rate = clamped.rate
        let policyNote: string | null = null
        if (policy?.rateCapPct != null && rate > policy.rateCapPct) { rate = policy.rateCapPct; policyNote = `campaign cap ${policy.rateCapPct}%` }
        if (policy?.rateFloorPct != null && rate < policy.rateFloorPct) { rate = Math.min(policy.rateFloorPct, clamped.rate); policyNote = `campaign floor ${policy.rateFloorPct}%` }
        rate = Math.round(rate * 10) / 10
        if (Math.abs(rate - ratePct) < 0.1) continue
        candidates.push({
          ...base, kind: 'adjust_ad_rate', from: `${ratePct}%`, to: `${rate}%`, forcePropose,
          reasoning: { ...base.reasoning, clampNote: policyNote ? `${clamped.note ? `${clamped.note} · ` : ''}${policyNote}` : clamped.note },
          inverse: { type: 'set_rate', listingId: ad.listingId!, ratePct },
          apply: async () => {
            const r = await writes.setAdRates(ctx, ad.campaign.id, [{ listingId: ad.listingId!, ratePct: rate }])
            return { ok: !!r.results[0]?.ok, detail: r.results[0]?.blocked ?? r.results[0]?.error ?? `rate ${ratePct}% → ${rate}% (${r.mode})` }
          },
        })
      } else if (action.type === 'pause_ad') {
        candidates.push({
          ...base, kind: 'pause_ad', from: 'ACTIVE', to: 'removed from campaign', forcePropose,
          inverse: { type: 'promote', listingId: ad.listingId!, ratePct },
          apply: async () => {
            const r = await writes.removeAds(ctx, ad.campaign.id, [ad.listingId!])
            return { ok: !!r.results[0]?.ok, detail: r.results[0]?.error ?? `ad removed (${r.mode})` }
          },
        })
      } else if (action.type === 'reactivate_ad') {
        const idx = liveIdx.get(ad.listingId!)
        if (!idx || idx.endedAt != null || (idx.quantity ?? 0) <= 0) continue
        candidates.push({
          ...base, kind: 'reactivate_ad', from: 'STALE', to: 're-promoted', forcePropose,
          inverse: { type: 'remove_ad', listingId: ad.listingId! },
          apply: async () => {
            const r = await writes.promoteListings(ctx, { campaignId: ad.campaign.id, items: [{ listingId: ad.listingId!, ratePct: ratePct ?? undefined }] })
            return { ok: !!r.results[0]?.ok, detail: r.results[0]?.blocked ?? r.results[0]?.error ?? `re-promoted (${r.mode})` }
          },
        })
      } else if (action.type === 'alert') {
        candidates.push({ ...base, kind: 'alert', from: '', to: 'operator attention', inverse: {}, apply: async () => ({ ok: true, detail: 'alert acknowledged' }) })
      }
      void short
    }
  } else if (trigger.scope === 'CPC_KEYWORD') {
    const keywords = await prisma.ebayKeyword.findMany({
      where: { status: 'ACTIVE', campaign: { fundingModel: 'COST_PER_CLICK', status: 'RUNNING', ...(rule.marketplace ? { marketplace: rule.marketplace } : {}), ...campaignScope, ...POLICY_ALLOWS } },
      include: { campaign: { select: { id: true, externalCampaignId: true, name: true, marketplace: true } } },
    })
    const kwPolicies = await policiesFor(keywords.map((k) => k.campaignId))
    const kwIds = keywords.map((k) => k.externalKeywordId)
    const factsByWindow = new Map<string, Map<string, EntityFacts>>()
    for (const [k, w] of windowSpecs) factsByWindow.set(k, await factsFor('KEYWORD', kwIds, w.windowDays, w.exclude))
    const benchByWindow = new Map<string, { account: BenchFacts; campaign: Map<string, BenchFacts> }>()
    if (needsBench) for (const [k] of windowSpecs) benchByWindow.set(k, buildBench(keywords.map((x) => ({ id: x.externalKeywordId, campaignId: x.campaignId })), factsByWindow.get(k)!))
    for (const kw of keywords) {
      evaluated++
      const factsAt = (c: Condition) => factsByWindow.get(wkey(c))!.get(kw.externalKeywordId) ?? zeroFacts
      const benchAt = (c: Condition) => { const b = benchByWindow.get(wkey(c)); return b ? { account: b.account, campaign: b.campaign.get(kw.campaignId) ?? null } : undefined }
      const detailed = trigger.all.map((c) => evalConditionDetailed(c, factsAt(c), null, null, benchAt(c)))
      if (!detailed.every((r) => r.pass === true)) continue
      const f = factsByWindow.get(maxKey)!.get(kw.externalKeywordId) ?? zeroFacts
      const kwPolicy = kwPolicies.get(kw.campaignId)
      const forcePropose = kwPolicy?.posture === 'SUGGEST'
      const base = {
        entityRef: { campaignId: kw.campaign.id, externalCampaignId: kw.campaign.externalCampaignId, campaignName: kw.campaign.name, keywordId: kw.id, keywordText: kw.text, marketplace: kw.campaign.marketplace },
        reasoning: {
          rule: rule.id, windowDays: maxWindowDays, facts: f, conditions: trigger.all,
          conditionResults: trigger.all.map((c, i) => ({ ...c, value: detailed[i].value, cmp: detailed[i].cmp, pass: detailed[i].pass })),
        },
      }
      if (action.type === 'pause_keyword') {
        candidates.push({
          ...base, kind: 'pause_keyword', from: 'ACTIVE', to: 'PAUSED', forcePropose,
          inverse: { type: 'keyword_status', keywordId: kw.id, status: 'ACTIVE' },
          apply: async () => {
            const r = await writes.updateKeywords(ctx, kw.campaign.id, [{ keywordId: kw.id, status: 'PAUSED' }])
            return { ok: !!r.results[0]?.ok, detail: r.results[0]?.error ?? `keyword paused (${r.mode})` }
          },
        })
      } else if (action.type === 'bid_down_keyword' && kw.bidCents != null) {
        // ER1 — per-campaign bid floor clamps the reduction
        const newBid = Math.max(2, kwPolicy?.bidFloorCents ?? 2, Math.round(kw.bidCents * (1 + (action.bidDeltaPct ?? -20) / 100)))
        if (newBid >= kw.bidCents) continue
        candidates.push({
          ...base, kind: 'bid_down_keyword', from: `€${(kw.bidCents / 100).toFixed(2)}`, to: `€${(newBid / 100).toFixed(2)}`, forcePropose,
          inverse: { type: 'keyword_bid', keywordId: kw.id, bidCents: kw.bidCents },
          apply: async () => {
            const r = await writes.updateKeywords(ctx, kw.campaign.id, [{ keywordId: kw.id, bidCents: newBid }])
            return { ok: !!r.results[0]?.ok, detail: r.results[0]?.error ?? `bid → €${(newBid / 100).toFixed(2)} (${r.mode})` }
          },
        })
      }
    }
  }
  return { evaluated, candidates }
}

export interface EvaluationReport { rules: number; evaluated: number; matched: number; proposed: number; applied: number; skippedGlobal: boolean; errors: string[] }

export async function evaluateEbayAdsRules(onlyRuleId?: string): Promise<EvaluationReport> {
  const report: EvaluationReport = { rules: 0, evaluated: 0, matched: 0, proposed: 0, applied: 0, skippedGlobal: false, errors: [] }
  const state = await getAutomationState()
  if (state.halted || state.globalMode === 'OFF') {
    report.skippedGlobal = true
    logger.info(`[E5][ebay-ads] evaluator skipped (mode=${state.globalMode} halted=${state.halted})`)
    return report
  }
  await checkSpendCeilings().catch((e) => report.errors.push(`ceilings: ${(e as Error).message}`))

  const rules = await prisma.ebayAdsRule.findMany({ where: { enabled: true, ...(onlyRuleId ? { id: onlyRuleId } : {}) } })
  for (const rule of rules) {
    if (rule.cooldownUntil && rule.cooldownUntil > new Date()) continue
    report.rules++
    let evaluated = 0, matched = 0, proposed = 0, applied = 0
    const summary: Array<Record<string, unknown>> = []
    try {
      const { evaluated: ev, candidates } = await candidatesForRule(rule)
      evaluated = ev
      const mode = await effectiveMode(rule.mode)
      for (const cand of candidates) {
        matched++
        const entityKey = cand.entityRef.listingId ?? cand.entityRef.keywordId ?? cand.entityRef.externalCampaignId
        const proposedKey = `${cand.kind}:${cand.entityRef.campaignId}:${entityKey}`
        const existing = await prisma.ebayAdsProposal.findUnique({ where: { proposedKey } })
        if (existing && existing.status === 'PENDING') continue // one pending per kind+entity
        if (existing && existing.status === 'APPLIED' && existing.decidedAt && existing.decidedAt > new Date(Date.now() - rule.cooldownHours * 3600_000)) continue // per-entity cooldown
        // ER3.2 — snoozed/stopped: a REJECTED row with a future expiresAt is the
        // operator's "don't re-suggest until then" (plain dismiss leaves it null
        // and the suggestion may return next run — stated in the UI).
        if (existing && existing.status === 'REJECTED' && existing.expiresAt && existing.expiresAt > new Date()) continue
        const data = {
          ruleId: rule.id,
          kind: cand.kind,
          entityRef: cand.entityRef as object,
          proposedAction: { from: cand.from, to: cand.to, inverse: cand.inverse } as object,
          reasoning: cand.reasoning,
          expiresAt: new Date(Date.now() + 14 * 86_400_000),
        }
        const candMode = cand.forcePropose ? 'propose' : mode // ER1 posture SUGGEST downgrade
        if (candMode === 'apply' && cand.kind !== 'alert') {
          const outcome = await cand.apply()
          await prisma.ebayAdsProposal.upsert({
            where: { proposedKey },
            create: { ...data, proposedKey, status: outcome.ok ? 'APPLIED' : 'REJECTED', decidedBy: AUTOMATION_ACTOR, decidedAt: new Date(), appliedResult: { detail: outcome.detail } as object },
            update: { ...data, status: outcome.ok ? 'APPLIED' : 'REJECTED', decidedBy: AUTOMATION_ACTOR, decidedAt: new Date(), appliedResult: { detail: outcome.detail } as object },
          })
          if (outcome.ok) applied++
          summary.push({ key: proposedKey, mode: 'applied', detail: outcome.detail })
        } else {
          await prisma.ebayAdsProposal.upsert({
            where: { proposedKey },
            create: { ...data, proposedKey, status: 'PENDING' },
            update: { ...data, status: 'PENDING', decidedBy: null, decidedAt: null, appliedResult: undefined },
          })
          proposed++
          summary.push({ key: proposedKey, mode: 'proposed', from: cand.from, to: cand.to })
        }
      }
      await prisma.ebayAdsRule.update({
        where: { id: rule.id },
        data: { lastEvaluatedAt: new Date(), ...(applied > 0 ? { cooldownUntil: new Date(Date.now() + rule.cooldownHours * 3600_000) } : {}) },
      })
      await prisma.ebayAdsRuleExecution.create({
        data: { ruleId: rule.id, status: 'SUCCESS', evaluated, matched, proposed, applied, summary: summary.slice(0, 50) as object },
      })
    } catch (e) {
      report.errors.push(`${rule.name}: ${(e as Error).message}`)
      await prisma.ebayAdsRuleExecution.create({ data: { ruleId: rule.id, status: 'FAILED', evaluated, matched, proposed, applied, summary: [{ error: (e as Error).message }] as object } }).catch(() => {})
    }
    report.evaluated += evaluated; report.matched += matched; report.proposed += proposed; report.applied += applied
  }
  logger.info('[E5][ebay-ads] evaluation complete', report as unknown as Record<string, unknown>)
  return report
}

// ── Proposal decisions + rollback ────────────────────────────────────────────
export async function decideProposals(actorUserId: string | null, ids: string[], decision: 'approve' | 'reject', snoozeDays?: number): Promise<Array<{ id: string; ok: boolean; detail: string }>> {
  const out: Array<{ id: string; ok: boolean; detail: string }> = []
  for (const id of ids) {
    const p = await prisma.ebayAdsProposal.findUnique({ where: { id } })
    if (!p || p.status !== 'PENDING') { out.push({ id, ok: false, detail: 'not pending' }); continue }
    if (decision === 'reject') {
      // ER3.2 — snooze rides expiresAt on the REJECTED row: the evaluator won't
      // re-raise this kind+entity until it passes. Plain reject must CLEAR it —
      // creation stamps every proposal with a +14d PENDING expiry, which would
      // otherwise read as a two-week snooze.
      const snooze = snoozeDays && snoozeDays > 0 ? new Date(Date.now() + Math.min(snoozeDays, 3650) * 86_400_000) : null
      await prisma.ebayAdsProposal.update({ where: { id }, data: { status: 'REJECTED', decidedBy: actorUserId, decidedAt: new Date(), expiresAt: snooze } })
      out.push({ id, ok: true, detail: snooze ? `snoozed until ${snooze.toISOString().slice(0, 10)}` : 'rejected' })
      continue
    }
    try {
      const detail = await applyProposalAction(actorUserId, p)
      await prisma.ebayAdsProposal.update({ where: { id }, data: { status: 'APPLIED', decidedBy: actorUserId, decidedAt: new Date(), appliedResult: { detail } as object } })
      out.push({ id, ok: true, detail })
    } catch (e) {
      out.push({ id, ok: false, detail: (e as Error).message })
    }
  }
  return out
}

async function applyProposalAction(actorUserId: string | null, p: { kind: string; entityRef: unknown; proposedAction: unknown }): Promise<string> {
  const ctx = { actorUserId: actorUserId ?? AUTOMATION_ACTOR }
  const ref = p.entityRef as { campaignId: string; listingId?: string; keywordId?: string }
  const act = p.proposedAction as { to?: unknown }
  if (p.kind === 'adjust_ad_rate' && ref.listingId) {
    const ratePct = Number(String(act.to ?? '').replace('%', ''))
    const r = await writes.setAdRates(ctx, ref.campaignId, [{ listingId: ref.listingId, ratePct }])
    if (!r.results[0]?.ok) throw new Error(r.results[0]?.blocked ?? r.results[0]?.error ?? 'failed')
    return `rate → ${ratePct}% (${r.mode})`
  }
  if (p.kind === 'pause_ad' && ref.listingId) {
    const r = await writes.removeAds(ctx, ref.campaignId, [ref.listingId])
    if (!r.results[0]?.ok) throw new Error(r.results[0]?.error ?? 'failed')
    return `ad removed (${r.mode})`
  }
  if (p.kind === 'reactivate_ad' && ref.listingId) {
    const r = await writes.promoteListings(ctx, { campaignId: ref.campaignId, items: [{ listingId: ref.listingId }] })
    if (!r.results[0]?.ok) throw new Error(r.results[0]?.blocked ?? r.results[0]?.error ?? 'failed')
    return `re-promoted (${r.mode})`
  }
  if (p.kind === 'pause_keyword' && ref.keywordId) {
    const r = await writes.updateKeywords(ctx, ref.campaignId, [{ keywordId: ref.keywordId, status: 'PAUSED' }])
    if (!r.results[0]?.ok) throw new Error(r.results[0]?.error ?? 'failed')
    return `keyword paused (${r.mode})`
  }
  if (p.kind === 'bid_down_keyword' && ref.keywordId) {
    const bidCents = Math.round(Number(String(act.to ?? '').replace(/[€\s]/g, '').replace(',', '.')) * 100)
    const r = await writes.updateKeywords(ctx, ref.campaignId, [{ keywordId: ref.keywordId, bidCents }])
    if (!r.results[0]?.ok) throw new Error(r.results[0]?.error ?? 'failed')
    return `bid → €${(bidCents / 100).toFixed(2)} (${r.mode})`
  }
  if (p.kind === 'rate_discovery_step') {
    const refd = p.entityRef as { campaignId: string }
    const target = Number((p.proposedAction as { targetPct?: number }).targetPct)
    if (!Number.isFinite(target)) throw new Error('discovery step has no target rate recorded')
    const ads = await prisma.ebayAd.findMany({ where: { campaignId: refd.campaignId, listingId: { not: null }, status: { notIn: ['STALE'] } }, select: { listingId: true } })
    if (!ads.length) throw new Error('no active ads to step')
    const camp = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: refd.campaignId }, select: { marketplace: true } })
    const short = ({ EBAY_IT: 'IT', EBAY_DE: 'DE', EBAY_FR: 'FR', EBAY_ES: 'ES' } as Record<string, string>)[camp.marketplace] ?? 'IT'
    const eco = new Map((await prisma.ebayListingEconomics.findMany({ where: { marketplace: short, itemId: { in: ads.map((a) => a.listingId!) } }, select: { itemId: true, breakEvenAdRatePct: true } }))
      .map((e) => [e.itemId, e.breakEvenAdRatePct != null ? Number(e.breakEvenAdRatePct.toString()) : null]))
    const items = ads.map((a) => {
      const be = eco.get(a.listingId!) ?? null
      return { listingId: a.listingId!, ratePct: Math.max(2, Math.round(Math.min(target, be ?? target) * 10) / 10) }
    })
    const r = await writes.setAdRates(ctx, refd.campaignId, items)
    const ok = r.results.filter((x) => x.ok).length
    await prisma.ebayRateDiscoveryPlan.update({ where: { campaignId: refd.campaignId }, data: { currentPct: target.toFixed(1), lastStepAt: new Date() } }).catch(() => {})
    return `discovery step → ${target}%: ${ok}/${items.length} ad(s) set (${r.mode}); BE-clamped where costs exist`
  }
  if (p.kind === 'enroll_catch_all') {
    const ref2 = p.entityRef as { campaignId: string; listingIds?: string[] }
    const listingIds = ref2.listingIds ?? []
    if (!ref2.campaignId || !listingIds.length) throw new Error('nothing to enroll')
    const r = await writes.promoteListings(ctx, { campaignId: ref2.campaignId, items: listingIds.map((listingId) => ({ listingId })) })
    const ok = r.results.filter((x) => x.ok).length
    return `enrolled ${ok}/${listingIds.length} listing(s) (${r.mode})${ok < listingIds.length ? ' — see campaign for per-item blocks' : ''}`
  }
  if (p.kind === 'alert') return 'acknowledged'
  throw new Error(`unsupported proposal kind ${p.kind}`)
}

export async function rollbackProposal(actorUserId: string | null, id: string): Promise<string> {
  const p = await prisma.ebayAdsProposal.findUniqueOrThrow({ where: { id } })
  if (p.status !== 'APPLIED') throw new Error('only APPLIED proposals can be rolled back')
  const ctx = { actorUserId: actorUserId ?? AUTOMATION_ACTOR }
  const ref = p.entityRef as { campaignId: string; listingId?: string; keywordId?: string }
  const inv = (p.proposedAction as { inverse?: Record<string, unknown> }).inverse ?? {}
  let detail = ''
  if (inv.type === 'set_rate' && ref.listingId) {
    const r = await writes.setAdRates(ctx, ref.campaignId, [{ listingId: ref.listingId, ratePct: Number(inv.ratePct) }], { reason: `rollback of proposal ${p.id}` })
    detail = r.results[0]?.ok ? `rate restored to ${inv.ratePct}%` : (r.results[0]?.error ?? 'failed')
    if (!r.results[0]?.ok) throw new Error(detail)
  } else if (inv.type === 'promote' && ref.listingId) {
    const r = await writes.promoteListings(ctx, { campaignId: ref.campaignId, items: [{ listingId: ref.listingId, ratePct: inv.ratePct != null ? Number(inv.ratePct) : undefined }], override: { reason: `rollback of proposal ${p.id}` } })
    detail = r.results[0]?.ok ? 're-promoted' : (r.results[0]?.blocked ?? r.results[0]?.error ?? 'failed')
    if (!r.results[0]?.ok) throw new Error(detail)
  } else if (inv.type === 'remove_ad' && ref.listingId) {
    const r = await writes.removeAds(ctx, ref.campaignId, [ref.listingId])
    detail = r.results[0]?.ok ? 'ad removed again' : (r.results[0]?.error ?? 'failed')
  } else if (inv.type === 'keyword_status' && ref.keywordId) {
    const r = await writes.updateKeywords(ctx, ref.campaignId, [{ keywordId: ref.keywordId, status: inv.status as 'ACTIVE' | 'PAUSED' }])
    detail = r.results[0]?.ok ? `keyword ${String(inv.status).toLowerCase()}` : (r.results[0]?.error ?? 'failed')
  } else if (inv.type === 'keyword_bid' && ref.keywordId) {
    const r = await writes.updateKeywords(ctx, ref.campaignId, [{ keywordId: ref.keywordId, bidCents: Number(inv.bidCents) }])
    detail = r.results[0]?.ok ? `bid restored` : (r.results[0]?.error ?? 'failed')
  } else if (inv.type === 'discovery_rates' && ref.campaignId) {
    // inverse of a discovery step: restore per-ad rates and HALT the ladder
    // (a rollback is operator intervention — discovery must not re-propose).
    const rates = (inv.rates as Record<string, number | null> | undefined) ?? {}
    const items = Object.entries(rates).filter(([, v]) => v != null).map(([listingId, ratePct]) => ({ listingId, ratePct: ratePct! }))
    if (!items.length) throw new Error('no previous rates recorded for this discovery step')
    const r = await writes.setAdRates(ctx, ref.campaignId, items, { reason: `rollback of discovery step (proposal ${p.id})` })
    const ok = r.results.filter((x) => x.ok).length
    await prisma.ebayRateDiscoveryPlan.update({ where: { campaignId: ref.campaignId }, data: { status: 'HALTED' } }).catch(() => {})
    detail = `${ok}/${items.length} rate(s) restored — discovery HALTED`
  } else if (inv.type === 'remove_ads' && ref.campaignId) {
    // inverse of enroll_catch_all — un-promote the batch that was enrolled
    const ids = ((inv.listingIds as string[] | undefined) ?? []).filter(Boolean)
    if (!ids.length) throw new Error('no listing ids recorded for this enrollment')
    const r = await writes.removeAds(ctx, ref.campaignId, ids)
    const ok = r.results.filter((x) => x.ok).length
    detail = `${ok}/${ids.length} enrollment(s) removed`
  } else {
    throw new Error('no inverse recorded for this proposal')
  }
  await prisma.ebayAdsProposal.update({ where: { id }, data: { status: 'ROLLED_BACK', appliedResult: { ...(p.appliedResult as object ?? {}), rollback: detail } as object } })
  return detail
}

// ── Spend ceilings + anomaly guard ───────────────────────────────────────────
export async function checkSpendCeilings(): Promise<Array<{ marketplace: string; mtdCents: number; capCents: number; pct: number; halted: boolean }>> {
  const ceilings = await prisma.marketingSpendCeiling.findMany({ where: { channel: 'EBAY' } })
  const out: Array<{ marketplace: string; mtdCents: number; capCents: number; pct: number; halted: boolean }> = []
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0)
  for (const c of ceilings) {
    const agg = await prisma.ebayAdsDailyPerformance.aggregate({
      where: { entityType: 'CAMPAIGN', marketplace: c.marketplace, date: { gte: monthStart } },
      _sum: { adFeesCents: true },
    })
    const mtd = agg._sum.adFeesCents ?? 0
    const pct = c.monthlyCapCents > 0 ? (mtd / c.monthlyCapCents) * 100 : 0
    let halted = false
    if (pct >= 100) {
      await prisma.marketingAutomationState.upsert({
        where: { channel: 'EBAY' },
        create: { channel: 'EBAY', globalMode: 'OFF', halted: true, haltReason: `spend ceiling breached for ${c.marketplace} (${(mtd / 100).toFixed(2)}€ ≥ ${(c.monthlyCapCents / 100).toFixed(2)}€)`, haltedBy: 'auto:spend-ceiling' },
        update: { halted: true, haltReason: `spend ceiling breached for ${c.marketplace}`, haltedBy: 'auto:spend-ceiling' },
      })
      halted = true
      logger.error(`[E5][ebay-ads] SPEND CEILING BREACHED ${c.marketplace}: €${(mtd / 100).toFixed(2)} / €${(c.monthlyCapCents / 100).toFixed(2)} — automation HALTED`)
    }
    out.push({ marketplace: c.marketplace, mtdCents: mtd, capCents: c.monthlyCapCents, pct: Math.round(pct * 10) / 10, halted })
  }
  return out
}

// ER3.3 — campaignId (internal) lets the dashboard Alerts card deep-link to
// the campaign page; entityId stays the EXTERNAL id for message context.
export interface Anomaly { type: string; severity: 'WARN' | 'CRITICAL'; message: string; entityId?: string; campaignId?: string }

export async function detectAnomalies(): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = []
  const y = new Date(); y.setUTCDate(y.getUTCDate() - 1); y.setUTCHours(0, 0, 0, 0)
  const w = new Date(y); w.setUTCDate(w.getUTCDate() - 7)
  const [yesterday, trailing] = await Promise.all([
    prisma.ebayAdsDailyPerformance.aggregate({ where: { entityType: 'CAMPAIGN', date: y }, _sum: { adFeesCents: true, clicks: true, impressions: true } }),
    prisma.ebayAdsDailyPerformance.aggregate({ where: { entityType: 'CAMPAIGN', date: { gte: w, lt: y } }, _sum: { adFeesCents: true, clicks: true, impressions: true } }),
  ])
  const yFees = yesterday._sum.adFeesCents ?? 0
  const avgFees = (trailing._sum.adFeesCents ?? 0) / 7
  if (avgFees > 50 && yFees > 3 * avgFees) {
    anomalies.push({ type: 'fee_spike', severity: 'CRITICAL', message: `yesterday's ad fees €${(yFees / 100).toFixed(2)} are ${(yFees / avgFees).toFixed(1)}× the trailing-7d average (€${(avgFees / 100).toFixed(2)}/day)` })
  }
  const yImpr = yesterday._sum.impressions ?? 0
  const yCtr = yImpr > 0 ? (yesterday._sum.clicks ?? 0) / yImpr : null
  const tImpr = trailing._sum.impressions ?? 0
  const tCtr = tImpr > 0 ? (trailing._sum.clicks ?? 0) / tImpr : null
  if (yCtr != null && tCtr != null && yImpr > 500 && yCtr < tCtr * 0.4) {
    anomalies.push({ type: 'ctr_collapse', severity: 'WARN', message: `CTR collapsed to ${(yCtr * 100).toFixed(2)}% vs trailing ${(tCtr * 100).toFixed(2)}% on ${yImpr} impressions` })
  }
  // Campaign ended outside Nexus (no end_campaign audit in the last 3 days)
  const recentlyEnded = await prisma.ebayCampaign.findMany({ where: { status: 'ENDED', endDate: { gte: new Date(Date.now() - 3 * 86_400_000) } }, select: { id: true, externalCampaignId: true, name: true } })
  for (const c of recentlyEnded) {
    const audited = await prisma.campaignAction.findFirst({ where: { channel: 'EBAY', actionType: 'end_campaign', entityId: c.externalCampaignId } })
    if (!audited) anomalies.push({ type: 'campaign_ended_externally', severity: 'WARN', message: `campaign "${c.name}" (${c.externalCampaignId}) ended outside Nexus — Seller Hub or eBay-side change (easy boost?)`, entityId: c.externalCampaignId, campaignId: c.id })
  }
  // E7 #12 Floor Watch: DYNAMIC campaigns whose applied ad rates exceed the
  // configured cap (eBay's stealth-floor precedent, Nov 2024).
  try {
    const dynamics = await prisma.ebayCampaign.findMany({ where: { adRateStrategy: 'DYNAMIC', status: 'RUNNING' }, include: { ads: { where: { status: { notIn: ['STALE'] } }, select: { listingId: true, bidPercentage: true } } } })
    for (const d of dynamics) {
      const cap = Number(((d.dynamicAdRatePrefs as Array<{ adRateCapPercent?: string }> | null)?.[0]?.adRateCapPercent) ?? NaN)
      if (!Number.isFinite(cap)) continue
      const over = d.ads.filter((a) => a.bidPercentage != null && Number(a.bidPercentage.toString()) > cap + 0.05)
      if (over.length) {
        anomalies.push({ type: 'dynamic_rate_over_cap', severity: 'CRITICAL', message: `Floor Watch: ${over.length} ad(s) in "${d.name}" carry rates above the configured cap ${cap}% — eBay-side drift`, entityId: d.externalCampaignId, campaignId: d.id })
      }
    }
  } catch (e) { logger.warn(`[E7][floor-watch] ${(e as Error).message}`) }
  // E7 #25: any Nexus-set value drifted eBay-side ("easy boost" overwrites,
  // Seller Hub edits) → one WARN pointing at the reconciliation tab.
  try {
    const drifts = await detectDrift()
    if (drifts.length) anomalies.push({ type: 'nexus_ebay_drift', severity: 'WARN', message: `${drifts.length} value(s) on eBay differ from what Nexus last set (rate / budget / removed ad) — review Automation → Drift` })
  } catch (e) { logger.warn(`[E7][drift] ${(e as Error).message}`) }
  return anomalies
}

// ── E7 #25 — post-launch reconciliation ──────────────────────────────────────
// Intent = replay of OUR audit trail (CampaignAction); current = the hourly
// entity mirror (which IS eBay state). Anything eBay changed under us —
// "easy boost" rate overwrites, Seller Hub edits, removed ads — shows as a
// drift row. Repair either re-applies the Nexus value through the guarded
// write layer or accepts eBay's value as the new baseline (audited).

export interface DriftRow {
  campaignId: string; externalCampaignId: string; campaignName: string; marketplace: string
  kind: 'ad_rate' | 'budget' | 'ad_removed'
  listingId: string | null
  /** ratePct for ad kinds; cents for budget */
  nexusValue: number
  ebayValue: number | null
  setAt: string
  sourceAction: string
}

const DRIFT_ACTIONS = ['bulk_create_ads', 'bulk_update_ad_rates', 'bulk_delete_ads', 'set_campaign_budget', 'create_campaign', 'accept_drift']

export async function detectDrift(campaignId?: string): Promise<DriftRow[]> {
  const camps = await prisma.ebayCampaign.findMany({
    where: {
      ...(campaignId ? { id: campaignId } : {}),
      status: { in: ['RUNNING', 'PAUSED'] },
      NOT: { externalCampaignId: { startsWith: 'sandbox-' } },
    },
    include: { ads: { where: { status: { notIn: ['STALE'] } }, select: { listingId: true, bidPercentage: true } } },
  })
  if (!camps.length) return []
  const actions = await prisma.campaignAction.findMany({
    where: { channel: 'EBAY', entityId: { in: camps.map((c) => c.externalCampaignId) }, actionType: { in: DRIFT_ACTIONS }, channelResponseStatus: { in: ['SUCCESS', 'PARTIAL'] } },
    orderBy: { createdAt: 'asc' },
  })
  const out: DriftRow[] = []
  for (const c of camps) {
    const rateIntent = new Map<string, { pct: number; at: Date; src: string }>()
    let budgetIntent: { cents: number; at: Date; src: string } | null = null
    for (const a of actions.filter((x) => x.entityId === c.externalCampaignId)) {
      const after = (a.payloadAfter ?? {}) as Record<string, unknown>
      const results = ((after.results as Array<{ key: string; ok: boolean }> | undefined) ?? [])
      const failed = new Set(results.filter((r) => !r.ok).map((r) => r.key))
      if ((a.actionType === 'bulk_update_ad_rates' || a.actionType === 'bulk_create_ads') && after.rates && typeof after.rates === 'object') {
        for (const [lid, v] of Object.entries(after.rates as Record<string, unknown>)) {
          const pctv = Number(v)
          if (Number.isFinite(pctv) && !failed.has(lid)) rateIntent.set(lid, { pct: pctv, at: a.createdAt, src: a.actionType })
        }
      } else if (a.actionType === 'bulk_delete_ads') {
        for (const r of results.filter((r) => r.ok)) rateIntent.delete(r.key)
      } else if ((a.actionType === 'set_campaign_budget' || a.actionType === 'create_campaign') && after.dailyBudgetCents != null) {
        budgetIntent = { cents: Number(after.dailyBudgetCents), at: a.createdAt, src: a.actionType }
      } else if (a.actionType === 'accept_drift') {
        if (after.field === 'budget' && after.value != null) budgetIntent = { cents: Number(after.value), at: a.createdAt, src: 'accept_drift' }
        else if (typeof after.listingId === 'string') {
          if (after.value == null) rateIntent.delete(after.listingId)
          else rateIntent.set(after.listingId, { pct: Number(after.value), at: a.createdAt, src: 'accept_drift' })
        }
      }
    }
    const adByListing = new Map(c.ads.filter((x) => x.listingId).map((x) => [x.listingId!, x]))
    for (const [lid, intent] of rateIntent) {
      const ad = adByListing.get(lid)
      const base = { campaignId: c.id, externalCampaignId: c.externalCampaignId, campaignName: c.name, marketplace: c.marketplace, listingId: lid, nexusValue: intent.pct, setAt: intent.at.toISOString(), sourceAction: intent.src }
      if (!ad) out.push({ ...base, kind: 'ad_removed', ebayValue: null })
      else if (ad.bidPercentage != null && Math.abs(Number(ad.bidPercentage.toString()) - intent.pct) > 0.05) out.push({ ...base, kind: 'ad_rate', ebayValue: Number(ad.bidPercentage.toString()) })
    }
    if (budgetIntent && c.dailyBudget != null) {
      const curCents = Math.round(Number(c.dailyBudget.toString()) * 100)
      if (curCents !== budgetIntent.cents) out.push({ campaignId: c.id, externalCampaignId: c.externalCampaignId, campaignName: c.name, marketplace: c.marketplace, kind: 'budget', listingId: null, nexusValue: budgetIntent.cents, ebayValue: curCents, setAt: budgetIntent.at.toISOString(), sourceAction: budgetIntent.src })
    }
  }
  return out
}

export async function repairDrift(actorUserId: string | null, req: { campaignId: string; kind: string; listingId?: string | null; action: 'reapply' | 'accept' }): Promise<string> {
  const drifts = await detectDrift(req.campaignId)
  const d = drifts.find((x) => x.kind === req.kind && (x.listingId ?? null) === (req.listingId ?? null))
  if (!d) throw new Error('drift no longer present — already reconciled or re-synced')
  const ctx = { actorUserId: actorUserId ?? AUTOMATION_ACTOR }
  if (req.action === 'reapply') {
    if (d.kind === 'ad_rate') {
      const r = await writes.setAdRates(ctx, req.campaignId, [{ listingId: d.listingId!, ratePct: d.nexusValue }], { reason: `drift repair: restore Nexus rate ${d.nexusValue}%` })
      if (!r.results[0]?.ok) throw new Error(r.results[0]?.blocked ?? r.results[0]?.error ?? 'failed')
      return `rate restored to ${d.nexusValue}% (${r.mode})`
    }
    if (d.kind === 'ad_removed') {
      const r = await writes.promoteListings(ctx, { campaignId: req.campaignId, items: [{ listingId: d.listingId!, ratePct: d.nexusValue }], override: { reason: 'drift repair: re-promote listing removed eBay-side' } })
      if (!r.results[0]?.ok) throw new Error(r.results[0]?.blocked ?? r.results[0]?.error ?? 'failed')
      return `re-promoted at ${d.nexusValue}% (${r.mode})`
    }
    const r = await writes.updateBudget(ctx, req.campaignId, d.nexusValue)
    return `budget restored to €${(d.nexusValue / 100).toFixed(2)} (${r.mode})`
  }
  const c = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: req.campaignId } })
  await prisma.campaignAction.create({
    data: {
      userId: actorUserId, channel: 'EBAY', actionType: 'accept_drift', entityType: 'CAMPAIGN', entityId: c.externalCampaignId,
      payloadBefore: { nexusValue: d.nexusValue },
      payloadAfter: { field: d.kind === 'budget' ? 'budget' : d.kind, listingId: d.listingId, value: d.ebayValue, _mode: 'accept' } as object,
      channelResponseStatus: 'SUCCESS',
    },
  })
  return 'accepted eBay value as the new baseline'
}

/**
 * E7 #21 (coverage guard): live listings not promoted in ANY active General
 * campaign → ONE aggregate PENDING proposal to enroll them into the newest
 * running catch-all (or an alert proposing to create one). Refreshed each
 * run; approving promotes all listed items through the guarded write path.
 */
export async function runCoverageGuard(): Promise<{ unpromoted: number; proposal: boolean }> {
  const live = await prisma.ebayListingIndex.findMany({ where: { endedAt: null }, select: { itemId: true, marketplace: true } })
  const promoted = new Set((await prisma.ebayAd.findMany({
    where: { listingId: { not: null }, status: { notIn: ['STALE'] }, campaign: { fundingModel: 'COST_PER_SALE', status: { in: ['RUNNING', 'PAUSED'] } } },
    select: { listingId: true },
  })).map((a) => a.listingId!))
  const unpromoted = live.filter((l) => !promoted.has(l.itemId))
  const proposedKey = 'coverage:enroll-catch-all'
  if (unpromoted.length === 0) {
    await prisma.ebayAdsProposal.deleteMany({ where: { proposedKey, status: 'PENDING' } })
    return { unpromoted: 0, proposal: false }
  }
  const catchAll = await prisma.ebayCampaign.findFirst({
    // ER1 — never propose enrolling into a Protected / posture-OFF campaign
    where: { nexusManaged: true, fundingModel: 'COST_PER_SALE', status: 'RUNNING', name: { startsWith: 'catch_all-' }, ...POLICY_ALLOWS },
    orderBy: { createdAt: 'desc' },
  })
  await prisma.ebayAdsProposal.upsert({
    where: { proposedKey },
    create: {
      kind: catchAll ? 'enroll_catch_all' : 'alert',
      entityRef: (catchAll
        ? { campaignId: catchAll.id, externalCampaignId: catchAll.externalCampaignId, campaignName: catchAll.name, listingIds: unpromoted.map((u) => u.itemId), marketplace: catchAll.marketplace }
        : { campaignName: '— no catch-all campaign exists —', listingIds: unpromoted.map((u) => u.itemId), marketplace: 'EBAY_IT' }) as object,
      proposedAction: { from: `${unpromoted.length} unpromoted listing(s)`, to: catchAll ? `enroll into "${catchAll.name}"` : 'create a catch-all campaign (builder → Protect margin)', inverse: { type: 'remove_ads', listingIds: unpromoted.map((u) => u.itemId) } } as object,
      reasoning: { coverage: `${promoted.size}/${live.length} live listings promoted` } as object,
      proposedKey,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
    update: {
      kind: catchAll ? 'enroll_catch_all' : 'alert',
      entityRef: (catchAll
        ? { campaignId: catchAll.id, externalCampaignId: catchAll.externalCampaignId, campaignName: catchAll.name, listingIds: unpromoted.map((u) => u.itemId), marketplace: catchAll.marketplace }
        : { campaignName: '— no catch-all campaign exists —', listingIds: unpromoted.map((u) => u.itemId), marketplace: 'EBAY_IT' }) as object,
      proposedAction: { from: `${unpromoted.length} unpromoted listing(s)`, to: catchAll ? `enroll into "${catchAll.name}"` : 'create a catch-all campaign (builder → Protect margin)', inverse: { type: 'remove_ads', listingIds: unpromoted.map((u) => u.itemId) } } as object,
      status: 'PENDING', decidedBy: null, decidedAt: null,
    },
  })
  return { unpromoted: unpromoted.length, proposal: true }
}

// ── ER2 — Rate Discovery ladder (SPEC-campaign-builder §5④) ─────────────────
// Walks each ACTIVE plan floor→cap one dwell window at a time. Every step is
// a PROPOSE proposal (never auto in v1); apply sets ALL the campaign's ad
// rates to min(step, per-listing break-even) and advances the plan. Runs
// with the anomaly guard daily — armed explicitly at launch, so it ticks
// independently of the global dial.
export async function evaluateRateDiscovery(): Promise<{ plans: number; proposed: number; completed: number }> {
  const report = { plans: 0, proposed: 0, completed: 0 }
  const plans = await prisma.ebayRateDiscoveryPlan.findMany({
    where: { status: 'ACTIVE', campaign: { status: 'RUNNING', ...POLICY_ALLOWS } },
    include: { campaign: { select: { id: true, externalCampaignId: true, name: true, marketplace: true } } },
  })
  const ctx = { actorUserId: AUTOMATION_ACTOR }
  for (const plan of plans) {
    report.plans++
    const now = new Date()
    const current = plan.currentPct != null ? Number(plan.currentPct.toString()) : null
    const floor = Number(plan.floorPct.toString())
    const cap = Number(plan.capPct.toString())
    const step = Number(plan.stepPct.toString())
    const dwellMs = plan.dwellDays * 86_400_000

    // record the finished window into history before stepping on
    let history = (plan.history as Array<Record<string, unknown>> | null) ?? []
    if (current != null && plan.lastStepAt && now.getTime() - plan.lastStepAt.getTime() >= dwellMs) {
      const win = await prisma.ebayAdsDailyPerformance.aggregate({
        where: { entityType: 'CAMPAIGN', entityId: plan.campaign.externalCampaignId, date: { gte: plan.lastStepAt, lte: now } },
        _sum: { adFeesCents: true, salesCents: true },
      })
      history = [...history, {
        pct: current, from: plan.lastStepAt.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10),
        days: Math.round((now.getTime() - plan.lastStepAt.getTime()) / 86_400_000),
        adFeesCents: win._sum.adFeesCents ?? 0, salesCents: win._sum.salesCents ?? 0,
      }]
      await prisma.ebayRateDiscoveryPlan.update({ where: { id: plan.id }, data: { history: history as object } })
    } else if (current != null && plan.lastStepAt && now.getTime() - plan.lastStepAt.getTime() < dwellMs) {
      continue // still dwelling on the current step
    }

    const target = current == null ? floor : Math.round((current + step) * 10) / 10
    if (target > cap) {
      // ladder complete — pick the best window by net-of-fees sales per day
      const best = history.reduce<{ pct: number; score: number } | null>((acc, h) => {
        const days = Math.max(1, Number(h.days ?? 1))
        const score = ((Number(h.salesCents ?? 0) - Number(h.adFeesCents ?? 0)) / days)
        return acc == null || score > acc.score ? { pct: Number(h.pct), score } : acc
      }, null)
      await prisma.ebayRateDiscoveryPlan.update({ where: { id: plan.id }, data: { status: 'COMPLETE', bestPct: best != null ? best.pct.toFixed(1) : null } })
      await prisma.ebayAdsProposal.upsert({
        where: { proposedKey: `discovery:${plan.campaignId}` },
        create: {
          kind: 'alert', proposedKey: `discovery:${plan.campaignId}`, status: 'PENDING',
          entityRef: { campaignId: plan.campaign.id, externalCampaignId: plan.campaign.externalCampaignId, campaignName: plan.campaign.name, marketplace: plan.campaign.marketplace } as object,
          proposedAction: { from: `ladder ${floor}%→${cap}%`, to: best != null ? `best net-of-fees sales/day at ${best.pct}% — consider settling there` : 'complete (no window data)', inverse: {} } as object,
          reasoning: { discovery: history } as object,
          expiresAt: new Date(Date.now() + 14 * 86_400_000),
        },
        update: {
          kind: 'alert', status: 'PENDING', decidedBy: null, decidedAt: null,
          proposedAction: { from: `ladder ${floor}%→${cap}%`, to: best != null ? `best net-of-fees sales/day at ${best.pct}% — consider settling there` : 'complete (no window data)', inverse: {} } as object,
          reasoning: { discovery: history } as object,
        },
      })
      report.completed++
      continue
    }

    // propose the next step (ONE live discovery proposal per campaign)
    const ads = await prisma.ebayAd.findMany({ where: { campaignId: plan.campaignId, listingId: { not: null }, status: { notIn: ['STALE'] } }, select: { listingId: true, bidPercentage: true } })
    if (!ads.length) continue
    const prevRates = Object.fromEntries(ads.map((a) => [a.listingId!, a.bidPercentage != null ? Number(a.bidPercentage.toString()) : null]))
    const existing = await prisma.ebayAdsProposal.findUnique({ where: { proposedKey: `discovery:${plan.campaignId}` } })
    if (existing?.status === 'PENDING') continue // step already awaiting a decision
    await prisma.ebayAdsProposal.upsert({
      where: { proposedKey: `discovery:${plan.campaignId}` },
      create: {
        kind: 'rate_discovery_step', proposedKey: `discovery:${plan.campaignId}`, status: 'PENDING',
        entityRef: { campaignId: plan.campaign.id, externalCampaignId: plan.campaign.externalCampaignId, campaignName: plan.campaign.name, marketplace: plan.campaign.marketplace } as object,
        proposedAction: { from: current != null ? `${current}%` : 'launch rates', to: `${target}% (all ads, clamped per listing to break-even)`, targetPct: target, inverse: { type: 'discovery_rates', rates: prevRates } } as object,
        reasoning: { plan: { floor, cap, step, dwellDays: plan.dwellDays }, windows: history } as object,
        expiresAt: new Date(Date.now() + 14 * 86_400_000),
      },
      update: {
        kind: 'rate_discovery_step', status: 'PENDING', decidedBy: null, decidedAt: null,
        proposedAction: { from: current != null ? `${current}%` : 'launch rates', to: `${target}% (all ads, clamped per listing to break-even)`, targetPct: target, inverse: { type: 'discovery_rates', rates: prevRates } } as object,
        reasoning: { plan: { floor, cap, step, dwellDays: plan.dwellDays }, windows: history } as object,
      },
    })
    report.proposed++
    void ctx
  }
  return report
}

export async function runAnomalyGuard(): Promise<{ anomalies: number; ceilings: number }> {
  const [anoms, ceils] = await Promise.all([detectAnomalies(), checkSpendCeilings()])
  await runCoverageGuard().catch((e) => logger.warn(`[E7][coverage] ${(e as Error).message}`))
  await evaluateRateDiscovery().catch((e) => logger.warn(`[ER2][discovery] ${(e as Error).message}`))
  if (anoms.length || ceils.some((c) => c.pct >= 80)) {
    try {
      const { notifyAutomation } = await import('../advertising/ads-automation-notify.service.js')
      for (const a of anoms) {
        await notifyAutomation({ type: 'ebay-ads-anomaly', severity: a.severity === 'CRITICAL' ? 'danger' : 'warn', title: `eBay ads: ${a.type.replace(/_/g, ' ')}`, body: a.message, href: '/marketing/ads/ebay' })
      }
      for (const c of ceils.filter((x) => x.pct >= 80)) {
        await notifyAutomation({ type: 'ebay-ads-ceiling', severity: c.pct >= 100 ? 'danger' : 'warn', title: `eBay ${c.marketplace} spend at ${c.pct}% of monthly ceiling`, body: `€${(c.mtdCents / 100).toFixed(2)} of €${(c.capCents / 100).toFixed(2)}`, href: '/marketing/ads/ebay/automation' })
      }
    } catch (e) {
      logger.warn(`[E5][ebay-ads] notify failed: ${(e as Error).message}`)
    }
  }
  return { anomalies: anoms.length, ceilings: ceils.length }
}

// ── Weekly digest ────────────────────────────────────────────────────────────
export async function generateWeeklyDigest(): Promise<{ weekStart: string; created: boolean }> {
  const now = new Date()
  const weekStart = new Date(now); weekStart.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7) - 7); weekStart.setUTCHours(0, 0, 0, 0) // previous Monday
  const weekEnd = new Date(weekStart); weekEnd.setUTCDate(weekStart.getUTCDate() + 6)
  const priorStart = new Date(weekStart); priorStart.setUTCDate(priorStart.getUTCDate() - 7)

  const sum = (from: Date, to: Date) => prisma.ebayAdsDailyPerformance.aggregate({
    where: { entityType: 'CAMPAIGN', date: { gte: from, lte: to } },
    _sum: { adFeesCents: true, salesCents: true, clicks: true, impressions: true, soldQty: true },
  })
  const [cur, prev, byCampaign, pending, applied, anomalies, economics] = await Promise.all([
    sum(weekStart, weekEnd),
    sum(priorStart, new Date(weekStart.getTime() - 86_400_000)),
    prisma.ebayAdsDailyPerformance.groupBy({ by: ['entityId'], where: { entityType: 'CAMPAIGN', date: { gte: weekStart, lte: weekEnd } }, _sum: { adFeesCents: true, salesCents: true, soldQty: true } }),
    prisma.ebayAdsProposal.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.ebayAdsProposal.findMany({ where: { status: 'APPLIED', decidedAt: { gte: weekStart, lte: new Date(weekEnd.getTime() + 86_400_000) } }, take: 50 }),
    detectAnomalies(),
    prisma.ebayListingEconomics.groupBy({ by: ['dataStatus'], _count: { _all: true } }),
  ])
  const names = new Map((await prisma.ebayCampaign.findMany({ select: { externalCampaignId: true, name: true } })).map((c) => [c.externalCampaignId, c.name]))
  const movers = byCampaign
    .map((c) => ({ campaign: names.get(c.entityId) ?? c.entityId, feesCents: c._sum.adFeesCents ?? 0, salesCents: c._sum.salesCents ?? 0, sold: c._sum.soldQty ?? 0 }))
    .sort((a, b) => b.feesCents - a.feesCents)

  const payload = {
    week: { start: weekStart.toISOString().slice(0, 10), end: weekEnd.toISOString().slice(0, 10) },
    totals: {
      adFeesCents: cur._sum.adFeesCents ?? 0, salesCents: cur._sum.salesCents ?? 0,
      clicks: cur._sum.clicks ?? 0, impressions: cur._sum.impressions ?? 0, soldQty: cur._sum.soldQty ?? 0,
      acosPct: (cur._sum.salesCents ?? 0) > 0 ? Math.round(((cur._sum.adFeesCents ?? 0) / (cur._sum.salesCents ?? 1)) * 1000) / 10 : null,
    },
    prior: { adFeesCents: prev._sum.adFeesCents ?? 0, salesCents: prev._sum.salesCents ?? 0, soldQty: prev._sum.soldQty ?? 0 },
    movers: movers.slice(0, 8),
    autopilotApplied: applied.map((p) => ({ kind: p.kind, entityRef: p.entityRef, result: p.appliedResult })),
    pendingProposals: pending.map((p) => ({ id: p.id, kind: p.kind, entityRef: p.entityRef, action: p.proposedAction, createdAt: p.createdAt })),
    anomalies,
    economics: Object.fromEntries(economics.map((e) => [e.dataStatus, e._count._all])),
    attribution: 'ebay-any-click',
    generatedAt: new Date().toISOString(),
  }
  const existing = await prisma.ebayAdsDigest.findUnique({ where: { weekStart } })
  await prisma.ebayAdsDigest.upsert({ where: { weekStart }, create: { weekStart, payload: payload as object }, update: { payload: payload as object } })
  try {
    const { notifyAutomation } = await import('../advertising/ads-automation-notify.service.js')
    await notifyAutomation({ type: 'ebay-ads-digest', severity: 'info', title: `eBay ads weekly digest ready (${payload.week.start})`, body: `€${(payload.totals.adFeesCents / 100).toFixed(2)} fees · €${(payload.totals.salesCents / 100).toFixed(2)} sales · ${pending.length} proposal(s) awaiting review`, href: '/marketing/ads/ebay/digest' })
  } catch { /* notify optional */ }
  return { weekStart: payload.week.start, created: !existing }
}

// ── Starter rule-pack (all PROPOSE, all disabled — §5 "useful on day one") ───
// ── ER3.2 — rule-body validation + dry-run preview ───────────────────────────
const METRICS: Metric[] = ['ad_fees_cents', 'sales_cents', 'clicks', 'impressions', 'sold_qty', 'acos_pct', 'ctr_pct', 'fee_pct_of_sales', 'rate_minus_breakeven']
const OPS = ['gt', 'gte', 'lt', 'lte']
const CPS_ACTIONS = ['adjust_ad_rate', 'set_rate_to_breakeven_factor', 'pause_ad', 'reactivate_ad', 'alert']
const CPC_ACTIONS = ['pause_keyword', 'bid_down_keyword', 'alert']

export interface RuleBody {
  name: string; trigger: RuleTrigger; action: RuleAction
  guardrails?: Record<string, unknown> | null; scope?: { campaignIds?: string[] } | null
  marketplace?: string | null; cooldownHours?: number
}

/** ER3.2 pure — validate a rule body (create/edit/preview share it). Returns
 *  human-readable problems; empty array = valid. */
export function validateRuleBody(b: Partial<RuleBody>): string[] {
  const errs: string[] = []
  if (!b.name || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) errs.push('name: required, ≤ 80 chars')
  const t = b.trigger as RuleTrigger | undefined
  if (!t || (t.scope !== 'CPS_AD' && t.scope !== 'CPC_KEYWORD')) errs.push('trigger.scope: CPS_AD or CPC_KEYWORD')
  const conds = t?.all
  if (!Array.isArray(conds) || conds.length < 1 || conds.length > 8) errs.push('trigger.all: 1–8 conditions')
  for (const [i, c] of (Array.isArray(conds) ? conds : []).entries()) {
    const at = `condition ${i + 1}`
    if (!METRICS.includes(c?.metric)) errs.push(`${at}: unknown metric`)
    if (!OPS.includes(c?.op)) errs.push(`${at}: unknown operator`)
    if (!Number.isInteger(c?.windowDays) || c.windowDays < 1 || c.windowDays > 90) errs.push(`${at}: windowDays 1–90`)
    const ex = c?.excludeRecentDays ?? 0
    if (!Number.isInteger(ex) || ex < 0 || ex > 7 || (Number.isInteger(c?.windowDays) && ex > 0 && ex >= c.windowDays)) errs.push(`${at}: excludeRecentDays 0–7 and below windowDays`)
    if (c?.benchmark != null) {
      if (!['account_avg', 'campaign_avg', 'break_even'].includes(c.benchmark)) errs.push(`${at}: unknown benchmark`)
      if (c.metric === 'rate_minus_breakeven') errs.push(`${at}: rate−break-even is already benchmark-relative — use an absolute threshold`)
      if (c.benchmark === 'break_even' && !(t?.scope === 'CPS_AD' && (c.metric === 'acos_pct' || c.metric === 'fee_pct_of_sales'))) {
        errs.push(`${at}: break-even benchmark applies to ACOS / fee-%-of-sales on CPS ads only`)
      }
      const m = c.multiplier ?? 1
      if (typeof m !== 'number' || !(m >= 0.1 && m <= 10)) errs.push(`${at}: multiplier 0.1–10`)
    } else if (typeof c?.threshold !== 'number' || !Number.isFinite(c.threshold)) {
      errs.push(`${at}: threshold required (or pick a benchmark)`)
    }
  }
  const a = b.action as RuleAction | undefined
  const pool = t?.scope === 'CPC_KEYWORD' ? CPC_ACTIONS : CPS_ACTIONS
  if (!a || !pool.includes(a.type)) errs.push(`action.type: one of ${pool.join(', ')} for this scope`)
  if (a?.type === 'adjust_ad_rate') {
    const d = a.deltaPct ?? -10
    if (typeof d !== 'number' || d === 0 || d < -90 || d > 300) errs.push('action.deltaPct: −90…300, non-zero')
  }
  if (a?.type === 'set_rate_to_breakeven_factor') {
    const f = a.factor ?? 0.8
    if (typeof f !== 'number' || f < 0.1 || f > 1.5) errs.push('action.factor: 0.1–1.5')
  }
  if (a?.minRatePct != null && (typeof a.minRatePct !== 'number' || a.minRatePct < 2 || a.minRatePct > 100)) errs.push('action.minRatePct: 2–100')
  if (a?.type === 'bid_down_keyword') {
    const d = a.bidDeltaPct ?? -20
    if (typeof d !== 'number' || d >= 0 || d < -90) errs.push('action.bidDeltaPct: −90…−1')
  }
  const ids = b.scope?.campaignIds
  if (ids != null && (!Array.isArray(ids) || ids.length > 200 || ids.some((x) => typeof x !== 'string' || !x))) errs.push('scope.campaignIds: up to 200 ids')
  if (b.marketplace != null && !/^EBAY_[A-Z]{2}$/.test(b.marketplace)) errs.push('marketplace: EBAY_XX or null')
  if (b.cooldownHours != null && (!Number.isInteger(b.cooldownHours) || b.cooldownHours < 1 || b.cooldownHours > 720)) errs.push('cooldownHours: 1–720')
  return errs
}

/** ER3.2 — dry-run an (unsaved) rule body against live data: counts + the first
 *  matches with the facts that fired. Writes NOTHING (no proposals, no
 *  execution rows, no cooldown bumps); the apply closures are never invoked. */
export async function previewRule(body: RuleBody): Promise<{ evaluated: number; matched: number; samples: Array<{ kind: string; entityRef: unknown; from: unknown; to: unknown; reasoning: object }> }> {
  const errs = validateRuleBody(body)
  if (errs.length) throw new Error(`invalid rule: ${errs.join(' · ')}`)
  const { evaluated, candidates } = await candidatesForRule({
    id: 'preview', marketplace: body.marketplace ?? null,
    trigger: body.trigger, action: body.action, scope: body.scope ?? null,
  })
  return {
    evaluated, matched: candidates.length,
    samples: candidates.slice(0, 10).map((c) => ({ kind: c.kind, entityRef: c.entityRef, from: c.from, to: c.to, reasoning: c.reasoning })),
  }
}

export const STARTER_RULES: Array<{ name: string; trigger: RuleTrigger; action: RuleAction; guardrails: object; cooldownHours: number }> = [
  {
    name: 'Fee % creep-down (CPS)',
    trigger: { scope: 'CPS_AD', all: [{ metric: 'fee_pct_of_sales', windowDays: 14, op: 'gt', threshold: 20 }, { metric: 'sales_cents', windowDays: 14, op: 'gt', threshold: 0 }] },
    action: { type: 'adjust_ad_rate', deltaPct: -10, minRatePct: 2 },
    guardrails: { note: 'clamped to break-even; skips missing-COGS' }, cooldownHours: 72,
  },
  {
    name: 'Click bleeder — remove ad (CPS)',
    trigger: { scope: 'CPS_AD', all: [{ metric: 'clicks', windowDays: 30, op: 'gte', threshold: 30 }, { metric: 'sold_qty', windowDays: 30, op: 'lte', threshold: 0 }] },
    action: { type: 'pause_ad' },
    guardrails: { note: 'any-click: every future sale of a clicked item carries fees — removing the ad stops new exposure' }, cooldownHours: 168,
  },
  {
    name: 'Rate above break-even — repair (CPS)',
    trigger: { scope: 'CPS_AD', all: [{ metric: 'rate_minus_breakeven', windowDays: 1, op: 'gt', threshold: 0 }] },
    action: { type: 'set_rate_to_breakeven_factor', factor: 0.8, minRatePct: 2 },
    guardrails: { note: 'the margin-anchored substitute for suggested rates (no CPS suggestion API on IT/FR/ES)' }, cooldownHours: 72,
  },
  {
    name: 'Restock re-promote (CPS)',
    trigger: { scope: 'CPS_AD', all: [{ metric: 'impressions', windowDays: 7, op: 'gte', threshold: 0 }] },
    action: { type: 'reactivate_ad' },
    guardrails: { note: 'targets STALE ads whose listing is live with stock again' }, cooldownHours: 48,
  },
  {
    name: 'Keyword bleeder — pause (CPC)',
    trigger: { scope: 'CPC_KEYWORD', all: [{ metric: 'clicks', windowDays: 30, op: 'gte', threshold: 20 }, { metric: 'sold_qty', windowDays: 30, op: 'lte', threshold: 0 }] },
    action: { type: 'pause_keyword' },
    guardrails: {}, cooldownHours: 168,
  },
  {
    name: 'Keyword bid-down on thin CTR (CPC)',
    trigger: { scope: 'CPC_KEYWORD', all: [{ metric: 'impressions', windowDays: 14, op: 'gte', threshold: 1000 }, { metric: 'ctr_pct', windowDays: 14, op: 'lt', threshold: 0.2 }] },
    action: { type: 'bid_down_keyword', bidDeltaPct: -20 },
    guardrails: {}, cooldownHours: 96,
  },
]

export async function installStarterRules(): Promise<{ installed: number; skipped: number }> {
  let installed = 0, skipped = 0
  for (const r of STARTER_RULES) {
    const exists = await prisma.ebayAdsRule.findFirst({ where: { name: r.name } })
    if (exists) { skipped++; continue }
    await prisma.ebayAdsRule.create({
      data: { name: r.name, enabled: false, mode: 'PROPOSE', trigger: r.trigger as object, action: r.action as object, guardrails: r.guardrails as object, cooldownHours: r.cooldownHours },
    })
    installed++
  }
  return { installed, skipped }
}
