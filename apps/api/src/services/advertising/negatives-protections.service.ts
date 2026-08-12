/**
 * NEG.5 — protected terms: what can never be negated, and what already is in spite of that.
 *
 * Two halves. The forward half (the ten whitelisted terms and their reach) has always been true and
 * is cheap to show. The backward half has never existed anywhere: **the whitelist is a
 * going-forward gate installed 2026-08-04 over a base written 2026-05-20**, and
 * `ads-write-gate.ts:300-337` can only refuse the next write. It cannot see, let alone remove,
 * what was already there.
 *
 * *"Nothing can ever negate these"* and *"nothing currently negates these"* are different
 * sentences, and only the first has ever been implemented.
 *
 * ── 🔴 132 is a PAIR count, and 128 is the negation count ─────────────────────────────────────
 *
 * Measured 2026-08-12. Four negations — all of them the phrase `xavia gale` — contradict **two**
 * protected terms each. So:
 *
 *   132 = (negation × protected term) pairs   ← what the study reported, and what group sizes sum to
 *   128 = distinct AdTarget rows              ← what an operator would have to remove
 *
 * Both are returned and both are on screen, because an audit grouped BY PROTECTED TERM has group
 * sizes that sum to 132, and a headline of 128 over groups summing to 132 reads as a bug. The
 * study's own predicate (`_neg-study.mts:71-83`) also had no `break`, which is why its published
 * figure is the pair count without saying so.
 *
 * ── The semantics is replicated, never re-invented ───────────────────────────────────────────
 *
 * `matchesProtection` below mirrors `ads-write-gate.ts:322-327` exactly, including the
 * `matchType ?? (isPrefix ? 'PREFIX' : 'EXACT')` fallback for rows written before that column
 * existed. 🔴 If this and the gate ever diverge, the audit and the enforcement disagree silently
 * and this file becomes fiction. Measured over the same base: CONTAINS 132 · PREFIX 96 · EXACT 32,
 * and all ten live rows are CONTAINS — so 132 is the number that binds.
 *
 * The same risk applies to the normaliser. `normaliseNegTerm` (negatives.service.ts) and
 * `normaliseTerm` (ads-write-gate.ts) are byte-identical today and asserted equal in
 * `_neg5-ground.mts`; this file imports the GATE's, so a divergence moves the audit with the
 * enforcement rather than away from it.
 *
 * Read-only except for `markReview`/`unmarkReview`, which write only to `AdNegativeReview`. No
 * Amazon call is made from this file: removal is NEG.3's path and stays there.
 */

import prisma from '../../db.js'
import { normaliseTerm } from './ads-write-gate.js'
import {
  normaliseMatchType, resolveNegScope,
  NEG_MARKETS, NEG_MARKET_ALL,
  type NegScopeRequest, type NegGrain, type NegMatchType, type NegLevel,
} from './negatives.service.js'

/** The reach window. 30/60/120 to match every other window control on this page. */
const WINDOWS = [30, 60, 120] as const
const DEFAULT_WINDOW = 30

/** The only decision that exists. A string, not an enum — the second value is not yet known. */
export const DECISION_INTENDED_FUNNEL = 'INTENDED_FUNNEL'

export type Classification = 'own-line-brand' | 'other-line-brand' | 'non-brand'

/**
 * 🔴 `ads-write-gate.ts:322-327` verbatim. Do not "simplify" this — the fallback chain is the
 * contract with every row written before `matchType` existed.
 */
export function resolvedMatchType(p: { matchType: string | null; isPrefix: boolean }): string {
  return p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')
}

export function matchesProtection(negTerm: string, protTerm: string, mode: string): boolean {
  if (!negTerm || !protTerm) return false
  if (mode === 'CONTAINS') return negTerm.includes(protTerm)
  if (mode === 'PREFIX') return negTerm.startsWith(protTerm)
  return negTerm === protTerm
}

