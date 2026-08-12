/**
 * NEG.4 — attention: what is wrong right now.
 *
 * Three lists, each a count that can reach zero — and two of them are at or near zero today, which
 * is a **result**, not an empty screen.
 *
 * 🔴 THE SEAM. `getTermContext` (NEG.2) returns FACTS and ships no `isConflict` boolean on purpose.
 * THRESHOLDS AND VERDICTS LIVE HERE, and they do not travel back: four consumers read term-context
 * and none of them share this policy.
 *
 * ── 🔴 The most dangerous property of this file ───────────────────────────────────────────────
 *
 * **The correct answer for Detector A is currently ZERO — and a broken query returns zero too.**
 * A `.catch(() => [])`, a wrong join, or an empty `IN` list is indistinguishable from a clean
 * account by looking at the output. So the derivation computes the overlap at TWO strictness
 * levels and returns both:
 *
 *   `overlapsRelaxed`  — any negation state. Measured 2026-08-12: **3**. This is the JOIN working.
 *   `conflicts`        — §5's full blocking predicate. Measured: **0**. This is the POLICY.
 *
 * A relaxed count of 0 means the join is broken, whatever the policy count says.
 * `_neg4-detectors.mts` asserts both, in that order, for exactly this reason.
 *
 * ── The join ─────────────────────────────────────────────────────────────────────────────────
 *
 * `AmazonAdsSearchTerm.adGroupId` is an EXTERNAL Amazon id; `AdTarget` reaches its ad group via
 * `AdGroup.externalAdGroupId`. Local-to-external returns 0 for every term forever and looks exactly
 * like the clean account we now legitimately have. Lifted from `_neg-page-conflict.mts:44-84`,
 * which is the written and verified version of this query — not re-derived.
 */

import prisma from '../../db.js'
import {
  normaliseNegTerm, normaliseMatchType, resolveNegScope,
  NEG_MARKETS, NEG_MARKET_ALL,
  type NegScopeRequest, type NegGrain, type NegMatchType,
} from './negatives.service.js'

/** The default window for "is it taking traffic". Movable by the caller; stated on screen. */
const DEFAULT_WINDOW = 30
const WINDOWS = [30, 60, 120] as const
/** The look-back for "did it ever earn". Fixed — Detector B's whole shape depends on it. */
const HISTORY_DAYS = 120
/** Detector B's bar. One order is a signal worth surfacing, not a proven loss — the UI says so. */
const MIN_HISTORY_ORDERS = 1

export type AttentionAlert = 'conflict' | 'suppressed' | 'splitbrain'

/**
 * 🔴 §5 — a negation BLOCKS only when all four hold. Deliberately stricter than
 * `isBlockingNow` (NEG.1), which does not exclude campaign-level rows: a campaign-level negation
 * cannot participate in an AD-GROUP overlap at all, so including one would invent a conflict in a
 * place Amazon does not evaluate.
 */
export function isBlockingAdGroupNegation(n: {
  status: string
  externalTargetId: string | null
  negativeLevel: string | null
  campaignStatus: string | null
}): boolean {
  return n.externalTargetId != null
    && n.status === 'ENABLED'
    && n.campaignStatus === 'ENABLED'
    && n.negativeLevel !== 'CAMPAIGN'
}

export interface ConflictRow {
  adTargetId: string
  term: string
  termKey: string
  match: NegMatchType
  campaignId: string
  campaignName: string
  adGroupId: string
  adGroupName: string
  externalAdGroupId: string
  market: string
  /** 🔴 THIS AD GROUP'S OWN traffic — never the term's account-wide total. */
  adGroupTraffic: { impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number }
  /** how many negation ROWS sit in this same ad group for this term — the write count to clear it */
  overlapRows: number
  /** the three numbers, never collapsed */
  negatedIn: number
  runsIn: number
  actionable: boolean
}

export interface SuppressedRow {
  termKey: string
  term: string
  negations: number
  /** how many of them actually block — 0 means the negative is NOT the cause */
  blocking: number
  markets: string[]
  history: { days: number; impressions: number; orders: number; salesCents: number; spendCents: number }
  windowImpressions: number
  /** 🔴 sample size on the row: one order is thin, and must look thin */
  thin: boolean
  /** true when nothing blocks it — the campaigns are paused, so the negative is not the cause */
  explained: boolean
  actionable: boolean
}

