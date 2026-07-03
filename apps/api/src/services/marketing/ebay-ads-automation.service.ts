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
export interface Condition { metric: Metric; windowDays: number; op: 'gt' | 'gte' | 'lt' | 'lte'; threshold: number }
export interface RuleTrigger { scope: 'CPS_AD' | 'CPC_KEYWORD'; all: Condition[] }
export interface RuleAction {
  type: 'adjust_ad_rate' | 'set_rate_to_breakeven_factor' | 'pause_ad' | 'reactivate_ad' | 'pause_keyword' | 'bid_down_keyword' | 'alert'
  deltaPct?: number       // adjust_ad_rate: signed % change of the rate
  factor?: number         // set_rate_to_breakeven_factor: rate = BE × factor
  minRatePct?: number     // floor for downward moves (default 2)
  bidDeltaPct?: number    // bid_down_keyword
}

export interface EntityFacts { impressions: number; clicks: number; adFeesCents: number; salesCents: number; soldQty: number }

/** Pure: evaluate one condition against aggregated facts (+economics). */
export function evalCondition(c: Condition, f: EntityFacts, ratePct: number | null, breakEvenPct: number | null): boolean | null {
  let v: number | null
  switch (c.metric) {
    case 'ad_fees_cents': v = f.adFeesCents; break
    case 'sales_cents': v = f.salesCents; break
    case 'clicks': v = f.clicks; break
    case 'impressions': v = f.impressions; break
    case 'sold_qty': v = f.soldQty; break
    case 'acos_pct': v = f.salesCents > 0 ? (f.adFeesCents / f.salesCents) * 100 : null; break
    case 'ctr_pct': v = f.impressions > 0 ? (f.clicks / f.impressions) * 100 : null; break
    case 'fee_pct_of_sales': v = f.salesCents > 0 ? (f.adFeesCents / f.salesCents) * 100 : null; break
    case 'rate_minus_breakeven': v = ratePct != null && breakEvenPct != null ? ratePct - breakEvenPct : null; break
  }
  if (v == null) return null // not computable → condition not satisfied (fail-safe)
  switch (c.op) {
    case 'gt': return v > c.threshold
    case 'gte': return v >= c.threshold
    case 'lt': return v < c.threshold
    case 'lte': return v <= c.threshold
  }
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
}

