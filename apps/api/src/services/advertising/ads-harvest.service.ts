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
 * negative write service (writeNegativeKeyword) + AX.4 createKeywordLocal. Sandbox-safe + gated.
 *
 * ADS AUTONOMY W1-7 — a caller that names no numbers of its own gets the ads strategy's harvest and negate thresholds
 * where the Owner set them, and the ASIN of a product the strategy protects is never a negative candidate.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { writeNegativeKeyword, writeNegativeProductTarget } from './ads-negative-kw.service.js'
import type { AdWriteEvidence } from './ads-evidence.js'
import { createKeywordLocal, createTargetLocal } from './ads-create.service.js'
// NEG.0(a) — enforced HERE rather than at applyHarvest's callers, for the reason the write
// gate gives about itself: a protection only some callers honour is not a protection. The callers
// are the rule engine, the POST route, and two recommendation-accept paths (a fifth,
// ads-auto-harvest — which wrote the 22 engine-attributed rows — was retired in HP5, 2026-08-21).
import { checkProtectConverting, normaliseNegTerm, type NegationDecision, type ProtectConvertingConfig } from './ads-protect-converting.js'
import { adProductOf, SPONSORED_PRODUCTS } from '@nexus/shared/ads-ad-product'
// W1-7 — the ads strategy's search-term thresholds and the products it protects.
import type { HarvestThresholds, NegateThresholds } from './ads-strategy/fields.js'
import { openTermsStrategy, protectedAsins, sourceLabel, strategyMarketOf, termsForAdGroups, type StrategyTerms } from './ads-strategy/terms.js'

/**
 * 5d (review 7.4) — the source ad group is a fallback destination only when it can take a keyword or product
 * target: a manual Sponsored Products campaign. An automatic one cannot, so the create failed and left a local row.
 */
const SOURCE_SELECT = { id: true, campaign: { select: { targetingType: true, adProduct: true, type: true } } } as const
const takesTargets = (ag: { campaign: { targetingType: string | null; adProduct: string | null; type: string | null } | null } | null): boolean =>
  !!ag?.campaign && ag.campaign.targetingType === 'MANUAL' && adProductOf(ag.campaign) === SPONSORED_PRODUCTS
const NO_DESTINATION = 'No destination was given for this match type, and the ad group this term came from is not in a manual Sponsored Products campaign, so it cannot take it. Nothing was created.'

export interface HarvestCandidate {
  query: string
  externalCampaignId: string
  externalAdGroupId: string
  impressions: number
  clicks: number
  costCents: number
  orders: number
  salesCents: number
  /** W1-7 — the market its search-term rows name ('IT'). */
  market?: string | null
  /**
   * W1-7 — set when the ads strategy's group chose this candidate: the window its numbers cover and the row the group
   * came from. Absent: the caller's numbers, or the defaults, chose it.
   */
  strategy?: { windowDays: number; level: string; label: string; version: number; product?: string }
}

/** W1-7 — the numbers that chose the candidates. */
export interface HarvestCriteriaUsed {
  /**
   * `caller`: the caller named numbers of its own (a rule's, a person's, a tool's), and they chose every candidate.
   * `strategy`: the caller named none: the ads strategy's harvest and negate groups chose wherever a market, a category
   * or a product sets one (each such candidate names its row; `strategy` lists them), and `defaults` everywhere else.
   */
  from: 'caller' | 'strategy'
  /** The numbers that chose every candidate the strategy did not. */
  defaults: { windowDays: number; minSpendCents: number; minOrders: number }
  /** The strategy groups that chose at least one candidate, each with its thresholds and how many it chose. */
  strategy: Array<{ group: 'harvest' | 'negate'; source: { level: string; label: string; version: number; product?: string }; thresholds: HarvestThresholds | NegateThresholds; candidates: number }>
}

export interface HarvestPreview {
  negatives: HarvestCandidate[]
  graduations: HarvestCandidate[]
  productNegatives: HarvestCandidate[]
  productGraduations: HarvestCandidate[]
  /** The window of every candidate the strategy did not choose (a strategy candidate carries its own). */
  windowDays: number
  criteria: HarvestCriteriaUsed
  /**
   * W1-7 — ASIN negatives left out: the ads strategy protects that product in its market, and every writer refuses its
   * ASIN as a negative. Listed so the leaving-out is never silent.
   */
  protectedAsins: Array<HarvestCandidate & { reason: string }>
}

// H.5 — a search-term "query" that is an ASIN (B0 + 8 alnum) is a product-targeting match from an auto
// campaign, not a keyword. Those become PRODUCT-target candidates instead of keyword candidates.
const isAsinQuery = (q: string): boolean => /^b0[a-z0-9]{8}$/i.test(q.trim())