/**
 * Triage, not a verdict. §7 of the brief is explicit that this is a sort order and a default
 * filter and never a judgement — nothing here infers an operator's intent, and nothing resolves a
 * contradiction automatically on the strength of a campaign name.
 *
 * `own-line` is read off the campaign's own name rather than a hardcoded line list, so a line
 * added next month classifies correctly with no code change. Punctuation is stripped from both
 * sides so `airmesh` matches `IT-AIRMESH-SP-Brand-Broad` and `air mesh` would too.
 */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
export function classifyContradiction(campaignName: string, protectedTerm: string): Classification {
  if (!/brand/i.test(campaignName)) return 'non-brand'
  return squash(campaignName).includes(squash(protectedTerm)) ? 'own-line-brand' : 'other-line-brand'
}

/** Ordering: the hardest to defend first, the standard funnel pattern last. */
const CLASS_RANK: Record<Classification, number> = { 'own-line-brand': 0, 'other-line-brand': 1, 'non-brand': 2 }

export interface ProtectionView {
  id: string
  term: string
  mode: string
  /** EXACT · PREFIX · CONTAINS, after the isPrefix fallback — the semantics that actually binds */
  matchType: string
  /** what it will and will not catch, in words, so the operator never has to know the enum */
  semantics: string
  marketplace: string | null
  campaignId: string | null
  campaignName: string | null
  reason: string | null
  createdBy: string | null
  createdAt: string
  /** distinct search-term queries in the window this protection would cover — its blast radius */
  reachQueries: number
  /** contradictions this protection currently has, as PAIRS */
  contradictions: number
}

export interface ContradictionRow {
  /** the AdTarget id — what NEG.3's removal takes */
  id: string
  /** the negated phrase, normalised the way the gate normalises */
  term: string
  /** the stored spelling, shown as-is */
  termRaw: string
  match: NegMatchType
  matchRaw: string
  level: NegLevel
  campaignId: string
  campaignName: string
  campaignStatus: string
  adGroupId: string
  adGroupName: string
  market: string
  status: string
  atAmazon: boolean
  blockingNow: boolean
  addedAt: string
  classification: Classification
  /** whether this row falls inside the scope the page is currently showing */
  inScope: boolean
  /** the negated phrase's own traffic in the window — the cost of the block, or null if none */
  performance: { impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number } | null
  /** §10 — a row whose campaign is not on the write allowlist cannot be removed today */
  removable: boolean
  /** true when this row landed AFTER the decision that now covers it — §5's stated trade-off */
  newSinceDecision: boolean
}

export interface ReviewDecision {
  decision: string
  reason: string | null
  reviewedBy: string | null
  reviewedAt: string
}

/** The decision grain: one protected term inside one campaign. */
export interface CampaignGroup {
  campaignId: string
  campaignName: string
  campaignStatus: string
  market: string
  classification: Classification
  rows: ContradictionRow[]
  /** 🔴 what a decision here covers — every current AND future negation of this term here */
  covers: number
  blocking: number
  /** rows that landed after the decision. Surfaced, never absorbed. */
  newSinceDecision: number
  decision: ReviewDecision | null
  /** false when NO row here is removable — the Remove control hides rather than disables */
  removable: boolean
  removableReason: string | null
}

export interface TermGroup {
  protectedTerm: string
  matchType: string
  semantics: string
  /** pairs, not distinct negations — this term's own share of the 132 */
  contradictions: number
  blocking: number
  reviewed: number
  open: number
  campaigns: CampaignGroup[]
}