async function factsFor(entityType: 'LISTING' | 'KEYWORD', ids: string[], windowDays: number): Promise<Map<string, EntityFacts>> {
  if (!ids.length) return new Map()
  const since = new Date(); since.setUTCDate(since.getUTCDate() - windowDays)
  const rows = await prisma.ebayAdsDailyPerformance.groupBy({
    by: ['entityId'],
    where: { entityType, entityId: { in: ids }, date: { gte: since } },
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
  const windowDays = Math.max(...trigger.all.map((c) => c.windowDays), 1)

  if (trigger.scope === 'CPS_AD') {
    const ads = await prisma.ebayAd.findMany({
      where: {
        listingId: { not: null },
        status: { in: action.type === 'reactivate_ad' ? ['STALE'] : ['ACTIVE'] },
        campaign: { fundingModel: 'COST_PER_SALE', status: 'RUNNING', ...(rule.marketplace ? { marketplace: rule.marketplace } : {}), ...campaignScope },
      },
      include: { campaign: { select: { id: true, externalCampaignId: true, name: true, marketplace: true, bidPercentage: true } } },
    })
    const short = (m: string) => ({ EBAY_IT: 'IT', EBAY_DE: 'DE', EBAY_FR: 'FR', EBAY_ES: 'ES' } as Record<string, string>)[m] ?? 'IT'
    const listingIds = ads.map((a) => a.listingId!)
    const facts = await factsFor('LISTING', listingIds, windowDays)
    const eco = new Map((await prisma.ebayListingEconomics.findMany({ where: { itemId: { in: listingIds } }, select: { itemId: true, breakEvenAdRatePct: true, dataStatus: true } }))
      .map((e) => [e.itemId, { be: e.breakEvenAdRatePct != null ? Number(e.breakEvenAdRatePct.toString()) : null, status: e.dataStatus }]))
    const liveIdx = new Map((await prisma.ebayListingIndex.findMany({ where: { itemId: { in: listingIds } }, select: { itemId: true, endedAt: true, quantity: true } })).map((l) => [l.itemId, l]))

    for (const ad of ads) {
      evaluated++
      const f = facts.get(ad.listingId!) ?? zeroFacts
      const ratePct = ad.bidPercentage != null ? Number(ad.bidPercentage.toString()) : ad.campaign.bidPercentage != null ? Number(ad.campaign.bidPercentage.toString()) : null
      const e = eco.get(ad.listingId!)
      // manual-only: automations skip unknown economics for RATE actions
      const needsEconomics = action.type === 'adjust_ad_rate' || action.type === 'set_rate_to_breakeven_factor'
      if (needsEconomics && (e?.be == null)) continue
      const results = trigger.all.map((c) => evalCondition(c, f, ratePct, e?.be ?? null))
      if (!results.every((r) => r === true)) continue

      const base = {
        entityRef: { campaignId: ad.campaign.id, externalCampaignId: ad.campaign.externalCampaignId, campaignName: ad.campaign.name, listingId: ad.listingId!, marketplace: ad.campaign.marketplace },
        reasoning: { rule: rule.id, windowDays, facts: f, ratePct, breakEven: e?.be ?? null, conditions: trigger.all },
      }
      if (action.type === 'adjust_ad_rate' || action.type === 'set_rate_to_breakeven_factor') {
        if (ratePct == null) continue
        const target = action.type === 'adjust_ad_rate' ? ratePct * (1 + (action.deltaPct ?? -10) / 100) : (e!.be!) * (action.factor ?? 0.8)
        const clamped = clampAutoRate(target, e?.be ?? null, action.minRatePct)
        if (clamped.rate == null || Math.abs(clamped.rate - ratePct) < 0.1) continue
        candidates.push({
          ...base, kind: 'adjust_ad_rate', from: `${ratePct}%`, to: `${clamped.rate}%`,
          reasoning: { ...base.reasoning, clampNote: clamped.note },
          inverse: { type: 'set_rate', listingId: ad.listingId!, ratePct },
          apply: async () => {
            const r = await writes.setAdRates(ctx, ad.campaign.id, [{ listingId: ad.listingId!, ratePct: clamped.rate! }])
            return { ok: !!r.results[0]?.ok, detail: r.results[0]?.blocked ?? r.results[0]?.error ?? `rate ${ratePct}% → ${clamped.rate}% (${r.mode})` }
          },
        })
      } else if (action.type === 'pause_ad') {
        candidates.push({
          ...base, kind: 'pause_ad', from: 'ACTIVE', to: 'removed from campaign',
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
          ...base, kind: 'reactivate_ad', from: 'STALE', to: 're-promoted',
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
      where: { status: 'ACTIVE', campaign: { fundingModel: 'COST_PER_CLICK', status: 'RUNNING', ...(rule.marketplace ? { marketplace: rule.marketplace } : {}), ...campaignScope } },
      include: { campaign: { select: { id: true, externalCampaignId: true, name: true, marketplace: true } } },
    })
    const facts = await factsFor('KEYWORD', keywords.map((k) => k.externalKeywordId), windowDays)
    for (const kw of keywords) {
      evaluated++
      const f = facts.get(kw.externalKeywordId) ?? zeroFacts
      const results = trigger.all.map((c) => evalCondition(c, f, null, null))
      if (!results.every((r) => r === true)) continue
      const base = {
        entityRef: { campaignId: kw.campaign.id, externalCampaignId: kw.campaign.externalCampaignId, campaignName: kw.campaign.name, keywordId: kw.id, keywordText: kw.text, marketplace: kw.campaign.marketplace },
        reasoning: { rule: rule.id, windowDays, facts: f, conditions: trigger.all },
      }
      if (action.type === 'pause_keyword') {
        candidates.push({
          ...base, kind: 'pause_keyword', from: 'ACTIVE', to: 'PAUSED',
          inverse: { type: 'keyword_status', keywordId: kw.id, status: 'ACTIVE' },
          apply: async () => {
            const r = await writes.updateKeywords(ctx, kw.campaign.id, [{ keywordId: kw.id, status: 'PAUSED' }])
            return { ok: !!r.results[0]?.ok, detail: r.results[0]?.error ?? `keyword paused (${r.mode})` }
          },
        })
      } else if (action.type === 'bid_down_keyword' && kw.bidCents != null) {
        const newBid = Math.max(2, Math.round(kw.bidCents * (1 + (action.bidDeltaPct ?? -20) / 100)))
        if (newBid >= kw.bidCents) continue
        candidates.push({
          ...base, kind: 'bid_down_keyword', from: `€${(kw.bidCents / 100).toFixed(2)}`, to: `€${(newBid / 100).toFixed(2)}`,
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
        const data = {
          ruleId: rule.id,
          kind: cand.kind,
          entityRef: cand.entityRef as object,
          proposedAction: { from: cand.from, to: cand.to, inverse: cand.inverse } as object,
          reasoning: cand.reasoning,
          expiresAt: new Date(Date.now() + 14 * 86_400_000),
        }
        if (mode === 'apply' && cand.kind !== 'alert') {
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
export async function decideProposals(actorUserId: string | null, ids: string[], decision: 'approve' | 'reject'): Promise<Array<{ id: string; ok: boolean; detail: string }>> {
  const out: Array<{ id: string; ok: boolean; detail: string }> = []
  for (const id of ids) {
    const p = await prisma.ebayAdsProposal.findUnique({ where: { id } })
    if (!p || p.status !== 'PENDING') { out.push({ id, ok: false, detail: 'not pending' }); continue }
    if (decision === 'reject') {
      await prisma.ebayAdsProposal.update({ where: { id }, data: { status: 'REJECTED', decidedBy: actorUserId, decidedAt: new Date() } })
      out.push({ id, ok: true, detail: 'rejected' })
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

export interface Anomaly { type: string; severity: 'WARN' | 'CRITICAL'; message: string; entityId?: string }

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
  const recentlyEnded = await prisma.ebayCampaign.findMany({ where: { status: 'ENDED', endDate: { gte: new Date(Date.now() - 3 * 86_400_000) } }, select: { externalCampaignId: true, name: true } })
  for (const c of recentlyEnded) {
    const audited = await prisma.campaignAction.findFirst({ where: { channel: 'EBAY', actionType: 'end_campaign', entityId: c.externalCampaignId } })
    if (!audited) anomalies.push({ type: 'campaign_ended_externally', severity: 'WARN', message: `campaign "${c.name}" (${c.externalCampaignId}) ended outside Nexus — Seller Hub or eBay-side change (easy boost?)`, entityId: c.externalCampaignId })
  }
  return anomalies
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
    where: { nexusManaged: true, fundingModel: 'COST_PER_SALE', status: 'RUNNING', name: { startsWith: 'catch_all-' } },
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

export async function runAnomalyGuard(): Promise<{ anomalies: number; ceilings: number }> {
  const [anoms, ceils] = await Promise.all([detectAnomalies(), checkSpendCeilings()])
  await runCoverageGuard().catch((e) => logger.warn(`[E7][coverage] ${(e as Error).message}`))
  // E7 #12 Floor Watch: DYNAMIC campaigns whose applied ad rates exceed the
  // configured cap (eBay's stealth-floor precedent, Nov 2024).
  try {
    const dynamics = await prisma.ebayCampaign.findMany({ where: { adRateStrategy: 'DYNAMIC', status: 'RUNNING' }, include: { ads: { where: { status: { notIn: ['STALE'] } }, select: { listingId: true, bidPercentage: true } } } })
    for (const d of dynamics) {
      const cap = Number(((d.dynamicAdRatePrefs as Array<{ adRateCapPercent?: string }> | null)?.[0]?.adRateCapPercent) ?? NaN)
      if (!Number.isFinite(cap)) continue
      const over = d.ads.filter((a) => a.bidPercentage != null && Number(a.bidPercentage.toString()) > cap + 0.05)
      if (over.length) {
        anoms.push({ type: 'dynamic_rate_over_cap', severity: 'CRITICAL', message: `Floor Watch: ${over.length} ad(s) in "${d.name}" carry rates above the configured cap ${cap}% — eBay-side drift`, entityId: d.externalCampaignId })
      }
    }
  } catch (e) { logger.warn(`[E7][floor-watch] ${(e as Error).message}`) }
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