const DEFAULT_MIN_SPEND_CENTS = 1500 // €15 with zero orders → wasteful
export const DEFAULT_MIN_ORDERS = 2 // converting → worth graduating
export const DEFAULT_WINDOW_DAYS = 60

/**
 * Every search term × campaign × ad group over a window, summed. Grouped by market too, then folded back: an ad group
 * lives in one market, so the totals are exactly the three-key totals, and each carries its market.
 */
async function termTotals(windowDays: number, adGroupExternalIds?: string[]): Promise<Map<string, HarvestCandidate>> {
  const since = new Date(Date.now() - windowDays * 86400_000)
  // AT.4b — when a rule carries a source scope, only consider search terms from
  // those ad groups (by external id). Note: passing an EMPTY array intentionally
  // matches nothing — a wizard rule scoped to not-yet-live (gated) ad groups
  // harvests zero, never the whole account.
  const rows = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'campaignId', 'adGroupId', 'marketplace'],
    where: { date: { gte: since }, ...(adGroupExternalIds ? { adGroupId: { in: adGroupExternalIds } } : {}) },
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })
  const out = new Map<string, HarvestCandidate>()
  const micros = new Map<string, bigint>()
  for (const r of rows) {
    const key = `${r.query}\u0000${r.campaignId}\u0000${r.adGroupId}`
    const t = out.get(key) ?? {
      query: r.query, externalCampaignId: r.campaignId, externalAdGroupId: r.adGroupId,
      impressions: 0, clicks: 0, costCents: 0, orders: 0, salesCents: 0, market: strategyMarketOf(r.marketplace),
    }
    t.impressions += r._sum.impressions ?? 0
    t.clicks += r._sum.clicks ?? 0
    t.orders += r._sum.orders7d ?? 0
    t.salesCents += r._sum.sales7dCents ?? 0
    micros.set(key, (micros.get(key) ?? 0n) + BigInt(r._sum.costMicros ?? 0n))
    out.set(key, t)
  }
  for (const [key, t] of out) t.costCents = Math.round(Number(micros.get(key) ?? 0n) / 10000)
  return out
}

/**
 * A strategy harvest group's bar: enough orders and clicks, and an ACoS under its ceiling (no sales = no ACoS: kept).
 * AA-W2-7 — exported: a negative Claude asks for runs by rule only for a term that does not meet it (harvest first).
 */
export const meetsHarvest = (c: Pick<HarvestCandidate, 'orders' | 'clicks' | 'costCents' | 'salesCents'>, h: Omit<HarvestThresholds, 'windowDays'>) =>
  c.orders >= h.minOrders && c.clicks >= h.minClicks && (h.maxAcosPct == null || c.salesCents <= 0 || (c.costCents / c.salesCents) * 100 <= h.maxAcosPct)
/** A strategy negate group's bar: enough clicks and spend, and no more orders than it allows. */
const meetsNegate = (c: HarvestCandidate, n: NegateThresholds) =>
  c.orders <= n.maxOrders && c.clicks >= n.minClicks && c.costCents >= n.minSpendCents

/**
 * The search terms worth negating (spent, did not convert) and worth graduating (converted), per ad group.
 *
 * W1-7 — whose numbers decide. A caller that names its own (`windowDays`, `minSpendCents` or `minOrders`: a rule's, a
 * person's, a tool's) decides every candidate with them WHOLE, as before: no strategy threshold is read (the Owner's
 * control rule). A caller that names none gets the ads strategy's harvest and negate groups wherever a market, category
 * or product sets one (per ad group, its products together: ads-strategy/terms.ts), each over its own window, and its
 * `defaults` (else this service's: 60 days, €15, 2 orders) everywhere else. Where a group decides, the harvest bar is
 * asked first: a term that meets it is never offered as a negative. Either way the ASIN of a product the strategy
 * protects is never offered as a negative (`protectedAsins` lists them).
 */
