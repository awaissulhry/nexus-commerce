/**
 * AX.7 — Negative + keyword harvesting.
 *
 * From AmazonAdsSearchTerm over a window:
 *   • NEGATIVE candidates — terms that spent ≥ minSpend with 0 orders →
 *     propose adding as a campaign negative (stops the bleed).
 *   • GRADUATE candidates — converting terms (orders ≥ minOrders) found via
 *     auto/broad targeting → propose creating an Exact keyword in the
 *     originating ad group (the auto→manual harvest funnel).
 *
 * preview() returns candidates; apply() executes the chosen actions via the
 * shipped createNegative + AX.4 createKeywordLocal. Sandbox-safe + gated.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { createNegative, type NegativeMatchType } from './ads-negative-kw.service.js'
import { createKeywordLocal, createNegativeKeywordCampaignLocal, createTargetLocal, createNegativeProductTargetLocal } from './ads-create.service.js'
// NEG.0(a) — enforced HERE rather than at applyHarvest's five callers, for the reason the write
// gate gives about itself: a protection only some callers honour is not a protection. The five are
// the rule engine, the POST route, ads-auto-harvest (which wrote the 22 engine-attributed rows),
// and two recommendation-accept paths.
import { checkProtectConverting, normaliseNegTerm, type NegationDecision, type ProtectConvertingConfig } from './ads-protect-converting.js'

export interface HarvestCandidate {
  query: string
  externalCampaignId: string
  externalAdGroupId: string
  impressions: number
  clicks: number
  costCents: number
  orders: number
  salesCents: number
}
export interface HarvestPreview { negatives: HarvestCandidate[]; graduations: HarvestCandidate[]; productNegatives: HarvestCandidate[]; productGraduations: HarvestCandidate[]; windowDays: number }

// H.5 — a search-term "query" that is an ASIN (B0 + 8 alnum) is a product-targeting match from an auto
// campaign, not a keyword. Those become PRODUCT-target candidates instead of keyword candidates.
const isAsinQuery = (q: string): boolean => /^b0[a-z0-9]{8}$/i.test(q.trim())

const DEFAULT_MIN_SPEND_CENTS = 1500 // €15 with zero orders → wasteful
const DEFAULT_MIN_ORDERS = 2 // converting → worth graduating

export async function previewHarvest(opts: { windowDays?: number; minSpendCents?: number; minOrders?: number; adGroupExternalIds?: string[] } = {}): Promise<HarvestPreview> {
  const windowDays = opts.windowDays ?? 60
  const minSpend = opts.minSpendCents ?? DEFAULT_MIN_SPEND_CENTS
  const minOrders = opts.minOrders ?? DEFAULT_MIN_ORDERS
  const since = new Date(Date.now() - windowDays * 86400_000)
  // AT.4b — when a rule carries a source scope, only consider search terms from
  // those ad groups (by external id). Note: passing an EMPTY array intentionally
  // matches nothing — a wizard rule scoped to not-yet-live (gated) ad groups
  // harvests zero, never the whole account.
  const rows = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'campaignId', 'adGroupId'],
    where: { date: { gte: since }, ...(opts.adGroupExternalIds ? { adGroupId: { in: opts.adGroupExternalIds } } : {}) },
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })
  const negatives: HarvestCandidate[] = []
  const graduations: HarvestCandidate[] = []
  const productNegatives: HarvestCandidate[] = []
  const productGraduations: HarvestCandidate[] = []
  for (const r of rows) {
    const costCents = Math.round(Number(r._sum.costMicros ?? 0n) / 10000)
    const orders = r._sum.orders7d ?? 0
    const cand: HarvestCandidate = {
      query: r.query, externalCampaignId: r.campaignId, externalAdGroupId: r.adGroupId,
      impressions: r._sum.impressions ?? 0, clicks: r._sum.clicks ?? 0, costCents, orders, salesCents: r._sum.sales7dCents ?? 0,
    }
    // H.5 — ASIN queries become PRODUCT-target candidates; everything else stays keyword candidates.
    const asin = isAsinQuery(cand.query)
    if (orders === 0 && costCents >= minSpend) (asin ? productNegatives : negatives).push(cand)
    else if (orders >= minOrders) (asin ? productGraduations : graduations).push(cand)
  }
  negatives.sort((a, b) => b.costCents - a.costCents)
  graduations.sort((a, b) => b.orders - a.orders)
  productNegatives.sort((a, b) => b.costCents - a.costCents)
  productGraduations.sort((a, b) => b.orders - a.orders)
  return { negatives, graduations, productNegatives, productGraduations, windowDays }
}

export interface HarvestApplyResult {
  negativesAdded: number
  keywordsGraduated: number
  isolationNegativesAdded: number
  productsGraduated: number
  productNegativesAdded: number
  errors: string[]
  /** NEG.0(a) — negations refused because the term converted inside the window. */
  negativesProtected: number
  /** The refusals in full. A count nobody can read back to a term is a silent skip with a number on it. */
  protectedTerms: Array<{ term: string; path: 'wasteful' | 'isolation'; reason: string }>
}
// AT.4b — per-(external)-ad-group match-type plan from a wizard rule's `sources`.
// Absent → the original defaults (graduate EXACT, negate NEGATIVE_EXACT). H.5 adds the product flags:
// graduateProduct/negateProduct gate whether converting/wasteful ASINs become product targets.
export type HarvestPlan = Record<string, { graduate?: string[]; negate?: string[]; graduateProduct?: boolean; negateProduct?: boolean }>