export interface ProtectionsPayload {
  scope: {
    boundBy: NegGrain
    market: string
    campaignsInScope: number
    campaignsInMarket: number
  }
  window: { days: number; since: string }
  forward: {
    protections: ProtectionView[]
    /** the denominator behind every `reachQueries` — a real count, so a zero reach is legible */
    reach: { distinctQueries: number; searchTermRows: number }
    /**
     * 🔴 Always false, and on screen. Every refusal is logged via `logGateDeny` but nothing
     * persists it, so there is no table to count. The forward half shows what WILL be refused,
     * never what has been — and it must not imply a history it cannot produce.
     */
    refusalHistoryAvailable: boolean
  }
  backward: {
    groups: TermGroup[]
    totals: {
      /** pairs — the unit of this audit, and the number the groups sum to */
      contradictions: number
      /** distinct AdTarget rows behind those pairs */
      negations: number
      /** pairs sitting under a decision */
      reviewed: number
      open: number
      blocking: number
      /** pairs that landed after the decision covering them */
      newSinceDecision: number
      byClass: Record<Classification, number>
    }
    /** the same numbers narrowed to the current scope, so a scoped view can say "12 of 132" */
    scoped: { contradictions: number; negations: number; reviewed: number; open: number }
  }
  /**
   * 🔴 Real counts of what was read. A failed query and a clean account both produce empty lists,
   * and here "nothing contradicts the whitelist" is the most reassuring possible lie. Zero
   * `protectionRows` or zero `negationRows` means the read failed; the panel says so instead of
   * rendering a goal state.
   */
  coverage: { protectionRows: number; negationRows: number; reviewRows: number }
}

export interface ProtectionsRequest extends NegScopeRequest {
  window?: number | null
}

/** Human sentence for a match mode. The operator never has to know the enum. */
function semanticsOf(mode: string, term: string): string {
  if (mode === 'CONTAINS') return `blocks any negation whose phrase contains “${term}” anywhere — including “giacca moto ${term}”`
  if (mode === 'PREFIX') return `blocks any negation whose phrase starts with “${term}” — but not “giacca moto ${term}”`
  return `blocks a negation of exactly “${term}” — nothing longer, not even “${term} moto”`
}