export async function previewHarvest(opts: {
  windowDays?: number; minSpendCents?: number; minOrders?: number
  /** W1-7 — the caller's own fallbacks where the strategy sets no group (a rule's documented defaults, the recommendations' window). */
  defaults?: { windowDays?: number; minSpendCents?: number; minOrders?: number }
  adGroupExternalIds?: string[]
} = {}): Promise<HarvestPreview> {
  const own = opts.windowDays != null || opts.minSpendCents != null || opts.minOrders != null
  const named = own ? opts : opts.defaults ?? {}
  const defaults = {
    windowDays: named.windowDays ?? DEFAULT_WINDOW_DAYS,
    minSpendCents: named.minSpendCents ?? DEFAULT_MIN_SPEND_CENTS,
    minOrders: named.minOrders ?? DEFAULT_MIN_ORDERS,
  }
  const strategy = own ? null : await openTermsStrategy()
  const windows = [...new Set([defaults.windowDays, ...(strategy?.windows ?? [])])]
  const totals = new Map<number, Map<string, HarvestCandidate>>()
  for (const w of windows) totals.set(w, await termTotals(w, opts.adGroupExternalIds))
  // The windows nest (each ends now), so the widest holds every term any of them holds.
  const widest = totals.get(Math.max(...windows))!
  const terms = strategy ? await termsForAdGroups(strategy, [...widest.values()].map((t) => ({ market: t.market ?? null, externalAdGroupId: t.externalAdGroupId }))) : new Map<string, StrategyTerms>()

  const negatives: HarvestCandidate[] = []
  const graduations: HarvestCandidate[] = []
  const productNegatives: HarvestCandidate[] = []
  const productGraduations: HarvestCandidate[] = []
  // Which strategy group chose each candidate, to count them once the lists are final.
  const groups = new Map<string, HarvestCriteriaUsed['strategy'][number]>()
  const groupOf = new Map<HarvestCandidate, string>()
  const add = (c: HarvestCandidate, kind: 'negate' | 'graduate', by: StrategyTerms['harvest'] | StrategyTerms['negate'] | null) => {
    let cand = c
    if (by) {
      const s = by.source
      const source = { level: s.level, label: s.label, version: s.version, ...(s.product ? { product: s.product } : {}) }
      cand = { ...c, strategy: { windowDays: by.group.windowDays, ...source } }
      const key = `${kind}|${s.strategyId}|${s.product ?? ''}`
      if (!groups.has(key)) groups.set(key, { group: kind === 'graduate' ? 'harvest' : 'negate', source, thresholds: by.group, candidates: 0 })
      groupOf.set(cand, key)
    }
    // H.5 — ASIN queries become PRODUCT-target candidates; everything else stays keyword candidates.
    const asin = isAsinQuery(cand.query)
    if (kind === 'negate') (asin ? productNegatives : negatives).push(cand)
    else (asin ? productGraduations : graduations).push(cand)
  }
  const base = totals.get(defaults.windowDays)!
  for (const [key, any] of widest) {
    const t = terms.get(`${any.market}|${any.externalAdGroupId}`)
    if (!t) {
      // The caller's numbers, or the defaults: no order and at least the spend → negate; at least the orders → graduate.
      const c = base.get(key)
      if (!c) continue
      if (c.orders === 0 && c.costCents >= defaults.minSpendCents) add(c, 'negate', null)
      else if (c.orders >= defaults.minOrders) add(c, 'graduate', null)
      continue
    }
    // W1-7 — a strategy group decides; the defaults stand in for a group the strategy does not set here.
    const h = t.harvest?.group ?? { minOrders: defaults.minOrders, minClicks: 0, maxAcosPct: null, windowDays: defaults.windowDays }
    const n = t.negate?.group ?? { minClicks: 0, minSpendCents: defaults.minSpendCents, maxOrders: 0, windowDays: defaults.windowDays }
    const g = totals.get(h.windowDays)!.get(key)
    if (g && meetsHarvest(g, h)) { add(g, 'graduate', t.harvest); continue }
    const x = totals.get(n.windowDays)!.get(key)
    if (x && meetsNegate(x, n)) add(x, 'negate', t.negate)
  }

  // W1-7 — the ASIN of a protected product is never offered as a negative (every writer refuses it).
  const held: Array<HarvestCandidate & { reason: string }> = []
  const kept: HarvestCandidate[] = []
  const byMarket = new Map<string | null, HarvestCandidate[]>()
  for (const c of productNegatives) byMarket.set(c.market ?? null, [...(byMarket.get(c.market ?? null) ?? []), c])
  for (const [market, list] of byMarket) {
    const hits = await protectedAsins(market, list.map((c) => c.query))
    for (const c of list) {
      const hit = hits.get(c.query.trim().toUpperCase())
      if (hit) held.push({ ...c, reason: `${hit.sku} is protected by the ads strategy in ${hit.market} (${sourceLabel(hit.source)}): its ASIN is never negated.` })
      else kept.push(c)
    }
  }

  negatives.sort((a, b) => b.costCents - a.costCents)
  graduations.sort((a, b) => b.orders - a.orders)
  kept.sort((a, b) => b.costCents - a.costCents)
  productGraduations.sort((a, b) => b.orders - a.orders)
  held.sort((a, b) => b.costCents - a.costCents)
  for (const c of [...negatives, ...graduations, ...kept, ...productGraduations]) {
    const key = groupOf.get(c)
    if (key) groups.get(key)!.candidates += 1
  }
  return {
    negatives, graduations, productNegatives: kept, productGraduations, windowDays: defaults.windowDays,
    criteria: { from: own ? 'caller' : 'strategy', defaults, strategy: [...groups.values()].filter((g) => g.candidates > 0) },
    protectedAsins: held,
  }
}