// H.2 — destination routing. matchType (EXACT/PHRASE/BROAD) → the LOCAL ad group of the campaign
// that hosts that match type in the same product group (e.g. EXACT → the Exact campaign). A graduated
// keyword is created there instead of back in the source ad group. Absent → graduate in source (the
// standalone "Auto harvest & negate" template, unchanged).
export async function applyHarvest(args: { negatives?: HarvestCandidate[]; graduations?: Array<HarvestCandidate & { bidEur?: number }>; productNegatives?: HarvestCandidate[]; productGraduations?: Array<HarvestCandidate & { bidEur?: number }>; userId?: string; plan?: HarvestPlan; destinations?: Record<string, string>; protectConverting?: boolean; protectDays?: number }): Promise<HarvestApplyResult> {
  const result: HarvestApplyResult = { negativesAdded: 0, keywordsGraduated: 0, isolationNegativesAdded: 0, productsGraduated: 0, productNegativesAdded: 0, errors: [], negativesProtected: 0, protectedTerms: [] }

  // NEG.0(a) — one read for the whole batch, then a pure decision per term.
  //
  // 🔴 This deliberately covers the H.3 ISOLATION negation as well as the wasteful one, and that is
  // load-bearing: an isolation negation targets a term that just graduated *because* it converted,
  // so under a literal reading of the builder's sentence every one of them is refused. The two
  // paths are counted separately below so the effect is visible rather than inferred. If isolation
  // should be exempt — the argument being that the term is not blocked, only routed, since the same
  // term is created as EXACT in the destination campaign in the same transaction — that is an
  // operator decision, not one to make silently inside a safety fix.
  const protectConfig: ProtectConvertingConfig = {
    enabled: args.protectConverting !== false,
    days: args.protectDays != null && Number(args.protectDays) > 0 ? Math.floor(Number(args.protectDays)) : 30,
  }
  const candidateTerms = [...(args.negatives ?? []), ...(args.graduations ?? [])].map((c) => c.query)
  const guard = await checkProtectConverting({ terms: candidateTerms, config: protectConfig })
  const refusalFor = (query: string): NegationDecision | null => {
    const d = guard.get(normaliseNegTerm(query))
    return d && !d.allowed ? d : null
  }
  const recordRefusal = (query: string, path: 'wasteful' | 'isolation', d: NegationDecision) => {
    result.negativesProtected++
    result.protectedTerms.push({ term: query, path, reason: d.reason })
    logger.warn('[applyHarvest] negation refused by protectConverting', { query, path, evidence: d.evidence })
  }

  // H.7 — negate at campaign scope: push to Amazon (gated, via createNegative) THEN mirror a local row
  // so our platform reflects it immediately (gated-local symmetry with graduations). Ordered so
  // createNegative's existsLocally probe doesn't pre-empt the first push; on later runs both sides find
  // the local row and dedupe. Returns the number of match types negated.
  const negateCampaign = async (externalCampaignId: string, query: string, planNegate?: string[]): Promise<number> => {
    const negMatches = planNegate?.length ? planNegate : ['EXACT']
    const camp = await prisma.campaign.findFirst({ where: { externalCampaignId }, select: { marketplace: true } })
    // NEG.0(b) — `marketplace` was omitted here behind `as never`, so the gate denied at
    // `connection` (ads-write-gate.ts:165-171) before it ever reached the protected-terms check,
    // and `createNegativeKeywordCampaignLocal` — which has no gate of its own — wrote the local row
    // regardless. That pair is why all 22 campaign-scope negatives in the account carry no Amazon
    // id. Refuse rather than repeat it: a push that cannot be gated must not leave a mirror behind.
    if (!camp?.marketplace) throw new Error(`no local campaign (or no marketplace) for externalCampaignId=${externalCampaignId} — cannot resolve a connection for the write gate`)
    const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: camp.marketplace, isActive: true }, select: { profileId: true } })
    for (const nm of negMatches) {
      // Amazon SP has no negative-broad (ads-api-client.ts:1759). A plan asking for one used to be
      // sent as `NEGATIVE_BROAD` and rejected downstream; name it here instead.
      if (nm !== 'EXACT' && nm !== 'PHRASE') throw new Error(`unsupported negative match type "${nm}" — Amazon SP accepts EXACT and PHRASE only`)
      const matchType: NegativeMatchType = nm === 'EXACT' ? 'NEGATIVE_EXACT' : 'NEGATIVE_PHRASE'
      const r = await createNegative({ profileId: conn?.profileId ?? '', externalCampaignId, keywordText: query, matchType, scope: 'CAMPAIGN', marketplace: camp.marketplace })
      if (r.denied) throw new Error(`write gate denied at ${r.denied.deniedAt}: ${r.denied.reason}`)
      await createNegativeKeywordCampaignLocal({ externalCampaignId, keywordText: query, matchType: nm, externalTargetId: r.externalNegativeKeywordId ?? null, userId: args.userId })
    }
    return negMatches.length
  }

  for (const n of args.negatives ?? []) {
    const refused = refusalFor(n.query)
    if (refused) { recordRefusal(n.query, 'wasteful', refused); continue }
    try {
      await negateCampaign(n.externalCampaignId, n.query, args.plan?.[n.externalAdGroupId]?.negate)
      result.negativesAdded++
    } catch (e) { result.errors.push(`neg "${n.query}": ${(e as Error).message}`) }
  }

  for (const g of args.graduations ?? []) {
    try {
      // Source local ad group the term came from (by external id) — fallback destination + lets us
      // tell whether a graduation actually crosses into a different campaign (drives H.3 isolation).
      const srcAg = await prisma.adGroup.findFirst({ where: { externalAdGroupId: g.externalAdGroupId }, select: { id: true } })
      // Bid = derived from observed CPC (cost/clicks) or a sensible default.
      const bidEur = g.bidEur ?? (g.clicks > 0 ? Math.max(0.05, g.costCents / g.clicks / 100) : 0.5)
      const gradMatches = args.plan?.[g.externalAdGroupId]?.graduate?.length ? args.plan[g.externalAdGroupId].graduate! : ['EXACT']
      for (const gm of gradMatches) {
        // H.2 — route into the destination campaign that hosts this match type (EXACT → Exact
        // campaign), not back into the source. Fall back to the source ad group when no destination
        // of that kind exists (back-compat / standalone template).
        const destAdGroupId = args.destinations?.[gm] ?? srcAg?.id
        if (!destAdGroupId) { result.errors.push(`grad "${g.query}" (${gm}): no destination/local ad group`); continue }
        await createKeywordLocal({ adGroupId: destAdGroupId, keywordText: g.query, matchType: gm as 'EXACT' | 'PHRASE' | 'BROAD', bidEur, userId: args.userId })
      }
      result.keywordsGraduated++

      // H.3 — isolation. If the winner was promoted into a DIFFERENT campaign, negate it in its source
      // so the discovery campaign stops competing with the new tighter keyword. Match types come from
      // the source row's negate plan (default EXACT). createNegative is idempotent + write-gated, so a
      // recurring tick won't pile up duplicates and nothing pushes live while gated.
      const promotedElsewhere = !!srcAg && gradMatches.some((gm) => { const d = args.destinations?.[gm]; return !!d && d !== srcAg.id })
      if (promotedElsewhere) {
        // 🔴 NEG.0(a), the awkward case: a graduated term converted by definition, so the literal
        // reading of "never negate a term that converted" refuses every isolation negation. Applied
        // as written and counted under `path: 'isolation'` so the effect is legible on the result
        // rather than showing up as an unexplained zero. Unreachable today — the only caller that
        // has ever run this service (ads-auto-harvest) passes no `destinations`, so
        // `promotedElsewhere` is false for it.
        const refused = refusalFor(g.query)
        if (refused) recordRefusal(g.query, 'isolation', refused)
        else {
          try { result.isolationNegativesAdded += await negateCampaign(g.externalCampaignId, g.query, args.plan?.[g.externalAdGroupId]?.negate) }
          catch (e) { result.errors.push(`iso-neg "${g.query}": ${(e as Error).message}`) }
        }
      }
    } catch (e) { result.errors.push(`grad "${g.query}": ${(e as Error).message}`) }
  }

  // ── H.5 — product-target harvesting (ASIN candidates) ──────────────────────────────
  // Negate a wasteful/promoted ASIN in its SOURCE ad group (ad-group-scoped negative product target,
  // idempotent + local-mirrored). Returns false if the source ad group isn't local.
  const negateProductInSource = async (externalAdGroupId: string, asin: string): Promise<boolean> => {
    const srcAg = await prisma.adGroup.findFirst({ where: { externalAdGroupId }, select: { id: true } })
    if (!srcAg) return false
    await createNegativeProductTargetLocal({ adGroupId: srcAg.id, asin, userId: args.userId })
    return true
  }

  for (const pg of args.productGraduations ?? []) {
    if (args.plan?.[pg.externalAdGroupId]?.graduateProduct !== true) continue // only when the row opted into product graduation
    try {
      const srcAg = await prisma.adGroup.findFirst({ where: { externalAdGroupId: pg.externalAdGroupId }, select: { id: true } })
      const bidEur = pg.bidEur ?? (pg.clicks > 0 ? Math.max(0.05, pg.costCents / pg.clicks / 100) : 0.5)
      // H.2-analog — route the converting ASIN into the PRODUCT destination (the PAT campaign), fallback source.
      const destAdGroupId = args.destinations?.PRODUCT ?? srcAg?.id
      if (!destAdGroupId) { result.errors.push(`prod-grad "${pg.query}": no destination/local ad group`); continue }
      await createTargetLocal({ adGroupId: destAdGroupId, kind: 'PRODUCT', value: pg.query, bidEur, userId: args.userId })
      result.productsGraduated++
      // H.3-analog — isolate: if promoted into a different campaign, negate the ASIN in its source.
      if (srcAg && destAdGroupId !== srcAg.id) {
        try { if (await negateProductInSource(pg.externalAdGroupId, pg.query)) result.productNegativesAdded++ }
        catch (e) { result.errors.push(`prod-iso "${pg.query}": ${(e as Error).message}`) }
      }
    } catch (e) { result.errors.push(`prod-grad "${pg.query}": ${(e as Error).message}`) }
  }

  for (const pn of args.productNegatives ?? []) {
    if (args.plan?.[pn.externalAdGroupId]?.negateProduct !== true) continue // only when the row opted into product negation
    try { if (await negateProductInSource(pn.externalAdGroupId, pn.query)) result.productNegativesAdded++ }
    catch (e) { result.errors.push(`prod-neg "${pn.query}": ${(e as Error).message}`) }
  }

  logger.info('[AX.7] harvest applied', result)
  return result
}
