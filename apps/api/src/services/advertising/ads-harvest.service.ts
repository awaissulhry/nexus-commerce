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
// PB-6a — winners stay: the lock every rule's harvest asks (L1 binds every caller in the write service), the bid modes, the band.
import { blockedPositive, blockedWords, familyAdGroups, homeOf, negativeKey, positivesIn, productFamilyOf, standingNegativesIn, type NegativeMatch, type Positive } from './ads-winner-lock.js'
import { normalizeHarvestBidMode, resolveHarvestBidEur } from './ads-harvest-wire.js'
import { bidLimitsFor, clampToStrategy } from './ads-strategy/bids.js'
// PB-6b — the intent router: a source's destination may pick the product's Brand, Competitor or Category ad group.
import { destinationAdGroups, resolveDestination, type HarvestDestination, type Intent } from './ads-harvest-route.js'

/**
 * 5d (review 7.4) — the source ad group is a fallback destination only when it can take a keyword or product
 * target: a manual Sponsored Products campaign. An automatic one cannot, so the create failed and left a local row.
 */
// Batch 2 review fix — and its campaign's portfolio: the Owner's harvest destination may be stored at the portfolio grain.
const SOURCE_SELECT = { id: true, externalAdGroupId: true, campaignId: true, campaign: { select: { targetingType: true, adProduct: true, type: true, marketplace: true, portfolioId: true } } } as const
const takesTargets = (ag: { campaign: { targetingType: string | null; adProduct: string | null; type: string | null } | null } | null): boolean =>
  !!ag?.campaign && ag.campaign.targetingType === 'MANUAL' && adProductOf(ag.campaign) === SPONSORED_PRODUCTS
const NO_DESTINATION = 'No destination was given for this match type, and the ad group this term came from is not in a manual Sponsored Products campaign, so it cannot take it. Nothing was created.'
/**
 * ONE BRAIN AB-11 — the defect "a harvest with no destination never negates its source" (harvest-destination.service.ts
 * header), fixed: with no destination named for a match type, the harvest destination is RESOLVED — the one stored for
 * the source's scope (set-harvest-destination), else the only ad group the harvest resolver offers — and the keyword lands
 * there, so the isolation negative fires. When none resolves (none fits, or several could and none is stored) nothing is
 * created: a keyword is never graduated back into the ad group that found it, where its source could never be negated.
 * The Owner's stored destination may still BE the source (his choice), or say negateAtSource off: both are kept.
 */
const unresolved = (r: { source: string; shortlist: unknown[]; refusal?: string }, gm: string) => r.source === 'resolved-ambiguous'
  ? `No destination is set for this match type, and ${r.shortlist.length} ad groups of this product could take it, so none was chosen. Nothing was created — never back into the ad group that found it, whose source negative could then never fire; store one with set-harvest-destination.`
  : r.source === 'resolved-paused'
    // Batch 2 review fix — the only candidate does not serve (its campaign or ad group is not ENABLED).
    ? `No destination is set for this match type. ${r.refusal ?? 'The only ad group that could take it does not serve.'} Nothing was created.`
    : `No destination is set for this match type and no manual ${gm === 'PRODUCT' ? 'product-target' : gm.toLowerCase()} ad group advertises this product here, so nothing was created — never back into the ad group that found it, whose source negative could then never fire.`