/**
 * HV.4 — one row per candidate the caller asked for, so a bulk write reports N outcomes rather
 * than one number. Additive: every counter below is unchanged, and
 * `ads-recommendations.service.ts:171/173` reads only those (the other reader,
 * `ads-auto-harvest.service.ts`, was retired in HP5, 2026-08-21).
 *
 * 🔴 `reachedAmazon` is `externalTargetId != null` — never "we called create". 209 of the engine's
 * 218 graduations reported success and do not exist at Amazon, because `createKeywordLocal` writes
 * the local row and the audit row whether or not the push landed. That is the defect this field
 * exists to make impossible to repeat.
 *
 * `outcome` is three of C7's four words. "proposed" cannot occur here: this path only runs when an
 * operator has already decided.
 */
export interface HarvestOutcome {
  query: string
  matchType: string
  sourceAdGroupId: string | null
  destinationAdGroupId: string | null
  targetId: string | null
  externalTargetId: string | null
  reachedAmazon: boolean
  /** null when no isolation negative was attempted — see `negateReason` for why */
  negative: {
    attempted: boolean
    scope: 'AD_GROUP' | 'CAMPAIGN'
    targetId: string | null
    externalTargetId: string | null
    reachedAmazon: boolean
    refusal?: { deniedAt: string; reason: string }
    error?: string
  } | null
  /** the sentence explaining the negative's presence or absence, composed once, server-side */
  negateReason: string
  outcome: 'acted' | 'refused' | 'failed'
  refusal?: { deniedAt: string; reason: string }
  error?: string
}

/** One negative write, as it actually resolved. `externalTargetId` is the only proof it landed. */
type NegRow = { matchType: string; externalTargetId: string | null; denied?: { deniedAt: string; reason: string } }

/**
 * 🔴 HV.8a — the wasteful half of the write, reported per candidate.
 *
 * `negativesAdded` used to increment once per candidate the loop reached, discarding
 * `negateCampaign`'s return value entirely. That is `neg=8/8` in one line: for 72 nightly runs the
 * engine reported eight negatives created while **0 of 20** campaign-scoped rows in this account
 * have ever carried an Amazon id. The counter now advances only for rows Amazon confirmed, and this
 * array carries the rest with their reason — the same bar HV.4 held for keywords.
 */
export interface HarvestNegativeOutcome {
  query: string
  scope: 'AD_GROUP' | 'CAMPAIGN'
  matchTypes: string[]
  externalTargetId: string | null
  reachedAmazon: boolean
  outcome: 'acted' | 'refused' | 'failed'
  refusal?: { deniedAt: string; reason: string }
  error?: string
  /** The sentence explaining this row, composed once, server-side. */
  reason: string
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
  /** HV.4 — per-candidate outcomes. Empty for callers that do not ask for graduations. */
  outcomes: HarvestOutcome[]
  /** HV.8a — one row per WASTEFUL negative attempted, landed or not. Additive. */
  negativeOutcomes: HarvestNegativeOutcome[]
}
// AT.4b — per-(external)-ad-group match-type plan from a wizard rule's `sources`.
// Absent → the original defaults (graduate EXACT, negate NEGATIVE_EXACT). H.5 adds the product flags:
// graduateProduct/negateProduct gate whether converting/wasteful ASINs become product targets.
export type HarvestPlan = Record<string, { graduate?: string[]; negate?: string[]; graduateProduct?: boolean; negateProduct?: boolean }>

