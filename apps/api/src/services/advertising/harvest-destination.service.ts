/**
 * HV.3 — where a graduated keyword would go, and what that decides.
 *
 * ── 🔴 The coupling this module exists to make visible ────────────────────────────────────────
 *
 * `applyHarvest` (`ads-harvest.service.ts:123, :133`):
 *
 *     const destAdGroupId  = args.destinations?.[gm] ?? srcAg?.id
 *     const promotedElsewhere = !!srcAg && gradMatches.some((gm) => {
 *       const d = args.destinations?.[gm]; return !!d && d !== srcAg.id })
 *     if (promotedElsewhere) { … negateCampaign(…) }      ← the H.3 isolation negative
 *
 * **No destination ⇒ the keyword is created back in the ad group that discovered it ⇒
 * `promotedElsewhere` is false ⇒ the source is never negated.** "Promoted into the source" and
 * "did not negate the source" are ONE defect. Only the SP Super Wizard has ever populated that
 * map; `automation-templates.ts`'s standalone rule and `ads-auto-harvest.service.ts:48` both pass
 * `undefined`, so **every** harvest this account has ever run took the fallback.
 *
 * ── 🔴 Why the resolver proposes a SHORTLIST and never a destination ──────────────────────────
 *
 * Measured on prod 2026-08-12 across all 289 ad groups (`scripts/_hv-3-destination.mts`):
 *
 *   target EXACT   resolves for 287 of 287 sources · UNIQUE for **38 (13%)** · median 5 · max 21
 *   target PHRASE  284 of 287 · unique 48
 *   target BROAD   287 of 287 · unique 51
 *
 * Tightening the product key from the product LINE to the exact ASIN moves it 35 → 38 of 287. This
 * account advertises the same ASINs across many overlapping campaigns, so "the manual
 * keyword-targeted ad group for this product in this market whose role is EXACT" is five to
 * twenty-one ad groups. **A resolver that returns nine answers is a shortlist, not a proposal**,
 * and rendering one of the nine as "proposed" would be inventing certainty. The operator picks;
 * `AdsHarvestDestination` remembers.
 *
 * This contradicts the session brief, which recommended by-product as the proposal and the picker
 * as the override. It is the other way round for this account, and the numbers above are why.
 */

import prisma from '../../db.js'
// One product → ad-group walk for the whole codebase. Exported by HV.3 (one keyword, no behaviour
// change) rather than copied, so this page and the funnel can never disagree about which ad groups
// advertise a product.
import { gatherProductAdGroups } from './ads-keyword-funnel.service.js'

export type HvMatchRole = 'AUTO' | 'BROAD' | 'PHRASE' | 'EXACT'
/** The target types a harvest can CREATE — also the keys of `applyHarvest`'s `destinations` map. */
export type HvCreateType = 'EXACT' | 'PHRASE' | 'BROAD' | 'PRODUCT'
export type HvDestGrain = 'account' | 'market' | 'line' | 'portfolio' | 'campaign' | 'adGroup'
export const HV_DEST_GRAINS: HvDestGrain[] = ['adGroup', 'campaign', 'portfolio', 'line', 'market', 'account']
export const HV_DEST_ACCOUNT = '*'

/**
 * How a destination came to be what it is. C9: a surface rendering a change shows its evidence, or
 * says explicitly that it has none.
 */
export type HvDestSource = 'stored' | 'resolved-unique' | 'resolved-ambiguous' | 'none'

/**
 * The candidate's status **relative to its destination**, which is a different question from
 * HV.1's source-relative `status` and must never replace it on screen.
 *
 * HV.1 asked "does this keyword exist where the traffic came from?". That is a fact about the
 * account. This asks "would promoting create anything?", which is a fact about a *decision* — and
 * it is undecidable until a destination exists, which for 7 of today's 8 candidates it does not.
 */