/** PB-6a — a source whose own plan names no destination for a match type (the wizard could not tell its theme). */
const UNROUTED = 'Two or more of this rule\'s campaigns take this match type, and which one fits this source (brand, competitor or category) could not be told, so no destination was chosen for it. Nothing was created; set the destination on the rule.'
/** PB-6b — a stored destination no ad group can be read from (a router missing one of its ad groups, or an ASIN sent to it). */
const UNREADABLE = 'This rule\'s destination for this match type cannot be read (an ASIN is never routed by intent), so nothing was created.'

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
export async function searchTermTotals(windowDays: number, adGroupExternalIds?: string[]): Promise<Map<string, HarvestCandidate>> {
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

/** W1-7 — the numbers a caller names: any of the three is its own, used whole; else its fallbacks where the strategy sets no group. */
export interface HarvestCriteria {
  windowDays?: number; minSpendCents?: number; minOrders?: number
  /** W1-7 — the caller's own fallbacks where the strategy sets no group (a rule's documented defaults, the recommendations' window). */
  defaults?: { windowDays?: number; minSpendCents?: number; minOrders?: number }
}

function criteriaOf(opts: HarvestCriteria) {
  const own = opts.windowDays != null || opts.minSpendCents != null || opts.minOrders != null
  const named = own ? opts : opts.defaults ?? {}
  return {
    own,
    defaults: {
      windowDays: named.windowDays ?? DEFAULT_WINDOW_DAYS,
      minSpendCents: named.minSpendCents ?? DEFAULT_MIN_SPEND_CENTS,
      minOrders: named.minOrders ?? DEFAULT_MIN_ORDERS,
    },
  }
}

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
export async function previewHarvest(opts: HarvestCriteria & { adGroupExternalIds?: string[] } = {}): Promise<HarvestPreview> {
  const { own, defaults } = criteriaOf(opts)
  const strategy = own ? null : await openTermsStrategy()
  const windows = [...new Set([defaults.windowDays, ...(strategy?.windows ?? [])])]
  const totals = new Map<number, Map<string, HarvestCandidate>>()
  for (const w of windows) totals.set(w, await searchTermTotals(w, opts.adGroupExternalIds))
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
      // The caller's numbers, or the defaults: at least the orders → graduate; no order and at least the spend → negate.
      // PB-6a (L3) — the harvest bar is asked first, as where the strategy decides: a winner is never a waste negative.
      const c = base.get(key)
      if (!c) continue
      // A term graduates only once it has sold: a rule that names 0 orders (a Negative Targeting rule's "Orders = 0")
      // means "no order" for its negatives, never "every term is a winner".
      if (c.orders > 0 && c.orders >= defaults.minOrders) add(c, 'graduate', null)
      else if (c.orders === 0 && c.costCents >= defaults.minSpendCents) add(c, 'negate', null)
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
  /**
   * PB-6a (L2) — set when a rule's harvest found the term already at home in the product's campaigns (a positive
   * EXACT keyword with its text, or its product target): nothing was created and it is not counted as graduated.
   */
  home?: { adGroupId: string; adTargetId: string; live: boolean }
  /** PB-6b — the intent router chose the destination: the product's Brand, Competitor or Category ad group. */
  intent?: Intent
}

/**
 * One negative write, as it actually resolved. `externalTargetId` is the only proof it landed. `existed`: it already
 * stood (nothing was added, so it is not counted).
 */
type NegRow = { matchType: string; externalTargetId: string | null; existed?: boolean; denied?: { deniedAt: string; reason: string } }

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
// PB-6a — and, per source: whether its lists are literal (v2), its own destinations, when it is closed, the new bid.
export type HarvestPlan = Record<string, HarvestPlanRow>
export interface HarvestPlanRow {
  graduate?: string[]; negate?: string[]; graduateProduct?: boolean; negateProduct?: boolean
  /** PB-6a — a v2 rule's lists are literal: [] = none, absent = EXACT. A v1 row reads an empty list as EXACT. */
  literal?: boolean
  /**
   * PB-6a — this source's own landing per match type; beats the call's `destinations`. null: none could be chosen (said).
   * PB-6b — or the intent router (ads-harvest-route.ts): the product's Brand, Competitor or Category ad group by the
   * term's words. An ASIN (PRODUCT) lands in one ad group, never through the router.
   */
  destinations?: Record<string, HarvestDestination | null>
  /**
   * PB-6a (L4) — close the source the moment the term lands elsewhere (handover "landed"). False: only once its new home
   * meets the harvest bar there ("proven", the Owner's choice). Absent: proven on a rule's harvest, landed otherwise.
   */
  negateOnLanding?: boolean
  /**
   * PB-6b — false: a term that graduated from this source is never negated there — not at the landing, not once its new
   * home proves itself (the playbook's harvest edge says not to negate the source). Its waste negatives are unaffected.
   * Absent: true.
   */
  negateSource?: boolean
  /** PB-6a — the new target's bid, in the harvest wire's modes (cpc, cpcPlus, adGroupDefault, fixed). */
  bid?: { mode?: unknown; value?: unknown }
}

/** PB-6a — a plan row's match types: a v1 row reads an empty list as EXACT; a v2 (`literal`) row's [] is none. */
export const planList = (row: HarvestPlanRow | undefined, key: 'graduate' | 'negate'): string[] =>
  row?.literal ? row[key] ?? ['EXACT'] : row?.[key]?.length ? row[key]! : ['EXACT']

/**
 * PB-6a — a rule's harvest (harvest_and_negate) and what binds it beyond what binds every caller (L1, a negative never
 * over a keyword of its own ad group, binds them all inside the negative write service):
 *   L2  a term that already has a home among the ad groups of the SAME product in its market is not created again
 *       (`home`). The product: what the rule's own ad groups advertise (`ownAdGroups`; a rule without sources: the
 *       term's source ad group), with its sibling variants of one parent. Another product's keyword is never a home.
 *   L4  its source is closed only when its plan row says `negateOnLanding`, else once that home meets the harvest bar.
 *   bid a bid the rule does not name follows the source's bid mode (refused by name when it cannot), else the term's
 *       CPC, else (no clicks) the strategy's lowest bid or the ad group's default bid; held inside the strategy band.
 * `criteria` are the numbers the candidates were chosen with (previewHarvest's), so a home is judged on the identical bar.
 */
export interface HarvestRuleLock {
  /** AdGroup.ids a compiled rule names as the product's own (its linked slots), added to the product's ad groups. */
  homeScope?: string[]
  /** AdGroup.ids whose products are the rule's own (its sources). Absent: each term's own source ad group. */
  ownAdGroups?: string[]
  /**
   * PB-6b — a compiled playbook rule: a term's home is looked up ONLY in the rule's listed slots (`homeScope`) and the ad
   * groups its routers may land in — never in a product family read from its ad groups. An adopted slot may advertise
   * another product too, and that product's keyword must never count as this one's home (the Owner's rule 3).
   */
  listedOnly?: boolean
  criteria: HarvestCriteria
}

type SourceRow = { id: string; externalAdGroupId: string | null; campaignId?: string | null; campaign: { targetingType: string | null; adProduct: string | null; type: string | null; marketplace: string | null; portfolioId?: string | null } | null }

interface Lock {
  /** Each candidate's source ad group, by Amazon's ad-group id. */
  sources: Map<string, SourceRow>
  /** A rule's harvest: positives by AdGroup.id (the product's ad groups, every source and destination). Grows as it creates. */
  positives: Map<string, Positive[]>
  /** L2 — each source ad group's product scope (AdGroup.ids). */
  scopes: Map<string, string[]>
  /** winnerKey(term, home) of each home that meets the harvest bar there. */
  winners: Set<string>
  /** AB-11 — the destination resolved for a graduation that names none (resolvedKey), or why none was. */
  resolved: Map<string, { adGroupId: string; keepSource: boolean } | { deniedAt: string; why: string }>
  /**
   * Batch 2 re-review fix — the graduations (resolvedKey) whose Owner's stored destination says negateAtSource off. His
   * choice wins over every source negative of the term — at the landing AND at a later handover (a home that meets the
   * harvest bar), whether or not his destination could be used now.
   */
  keeps: Set<string>
}

/** AB-11 — the key of a resolved destination: the source ad group, the match type and the term. */
const resolvedKey = (srcId: string, gm: string, query: string) => `${srcId}|${gm}|${normaliseNegTerm(query)}`

/** The key of a term's home: the normalised term and the home's AdGroup.id. */
export const winnerKey = (term: string, adGroupId: string) => `${normaliseNegTerm(term)}|${adGroupId}`

/** PB-6b — every ad group a plan row's routers may land in. */
const routerAdGroupsOf = (row: HarvestPlanRow | undefined): string[] =>
  Object.values(row?.destinations ?? {}).filter((d) => d != null && typeof d !== 'string').flatMap(destinationAdGroups)

const destinationsOf = (plan: HarvestPlan | undefined, destinations: Record<string, string> | undefined): string[] => [
  ...Object.values(destinations ?? {}),
  ...Object.values(plan ?? {}).flatMap((row) => Object.values(row.destinations ?? {}).flatMap(destinationAdGroups)),
].filter((id): id is string => typeof id === 'string' && !!id)

type Landing = { adGroupId: string; intent?: Intent; /** AB-11 — the Owner's stored destination says not to negate the source. */ keepSource?: boolean }

/**
 * Where a graduation of this match type lands: the source's own destination, the call's, else the source (5d). PB-6b — a
 * source's own destination may be the intent router: the term's words pick the ad group (`intent` says which).
 */
function landingOf(gm: string, query: string, src: SourceRow | null, row: HarvestPlanRow | undefined, destinations: Record<string, string> | undefined, resolved?: Lock['resolved']): Landing | { deniedAt: string; why: string } {
  if (row?.destinations && gm in row.destinations) {
    const own = row.destinations[gm]
    if (!own) return { deniedAt: 'no_destination', why: UNROUTED }
    return resolveDestination(query, own) ?? { deniedAt: 'no_destination', why: UNREADABLE }
  }
  const named = destinations?.[gm]
  if (named) return { adGroupId: named }
  // AB-11 — the resolved destination (stored, else the resolver's only one); never back into the source by default.
  const r = src ? resolved?.get(resolvedKey(src.id, gm, query)) : undefined
  if (r) return 'adGroupId' in r ? { adGroupId: r.adGroupId, ...(r.keepSource ? { keepSource: true } : {}) } : r
  return { deniedAt: 'no_destination', why: NO_DESTINATION }
}

/**
 * AB-11 — the destinations of the graduations that name none (no plan row destination, no call destination for the match
 * type): resolved once for the batch through the Keyword Harvest page's own resolver (harvest-destination.service.ts).
 * Batch 2 review fix — the stored destination is looked up along the whole chain the Keyword Harvest tab and
 * set-harvest-destination save to, the source campaign's portfolio included (as accountWideLanding and the brain's harvest
 * read it): the Owner's destinations are stored at the portfolio grain. And the graph is read for the batch's sources only
 * (their products in their markets, and the stored destinations), not the whole business (a rule runs every 15 minutes).
 */
async function resolveUnnamed(lock: Lock, items: ReadonlyArray<{ query: string; externalAdGroupId: string; matches: readonly string[] }>, plan: HarvestPlan | undefined, destinations: Record<string, string> | undefined): Promise<void> {
  const asks: Array<{ query: string; gm: string; src: SourceRow }> = []
  for (const it of items) {
    const src = lock.sources.get(it.externalAdGroupId)
    if (!src) continue
    const row = plan?.[it.externalAdGroupId]
    for (const gm of it.matches) {
      if ((row?.destinations && gm in row.destinations) || destinations?.[gm]) continue
      if (!lock.resolved.has(resolvedKey(src.id, gm, it.query))) asks.push({ query: it.query, gm, src })
    }
  }
  if (!asks.length) return
  const { loadDestinationGraph, resolveStoredDestinations, resolveDestination, sourceLines, storedDestinationRefusal } = await import('./harvest-destination.service.js')
  // Batch 2 re-review fix — the product line too (the page's and the brain's `line` grain): the whole chain is read.
  const lines = await sourceLines([...new Set(asks.map((a) => a.src.id))])
  const storedBy = new Map<string, Awaited<ReturnType<typeof resolveStoredDestinations>>>()
  for (const { src } of asks) {
    if (storedBy.has(src.id)) continue
    storedBy.set(src.id, await resolveStoredDestinations({
      market: src.campaign?.marketplace ?? 'all', line: lines.get(src.id) ?? null, portfolio: src.campaign?.portfolioId ?? null, campaign: src.campaignId ?? null, adGroup: src.id,
    }))
  }
  const graph = await loadDestinationGraph({
    sourceAdGroupIds: [...storedBy.keys()],
    alsoAdGroupIds: [...storedBy.values()].flatMap((m) => [...m.values()].map((d) => d.adGroupId)),
  })
  for (const a of asks) {
    const stored = storedBy.get(a.src.id)!
    const createType = (a.gm === 'PRODUCT' ? 'PRODUCT' : a.gm) as 'EXACT' | 'PHRASE' | 'BROAD' | 'PRODUCT'
    const r = resolveDestination({ graph, stored, sourceAdGroupId: a.src.id, sourceAdGroupName: '', term: a.query, kind: createType === 'PRODUCT' ? 'product' : 'keyword', createType })
    const key = resolvedKey(a.src.id, a.gm, a.query)
    const st = stored.get(createType)
    if (st?.negateAtSource === false) lock.keeps.add(key)
    // The Owner's stored destination, his choice whole: gone or in another market refuses by name (never the resolver's pick).
    const storedNo = storedDestinationRefusal({ stored, createType, resolved: r, graph, sourceMarket: a.src.campaign?.marketplace ?? null })
    if (storedNo) { lock.resolved.set(key, { deniedAt: 'no_destination', why: storedNo }); continue }
    if (!r.chosen) { lock.resolved.set(key, { deniedAt: 'no_destination', why: unresolved(r, a.gm) }); continue }
    // The Owner's stored destination may be the source itself, or keep the source: his choice, kept.
    lock.resolved.set(key, { adGroupId: r.chosen.adGroupId, keepSource: r.chosen.adGroupId === a.src.id || st?.negateAtSource === false })
  }
}

/** The positives a term is looked up in for a home: its product's ad groups, its source and its destination. */
const homePositives = (lock: Lock, src: SourceRow | null, destId: string | null): Positive[] =>
  [...new Set([...(src ? lock.scopes.get(src.id) ?? [] : []), src?.id, destId].filter((id): id is string => !!id))].flatMap((id) => lock.positives.get(id) ?? [])

const homeMatch = (gm: string) => (gm === 'PHRASE' || gm === 'BROAD' ? gm : 'EXACT') as 'EXACT' | 'PHRASE' | 'BROAD'

/** `keepSource`: the Owner's stored destination keeps this term's source (negateAtSource off) — on every kind of step. */
type GradStep = { kind: 'home'; home: Positive; keepSource?: boolean } | { kind: 'create'; adGroupId: string; intent?: Intent; keepSource?: boolean } | { kind: 'refused'; deniedAt: string; why: string; keepSource?: boolean }

/**
 * PB-6a — one graduation's step under the lock (L2 first: a term at home stays there, wherever it would land). Batch 2
 * re-review fix — a step at home or refused carries the Owner's negateAtSource off too (lock.keeps), so a later handover
 * never negates the source he keeps.
 */
function gradStep(lock: Lock, rule: boolean, query: string, gm: string, src: SourceRow | null, row: HarvestPlanRow | undefined, destinations: Record<string, string> | undefined): GradStep {
  const landing = landingOf(gm, query, src, row, destinations, lock.resolved)
  const ownerKeeps = !!src && lock.keeps.has(resolvedKey(src.id, gm, query))
  const keep = ownerKeeps ? { keepSource: true } : {}
  if (rule) {
    const home = homeOf(query, homePositives(lock, src, 'adGroupId' in landing ? landing.adGroupId : null), homeMatch(gm))
    if (home) return { kind: 'home', home, ...keep }
  }
  return 'adGroupId' in landing
    ? { kind: 'create', adGroupId: landing.adGroupId, ...(landing.intent ? { intent: landing.intent } : {}), ...(landing.keepSource || ownerKeeps ? { keepSource: true } : {}) }
    : { kind: 'refused', ...landing, ...keep }
}

/** PB-6b — the source row that is never closed for a graduated term (its edge says not to negate the source). */
const keepsSource = (row: HarvestPlanRow | undefined) => row?.negateSource === false

/** PB-6a (L4) — the home elsewhere whose turn it is to take the term over from its source, or null. */
function provenHome(lock: Lock, query: string, src: SourceRow | null, homes: readonly Positive[], negateOnLanding: boolean, keep = false): Positive | null {
  if (!src || keep) return null
  const away = homes.filter((h) => h.adGroupId !== src.id)
  return away.find((h) => negateOnLanding || lock.winners.has(winnerKey(query, h.adGroupId))) ?? null
}

/** PB-6b — what a source that is never closed says. */
const KEPT_SOURCE = 'This source is never negated for a term that graduated from it (its harvest edge says not to negate the source), so the term keeps running there too.'

/** The sentence an `alreadyHome` outcome says. */
function homeWords(home: Positive, src: SourceRow | null, closed: boolean, kept = false): string {
  const what = home.match === 'PRODUCT' ? 'a product target' : `${home.match === 'EXACT' ? 'an exact' : `a ${home.match.toLowerCase()}`} keyword`
  if (src && home.adGroupId === src.id) return `It is already ${what} of the ad group it converted in, so it stays there: nothing was created and nothing negated.`
  if (kept) return `It already lives as ${what} in this product's campaigns${home.live ? '' : ' (not yet live at Amazon)'}, so it was not created again. ${KEPT_SOURCE}`
  return closed
    ? `It already lives as ${what} in this product's campaigns, and there it now meets the harvest bar, so it was not created again and its source was negated.`
    : `It already lives as ${what} in this product's campaigns${home.live ? '' : ' (not yet live at Amazon)'}, so it was not created again. It keeps running in its source until that keyword meets the harvest bar there.`
}

/** A card proposed one step; today's data gives another: it is left for the next card. */
const STEP_CHANGED = 'The card proposed another step for this term than today\'s data gives, so nothing was done; the next card proposes it again.'

/**
 * PB-6a (L4) — which homes are winners: the term's search-term totals in the home's ad group meet the harvest bar
 * there — the bar previewHarvest asks with the same criteria (a rule's own numbers whole; else the ads strategy's harvest
 * group for that ad group; else the defaults), and a winner has sold. No new number. Keys: winnerKey(term, home id).
 */
export async function homeWinners(homes: ReadonlyArray<{ term: string; adGroupId: string }>, criteria: HarvestCriteria): Promise<Set<string>> {
  const out = new Set<string>()
  if (!homes.length) return out
  const { own, defaults } = criteriaOf(criteria)
  const groups = await prisma.adGroup.findMany({
    where: { id: { in: [...new Set(homes.map((h) => h.adGroupId))] } },
    select: { id: true, externalAdGroupId: true, campaign: { select: { marketplace: true } } },
  })
  const placed = new Map(groups.filter((g) => g.externalAdGroupId).map((g) => [g.id, { ext: g.externalAdGroupId!, market: strategyMarketOf(g.campaign?.marketplace) }]))
  const fallback: HarvestThresholds = { minOrders: defaults.minOrders, minClicks: 0, maxAcosPct: null, windowDays: defaults.windowDays }
  const strategy = own ? null : await openTermsStrategy()
  const terms = strategy ? await termsForAdGroups(strategy, [...placed.values()].map((g) => ({ market: g.market, externalAdGroupId: g.ext }))) : new Map<string, StrategyTerms>()
  const barOf = (g: { ext: string; market: string | null }) => terms.get(`${g.market}|${g.ext}`)?.harvest?.group ?? fallback
  const byWindow = new Map<number, Set<string>>()
  for (const g of placed.values()) {
    const w = barOf(g).windowDays
    byWindow.set(w, (byWindow.get(w) ?? new Set()).add(g.ext))
  }
  const sums = new Map<string, { orders: number; clicks: number; costCents: number; salesCents: number }>()
  for (const [w, exts] of byWindow) {
    for (const t of (await searchTermTotals(w, [...exts])).values()) {
      const key = `${w}|${t.externalAdGroupId}|${normaliseNegTerm(t.query)}`
      const sum = sums.get(key) ?? { orders: 0, clicks: 0, costCents: 0, salesCents: 0 }
      sum.orders += t.orders; sum.clicks += t.clicks; sum.costCents += t.costCents; sum.salesCents += t.salesCents
      sums.set(key, sum)
    }
  }
  for (const h of homes) {
    const g = placed.get(h.adGroupId)
    if (!g) continue
    const bar = barOf(g)
    const t = sums.get(`${bar.windowDays}|${g.ext}|${normaliseNegTerm(h.term)}`)
    if (t && t.orders > 0 && meetsHarvest(t, bar)) out.add(winnerKey(h.term, h.adGroupId))
  }
  return out
}

/** PB-6a — the lock's reads for one batch: the sources and, on a rule's harvest, the product's ad groups, their positives and the winning homes. */
async function readLock(args: {
  candidates: HarvestCandidate[]; graduating: Array<{ c: HarvestCandidate; product: boolean }>
  plan?: HarvestPlan; destinations?: Record<string, string>; rule?: HarvestRuleLock
}): Promise<Lock> {
  const exts = [...new Set(args.candidates.map((c) => c.externalAdGroupId))]
  const rows = exts.length ? await prisma.adGroup.findMany({ where: { externalAdGroupId: { in: exts } }, select: SOURCE_SELECT }) : []
  const sources = new Map<string, SourceRow>()
  for (const r of rows) if (r.externalAdGroupId && !sources.has(r.externalAdGroupId)) sources.set(r.externalAdGroupId, r)
  const lock: Lock = { sources, positives: new Map(), scopes: new Map(), winners: new Set(), resolved: new Map(), keeps: new Set() }
  // AB-11 — the graduations that name no destination get one resolved (never back into their source).
  await resolveUnnamed(lock, args.graduating.map(({ c, product }) => ({ query: c.query, externalAdGroupId: c.externalAdGroupId, matches: product || isAsinQuery(c.query) ? ['PRODUCT'] : planList(args.plan?.[c.externalAdGroupId], 'graduate') })), args.plan, args.destinations)
  if (!args.rule) return lock
  // L2 — the product's ad groups in the source's market: one family for the rule's own ad groups, else per source.
  const own = args.rule.ownAdGroups?.length ? args.rule.ownAdGroups : null
  const families = new Map<string, Promise<string[]>>()
  for (const src of sources.values()) {
    // PB-6b — and the ad groups this source's router may land in: a term at home in the product's Exact | Category stays
    // there even when the router would now pick Exact | Brand (L2 beats the router).
    const routed = src.externalAdGroupId ? routerAdGroupsOf(args.plan?.[src.externalAdGroupId]) : []
    // PB-6b — a compiled playbook rule names its product's ad groups itself: no family is read (rule 3).
    if (args.rule.listedOnly) { lock.scopes.set(src.id, [...new Set([...(args.rule.homeScope ?? []), ...routed])]); continue }
    const market = src.campaign?.marketplace ?? null
    const key = own ? `rule|${strategyMarketOf(market)}` : `source|${src.id}`
    if (!families.has(key)) families.set(key, productFamilyOf(own ?? [src.id]).then((family) => familyAdGroups(family, market)))
    lock.scopes.set(src.id, [...new Set([...(await families.get(key)!), ...(args.rule.homeScope ?? []), ...routed])])
  }
  lock.positives = await positivesIn([...[...lock.scopes.values()].flat(), ...rows.map((r) => r.id), ...destinationsOf(args.plan, args.destinations)])
  // The homes a handover may follow: found before anything is created (a home this batch creates is not a winner yet).
  const homes: Array<{ term: string; adGroupId: string }> = []
  for (const { c, product } of args.graduating) {
    const src = sources.get(c.externalAdGroupId) ?? null
    const row = args.plan?.[c.externalAdGroupId]
    const matches = product || isAsinQuery(c.query) ? ['PRODUCT'] : planList(row, 'graduate')
    for (const gm of matches) {
      const step = gradStep(lock, true, c.query, gm, src, row, args.destinations)
      if (step.kind === 'home' && step.home.adGroupId !== src?.id) homes.push({ term: c.query, adGroupId: step.home.adGroupId })
    }
  }
  lock.winners = await homeWinners(homes, args.rule.criteria)
  return lock
}

type BandCache = Map<string, Promise<{ limits: Awaited<ReturnType<typeof bidLimitsFor>>; defaultEur: number | null }>>

/**
 * PB-6a — a new target's starting bid: the caller's (a rule's own number, a person's), else the source's bid mode (a mode
 * that cannot produce one is refused by name: never a silent fallback), else the term's CPC, else — no clicks — the
 * strategy's lowest bid or the ad group's default bid; a rule's is held inside the destination's strategy band.
 */
async function startBid(cache: BandCache, g: HarvestCandidate & { bidEur?: number }, row: HarvestPlanRow | undefined, destAdGroupId: string, rule: boolean): Promise<{ bidEur: number } | { deniedAt: string; why: string }> {
  const band = () => {
    let b = cache.get(destAdGroupId)
    if (!b) {
      cache.set(destAdGroupId, (b = prisma.adGroup.findUnique({ where: { id: destAdGroupId }, select: { defaultBidCents: true, campaign: { select: { marketplace: true } } } })
        .then(async (ag) => ({ limits: await bidLimitsFor({ marketplace: ag?.campaign?.marketplace ?? null, adGroupId: destAdGroupId }), defaultEur: ag?.defaultBidCents != null ? ag.defaultBidCents / 100 : null }))))
    }
    return b
  }
  const cpc = g.clicks > 0 ? g.costCents / g.clicks / 100 : null
  let eur = g.bidEur ?? null
  if (eur == null && row?.bid) {
    const value = row.bid.value != null && row.bid.value !== '' && Number.isFinite(Number(row.bid.value)) ? Number(row.bid.value) : null
    const r = resolveHarvestBidEur(normalizeHarvestBidMode(row.bid.mode), value, cpc, (await band()).defaultEur)
    if ('refuse' in r) return { deniedAt: 'bid', why: `No starting bid: ${r.refuse}. Nothing was created; set the bid on the rule.` }
    eur = r.bidEur
  }
  if (eur == null && cpc != null) eur = Math.max(0.05, cpc)
  if (eur == null) {
    const { limits, defaultEur } = await band()
    eur = limits.minBidCents ? limits.minBidCents.value / 100 : defaultEur
    if (eur == null) return { deniedAt: 'bid', why: 'The term has no clicks to take a cost per click from, and neither the ads strategy (a lowest bid) nor the ad group (a default bid) names a bid to start at. Nothing was created.' }
  }
  return { bidEur: rule ? clampToStrategy(Math.round(eur * 100), (await band()).limits).cents / 100 : eur }
}

/** PB-6a — the card's items: what a rule's harvest would do, one row per candidate (kind, term, ad group, step). */
export type HarvestItemKind = 'negative' | 'graduation' | 'productNegative' | 'productGraduation'
export interface HarvestItem {
  kind: HarvestItemKind; query: string; externalAdGroupId: string; step: 'negate' | 'create' | 'handover' | 'refused'; why?: string
  /** PB-6b — the router's pick for a new keyword: the product's Brand, Competitor or Category ad group. */
  intent?: Intent
}
export const harvestItemKey = (i: { kind: string; query: string; externalAdGroupId: string }) => `${i.kind}|${normaliseNegTerm(i.query)}|${i.externalAdGroupId}`

export interface HarvestRulePlan {
  /** The candidates a run would act on, each list as applyHarvest takes it. */
  negatives: HarvestCandidate[]; graduations: HarvestCandidate[]; productNegatives: HarvestCandidate[]; productGraduations: HarvestCandidate[]
  /** What the card lists: every step a run would take, and every winner it would refuse (with its reason). */
  items: HarvestItem[]
  /** Left alone, each with its sentence: at home already (L2), a negative over its own keyword (L1). */
  keptHome: Array<{ query: string; externalAdGroupId: string; why: string }>
  blockedOwnKeyword: Array<{ query: string; externalAdGroupId: string; why: string }>
  /** Negatives that already stand where they would land: not proposed again. */
  alreadyStanding: number
}

/**
 * PB-6a — a rule's dry run with the lock applied: what applyHarvest would do with these candidates and what it would
 * leave alone, so a card proposes only what a run would really change. A winner it would refuse (no destination, no
 * bid) is listed too, with the reason: a card is never empty while winners wait. Reads only; the live run decides again.
 */
export async function planRuleHarvest(args: {
  negatives: HarvestCandidate[]; graduations: HarvestCandidate[]; productNegatives: HarvestCandidate[]; productGraduations: HarvestCandidate[]
  plan?: HarvestPlan; destinations?: Record<string, string>; rule: HarvestRuleLock
}): Promise<HarvestRulePlan> {
  const all = [...args.negatives, ...args.graduations, ...args.productNegatives, ...args.productGraduations]
  const graduating = [...args.graduations.map((c) => ({ c, product: false })), ...args.productGraduations.map((c) => ({ c, product: true }))]
  const lock = await readLock({ candidates: all, graduating, plan: args.plan, destinations: args.destinations, rule: args.rule })
  const sourceIds = [...lock.sources.values()].map((s) => s.id)
  const [standing, sourcePositives] = await Promise.all([standingNegativesIn(sourceIds), positivesIn(sourceIds)])
  const bands: BandCache = new Map()
  const out: HarvestRulePlan = { negatives: [], graduations: [], productNegatives: [], productGraduations: [], items: [], keptHome: [], blockedOwnKeyword: [], alreadyStanding: 0 }
  const item = (kind: HarvestItemKind, c: HarvestCandidate, step: HarvestItem['step'], why?: string, intent?: Intent) =>
    out.items.push({ kind, query: c.query, externalAdGroupId: c.externalAdGroupId, step, ...(why ? { why } : {}), ...(intent ? { intent } : {}) })
  /** The negatives of a source that would still be written: not over its own keyword (L1), not already standing. */
  const toWrite = (c: HarvestCandidate, matches: NegativeMatch[]): { write: NegativeMatch[]; blocked: Positive | null } => {
    const src = lock.sources.get(c.externalAdGroupId)
    const positives = src ? sourcePositives.get(src.id) ?? [] : []
    let blocked: Positive | null = null
    const write = matches.filter((m) => {
      const b = blockedPositive({ text: c.query, match: m }, positives)
      if (b) { blocked ??= b; return false }
      if (src && standing.has(negativeKey(src.id, m, c.query))) { out.alreadyStanding++; return false }
      return true
    })
    return { write, blocked }
  }
  const negMatches = (c: HarvestCandidate): NegativeMatch[] =>
    isAsinQuery(c.query) ? ['PRODUCT'] : planList(args.plan?.[c.externalAdGroupId], 'negate').filter((m): m is NegativeMatch => m === 'EXACT' || m === 'PHRASE')

  for (const [kind, list, into] of [['negative', args.negatives, out.negatives], ['productNegative', args.productNegatives, out.productNegatives]] as const) {
    for (const c of list) {
      const { write, blocked } = toWrite(c, kind === 'productNegative' ? ['PRODUCT'] : negMatches(c))
      if (write.length) { into.push(c); item(kind, c, 'negate') } else if (blocked) out.blockedOwnKeyword.push({ query: c.query, externalAdGroupId: c.externalAdGroupId, why: `Not negated: ${blockedWords(blocked)}` })
    }
  }
  for (const [kind, list, into] of [['graduation', args.graduations, out.graduations], ['productGraduation', args.productGraduations, out.productGraduations]] as const) {
    for (const c of list) {
      const src = lock.sources.get(c.externalAdGroupId) ?? null
      const row = args.plan?.[c.externalAdGroupId]
      const product = kind === 'productGraduation' || isAsinQuery(c.query)
      const steps = (product ? ['PRODUCT'] : planList(row, 'graduate')).map((gm) => gradStep(lock, true, c.query, gm, src, row, args.destinations))
      let refused = steps.find((s): s is Extract<GradStep, { kind: 'refused' }> => s.kind === 'refused') ?? null
      let creates: Extract<GradStep, { kind: 'create' }> | null = null
      for (const s of steps) {
        if (s.kind !== 'create') continue
        const bid = await startBid(bands, c, row, s.adGroupId, true)
        if ('why' in bid) refused ??= { kind: 'refused', ...bid }
        else creates ??= s
      }
      if (creates) { into.push(c); item(kind, c, 'create', undefined, creates.intent); continue }
      const homes = steps.flatMap((s) => (s.kind === 'home' ? [s.home] : []))
      // Batch 2 re-review fix — the Owner's negateAtSource off keeps the source here too: no handover is proposed.
      const keep = keepsSource(row) || steps.some((s) => s.keepSource === true)
      const proven = provenHome(lock, c.query, src, homes, row?.negateOnLanding === true, keep)
      if (proven) {
        const { write } = toWrite(c, product ? ['PRODUCT'] : negMatches(c))
        if (write.length) { into.push(c); item(kind, c, 'handover'); continue }
      }
      if (homes.length) { out.keptHome.push({ query: c.query, externalAdGroupId: c.externalAdGroupId, why: homeWords(homes[0], src, false, keep) }); continue }
      if (refused) item(kind, c, 'refused', refused.why)
    }
  }
  return out
}

// H.2 — destination routing. matchType (EXACT/PHRASE/BROAD) → the LOCAL ad group of the campaign
// that hosts that match type in the same product group (e.g. EXACT → the Exact campaign). A graduated
// keyword is created there instead of back in the source ad group. Absent → graduate in source (the
// standalone "Auto harvest & negate" template, unchanged).
export async function applyHarvest(args: {
  negatives?: HarvestCandidate[]
  /** PB-6a — `step`: an accepted card's step for this term; a 'create' never becomes a source negation, nor the reverse. */
  graduations?: Array<HarvestCandidate & { bidEur?: number; evidence?: AdWriteEvidence | null; step?: 'create' | 'handover' }>
  productNegatives?: HarvestCandidate[]
  productGraduations?: Array<HarvestCandidate & { bidEur?: number; step?: 'create' | 'handover' }>
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
  /**
   * PB-6a — set by a rule's harvest: the winners-stay lock binds (HarvestRuleLock). Absent (a person's promote, a
   * recommendation's accept): as before. L1 binds every caller, in the negative write service.
   */
  rule?: HarvestRuleLock
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

  // PB-6a — the lock's reads, once for the batch: the sources and (a rule) the product's ad groups and winning homes.
  const lock = await readLock({
    candidates: [...(args.negatives ?? []), ...(args.graduations ?? []), ...(args.productNegatives ?? []), ...(args.productGraduations ?? [])],
    graduating: [...(args.graduations ?? []).map((c) => ({ c, product: false })), ...(args.productGraduations ?? []).filter((c) => args.plan?.[c.externalAdGroupId]?.graduateProduct === true).map((c) => ({ c, product: true }))],
    plan: args.plan, destinations: args.destinations, rule: args.rule,
  })
  /** PB-6a — a target this batch created is a home for the rest of it (the same term from a second source). */
  const remember = (p: Positive) => lock.positives.set(p.adGroupId, [...(lock.positives.get(p.adGroupId) ?? []), p])
  const bands: BandCache = new Map()

  /**
   * The negation, at campaign or ad-group scope. 5b — through `writeNegativeKeyword`, the one negative write service: it
   * pushes (gated: protected terms, text limits, the allowlist), reads back a create that came back without an id
   * (HV.9a — moved there from here), and only then writes the local row and its audit row. A refusal is returned with
   * the gate's own words rather than thrown (C7): the promotion half may well have succeeded and the operator has to
   * see both. A refused or failed negative leaves no local row — the one HV.8a counted 20 of, all from a gate denial
   * the old code did not throw on. PB-6a — the service also refuses one that would block a keyword where it lands.
   *
   * HV.4 — AD_GROUP has landed 2,017 of 2,037 rows in this account; CAMPAIGN 0 of 20 before NEG.0(b). Returns the rows
   * so the caller reports `reachedAmazon` per negative rather than a count that cannot be read back to a term.
   */
  const negate = async (scope: 'AD_GROUP' | 'CAMPAIGN', externalCampaignId: string, externalAdGroupId: string, query: string, negMatches: string[]): Promise<NegRow[]> => {
    // 5d (review 7.5) — an ASIN is a product: one negative product target in its ad group, whatever the plan's
    // keyword match types say. Nexus has no campaign-level product negative, so that scope is refused by name.
    if (isAsinQuery(query)) {
      if (scope === 'CAMPAIGN') return [{ matchType: 'PRODUCT', externalTargetId: null, denied: { deniedAt: 'asin_campaign_level', reason: `"${query.trim()}" is an ASIN, a product. Nexus negates a product only inside an ad group, as a negative product target, so no campaign-level negative was made.` } }]
      const ag = await prisma.adGroup.findFirst({ where: { externalAdGroupId, campaign: { externalCampaignId } }, select: { id: true } })
      if (!ag) return [{ matchType: 'PRODUCT', externalTargetId: null, denied: { deniedAt: 'ad_group_unknown', reason: `Nexus holds no ad group ${externalAdGroupId}, so the negative product target could not be made.` } }]
      const r = await writeNegativeProductTarget({ adGroupId: ag.id, asin: query.trim(), userId: args.userId })
      if (r.refusal) return [{ matchType: 'PRODUCT', externalTargetId: null, denied: { deniedAt: r.refusal.deniedAt, reason: r.refusal.reason } }]
      if (r.outcome === 'failed') throw new Error(r.error ?? 'the negative product target was not created')
      return [{ matchType: 'PRODUCT', externalTargetId: r.externalTargetId, existed: r.outcome === 'already_existed' }]
    }
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
      out.push({ matchType: nm, externalTargetId: r.externalTargetId, existed: r.outcome === 'already_existed' })
    }
    return out
  }

  for (const n of args.negatives ?? []) {
    // PB-6a — a v2 source that negates nothing is passed over (its rule asked for none).
    const negMatches = planList(args.plan?.[n.externalAdGroupId], 'negate')
    if (!negMatches.length && !isAsinQuery(n.query)) continue
    const refused = refusalFor(n.query)
    if (refused) {
      recordRefusal(n.query, 'wasteful', refused)
      result.negativeOutcomes.push({ query: n.query, scope: negScope, matchTypes: [], externalTargetId: null, reachedAmazon: false, outcome: 'refused', refusal: { deniedAt: 'protect_converting', reason: refused.reason }, reason: `Not negated: ${refused.reason}` })
      continue
    }
    try {
      const rows = await negate(negScope, n.externalCampaignId, n.externalAdGroupId, n.query, negMatches)
      const landed = rows.filter((r) => r.externalTargetId != null)
      const denied = rows.find((r) => r.denied)
      // 🔴 Only what Amazon confirmed. A local mirror is a record of intent, not a negation. PB-6a — and one that
      // already stood was not added now.
      result.negativesAdded += landed.filter((r) => !r.existed).length
      result.negativeOutcomes.push({
        query: n.query,
        scope: negScope,
        matchTypes: rows.map((r) => r.matchType),
        externalTargetId: landed[0]?.externalTargetId ?? null,
        reachedAmazon: landed.length > 0,
        outcome: landed.length > 0 ? 'acted' : denied ? 'refused' : 'failed',
        ...(denied?.denied ? { refusal: denied.denied } : {}),
        reason: landed.length > 0
          ? landed.every((r) => r.existed)
            ? 'It already stood at Amazon; nothing new was added.'
            : `Negated at ${negScope === 'AD_GROUP' ? 'ad-group' : 'campaign'} scope; Amazon confirmed it.`
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
      const srcAg = lock.sources.get(g.externalAdGroupId) ?? null
      const row = args.plan?.[g.externalAdGroupId]
      // 5d (review 7.5) — an ASIN graduates as a PRODUCT target (the PRODUCT destination), never as a keyword.
      const asin = isAsinQuery(g.query)
      const gradMatches = asin ? ['PRODUCT'] : planList(row, 'graduate')
      const made: Array<{ matchType: string; destAdGroupId: string; targetId: string; externalTargetId: string | null; existed: boolean; intent?: Intent }> = []
      // PB-6a (L2) — where the term already lives in this product's campaigns: it is not created again.
      const homes: Positive[] = []
      let refusal: { deniedAt: string; why: string } | null = null
      let ownerKeeps = false
      for (const gm of gradMatches) {
        // H.2 — route into the destination campaign that hosts this match type (EXACT → Exact
        // campaign), not back into the source. Fall back to the source ad group when no destination
        // of that kind exists (back-compat / standalone template) — 5d: only when the source can take it.
        const step = gradStep(lock, !!args.rule, g.query, gm, srcAg, row, args.destinations)
        // Batch 2 re-review fix — the Owner's negateAtSource off is read on every step (a term at home included): it keeps
        // the source at a later handover too, never only at the landing.
        if (step.keepSource) ownerKeeps = true
        if (step.kind === 'home') { homes.push(step.home); continue }
        if (step.kind === 'refused') { refusal ??= step; result.errors.push(`grad "${g.query}" (${gm}): ${step.why}`); continue }
        // PB-6a — an accepted handover never creates: today's data asks a create, so it waits for the next card.
        if (g.step === 'handover') { refusal ??= { deniedAt: 'step_changed', why: STEP_CHANGED }; continue }
        const bid = await startBid(bands, g, row, step.adGroupId, !!args.rule)
        if ('why' in bid) { refusal ??= bid; result.errors.push(`grad "${g.query}" (${gm}): ${bid.why}`); continue }
        const k = asin
          ? await createTargetLocal({ adGroupId: step.adGroupId, kind: 'PRODUCT', value: g.query.trim(), bidEur: bid.bidEur, userId: args.userId })
          : await createKeywordLocal({ adGroupId: step.adGroupId, keywordText: g.query, matchType: gm as 'EXACT' | 'PHRASE' | 'BROAD', bidEur: bid.bidEur, userId: args.userId, evidence: g.evidence ?? null })
        const existed = !asin && (k as { existed?: boolean }).existed === true
        made.push({ matchType: gm, destAdGroupId: step.adGroupId, targetId: k.id, externalTargetId: k.externalTargetId, existed, ...(step.intent ? { intent: step.intent } : {}) })
        if (k.id) remember({ adTargetId: k.id, adGroupId: step.adGroupId, text: g.query, match: asin ? 'PRODUCT' : homeMatch(gm), live: k.externalTargetId != null })
      }
      // PB-6a — counted only when it reached Amazon now (a keyword that was already there is not graduated again).
      if (made.some((m) => m.externalTargetId != null && !m.existed)) { if (asin) result.productsGraduated++; else result.keywordsGraduated++ }

      // H.3 — isolation: negate the winner in its source so the discovery ad group stops competing with the new tighter
      // target. Match types come from the source row's negate plan (default EXACT; an ASIN gets a negative product
      // target). writeNegativeKeyword is idempotent + write-gated. It skips the converting guard (the term is routed,
      // not blocked); protected terms, text limits, a keyword of the source and the write gate still bind.
      // 5d (review 7.3, Owner decision D4) — never when the create failed, and never in the ad group that holds it.
      // PB-6a (L4) — when: at the landing (`negateOnLanding`: a person's promote, and a rule that asks for it), or — a
      // rule's default, the Owner's choice — only once the term's home there meets the harvest bar (the term keeps
      // running where it wins until then). An accepted create never turns into this handover.
      // PB-6b — a source whose edge says not to negate it is never closed, at the landing or after.
      const keep = keepsSource(row) || ownerKeeps
      const negateOnLanding = !keep && (row?.negateOnLanding ?? !args.rule)
      const landedElsewhere = !!srcAg && made.some((m) => m.externalTargetId != null && m.destAdGroupId !== srcAg.id)
      const proven = g.step === 'create' ? null : provenHome(lock, g.query, srcAg, homes, negateOnLanding, keep)
      const closeSource = (landedElsewhere && negateOnLanding) || !!proven
      const sourceNegates = asin ? ['PRODUCT'] : planList(row, 'negate')
      let negOutcome: HarvestOutcome['negative'] = null
      // The §4.1 sentence. HV.3 renders the same wording before the write; this records it after.
      let negateReason = proven
        ? homeWords(proven, srcAg, true)
        : keep && landedElsewhere
          ? `The keyword landed elsewhere. ${KEPT_SOURCE}`
          : landedElsewhere && !negateOnLanding
            ? 'The keyword landed elsewhere. The term keeps running in its source until the new keyword meets the harvest bar there; only then is the source negated.'
            : landedElsewhere
              ? 'The keyword landed elsewhere, so the source was negated.'
              : homes.length
                ? homeWords(homes[0], srcAg, false, keep)
                : made.some((m) => m.externalTargetId != null)
                  ? `No negative was created: the keyword was created in the ad group that discovered it, so applyHarvest's isolation negative does not fire.`
                  : 'No negative was created: nothing reached Amazon, so the source is not negated.'
      if (closeSource && !sourceNegates.length) {
        negateReason = `${negateReason} This source's plan negates nothing, so no negative was made.`
      } else if (closeSource) {
        try {
          const rows = await negate(negScope, g.externalCampaignId, g.externalAdGroupId, g.query, sourceNegates)
          const landed = rows.filter((r) => r.externalTargetId != null)
          const denied = rows.find((r) => r.denied)
          result.isolationNegativesAdded += landed.filter((r) => !r.existed).length
          negOutcome = { attempted: true, scope: negScope, targetId: null, externalTargetId: landed[0]?.externalTargetId ?? null, reachedAmazon: landed.length > 0, ...(denied?.denied ? { refusal: denied.denied } : {}) }
          if (denied?.denied) negateReason = `${made.length ? 'The keyword was created' : 'The term is at home'}, but the negative was refused at ${denied.denied.deniedAt}: ${denied.denied.reason}`
          else if (!proven) {
            // HV.8a — campaign scope reports what it actually did, exactly as the ad-group branch does.
            negateReason = negScope === 'AD_GROUP'
              ? `The keyword landed elsewhere, so this term was negated in its source ad group.`
              : landed.length > 0
                ? `The keyword landed elsewhere, so this term was negated at campaign scope.`
                : `The keyword landed elsewhere, but the campaign-scope negative did not reach Amazon.`
          }
        } catch (e) {
          negOutcome = { attempted: true, scope: negScope, targetId: null, externalTargetId: null, reachedAmazon: false, error: (e as Error).message }
          negateReason = `${made.length ? 'The keyword was created' : 'The term is at home'}, but the negative failed: ${(e as Error).message}`
          result.errors.push(`iso-neg "${g.query}": ${(e as Error).message}`)
        }
      }

      // 🔴 One outcome row per candidate. `reachedAmazon` is the external id, never the call.
      const first = made[0]
      const home = homes[0]
      const handedOver = !made.length && !!negOutcome?.reachedAmazon
      result.outcomes.push({
        query: g.query,
        matchType: first?.matchType ?? (gradMatches[0] ?? 'EXACT'),
        sourceAdGroupId: srcAg?.id ?? null,
        destinationAdGroupId: first?.destAdGroupId ?? home?.adGroupId ?? null,
        targetId: first?.targetId ?? null,
        externalTargetId: first?.externalTargetId ?? null,
        reachedAmazon: !!first && first.externalTargetId != null,
        negative: negOutcome,
        negateReason,
        outcome: made.length > 0 || handedOver ? 'acted' : home || refusal ? 'refused' : 'failed',
        ...(made.length === 0 && !handedOver && home ? { refusal: { deniedAt: 'already_home', reason: homeWords(home, srcAg, false, keep) } } : {}),
        ...(made.length === 0 && !home && refusal ? { refusal: { deniedAt: refusal.deniedAt, reason: refusal.why } } : {}),
        ...(home ? { home: { adGroupId: home.adGroupId, adTargetId: home.adTargetId, live: home.live } } : {}),
        ...(first?.intent ? { intent: first.intent } : {}),
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
  // idempotent + local-mirrored). Returns false if the source ad group isn't local, or the negative already stood.
  const negateProductInSource = async (externalAdGroupId: string, asin: string): Promise<boolean> => {
    const srcAg = lock.sources.get(externalAdGroupId)
    if (!srcAg) return false
    // 5b — a refused or failed one is an error the caller records, and leaves no local row.
    const r = await writeNegativeProductTarget({ adGroupId: srcAg.id, asin, userId: args.userId })
    if (r.outcome === 'refused' || r.outcome === 'failed') throw new Error(r.refusal ? `refused at ${r.refusal.deniedAt}: ${r.refusal.reason}` : r.error ?? 'not created')
    return r.outcome !== 'already_existed'
  }

  for (const pg of args.productGraduations ?? []) {
    const row = args.plan?.[pg.externalAdGroupId]
    if (row?.graduateProduct !== true) continue // only when the row opted into product graduation
    try {
      const srcAg = lock.sources.get(pg.externalAdGroupId) ?? null
      // H.2-analog — route the converting ASIN into the PRODUCT destination (the PAT campaign), fallback source
      // (5d: only when the source can take a product target). PB-6a (L2) — an ASIN already targeted here stays.
      const step = gradStep(lock, !!args.rule, pg.query, 'PRODUCT', srcAg, row, args.destinations)
      if (step.kind === 'refused') { result.errors.push(`prod-grad "${pg.query}": ${step.why}`); continue }
      let landedElsewhere = false
      if (step.kind === 'create') {
        if (pg.step === 'handover') { result.errors.push(`prod-grad "${pg.query}": ${STEP_CHANGED}`); continue }
        const bid = await startBid(bands, pg, row, step.adGroupId, !!args.rule)
        if ('why' in bid) { result.errors.push(`prod-grad "${pg.query}": ${bid.why}`); continue }
        const made = await createTargetLocal({ adGroupId: step.adGroupId, kind: 'PRODUCT', value: pg.query, bidEur: bid.bidEur, userId: args.userId })
        if (made.externalTargetId != null) result.productsGraduated++
        if (made.id) remember({ adTargetId: made.id, adGroupId: step.adGroupId, text: pg.query, match: 'PRODUCT', live: made.externalTargetId != null })
        landedElsewhere = !!srcAg && step.adGroupId !== srcAg.id && made.externalTargetId != null
      }
      // H.3-analog — isolate: negate the ASIN in its source, 5d: only once it LANDED in a different ad group; PB-6a (L4):
      // on a rule's harvest only once its home there meets the harvest bar (never for an accepted create).
      // Batch 2 re-review fix — the Owner's negateAtSource off keeps the source on every step, a home's handover included.
      const keep = keepsSource(row) || step.keepSource === true
      const negateOnLanding = !keep && (row?.negateOnLanding ?? !args.rule)
      const proven = step.kind === 'home' && pg.step !== 'create' ? provenHome(lock, pg.query, srcAg, [step.home], negateOnLanding, keep) : null
      if ((landedElsewhere && negateOnLanding) || proven) {
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