// H.2 — destination routing. matchType (EXACT/PHRASE/BROAD) → the LOCAL ad group of the campaign
// that hosts that match type in the same product group (e.g. EXACT → the Exact campaign). A graduated
// keyword is created there instead of back in the source ad group. Absent → graduate in source (the
// standalone "Auto harvest & negate" template, unchanged).
export async function applyHarvest(args: {
  negatives?: HarvestCandidate[]
  graduations?: Array<HarvestCandidate & { bidEur?: number; evidence?: AdWriteEvidence | null }>
  productNegatives?: HarvestCandidate[]
  productGraduations?: Array<HarvestCandidate & { bidEur?: number }>
  userId?: string
  plan?: HarvestPlan
  destinations?: Record<string, string>
  protectConverting?: boolean
  protectDays?: number
  /**
   * The scope BOTH negation paths write at — the wasteful loop and the isolation negative.
   *
   * 🔴 HV.8a moved the default from CAMPAIGN to **AD_GROUP**. CAMPAIGN has landed 0 of 20 rows in
   * this account's history; AD_GROUP has landed 2,017 of 2,037. Pass CAMPAIGN explicitly if you
   * want the broader block and are willing to be the first to prove it works.
   */
  negateScope?: 'AD_GROUP' | 'CAMPAIGN'
}): Promise<HarvestApplyResult> {
  const result: HarvestApplyResult = { negativesAdded: 0, keywordsGraduated: 0, isolationNegativesAdded: 0, productsGraduated: 0, productNegativesAdded: 0, errors: [], negativesProtected: 0, protectedTerms: [], outcomes: [], negativeOutcomes: [] }

  /**
   * 🔴 HV.4 — the isolation negative's SCOPE, and the account decided this.
   *
   * Measured 2026-08-12: AD_GROUP-scoped negatives 2,037, of which **2,017 reached Amazon (99%)**;
   * CAMPAIGN-scoped negatives 20, of which **0 reached Amazon (0%)**, newest 2026-06-24. Every
   * campaign-scoped negative this account has ever created failed. NEG.0(b) repaired the
   * missing-`marketplace` cause so it may work now, but it has never once been observed to.
   *
   * Functionally the isolation negative's job is to stop THE SOURCE AD GROUP competing with the
   * keyword we just created. Campaign scope blocks the term across every ad group in that
   * campaign — broader than the job, and if a destination ever shares the source's campaign it
   * would negate the very keyword being created.
   *
   * ── 🔴 HV.8a, 2026-08-13 — the default MOVED, and it changes both existing callers ───────────
   *
   * HV.4 left it at CAMPAIGN so `ads-auto-harvest.service.ts:48` and
   * `ads-recommendations.service.ts:171/173` stayed byte-identical. Byte-identical to what, though:
   * re-measured today the split is unchanged at **2,037 / 2,017 (99%)** against **20 / 0 (0%)**,
   * and the diagnosis is now closed rather than suspected. Every one of the 20 was written BEFORE
   * NEG.0(b) landed (2026-08-12); all 20 carry a `create_negative_keyword` audit row from
   * `automation:auto-harvest`, `lastSyncStatus` NULL and `lastSyncError` NULL — the signature of a
   * gate denial that the old code did not throw on, so the local mirror was written anyway. Zero
   * campaign-scoped rows exist since the repair, because HV.0 disarmed the engine the same day.
   *
   * So the compatibility being preserved was compatibility with a path that has never once worked,
   * and the "safe" default was the one that silently negates nothing. Preserving it is the riskier
   * choice, not the safer one. The cron is dry-running behind HV.0, which makes this the safest
   * moment the default will ever move. Both callers still compile: only the default changed.
   *
   * CAMPAIGN remains reachable by passing it explicitly, and now reports honestly when it does not
   * land rather than assuming it never does.
   */
  const negScope: 'AD_GROUP' | 'CAMPAIGN' = args.negateScope ?? 'AD_GROUP'

  // NEG.0(a) — one read for the whole batch, then a pure decision per term.
  //
  // It covered the H.3 ISOLATION negation too, so every isolation negative was refused: a graduated
  // term converted by definition. 5d (Owner decision D4) — the operator decided the exemption this
  // comment left open: the isolation negative skips this guard, but only after the keyword LANDED in
  // a different ad group (the term is routed there, not blocked). So only the wasteful terms are read.
  const protectConfig: ProtectConvertingConfig = {
    enabled: args.protectConverting !== false,
    days: args.protectDays != null && Number(args.protectDays) > 0 ? Math.floor(Number(args.protectDays)) : 30,
  }
  const candidateTerms = (args.negatives ?? []).map((c) => c.query)
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

  /**
   * The negation, at campaign or ad-group scope. 5b — through `writeNegativeKeyword`, the one negative write service: it
   * pushes (gated: protected terms, text limits, the allowlist), reads back a create that came back without an id
   * (HV.9a — moved there from here), and only then writes the local row and its audit row. A refusal is returned with
   * the gate's own words rather than thrown (C7): the promotion half may well have succeeded and the operator has to
   * see both. A refused or failed negative leaves no local row — the one HV.8a counted 20 of, all from a gate denial
   * the old code did not throw on.
   *
   * HV.4 — AD_GROUP has landed 2,017 of 2,037 rows in this account; CAMPAIGN 0 of 20 before NEG.0(b). Returns the rows
   * so the caller reports `reachedAmazon` per negative rather than a count that cannot be read back to a term.
   */
  const negate = async (scope: 'AD_GROUP' | 'CAMPAIGN', externalCampaignId: string, externalAdGroupId: string, query: string, planNegate?: string[]): Promise<NegRow[]> => {
    // 5d (review 7.5) — an ASIN is a product: one negative product target in its ad group, whatever the plan's
    // keyword match types say. Nexus has no campaign-level product negative, so that scope is refused by name.
    if (isAsinQuery(query)) {
      if (scope === 'CAMPAIGN') return [{ matchType: 'PRODUCT', externalTargetId: null, denied: { deniedAt: 'asin_campaign_level', reason: `"${query.trim()}" is an ASIN, a product. Nexus negates a product only inside an ad group, as a negative product target, so no campaign-level negative was made.` } }]
      const ag = await prisma.adGroup.findFirst({ where: { externalAdGroupId, campaign: { externalCampaignId } }, select: { id: true } })
      if (!ag) return [{ matchType: 'PRODUCT', externalTargetId: null, denied: { deniedAt: 'ad_group_unknown', reason: `Nexus holds no ad group ${externalAdGroupId}, so the negative product target could not be made.` } }]
      const r = await writeNegativeProductTarget({ adGroupId: ag.id, asin: query.trim(), userId: args.userId })
      if (r.refusal) return [{ matchType: 'PRODUCT', externalTargetId: null, denied: { deniedAt: r.refusal.deniedAt, reason: r.refusal.reason } }]
      if (r.outcome === 'failed') throw new Error(r.error ?? 'the negative product target was not created')
      return [{ matchType: 'PRODUCT', externalTargetId: r.externalTargetId }]
    }
    const negMatches = planNegate?.length ? planNegate : ['EXACT']
    const out: NegRow[] = []
    for (const nm of negMatches) {
      // Amazon SP has no negative-broad. A plan asking for one used to be sent as `NEGATIVE_BROAD` and rejected
      // downstream; name it here instead.
      if (nm !== 'EXACT' && nm !== 'PHRASE') throw new Error(`unsupported negative match type "${nm}" — Amazon SP accepts EXACT and PHRASE only`)
      const r = await writeNegativeKeyword({
        scope, externalCampaignId, ...(scope === 'AD_GROUP' ? { externalAdGroupId } : {}),
        keywordText: query, matchType: nm, userId: args.userId,
      })
      if (r.refusal) { out.push({ matchType: nm, externalTargetId: null, denied: { deniedAt: r.refusal.deniedAt, reason: r.refusal.reason } }); continue }
      if (r.outcome === 'failed') throw new Error(r.error ?? 'the negative was not created')
      out.push({ matchType: nm, externalTargetId: r.externalTargetId })
    }
    return out
  }

  for (const n of args.negatives ?? []) {
    const refused = refusalFor(n.query)
    if (refused) {
      recordRefusal(n.query, 'wasteful', refused)
      result.negativeOutcomes.push({ query: n.query, scope: negScope, matchTypes: [], externalTargetId: null, reachedAmazon: false, outcome: 'refused', refusal: { deniedAt: 'protect_converting', reason: refused.reason }, reason: `Not negated: ${refused.reason}` })
      continue
    }
    try {
      const planNegate = args.plan?.[n.externalAdGroupId]?.negate
      const rows = await negate(negScope, n.externalCampaignId, n.externalAdGroupId, n.query, planNegate)
      const landed = rows.filter((r) => r.externalTargetId != null)
      const denied = rows.find((r) => r.denied)
      // 🔴 Only what Amazon confirmed. A local mirror is a record of intent, not a negation.
      result.negativesAdded += landed.length
      result.negativeOutcomes.push({
        query: n.query,
        scope: negScope,
        matchTypes: rows.map((r) => r.matchType),
        externalTargetId: landed[0]?.externalTargetId ?? null,
        reachedAmazon: landed.length > 0,
        outcome: landed.length > 0 ? 'acted' : denied ? 'refused' : 'failed',
        ...(denied?.denied ? { refusal: denied.denied } : {}),
        reason: landed.length > 0
          ? `Negated at ${negScope === 'AD_GROUP' ? 'ad-group' : 'campaign'} scope; Amazon confirmed it.`
          : denied?.denied
            ? `Refused at ${denied.denied.deniedAt}: ${denied.denied.reason}`
            : `Amazon returned no id and a read-back did not find it, so this term is NOT negated at Amazon. Nothing was created; retrying is safe.`,
      })
    } catch (e) {
      result.errors.push(`neg "${n.query}": ${(e as Error).message}`)
      result.negativeOutcomes.push({ query: n.query, scope: negScope, matchTypes: [], externalTargetId: null, reachedAmazon: false, outcome: 'failed', error: (e as Error).message, reason: `Failed: ${(e as Error).message}` })
    }
  }

  for (const g of args.graduations ?? []) {
    try {
      // Source local ad group the term came from (by external id) — fallback destination + lets us
      // tell whether a graduation actually landed in a different ad group (drives H.3 isolation).
      const srcAg = await prisma.adGroup.findFirst({ where: { externalAdGroupId: g.externalAdGroupId }, select: SOURCE_SELECT })
      // Bid = derived from observed CPC (cost/clicks) or a sensible default.
      const bidEur = g.bidEur ?? (g.clicks > 0 ? Math.max(0.05, g.costCents / g.clicks / 100) : 0.5)
      // 5d (review 7.5) — an ASIN graduates as a PRODUCT target (the PRODUCT destination), never as a keyword.
      const asin = isAsinQuery(g.query)
      const gradMatches = asin ? ['PRODUCT'] : args.plan?.[g.externalAdGroupId]?.graduate?.length ? args.plan[g.externalAdGroupId].graduate! : ['EXACT']
      const made: Array<{ matchType: string; destAdGroupId: string; targetId: string; externalTargetId: string | null }> = []
      let noDestination = false
      for (const gm of gradMatches) {
        // H.2 — route into the destination campaign that hosts this match type (EXACT → Exact
        // campaign), not back into the source. Fall back to the source ad group when no destination
        // of that kind exists (back-compat / standalone template) — 5d: only when the source can take it.
        const destAdGroupId = args.destinations?.[gm] ?? (takesTargets(srcAg) ? srcAg!.id : null)
        if (!destAdGroupId) { noDestination = true; result.errors.push(`grad "${g.query}" (${gm}): ${NO_DESTINATION}`); continue }
        const k = asin
          ? await createTargetLocal({ adGroupId: destAdGroupId, kind: 'PRODUCT', value: g.query.trim(), bidEur, userId: args.userId })
          : await createKeywordLocal({ adGroupId: destAdGroupId, keywordText: g.query, matchType: gm as 'EXACT' | 'PHRASE' | 'BROAD', bidEur, userId: args.userId, evidence: g.evidence ?? null })
        made.push({ matchType: gm, destAdGroupId, targetId: k.id, externalTargetId: k.externalTargetId })
      }
      if (made.length) { if (asin) result.productsGraduated++; else result.keywordsGraduated++ }

      // H.3 — isolation: negate the winner in its source so the discovery ad group stops competing with
      // the new tighter target. Match types come from the source row's negate plan (default EXACT; an ASIN
      // gets a negative product target). writeNegativeKeyword is idempotent + write-gated.
      // 5d (review 7.3, Owner decision D4) — only once the target LANDED at Amazon in a DIFFERENT ad group:
      // never when the create failed, and never when it landed in the source (a negative there would cancel
      // it). It used to fire whenever a destination was named, landed or not. It skips the converting guard
      // (the term is routed, not blocked); protected terms, text limits and the write gate still bind.
      const promotedElsewhere = !!srcAg && made.some((m) => m.externalTargetId != null && m.destAdGroupId !== srcAg.id)
      let negOutcome: HarvestOutcome['negative'] = null
      // The §4.1 sentence. HV.3 renders the same wording before the write; this records it after.
      let negateReason = promotedElsewhere
        ? 'The keyword landed elsewhere, so the source was negated.'
        : made.some((m) => m.externalTargetId != null)
          ? `No negative was created: the keyword was created in the ad group that discovered it, so applyHarvest's isolation negative does not fire.`
          : 'No negative was created: nothing reached Amazon, so the source is not negated.'
      if (promotedElsewhere) {
        try {
          if (negScope === 'AD_GROUP') {
            const rows = await negate('AD_GROUP', g.externalCampaignId, g.externalAdGroupId, g.query, args.plan?.[g.externalAdGroupId]?.negate)
            const landed = rows.filter((r) => r.externalTargetId != null)
            const denied = rows.find((r) => r.denied)
            result.isolationNegativesAdded += landed.length
            negOutcome = { attempted: true, scope: 'AD_GROUP', targetId: null, externalTargetId: landed[0]?.externalTargetId ?? null, reachedAmazon: landed.length > 0, ...(denied?.denied ? { refusal: denied.denied } : {}) }
            negateReason = denied?.denied
              ? `The keyword was created, but the negative was refused at ${denied.denied.deniedAt}: ${denied.denied.reason}`
              : `The keyword landed elsewhere, so this term was negated in its source ad group.`
          } else {
            // HV.8a — campaign scope now reports what it actually did, exactly as the ad-group
            // branch does. It used to hardcode `reachedAmazon: false`, which was true of every row
            // this account has ever written but was an assumption rather than a reading.
            const rows = await negate('CAMPAIGN', g.externalCampaignId, g.externalAdGroupId, g.query, args.plan?.[g.externalAdGroupId]?.negate)
            const landed = rows.filter((r) => r.externalTargetId != null)
            const denied = rows.find((r) => r.denied)
            result.isolationNegativesAdded += landed.length
            negOutcome = { attempted: true, scope: 'CAMPAIGN', targetId: null, externalTargetId: landed[0]?.externalTargetId ?? null, reachedAmazon: landed.length > 0, ...(denied?.denied ? { refusal: denied.denied } : {}) }
            negateReason = landed.length > 0
              ? `The keyword landed elsewhere, so this term was negated at campaign scope.`
              : denied?.denied
                ? `The keyword was created, but the negative was refused at ${denied.denied.deniedAt}: ${denied.denied.reason}`
                : `The keyword landed elsewhere, but the campaign-scope negative did not reach Amazon.`
          }
        } catch (e) {
          negOutcome = { attempted: true, scope: negScope, targetId: null, externalTargetId: null, reachedAmazon: false, error: (e as Error).message }
          negateReason = `The keyword was created, but the negative failed: ${(e as Error).message}`
          result.errors.push(`iso-neg "${g.query}": ${(e as Error).message}`)
        }
      }

      // 🔴 One outcome row per candidate. `reachedAmazon` is the external id, never the call.
      const first = made[0]
      result.outcomes.push({
        query: g.query,
        matchType: first?.matchType ?? (gradMatches[0] ?? 'EXACT'),
        sourceAdGroupId: srcAg?.id ?? null,
        destinationAdGroupId: first?.destAdGroupId ?? null,
        targetId: first?.targetId ?? null,
        externalTargetId: first?.externalTargetId ?? null,
        reachedAmazon: !!first && first.externalTargetId != null,
        negative: negOutcome,
        negateReason,
        outcome: made.length > 0 ? 'acted' : noDestination ? 'refused' : 'failed',
        ...(made.length === 0 && noDestination ? { refusal: { deniedAt: 'no_destination', reason: NO_DESTINATION } } : {}),
      })
    } catch (e) {
      result.errors.push(`grad "${g.query}": ${(e as Error).message}`)
      result.outcomes.push({
        query: g.query, matchType: 'EXACT', sourceAdGroupId: null, destinationAdGroupId: null,
        targetId: null, externalTargetId: null, reachedAmazon: false, negative: null,
        negateReason: 'Nothing was written, so no negative was attempted.',
        outcome: 'failed', error: (e as Error).message,
      })
    }
  }

  // ── H.5 — product-target harvesting (ASIN candidates) ──────────────────────────────
  // Negate a wasteful/promoted ASIN in its SOURCE ad group (ad-group-scoped negative product target,
  // idempotent + local-mirrored). Returns false if the source ad group isn't local.
  const negateProductInSource = async (externalAdGroupId: string, asin: string): Promise<boolean> => {
    const srcAg = await prisma.adGroup.findFirst({ where: { externalAdGroupId }, select: { id: true } })
    if (!srcAg) return false
    // 5b — a refused or failed one is an error the caller records, and leaves no local row.
    const r = await writeNegativeProductTarget({ adGroupId: srcAg.id, asin, userId: args.userId })
    if (r.outcome === 'refused' || r.outcome === 'failed') throw new Error(r.refusal ? `refused at ${r.refusal.deniedAt}: ${r.refusal.reason}` : r.error ?? 'not created')
    return true
  }

  for (const pg of args.productGraduations ?? []) {
    if (args.plan?.[pg.externalAdGroupId]?.graduateProduct !== true) continue // only when the row opted into product graduation
    try {
      const srcAg = await prisma.adGroup.findFirst({ where: { externalAdGroupId: pg.externalAdGroupId }, select: SOURCE_SELECT })
      const bidEur = pg.bidEur ?? (pg.clicks > 0 ? Math.max(0.05, pg.costCents / pg.clicks / 100) : 0.5)
      // H.2-analog — route the converting ASIN into the PRODUCT destination (the PAT campaign), fallback source
      // (5d: only when the source can take a product target).
      const destAdGroupId = args.destinations?.PRODUCT ?? (takesTargets(srcAg) ? srcAg!.id : null)
      if (!destAdGroupId) { result.errors.push(`prod-grad "${pg.query}": ${NO_DESTINATION}`); continue }
      const made = await createTargetLocal({ adGroupId: destAdGroupId, kind: 'PRODUCT', value: pg.query, bidEur, userId: args.userId })
      result.productsGraduated++
      // H.3-analog — isolate: negate the ASIN in its source, 5d: only once it LANDED in a different ad group.
      if (srcAg && destAdGroupId !== srcAg.id && made.externalTargetId != null) {
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