export type HvDestStatus =
  /** no destination stored, and the resolver did not narrow to one — nothing is decided yet */
  | 'undecided'
  /** nothing resolves at all; the row is not promotable and HV.4 must refuse it */
  | 'no-destination'
  /** the destination holds no EXACT for this term — promoting creates something */
  | 'will-create'
  /** the destination already holds it, confirmed at Amazon — promoting creates nothing */
  | 'already-at-destination'
  /** the destination holds it but it never reached Amazon — Nexus thinks it is covered */
  | 'destination-local-only'
  /** 🔴 the destination does not hold it but another ad group does — a SECOND exact keyword */
  | 'would-duplicate'

export interface DestinationCandidate {
  adGroupId: string
  adGroupName: string
  campaignId: string
  campaignName: string
  campaignStatus: string | null
  role: HvMatchRole | null
  /** why this one is ranked where it is — shown in the picker, never inferred by the client */
  why: string
  /** `Campaign.maxBidCents` at THIS destination; the same term clamps differently per campaign */
  maxBidCents: number | null
  minBidCents: number | null
  /** does this ad group already hold an EXACT target for the term? */
  holdsTerm: boolean
  holdsTermAtAmazon: boolean
}

export interface ResolvedDestination {
  createType: HvCreateType
  source: HvDestSource
  chosen: DestinationCandidate | null
  /** every ad group the resolver considered plausible, best first */
  shortlist: DestinationCandidate[]
  status: HvDestStatus
  /**
   * 🔴 The §4.1 coupling, decided rather than described. False whenever the keyword would land in
   * the ad group that discovered it — which is what `applyHarvest` does with no destinations map.
   */
  wouldNegateAtSource: boolean
  /** the sentence the page prints, composed here so the client cannot phrase it differently */
  negateReason: string
  /** other ad groups already holding an EXACT for this term, excluding the destination */
  competingAdGroups: Array<{ id: string; name: string; campaignName: string }>
}

/**
 * Amazon's auto-targeting expression types. An ad group holding these IS an auto ad group — it is
 * what "close match / loose match / substitutes / complements" means — whatever its name says.
 */
const AUTO_EXPRESSIONS = new Set([
  'AUTO', 'SEARCH_CLOSE_MATCH', 'SEARCH_LOOSE_MATCH', 'PRODUCT_SUBSTITUTES', 'PRODUCT_COMPLEMENTS',
])

/**
 * `roleOf` — the funnel's classifier, name first then the majority of positive targets.
 *
 * 🔴 HV-R P3a added the auto-expression fallback, and it only fires where this returned **null**
 * before, so no existing answer moves. Measured on prod 2026-08-20, and the reason it was needed:
 * classifying by NAME alone leaves **110 of 289 ad groups unclassified** while their own targets
 * say exactly what they are — names like "Ad group - 06/07/2023 06:09:36.860" holding nothing but
 * BROAD targets. Name-vs-targets agreed on 136, disagreed on **1**, and the name was blank-but-
 * knowable on 110. An Ad Group View built on the name guess would have hidden 38% of the account.
 *
 * ⚠ `AdGroup.targetingType` is NOT the signal, however much it looks like it: it reads **MANUAL on
 * all 289 rows**, including the 39 inside AUTO campaigns. Another column that renders a constant
 * ([[reference_fleet_stale_constant_class]]) — do not reach for it.
 *
 * ⚠ `expressionType` OSCILLATES between `EXACT` and `_EXACT` at ~65 rows/minute while two ingests
 * fight over it, so it is normalised here rather than compared raw
 * ([[reference_adtarget_expressiontype_oscillates]]).
 */