export async function getProtections(req: ProtectionsRequest): Promise<ProtectionsPayload> {
  const windowDays = WINDOWS.includes(Number(req.window) as (typeof WINDOWS)[number]) ? Number(req.window) : DEFAULT_WINDOW
  const since = new Date(Date.now() - windowDays * 86400_000)

  const [campaigns, negAdGroups, products, ads] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true }, orderBy: { name: 'asc' } }),
    prisma.adGroup.findMany({ where: { targets: { some: { isNegative: true } } }, select: { id: true, name: true, campaignId: true } }),
    req.line ? prisma.product.findMany({ select: { id: true, parentId: true } }) : Promise.resolve([]),
    req.line ? prisma.adProductAd.findMany({ where: { productId: { not: null } }, select: { productId: true, adGroup: { select: { campaignId: true } } } }) : Promise.resolve([]),
  ])
  const scope = resolveNegScope(
    { campaigns, adGroups: negAdGroups, products, ads: ads.map((a) => ({ productId: a.productId, campaignId: a.adGroup?.campaignId ?? '' })).filter((a) => a.campaignId) },
    req,
  )
  const scopeCampaigns = new Set(scope.campaignIds)
  const scopeAdGroups = scope.adGroupIds ? new Set(scope.adGroupIds) : null

  // Scope narrows what is SHOWN, never what is READ. Every "N of M elsewhere" sentence on this
  // page depends on holding both numbers at once.
  const [protections, negs, reviews, searchTerms] = await Promise.all([
    prisma.adKeywordProtection.findMany({ orderBy: [{ mode: 'asc' }, { term: 'asc' }] }),
    prisma.adTarget.findMany({
      where: { isNegative: true },
      select: {
        id: true, expressionValue: true, expressionType: true, kind: true, status: true,
        externalTargetId: true, negativeLevel: true, createdAt: true,
        adGroup: {
          select: {
            id: true, name: true,
            campaign: { select: { id: true, name: true, status: true, marketplace: true, liveBidWritesEnabled: true } },
          },
        },
      },
    }),
    prisma.adNegativeReview.findMany(),
    prisma.amazonAdsSearchTerm.groupBy({
      by: ['query'],
      where: { date: { gte: since } },
      _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
    }),
  ])

  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]))
  const whitelist = protections.filter((p) => p.mode === 'WHITELIST')

  // ── traffic by normalised query, for the window ────────────────────────────────────────────
  const perf = new Map<string, { impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number }>()
  for (const t of searchTerms) {
    const k = normaliseTerm(t.query ?? '')
    if (!k) continue
    const prev = perf.get(k)
    const add = {
      impressions: t._sum.impressions ?? 0,
      clicks: t._sum.clicks ?? 0,
      spendCents: Math.round(Number(t._sum.costMicros ?? 0n) / 10_000),
      orders: t._sum.orders7d ?? 0,
      salesCents: t._sum.sales7dCents ?? 0,
    }
    perf.set(k, prev
      ? { impressions: prev.impressions + add.impressions, clicks: prev.clicks + add.clicks, spendCents: prev.spendCents + add.spendCents, orders: prev.orders + add.orders, salesCents: prev.salesCents + add.salesCents }
      : add)
  }
  const distinctQueries = [...perf.keys()]

  // ── the pairs ──────────────────────────────────────────────────────────────────────────────
  // One entry per (negation × protected term). A negation contradicting two protections produces
  // two, and appears under both groups — which is how an operator reads this page and why the
  // headline states the pair count with the negation count beside it.
  type Pair = {
    protection: (typeof whitelist)[number]
    neg: (typeof negs)[number]
    key: string
  }
  const pairs: Pair[] = []
  for (const n of negs) {
    const key = normaliseTerm(n.expressionValue ?? '')
    if (!key) continue
    for (const p of whitelist) {
      const t = normaliseTerm(p.term)
      if (matchesProtection(key, t, resolvedMatchType(p))) pairs.push({ protection: p, neg: n, key })
    }
  }

  const reviewKey = (term: string, campaignId: string) => `${normaliseTerm(term)}|${campaignId}`
  const reviewByKey = new Map(reviews.map((r) => [reviewKey(r.protectedTerm, r.campaignId), r]))

  const blockingOf = (n: (typeof negs)[number]) =>
    n.externalTargetId != null && String(n.status) === 'ENABLED' && n.adGroup?.campaign?.status === 'ENABLED'
  const inScopeOf = (n: (typeof negs)[number]) =>
    scopeAdGroups ? scopeAdGroups.has(n.adGroup?.id ?? '') : scopeCampaigns.has(n.adGroup?.campaign?.id ?? '')

  // ── group: protected term → campaign ───────────────────────────────────────────────────────
  const byProtection = new Map<string, Pair[]>()
  for (const p of pairs) {
    const k = p.protection.id
    byProtection.set(k, [...(byProtection.get(k) ?? []), p])
  }

  const groups: TermGroup[] = []
  let totalReviewed = 0
  let totalNewSince = 0
  let totalBlocking = 0
  const byClass: Record<Classification, number> = { 'own-line-brand': 0, 'other-line-brand': 0, 'non-brand': 0 }
  const scopedPairs: Pair[] = []
  let scopedReviewed = 0

  for (const p of whitelist) {
    const mine = byProtection.get(p.id) ?? []
    if (mine.length === 0) continue
    const mode = resolvedMatchType(p)

    const byCampaign = new Map<string, Pair[]>()
    for (const x of mine) {
      const cid = x.neg.adGroup?.campaign?.id ?? ''
      byCampaign.set(cid, [...(byCampaign.get(cid) ?? []), x])
    }

    const campaignGroups: CampaignGroup[] = []
    let termReviewed = 0
    let termBlocking = 0

    for (const [cid, cp] of byCampaign) {
      const first = cp[0].neg
      const cname = first.adGroup?.campaign?.name ?? campaignName.get(cid) ?? '—'
      const decision = reviewByKey.get(reviewKey(p.term, cid)) ?? null
      const cls = classifyContradiction(cname, p.term)

      const rows: ContradictionRow[] = cp.map((x) => {
        const n = x.neg
        const m = normaliseMatchType(n.expressionType, n.kind)
        const newSince = decision != null && n.createdAt > decision.reviewedAt
        const scoped = inScopeOf(n)
        if (scoped) scopedPairs.push(x)
        if (scoped && decision) scopedReviewed++
        return {
          id: n.id,
          term: x.key,
          termRaw: n.expressionValue ?? '',
          match: m.type,
          matchRaw: m.raw,
          level: (n.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP') as NegLevel,
          campaignId: cid,
          campaignName: cname,
          campaignStatus: String(first.adGroup?.campaign?.status ?? ''),
          adGroupId: n.adGroup?.id ?? '',
          adGroupName: n.adGroup?.name ?? '—',
          market: first.adGroup?.campaign?.marketplace ?? '—',
          status: String(n.status),
          atAmazon: n.externalTargetId != null,
          blockingNow: blockingOf(n),
          addedAt: n.createdAt.toISOString(),
          classification: cls,
          inScope: scoped,
          performance: perf.get(x.key) ?? null,
          removable: first.adGroup?.campaign?.liveBidWritesEnabled === true,
          newSinceDecision: newSince,
        }
      })

      rows.sort((a, b) => (b.blockingNow ? 1 : 0) - (a.blockingNow ? 1 : 0) || a.term.localeCompare(b.term))
      const blocking = rows.filter((r) => r.blockingNow).length
      const newSince = rows.filter((r) => r.newSinceDecision).length
      const removable = rows.some((r) => r.removable)
      termBlocking += blocking
      totalBlocking += blocking
      totalNewSince += newSince
      byClass[cls] += rows.length
      if (decision) { termReviewed += rows.length; totalReviewed += rows.length }

      campaignGroups.push({
        campaignId: cid,
        campaignName: cname,
        campaignStatus: String(first.adGroup?.campaign?.status ?? ''),
        market: first.adGroup?.campaign?.marketplace ?? '—',
        classification: cls,
        rows,
        covers: rows.length,
        blocking,
        newSinceDecision: newSince,
        decision: decision
          ? { decision: decision.decision, reason: decision.reason, reviewedBy: decision.reviewedBy, reviewedAt: decision.reviewedAt.toISOString() }
          : null,
        removable,
        // Stated once per group rather than on every row — §10 of NEG.4's brief, and the operator
        // decision of 2026-08-12 to leave the allowlist alone.
        removableReason: removable ? null : `${cname} is not on the live-write allowlist (Campaign.liveBidWritesEnabled=false), so a removal here would be refused by the write gate before it reached Amazon.`,
      })
    }

    // open first, then hardest-to-defend first, then biggest.
    campaignGroups.sort((a, b) =>
      (a.decision ? 1 : 0) - (b.decision ? 1 : 0)
      || CLASS_RANK[a.classification] - CLASS_RANK[b.classification]
      || b.covers - a.covers
      || a.campaignName.localeCompare(b.campaignName))

    groups.push({
      protectedTerm: p.term,
      matchType: mode,
      semantics: semanticsOf(mode, p.term),
      contradictions: mine.length,
      blocking: termBlocking,
      reviewed: termReviewed,
      open: mine.length - termReviewed,
      campaigns: campaignGroups,
    })
  }

  groups.sort((a, b) => b.open - a.open || b.contradictions - a.contradictions || a.protectedTerm.localeCompare(b.protectedTerm))

  // ── the forward half ───────────────────────────────────────────────────────────────────────
  const contradictionsByProtection = new Map<string, number>()
  for (const x of pairs) contradictionsByProtection.set(x.protection.id, (contradictionsByProtection.get(x.protection.id) ?? 0) + 1)

  const forwardProtections: ProtectionView[] = protections.map((p) => {
    const mode = resolvedMatchType(p)
    const t = normaliseTerm(p.term)
    let reach = 0
    for (const q of distinctQueries) if (matchesProtection(q, t, mode)) reach++
    return {
      id: p.id,
      term: p.term,
      mode: p.mode,
      matchType: mode,
      semantics: semanticsOf(mode, p.term),
      marketplace: p.marketplace,
      campaignId: p.campaignId,
      campaignName: p.campaignId ? campaignName.get(p.campaignId) ?? null : null,
      reason: p.reason,
      createdBy: p.createdBy,
      createdAt: p.createdAt.toISOString(),
      reachQueries: reach,
      contradictions: contradictionsByProtection.get(p.id) ?? 0,
    }
  })

  const scopedNegations = new Set(scopedPairs.map((x) => x.neg.id)).size

  return {
    scope: {
      boundBy: scope.boundBy,
      market: req.market,
      campaignsInScope: scope.campaignIds.length,
      campaignsInMarket: scope.campaignsInMarket,
    },
    window: { days: windowDays, since: since.toISOString() },
    forward: {
      protections: forwardProtections,
      reach: { distinctQueries: distinctQueries.length, searchTermRows: searchTerms.length },
      refusalHistoryAvailable: false,
    },
    backward: {
      groups,
      totals: {
        contradictions: pairs.length,
        negations: new Set(pairs.map((x) => x.neg.id)).size,
        reviewed: totalReviewed,
        open: pairs.length - totalReviewed,
        blocking: totalBlocking,
        newSinceDecision: totalNewSince,
        byClass,
      },
      scoped: {
        contradictions: scopedPairs.length,
        negations: scopedNegations,
        reviewed: scopedReviewed,
        open: scopedPairs.length - scopedReviewed,
      },
    },
    coverage: { protectionRows: protections.length, negationRows: negs.length, reviewRows: reviews.length },
  }
}