export interface SplitBrainRow {
  adTargetId: string
  term: string
  termKey: string
  match: NegMatchType
  level: 'AD_GROUP' | 'CAMPAIGN'
  campaignId: string
  campaignName: string
  campaignStatus: string
  adGroupName: string
  market: string
  addedAt: string
  /** why it is unconfirmed, where that is knowable */
  reason: string
  /** a local delete — the write gate never runs, so this is always true */
  actionable: boolean
}

export interface AttentionPayload {
  scope: {
    market: string
    boundBy: NegGrain
    resolved: { campaigns: number }
  }
  window: { days: number; since: string }
  thresholds: {
    windowDays: number
    historyDays: number
    minHistoryOrders: number
    blockingDefinition: string
    conflictDefinition: string
  }
  /** the denominator every "0 findings" is stated against */
  denominators: { blockingNegations: number; blockingNegationsUnscoped: number; negations: number; terms: number }
  conflicts: {
    rows: ConflictRow[]
    total: number
    totalUnscoped: number
    /**
     * 🔴 The same join with the blocking predicate REMOVED. Its whole purpose is to make a zero
     * legible: if this is also 0, the join is broken rather than the account clean.
     */
    overlapsRelaxed: number
    overlapsRelaxedUnscoped: number
    /** why each relaxed overlap is not a conflict — so the collapse has a reason on the record */
    relaxedExplained: Array<{ termKey: string; externalAdGroupId: string; rows: number; reason: string }>
  }
  suppressed: { rows: SuppressedRow[]; total: number; totalUnscoped: number; explained: number }
  splitBrain: { rows: SplitBrainRow[]; total: number; totalUnscoped: number; byReason: Record<string, number> }
  /** 🔴 a real count of the traffic rows read. 0 here means a failed read, not a quiet account. */
  coverage: { searchTermRows: number; termsWithTraffic: number; termsTotal: number }
}

export interface AttentionRequest extends NegScopeRequest {
  window?: number | null
}