export function roleOf(name: string, targets: Array<{ expressionType: string; isNegative: boolean }>): HvMatchRole | null {
  const n = (name || '').toUpperCase()
  if (n.includes('AUTO')) return 'AUTO'
  if (n.includes('EXACT')) return 'EXACT'
  if (n.includes('PHRASE')) return 'PHRASE'
  if (n.includes('BROAD')) return 'BROAD'
  const counts: Record<string, number> = {}
  for (const t of targets) {
    if (t.isNegative) continue
    const e = String(t.expressionType ?? '').toUpperCase().replace(/^_+/, '').replace(/^NEGATIVE_/, '')
    counts[e] = (counts[e] ?? 0) + 1
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const top = ranked[0]?.[0]
  if (top === 'EXACT' || top === 'PHRASE' || top === 'BROAD') return top
  // Nothing keyword-shaped led. If ANY auto expression is present the ad group is an auto ad group:
  // those four types are only ever written by auto targeting, so their presence is not ambiguous
  // the way a keyword majority is.
  if (ranked.some(([e]) => AUTO_EXPRESSIONS.has(e))) return 'AUTO'
  return null
}

const isExactType = (t: string | null | undefined): boolean =>
  String(t ?? '').trim().toUpperCase().replace(/^_+/, '').replace(/^NEGATIVE_/, '') === 'EXACT'
const termKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

// ── the graph this module needs, read once per request ────────────────────────────────────────

export interface DestinationGraph {
  adGroups: Map<string, {
    id: string; name: string; campaignId: string
    campaignName: string; marketplace: string | null; targetingType: string | null; campaignStatus: string | null
    maxBidCents: number | null; minBidCents: number | null
    role: HvMatchRole | null
  }>
  /** adGroupId → the product ids it advertises (exact products, not lines) */
  productsOfAdGroup: Map<string, Set<string>>
  /** `PRODUCT|term` / `KEYWORD|term` → ad group ids holding a positive EXACT (or product) target */
  holdersOfTerm: Map<string, Array<{ adGroupId: string; atAmazon: boolean }>>
}

export async function loadDestinationGraph(): Promise<DestinationGraph> {
  const [ags, ads, positives] = await Promise.all([
    prisma.adGroup.findMany({
      select: {
        id: true, name: true, campaignId: true,
        campaign: { select: { name: true, marketplace: true, targetingType: true, status: true, maxBidCents: true, minBidCents: true } },
        targets: { select: { expressionType: true, isNegative: true } },
      },
    }),
    prisma.adProductAd.findMany({ where: { productId: { not: null } }, select: { productId: true, adGroupId: true } }),
    prisma.adTarget.findMany({
      where: { isNegative: false, kind: { in: ['KEYWORD', 'PRODUCT'] } },
      select: { adGroupId: true, kind: true, expressionType: true, expressionValue: true, externalTargetId: true },
    }),
  ])

  const adGroups = new Map<string, DestinationGraph['adGroups'] extends Map<string, infer V> ? V : never>()
  for (const a of ags) {
    adGroups.set(a.id, {
      id: a.id, name: a.name, campaignId: a.campaignId,
      campaignName: a.campaign?.name ?? '', marketplace: a.campaign?.marketplace ?? null,
      targetingType: a.campaign?.targetingType ?? null, campaignStatus: a.campaign?.status ?? null,
      maxBidCents: a.campaign?.maxBidCents ?? null, minBidCents: a.campaign?.minBidCents ?? null,
      role: roleOf(a.name, a.targets),
    })
  }

  const productsOfAdGroup = new Map<string, Set<string>>()
  for (const a of ads) {
    if (!a.productId) continue
    const s = productsOfAdGroup.get(a.adGroupId) ?? new Set<string>()
    s.add(a.productId)
    productsOfAdGroup.set(a.adGroupId, s)
  }

  const holdersOfTerm = new Map<string, Array<{ adGroupId: string; atAmazon: boolean }>>()
  for (const p of positives) {
    const counts = p.kind === 'PRODUCT' ? true : isExactType(p.expressionType)
    if (!counts) continue
    const k = `${p.kind === 'PRODUCT' ? 'PRODUCT' : 'KEYWORD'}|${termKey(p.expressionValue)}`
    holdersOfTerm.set(k, [...(holdersOfTerm.get(k) ?? []), { adGroupId: p.adGroupId, atAmazon: p.externalTargetId != null }])
  }

  return { adGroups, productsOfAdGroup, holdersOfTerm }
}

// ── the stored override ───────────────────────────────────────────────────────────────────────

export interface DestScopeRequest {
  market: string
  line?: string | null
  portfolio?: string | null
  campaign?: string | null
  adGroup?: string | null
}

/** Same chain and the same "first row wins whole" rule as `AdsHarvestPolicy`. */
export function destLookupChain(scope: DestScopeRequest): Array<{ grain: HvDestGrain; scopeId: string }> {
  const chain: Array<{ grain: HvDestGrain; scopeId: string }> = []
  if (scope.adGroup) chain.push({ grain: 'adGroup', scopeId: scope.adGroup })
  if (scope.campaign) chain.push({ grain: 'campaign', scopeId: scope.campaign })
  if (scope.portfolio) chain.push({ grain: 'portfolio', scopeId: scope.portfolio })
  if (scope.line) chain.push({ grain: 'line', scopeId: scope.line })
  if (scope.market && scope.market !== 'all') chain.push({ grain: 'market', scopeId: scope.market })
  chain.push({ grain: 'account', scopeId: HV_DEST_ACCOUNT })
  return chain
}

export interface StoredDestination {
  adGroupId: string
  negateAtSource: boolean
  grain: HvDestGrain
  scopeId: string | null
  updatedAt: string
  updatedBy: string
}

/** Every stored row for the scopes in play, keyed `matchType`. First grain in the chain wins. */
export async function resolveStoredDestinations(scope: DestScopeRequest): Promise<Map<HvCreateType, StoredDestination>> {
  const chain = destLookupChain(scope)
  const rows = await prisma.adsHarvestDestination.findMany({
    where: { OR: chain.map((c) => ({ scopeGrain: c.grain, scopeId: c.scopeId })) },
  })
  const out = new Map<HvCreateType, StoredDestination>()
  for (const c of chain) {
    for (const r of rows) {
      if (r.scopeGrain !== c.grain || r.scopeId !== c.scopeId) continue
      const mt = r.matchType as HvCreateType
      if (out.has(mt)) continue                       // a more specific grain already answered
      out.set(mt, {
        adGroupId: r.adGroupId, negateAtSource: r.negateAtSource,
        grain: r.scopeGrain as HvDestGrain, scopeId: r.scopeId === HV_DEST_ACCOUNT ? null : r.scopeId,
        updatedAt: r.updatedAt.toISOString(), updatedBy: r.updatedBy,
      })
    }
  }
  return out
}

// ── the resolver ──────────────────────────────────────────────────────────────────────────────

/**
 * Rank the plausible destinations for one (source ad group → createType).
 *
 * The ranking is the whole value, because the set is usually 5–21 long:
 *   1. it already holds sibling keywords of this product's set — it is the ad group in use
 *   2. its campaign is ENABLED
 *   3. its role came from the NAME rather than the majority fallback — a deliberate structure
 *   4. name, for stability, so the order never changes between two reads
 */
export function rankDestinations(
  graph: DestinationGraph,
  sourceAdGroupId: string,
  createType: HvCreateType,
  term: string,
  kind: 'keyword' | 'product',
): DestinationCandidate[] {
  const src = graph.adGroups.get(sourceAdGroupId)
  if (!src) return []
  const wantRole: HvMatchRole | null = createType === 'PRODUCT' ? null : createType
  const products = graph.productsOfAdGroup.get(sourceAdGroupId) ?? new Set<string>()
  if (products.size === 0) return []

  const holders = graph.holdersOfTerm.get(`${kind === 'product' ? 'PRODUCT' : 'KEYWORD'}|${termKey(term)}`) ?? []
  const holderIds = new Map(holders.map((h) => [h.adGroupId, h.atAmazon]))

  const out: DestinationCandidate[] = []
  for (const [id, ag] of graph.adGroups) {
    // Never propose an auto campaign as a destination: a destination that cannot hold a keyword
    // makes the funnel loop structurally impossible (SellerApp's restriction, and the reason the
    // account's auto campaigns exist at all).
    if (ag.targetingType !== 'MANUAL') continue
    if (ag.marketplace !== src.marketplace) continue
    if (wantRole && ag.role !== wantRole) continue
    if (createType === 'PRODUCT' && ag.role === 'AUTO') continue
    const mine = graph.productsOfAdGroup.get(id)
    if (!mine || ![...products].some((p) => mine.has(p))) continue

    const holdsTerm = holderIds.has(id)
    const nameRole = /AUTO|EXACT|PHRASE|BROAD/.test((ag.name || '').toUpperCase())
    const why = [
      holdsTerm ? 'already holds this term' : null,
      ag.campaignStatus === 'ENABLED' ? 'campaign enabled' : `campaign ${String(ag.campaignStatus ?? 'unknown').toLowerCase()}`,
      nameRole ? `role “${ag.role}” from the name` : `role “${ag.role}” inferred from its keywords`,
      'advertises the same product',
    ].filter(Boolean).join(' · ')

    out.push({
      adGroupId: id, adGroupName: ag.name, campaignId: ag.campaignId, campaignName: ag.campaignName,
      campaignStatus: ag.campaignStatus, role: ag.role, why,
      maxBidCents: ag.maxBidCents, minBidCents: ag.minBidCents,
      holdsTerm, holdsTermAtAmazon: holdsTerm ? (holderIds.get(id) ?? false) : false,
    })
  }

  const score = (c: DestinationCandidate) =>
    (c.holdsTerm ? 4 : 0) + (c.campaignStatus === 'ENABLED' ? 2 : 0) + (/AUTO|EXACT|PHRASE|BROAD/.test(c.adGroupName.toUpperCase()) ? 1 : 0)
  return out.sort((a, b) => score(b) - score(a) || a.adGroupName.localeCompare(b.adGroupName))
}

/**
 * The whole answer for one candidate row: the destination, how it was decided, whether promoting
 * would create anything, whether the source would be negated, and who else already holds the term.
 */
export function resolveDestination(args: {
  graph: DestinationGraph
  stored: Map<HvCreateType, StoredDestination>
  sourceAdGroupId: string | null
  sourceAdGroupName: string
  term: string
  kind: 'keyword' | 'product'
  createType: HvCreateType
}): ResolvedDestination {
  const { graph, stored, sourceAdGroupId, sourceAdGroupName, term, kind, createType } = args
  const holders = graph.holdersOfTerm.get(`${kind === 'product' ? 'PRODUCT' : 'KEYWORD'}|${termKey(term)}`) ?? []
  const shortlist = sourceAdGroupId ? rankDestinations(graph, sourceAdGroupId, createType, term, kind) : []

  const st = stored.get(createType)
  const storedCand = st ? shortlist.find((c) => c.adGroupId === st.adGroupId)
    ?? (graph.adGroups.has(st.adGroupId) ? toCandidate(graph, st.adGroupId, term, kind) : null) : null

  let source: HvDestSource
  let chosen: DestinationCandidate | null
  if (storedCand) { source = 'stored'; chosen = storedCand }
  else if (shortlist.length === 1) { source = 'resolved-unique'; chosen = shortlist[0] }
  else if (shortlist.length > 1) { source = 'resolved-ambiguous'; chosen = null }
  else { source = 'none'; chosen = null }

  // ── the §4.1 coupling ───────────────────────────────────────────────────────────────────────
  // `applyHarvest` negates the source ONLY when the keyword lands somewhere else. With no chosen
  // destination it takes `?? srcAg.id`, so the answer is a flat no — which is the state every
  // harvest this account has ever run was in.
  const negateFlag = st?.negateAtSource ?? true
  const landsElsewhere = !!chosen && !!sourceAdGroupId && chosen.adGroupId !== sourceAdGroupId
  const wouldNegateAtSource = landsElsewhere && negateFlag

  let negateReason: string
  if (!chosen && source === 'none') {
    negateReason = `No destination exists, so nothing would be promoted and nothing negated. There is no manual ${createType.toLowerCase()} ad group advertising this product in ${graph.adGroups.get(sourceAdGroupId ?? '')?.marketplace ?? 'this market'}.`
  } else if (!chosen) {
    negateReason = `No — no destination is set, so the keyword would be created back in “${sourceAdGroupName}”, the ad group that discovered it. applyHarvest negates the source only when the keyword lands elsewhere, so that ad group would keep competing for this term.`
  } else if (!landsElsewhere) {
    negateReason = `No — the destination IS “${sourceAdGroupName}”, the ad group that discovered it. applyHarvest negates the source only when the keyword lands elsewhere.`
  } else if (!negateFlag) {
    negateReason = `No — the keyword would be created in “${chosen.adGroupName}”, but this scope's destination has negate-at-source switched off, so “${sourceAdGroupName}” would keep competing for this term.`
  } else {
    negateReason = `Yes — the keyword would be created in “${chosen.adGroupName}”, so “${sourceAdGroupName}” gets a negative-exact for this term in the same transaction.`
  }

  // ── destination-relative status ─────────────────────────────────────────────────────────────
  let status: HvDestStatus
  if (source === 'none') status = 'no-destination'
  else if (!chosen) status = 'undecided'
  else {
    const here = holders.filter((h) => h.adGroupId === chosen.adGroupId)
    if (here.length && here.some((h) => h.atAmazon)) status = 'already-at-destination'
    else if (here.length) status = 'destination-local-only'
    else if (holders.length > 0) status = 'would-duplicate'
    else status = 'will-create'
  }

  const competingAdGroups = holders
    .filter((h) => !chosen || h.adGroupId !== chosen.adGroupId)
    .map((h) => { const ag = graph.adGroups.get(h.adGroupId); return ag ? { id: ag.id, name: ag.name, campaignName: ag.campaignName } : null })
    .filter((x): x is { id: string; name: string; campaignName: string } => !!x)

  return { createType, source, chosen, shortlist, status, wouldNegateAtSource, negateReason, competingAdGroups }
}

function toCandidate(graph: DestinationGraph, adGroupId: string, term: string, kind: 'keyword' | 'product'): DestinationCandidate | null {
  const ag = graph.adGroups.get(adGroupId)
  if (!ag) return null
  const holders = graph.holdersOfTerm.get(`${kind === 'product' ? 'PRODUCT' : 'KEYWORD'}|${termKey(term)}`) ?? []
  const h = holders.find((x) => x.adGroupId === adGroupId)
  return {
    adGroupId, adGroupName: ag.name, campaignId: ag.campaignId, campaignName: ag.campaignName,
    campaignStatus: ag.campaignStatus, role: ag.role,
    // A stored destination that the resolver would NOT have offered is a legitimate operator
    // decision, and the page says so rather than quietly dropping it back to the shortlist.
    why: 'stored for this scope — chosen by hand, outside the resolver’s shortlist',
    maxBidCents: ag.maxBidCents, minBidCents: ag.minBidCents,
    holdsTerm: !!h, holdsTermAtAmazon: h?.atAmazon ?? false,
  }
}

// ── writes (the stored override only — nothing reaches Amazon) ────────────────────────────────

export class HarvestDestinationError extends Error {
  constructor(message: string, readonly code: string) { super(message) }
}

export const HV_CREATE_TYPES: HvCreateType[] = ['EXACT', 'PHRASE', 'BROAD', 'PRODUCT']

export async function saveHarvestDestination(args: {
  scopeGrain: HvDestGrain; scopeId: string | null; matchType: HvCreateType
  adGroupId: string; negateAtSource: boolean; updatedBy: string
}) {
  if (!HV_DEST_GRAINS.includes(args.scopeGrain)) throw new HarvestDestinationError(`unknown scope grain "${args.scopeGrain}"`, 'bad_grain')
  if (!HV_CREATE_TYPES.includes(args.matchType)) throw new HarvestDestinationError(`matchType must be one of ${HV_CREATE_TYPES.join('/')}`, 'bad_match_type')
  const scopeId = args.scopeGrain === 'account' ? HV_DEST_ACCOUNT : (args.scopeId ?? '').trim()
  if (args.scopeGrain !== 'account' && !scopeId) throw new HarvestDestinationError(`a ${args.scopeGrain} destination needs a scope id`, 'scope_id_required')
  if (args.scopeGrain === 'market' && scopeId === 'all') throw new HarvestDestinationError('"all" is not a market — save at the account grain instead', 'all_is_not_a_market')

  const ag = await prisma.adGroup.findUnique({
    where: { id: args.adGroupId },
    select: { id: true, name: true, campaign: { select: { targetingType: true, marketplace: true } } },
  })
  if (!ag) throw new HarvestDestinationError('that ad group does not exist', 'ad_group_not_found')
  // 🔴 An AUTO campaign cannot hold a keyword. Storing one would make the funnel loop structurally
  // impossible and HV.4 would fail at write time with a much less legible error.
  if (ag.campaign?.targetingType !== 'MANUAL') {
    throw new HarvestDestinationError(`“${ag.name}” is in an ${String(ag.campaign?.targetingType ?? 'unknown').toLowerCase()} campaign — a destination must be a manual, keyword-targeted ad group`, 'destination_not_manual')
  }
  const updatedBy = (args.updatedBy || '').trim()
  if (!updatedBy) throw new HarvestDestinationError('updatedBy is required — a destination decides where money goes', 'actor_required')

  const row = await prisma.adsHarvestDestination.upsert({
    where: { scopeGrain_scopeId_matchType: { scopeGrain: args.scopeGrain, scopeId, matchType: args.matchType } },
    create: { scopeGrain: args.scopeGrain, scopeId, matchType: args.matchType, adGroupId: args.adGroupId, negateAtSource: args.negateAtSource !== false, updatedBy },
    update: { adGroupId: args.adGroupId, negateAtSource: args.negateAtSource !== false, updatedBy },
  })
  return {
    id: row.id, scopeGrain: row.scopeGrain, scopeId: row.scopeId === HV_DEST_ACCOUNT ? null : row.scopeId,
    matchType: row.matchType, adGroupId: row.adGroupId, negateAtSource: row.negateAtSource,
    updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy,
  }
}

export async function deleteHarvestDestination(scopeGrain: HvDestGrain, scopeId: string | null, matchType: HvCreateType) {
  const id = scopeGrain === 'account' ? HV_DEST_ACCOUNT : (scopeId ?? '').trim()
  if (scopeGrain !== 'account' && !id) throw new HarvestDestinationError(`a ${scopeGrain} destination needs a scope id`, 'scope_id_required')
  const existing = await prisma.adsHarvestDestination.findUnique({ where: { scopeGrain_scopeId_matchType: { scopeGrain, scopeId: id, matchType } } })
  if (!existing) throw new HarvestDestinationError('there is no destination at that scope to remove', 'not_found')
  await prisma.adsHarvestDestination.delete({ where: { id: existing.id } })
  return { removed: { scopeGrain, scopeId: scopeGrain === 'account' ? null : id, matchType } }
}

export async function listHarvestDestinations() {
  const rows = await prisma.adsHarvestDestination.findMany({ orderBy: [{ scopeGrain: 'asc' }, { scopeId: 'asc' }, { matchType: 'asc' }] })
  const ags = await prisma.adGroup.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.adGroupId))] } },
    select: { id: true, name: true, campaign: { select: { name: true } } },
  })
  const byId = new Map(ags.map((a) => [a.id, a]))
  return rows.map((r) => ({
    id: r.id, scopeGrain: r.scopeGrain as HvDestGrain, scopeId: r.scopeId === HV_DEST_ACCOUNT ? null : r.scopeId,
    matchType: r.matchType as HvCreateType, adGroupId: r.adGroupId,
    adGroupName: byId.get(r.adGroupId)?.name ?? '(deleted ad group)',
    campaignName: byId.get(r.adGroupId)?.campaign?.name ?? '',
    negateAtSource: r.negateAtSource, updatedAt: r.updatedAt.toISOString(), updatedBy: r.updatedBy,
  }))
}