export interface MarkReviewRequest {
  protectedTerm: string
  campaignId: string
  reason?: string | null
  reviewedBy: string
}

/**
 * Record the decision. Idempotent at the (term, campaign) grain, which is the same grain the
 * unique index enforces — a second mark updates the reason and the actor rather than erroring or
 * silently doing nothing.
 */
export async function markReview(req: MarkReviewRequest): Promise<{ ok: true; covers: number } | { ok: false; error: string; code: string }> {
  const term = normaliseTerm(req.protectedTerm)
  if (!term) return { ok: false, error: 'protectedTerm is required', code: 'term_required' }

  // A decision must name a campaign that exists. Marking a typo would create a row that covers
  // nothing and silently reduces nothing — an audit that can be satisfied by a misspelling is not
  // one.
  const campaign = await prisma.campaign.findUnique({ where: { id: req.campaignId }, select: { id: true, name: true } })
  if (!campaign) return { ok: false, error: `campaign ${req.campaignId} not found`, code: 'campaign_not_found' }

  const known = await prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' }, select: { term: true, matchType: true, isPrefix: true } })
  if (!known.some((k) => normaliseTerm(k.term) === term)) {
    return { ok: false, error: `“${term}” is not a whitelisted term, so there is nothing to review`, code: 'not_protected' }
  }

  await prisma.adNegativeReview.upsert({
    where: { protectedTerm_campaignId: { protectedTerm: term, campaignId: req.campaignId } },
    create: {
      protectedTerm: term, campaignId: req.campaignId, decision: DECISION_INTENDED_FUNNEL,
      reason: req.reason?.trim() || null, reviewedBy: req.reviewedBy,
    },
    update: { reason: req.reason?.trim() || null, reviewedBy: req.reviewedBy, reviewedAt: new Date() },
  })

  // What the decision actually covers, counted after the write so the number is the truth rather
  // than the caller's belief about it.
  const negs = await prisma.adTarget.findMany({
    where: { isNegative: true, adGroup: { campaign: { id: req.campaignId } } },
    select: { expressionValue: true },
  })
  const mode = resolvedMatchType(known.find((k) => normaliseTerm(k.term) === term)!)
  const covers = negs.filter((n) => matchesProtection(normaliseTerm(n.expressionValue ?? ''), term, mode)).length
  return { ok: true, covers }
}

export async function unmarkReview(protectedTerm: string, campaignId: string): Promise<{ ok: boolean; removed: number }> {
  const term = normaliseTerm(protectedTerm)
  const res = await prisma.adNegativeReview.deleteMany({ where: { protectedTerm: term, campaignId } })
  return { ok: true, removed: res.count }
}

export { NEG_MARKETS, NEG_MARKET_ALL }