export async function getAttention(req: AttentionRequest): Promise<AttentionPayload> {
  const windowDays = WINDOWS.includes(Number(req.window) as (typeof WINDOWS)[number]) ? Number(req.window) : DEFAULT_WINDOW
  const since = new Date(Date.now() - windowDays * 86400_000)
  const since120 = new Date(Date.now() - HISTORY_DAYS * 86400_000)

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

  // The whole base, account-wide. Scope narrows what is SHOWN, never what is read — the "N of M
  // elsewhere" sentence depends on knowing both.
  const negs = await prisma.adTarget.findMany({
    where: { isNegative: true },
    select: {
      id: true, expressionValue: true, expressionType: true, kind: true, status: true,
      externalTargetId: true, negativeLevel: true, createdAt: true,
      adGroup: {
        select: {
          id: true, name: true, externalAdGroupId: true,
          campaign: { select: { id: true, name: true, status: true, marketplace: true, liveBidWritesEnabled: true } },
        },
      },
    },
  })
  const inScope = (n: typeof negs[number]) =>
    scopeAdGroups ? scopeAdGroups.has(n.adGroup?.id ?? '') : scopeCampaigns.has(n.adGroup?.campaign?.id ?? '')
  const blocks = (n: typeof negs[number]) => isBlockingAdGroupNegation({
    status: String(n.status), externalTargetId: n.externalTargetId,
    negativeLevel: n.negativeLevel, campaignStatus: n.adGroup?.campaign?.status ?? null,
  })
  /** §10 — a row whose campaign is not allowlisted cannot be retired today. It still gets listed. */
  const actionable = (n: typeof negs[number]) => n.adGroup?.campaign?.liveBidWritesEnabled === true

  const byTerm = new Map<string, typeof negs>()
  for (const n of negs) { const k = normaliseNegTerm(n.expressionValue); const a = byTerm.get(k) ?? []; a.push(n); byTerm.set(k, a) }
  const terms = [...byTerm.keys()]

  // ── traffic at the (query, EXTERNAL adGroupId) grain ────────────────────────────────────────
  // 🔴 Grouped by DATE as well, because a conflict needs the traffic to POSTDATE the negation.
  //
  // Measured 2026-08-12: at a 120-day window a date-blind overlap reports 9 conflicts, and for
  // three of them the ad group's last impression for that term lands ON or BEFORE the day the
  // negation was created — `chaqueta moto hombre` negated 2026-05-26, last impression 2026-05-26.
  // Those are not conflicts; they are the negative WORKING. Counting pre-negation traffic as
  // evidence that a negation blocks live traffic is a false-positive generator, and it is the
  // study's "cries wolf" failure reappearing on the time axis instead of the grain axis.
  //
  // `createdAt` is when WE first saw the row, which for a mirrored negation is at or after Amazon
  // created it. So this can only ever EXCLUDE a real conflict, never invent one — the safe
  // direction, and stated rather than assumed.
  const perAgDay = terms.length
    ? await prisma.amazonAdsSearchTerm.groupBy({
      by: ['query', 'adGroupId', 'date'],
      where: { date: { gte: since }, query: { in: terms } },
      _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
    })
    : []
  /** the newest impression date per (term, external ad group) — the time-order test's input */
  const lastSeen = new Map<string, Date>()
  for (const r of perAgDay) {
    const k = `${normaliseNegTerm(r.query)}|${r.adGroupId}`
    const prev = lastSeen.get(k)
    if (!prev || r.date > prev) lastSeen.set(k, r.date)
  }
  // Roll the day rows up to the (query, adGroup) grain the rest of the derivation works at.
  const perAgMap = new Map<string, { query: string; adGroupId: string; impressions: number; clicks: number; costMicros: bigint; orders: number; sales: number }>()
  for (const r of perAgDay) {
    const k = `${r.query}|${r.adGroupId}`
    const cur = perAgMap.get(k) ?? { query: r.query, adGroupId: r.adGroupId, impressions: 0, clicks: 0, costMicros: 0n, orders: 0, sales: 0 }
    cur.impressions += r._sum.impressions ?? 0
    cur.clicks += r._sum.clicks ?? 0
    cur.costMicros += r._sum.costMicros ?? 0n
    cur.orders += r._sum.orders7d ?? 0
    cur.sales += r._sum.sales7dCents ?? 0
    perAgMap.set(k, cur)
  }
  const perAg = [...perAgMap.values()].map((r) => ({
    query: r.query, adGroupId: r.adGroupId,
    _sum: { impressions: r.impressions, clicks: r.clicks, costMicros: r.costMicros, orders7d: r.orders, sales7dCents: r.sales },
  }))
  const trafficByTerm = new Map<string, Map<string, { impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number }>>()
  for (const r of perAg) {
    const t = normaliseNegTerm(r.query)
    const m = trafficByTerm.get(t) ?? new Map()
    m.set(r.adGroupId, {
      impressions: r._sum.impressions ?? 0,
      clicks: r._sum.clicks ?? 0,
      spendCents: Math.round(Number(r._sum.costMicros ?? 0n) / 10000),
      orders: r._sum.orders7d ?? 0,
      salesCents: r._sum.sales7dCents ?? 0,
    })
    trafficByTerm.set(t, m)
  }

  // ── Detector A ──────────────────────────────────────────────────────────────────────────────
  const conflicts: ConflictRow[] = []
  let conflictsUnscoped = 0
  let relaxedUnscoped = 0
  let relaxedScoped = 0
  const relaxedExplained: AttentionPayload['conflicts']['relaxedExplained'] = []

  for (const [termKey, rows] of byTerm) {
    const traffic = trafficByTerm.get(termKey)
    if (!traffic) continue
    const adGroupRows = rows.filter((r) => r.negativeLevel !== 'CAMPAIGN' && r.adGroup?.externalAdGroupId)
    const negatedIn = new Set(adGroupRows.map((r) => r.adGroup!.externalAdGroupId!)).size
    const runsIn = traffic.size

    for (const [extAg, tr] of traffic) {
      const here = adGroupRows.filter((r) => r.adGroup!.externalAdGroupId === extAg)
      if (here.length === 0) continue

      // relaxed — the join is working if this is ever non-zero
      relaxedUnscoped++
      if (here.some(inScope)) relaxedScoped++

      // 🔴 The time-order test. The impression must land AFTER the negation existed, or the
      // "conflict" is a record of the negative doing its job.
      const newest = lastSeen.get(`${termKey}|${extAg}`)
      const blockingHere = here.filter((r) => blocks(r) && newest != null && newest > r.createdAt)
      const blockingIgnoringTime = here.filter(blocks)
      if (blockingHere.length === 0) {
        // Why it is NOT a conflict, recorded rather than silently dropped.
        const why = blockingIgnoringTime.length > 0
          ? `the traffic predates the negation — the last impression here was ${newest?.toISOString().slice(0, 10)}, the negation was created ${blockingIgnoringTime.map((r) => r.createdAt.toISOString().slice(0, 10)).sort()[0]}; this is the negative working`
          : here.every((r) => String(r.status) === 'ARCHIVED') ? 'every negation here is ARCHIVED'
            : here.every((r) => r.adGroup?.campaign?.status !== 'ENABLED') ? 'the campaign is not enabled'
              : here.every((r) => !r.externalTargetId) ? 'Amazon never confirmed these negations'
                : 'no negation here meets all four blocking conditions'
        relaxedExplained.push({ termKey, externalAdGroupId: extAg, rows: here.length, reason: why })
        continue
      }

      conflictsUnscoped++
      const lead = blockingHere[0]
      if (!blockingHere.some(inScope)) continue
      conflicts.push({
        adTargetId: lead.id,
        term: lead.expressionValue,
        termKey,
        match: normaliseMatchType(lead.expressionType, lead.kind).type,
        campaignId: lead.adGroup?.campaign?.id ?? '',
        campaignName: lead.adGroup?.campaign?.name ?? '—',
        adGroupId: lead.adGroup?.id ?? '',
        adGroupName: lead.adGroup?.name ?? '—',
        externalAdGroupId: extAg,
        market: lead.adGroup?.campaign?.marketplace ?? '—',
        adGroupTraffic: tr,
        overlapRows: blockingHere.length,
        negatedIn,
        runsIn,
        actionable: actionable(lead),
      })
    }
  }
  conflicts.sort((a, b) => b.adGroupTraffic.salesCents - a.adGroupTraffic.salesCents || b.adGroupTraffic.impressions - a.adGroupTraffic.impressions)

  // ── Detector B ──────────────────────────────────────────────────────────────────────────────
  const hist = terms.length
    ? await prisma.amazonAdsSearchTerm.groupBy({
      by: ['query'], where: { date: { gte: since120 }, query: { in: terms } },
      _sum: { impressions: true, orders7d: true, sales7dCents: true, costMicros: true },
    })
    : []
  const histByTerm = new Map(hist.map((r) => [normaliseNegTerm(r.query), {
    impressions: r._sum.impressions ?? 0, orders: r._sum.orders7d ?? 0,
    salesCents: r._sum.sales7dCents ?? 0, spendCents: Math.round(Number(r._sum.costMicros ?? 0n) / 10000),
  }]))

  const suppressedAll: SuppressedRow[] = []
  for (const [termKey, rows] of byTerm) {
    const windowImpressions = [...(trafficByTerm.get(termKey)?.values() ?? [])].reduce((a, x) => a + x.impressions, 0)
    if (windowImpressions !== 0) continue
    const hb = histByTerm.get(termKey)
    if (!hb || hb.orders < MIN_HISTORY_ORDERS) continue
    const blocking = rows.filter(blocks).length
    suppressedAll.push({
      termKey,
      term: rows[0].expressionValue,
      negations: rows.length,
      blocking,
      markets: [...new Set(rows.map((r) => r.adGroup?.campaign?.marketplace).filter((x): x is string => !!x))].sort(),
      history: { days: HISTORY_DAYS, ...hb },
      windowImpressions,
      // Sample size on the row. One order is a signal worth surfacing, not a proven loss.
      thin: hb.orders <= 1,
      // 🔴 Nothing blocks it ⇒ the negative is NOT the cause; the campaigns are paused. Rendering
      // this as a finding would make the operator do the elimination the detector exists to do.
      explained: blocking === 0,
      actionable: rows.some((r) => blocks(r) && actionable(r)),
    })
  }
  suppressedAll.sort((a, b) => b.history.salesCents - a.history.salesCents)
  const suppressedScoped = suppressedAll.filter((s) => (byTerm.get(s.termKey) ?? []).some(inScope))

  // ── split-brain ─────────────────────────────────────────────────────────────────────────────
  const splitAll = negs.filter((n) => !n.externalTargetId)
  const reasonFor = (n: typeof negs[number]) =>
    n.negativeLevel === 'CAMPAIGN'
      ? 'campaign-scope mirror written after a denied push — the write gate refused at `connection` because `marketplace` was never passed (fixed in NEG.0)'
      : 'an ad-group negation that never got an id back from Amazon'
  const toSplit = (n: typeof negs[number]): SplitBrainRow => ({
    adTargetId: n.id,
    term: n.expressionValue,
    termKey: normaliseNegTerm(n.expressionValue),
    match: normaliseMatchType(n.expressionType, n.kind).type,
    level: n.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP',
    campaignId: n.adGroup?.campaign?.id ?? '',
    campaignName: n.adGroup?.campaign?.name ?? '—',
    campaignStatus: String(n.adGroup?.campaign?.status ?? '—'),
    adGroupName: n.adGroup?.name ?? '—',
    market: n.adGroup?.campaign?.marketplace ?? '—',
    addedAt: n.createdAt.toISOString(),
    reason: reasonFor(n),
    // A local delete: the write gate never runs, so the allowlist does not bite here.
    actionable: true,
  })
  const splitScoped = splitAll.filter(inScope).map(toSplit)
  const byReason: Record<string, number> = {}
  for (const s of splitAll) { const k = s.negativeLevel === 'CAMPAIGN' ? 'campaign-scope mirror' : 'no id returned'; byReason[k] = (byReason[k] ?? 0) + 1 }

  const blockingAll = negs.filter(blocks)

  return {
    scope: { market: req.market, boundBy: scope.boundBy, resolved: { campaigns: scope.campaignIds.length } },
    window: { days: windowDays, since: since.toISOString() },
    thresholds: {
      windowDays,
      historyDays: HISTORY_DAYS,
      minHistoryOrders: MIN_HISTORY_ORDERS,
      blockingDefinition: 'confirmed at Amazon · target ENABLED · campaign ENABLED · ad-group scope',
    conflictDefinition: 'a blocking negation whose OWN ad group took an impression for the exact term AFTER the negation was created',
    },
    denominators: {
      blockingNegations: blockingAll.filter(inScope).length,
      blockingNegationsUnscoped: blockingAll.length,
      negations: negs.filter(inScope).length,
      terms: byTerm.size,
    },
    conflicts: {
      rows: conflicts,
      total: conflicts.length,
      totalUnscoped: conflictsUnscoped,
      overlapsRelaxed: relaxedScoped,
      overlapsRelaxedUnscoped: relaxedUnscoped,
      relaxedExplained,
    },
    suppressed: {
      rows: suppressedScoped.filter((s) => !s.explained),
      total: suppressedScoped.filter((s) => !s.explained).length,
      totalUnscoped: suppressedAll.filter((s) => !s.explained).length,
      explained: suppressedScoped.filter((s) => s.explained).length,
    },
    splitBrain: { rows: splitScoped, total: splitScoped.length, totalUnscoped: splitAll.length, byReason },
    // 🔴 A real count of what was read. 0 here means the read failed; it does NOT mean a quiet
    // account, and the UI refuses to report "nothing wrong" when this is 0.
    coverage: { searchTermRows: perAg.length, termsWithTraffic: trafficByTerm.size, termsTotal: byTerm.size },
  }
}

export { NEG_MARKETS, NEG_MARKET_ALL }
