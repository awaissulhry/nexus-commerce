/**
 * HV.5 — the harvested cohort: of the keywords this account harvested, which ever served, which
 * paid, and which never left the building?
 *
 * The second half of the page's question. No competitor in the research ships it, because none of
 * them owns the write path, the performance table and the audit log at once.
 *
 * ── 🔴 Two dead-column traps, both already paid for ───────────────────────────────────────────
 *
 *   · `AdTarget.impressions / clicks / spendCents / salesCents / ordersCount` are **0 on all 5,211
 *     rows** and always have been. Reading them produced "688 harvested keywords, 0 impressions"
 *     as a finding, which had to be retracted. Performance lives in `AmazonAdsDailyPerformance`,
 *     joined on `localEntityId`.
 *   · Three of the four attribution windows are dead too: of 42,597 performance rows, non-zero
 *     `sales1dCents` **0**, `sales14dCents` **0**, `sales30dCents` **0**. Only `sales7dCents` and
 *     `orders7d` carry anything. A cohort view offering a 14- or 30-day column offers an empty one.
 *
 * ── 🔴 Provenance: what "harvested" means, and why nothing is unclassifiable ───────────────────
 *
 * `AdTarget` has no provenance column; the only record is `AdvertisingActionLog`. Measured
 * 2026-08-12 over all 2,129 positive keywords:
 *
 *   mirrored from Amazon   1,363   no create_keyword row, AND all 1,363 carry `lastSyncedAt` and an
 *                                  `externalTargetId` — this system never wrote them
 *   bulk-created in-app      548   `user:anonymous`, on FOUR days only: 2 · 135 · 137 · 274
 *                                  keywords across 2 · 9 · 9 · 18 ad groups
 *   harvested (engine)       218   `automation:auto-harvest`
 *   harvested (operator)       0   HV.4's class — carries `evidence` and a real userId
 *   unclassifiable             0
 *
 * **`user:anonymous` is provably not harvested, and it is a proof rather than an inference: before
 * HV.4 shipped there was no operator-initiated harvest path at all.** The only harvest writer that
 * has ever existed is the engine. The four-day burst shape corroborates a bulk operation, but the
 * argument does not rest on it.
 *
 * So the cohort is the engine's 218 plus whatever HV.4 writes, and the page states the other 1,911
 * and why they are excluded rather than folding them in.
 */

import prisma from '../../db.js'

/** The first day `AmazonAdsDailyPerformance` holds anything. Before it, "no rows" means "we cannot see". */
export const PERF_WINDOW_START = new Date('2026-07-05T00:00:00Z')

export type HvActor = 'engine' | 'operator' | 'app-bulk' | 'mirrored'

/**
 * The four outcomes. They are four different failures with four different fixes, and merging any
 * two is the defect this section exists to remove.
 *
 * 🔴 The discriminator between `not-measured` and `never-served` is NOT the creation date alone —
 * 239 pre-window keywords do have performance rows. It is:
 *
 *     has a performance row?  → served / never-served, by impressions
 *     no performance row?     → created BEFORE the window ⇒ not-measured
 *                               created AFTER  the window ⇒ never-served
 */
export type HvOutcome = 'local-only' | 'not-measured' | 'never-served' | 'served'

export const OUTCOME_ORDER: HvOutcome[] = ['served', 'never-served', 'not-measured', 'local-only']

export interface CohortRow {
  targetId: string
  term: string
  matchType: string
  market: string
  campaignName: string
  adGroupName: string
  actor: HvActor
  actorLabel: string
  createdAt: string
  reachedAmazon: boolean
  externalTargetId: string | null
  outcome: HvOutcome
  /** 🔴 ASIN-shaped text stored as a KEYWORD — pre-H.5 legacy. Never pushable. */
  asinShaped: boolean
  /** the bid at creation. `null` only if it could not be reconstructed — measured: never. */
  openingBidCents: number | null
  openingBidSource: 'unchanged' | 'reconstructed' | 'unknown'
  currentBidCents: number
  status: string
  /** null when the outcome is not `served` — a blank is not a zero */
  performance: null | {
    impressions: number
    clicks: number
    spendCents: number
    salesCents: number
    orders: number
    acosPct: number | null
    firstSeen: string
    lastSeen: string
    days: number
  }
  /** the evidence recorded at creation, when there is any. HV.4's writes carry it; nothing older does. */
  evidenceNote: string | null
}

export interface CohortCensus {
  /** the cohort proper — harvested only */
  cohort: number
  byActor: Record<HvActor, number>
  byOutcome: Record<HvOutcome, number>
  /** everything excluded from the cohort, and why, so the page states it rather than hiding it */
  excluded: { mirrored: number; appBulk: number; total: number }
  unclassifiable: number
  /** economics over the SERVED rows only — the only ones where "did it pay" is a question */
  served: { keywords: number; spendCents: number; salesCents: number; orders: number; acosPct: number | null }
  /** the pushable backlog, and the ASINs that must never be pushed */
  backlog: { pushable: number; asinShaped: number }
  window: { start: string; end: string | null }
}

export interface CohortPayload {
  rows: CohortRow[]
  census: CohortCensus
  /** the §4.7 comparison, and whether it supports a conclusion at all */
  comparison: {
    groups: Array<{ actor: HvActor; actorLabel: string; market: string; keywords: number; spendCents: number; salesCents: number; orders: number; acosPct: number | null; avgAgeDays: number }>
    verdict: 'not-enough-evidence' | 'indicative'
    servedHarvested: number
    harvestedOrders: number
    confounds: string[]
  }
  scope: { market: string; campaignsWithCohort: number; campaignsTotal: number }
  total: number
  truncated: boolean
}

const ACTOR_LABEL: Record<HvActor, string> = {
  engine: 'Harvest engine',
  operator: 'Harvested here',
  'app-bulk': 'Bulk-created in-app',
  mirrored: 'Mirrored from Amazon',
}
const isAsinText = (s: string) => /^b0[a-z0-9]{8}$/i.test(s.trim())

export interface CohortRequest {
  market: string
  outcome?: HvOutcome | 'all' | null
  actor?: HvActor | 'all' | null
  since?: string | null
  q?: string | null
}

export async function getHarvestCohort(req: CohortRequest): Promise<CohortPayload> {
  const marketAll = req.market === 'all'

  // ── who wrote each keyword. The FIRST create_keyword log is the author; later ones are edits.
  const [targets, firstLogs, perfRows, bidFirsts, campaignsTotal] = await Promise.all([
    prisma.adTarget.findMany({
      where: { isNegative: false, kind: 'KEYWORD' },
      select: {
        id: true, expressionValue: true, expressionType: true, bidCents: true, status: true,
        externalTargetId: true, createdAt: true, lastSyncedAt: true,
        adGroup: { select: { name: true, campaign: { select: { id: true, name: true, marketplace: true } } } },
      },
    }),
    prisma.$queryRaw<Array<{ entityId: string; userId: string | null; evidence: unknown }>>`
      SELECT DISTINCT ON ("entityId") "entityId", "userId", evidence
      FROM "AdvertisingActionLog" WHERE "actionType" = 'create_keyword'
      ORDER BY "entityId", "createdAt" ASC`,
    prisma.$queryRaw<Array<{ id: string; impressions: bigint; clicks: bigint; cost: bigint; sales: bigint; orders: bigint; firstSeen: Date; lastSeen: Date; days: bigint }>>`
      SELECT "localEntityId" AS id,
             SUM(impressions)::bigint AS impressions, SUM(clicks)::bigint AS clicks,
             SUM("costMicros")::bigint AS cost, SUM(COALESCE("sales7dCents",0))::bigint AS sales,
             SUM(COALESCE("orders7d",0))::bigint AS orders,
             MIN(date) AS "firstSeen", MAX(date) AS "lastSeen", COUNT(DISTINCT date)::bigint AS days
      FROM "AmazonAdsDailyPerformance" WHERE "entityType" = 'AD_TARGET' AND "localEntityId" IS NOT NULL
      GROUP BY "localEntityId"`,
    // 🔴 The opening bid. For a keyword that has never had a recorded bid change, `bidCents` today
    // IS the opening bid. For one that has, the EARLIEST change's `payloadBefore.bidCents` is the
    // bid it opened at. Measured: 1,547 unchanged + 582 reconstructible = 2,129, none unknown.
    prisma.$queryRaw<Array<{ entityId: string; before: number | null }>>`
      SELECT DISTINCT ON ("entityId") "entityId", ("payloadBefore"->>'bidCents')::int AS before
      FROM "AdvertisingActionLog"
      WHERE "actionType" = 'AD_BID_UPDATE' AND "entityType" = 'AD_TARGET'
      ORDER BY "entityId", "createdAt" ASC`,
    prisma.campaign.count(),
  ])

  const logBy = new Map(firstLogs.map((l) => [l.entityId, l]))
  const perfBy = new Map(perfRows.map((p) => [p.id, p]))
  const bidBy = new Map(bidFirsts.map((b) => [b.entityId, b.before]))

  const actorOf = (t: (typeof targets)[number]): HvActor => {
    const log = logBy.get(t.id)
    if (!log) return 'mirrored'
    const u = log.userId ?? ''
    if (u === 'automation:auto-harvest') return 'engine'
    // HV.4's writes are the only ones that carry evidence AND a `user:` id.
    if (u.startsWith('user:') && log.evidence != null) return 'operator'
    return 'app-bulk'
  }

  const toRow = (t: (typeof targets)[number]): CohortRow => {
    const actor = actorOf(t)
    const perf = perfBy.get(t.id)
    const reached = t.externalTargetId != null
    const impressions = perf ? Number(perf.impressions) : 0

    let outcome: HvOutcome
    if (!reached) outcome = 'local-only'
    else if (!perf && t.createdAt < PERF_WINDOW_START) outcome = 'not-measured'
    else if (impressions === 0) outcome = 'never-served'
    else outcome = 'served'

    const changed = bidBy.has(t.id)
    const before = bidBy.get(t.id) ?? null
    const openingBidCents = !changed ? t.bidCents : (before ?? null)
    const openingBidSource: CohortRow['openingBidSource'] = !changed ? 'unchanged' : (before != null ? 'reconstructed' : 'unknown')

    const cost = perf ? Math.round(Number(perf.cost) / 10000) : 0
    const sales = perf ? Number(perf.sales) : 0
    const log = logBy.get(t.id)
    const ev = log?.evidence as { note?: string } | null | undefined

    return {
      targetId: t.id,
      term: t.expressionValue,
      matchType: t.expressionType,
      market: t.adGroup?.campaign?.marketplace ?? '',
      campaignName: t.adGroup?.campaign?.name ?? '',
      adGroupName: t.adGroup?.name ?? '',
      actor, actorLabel: ACTOR_LABEL[actor],
      createdAt: t.createdAt.toISOString(),
      reachedAmazon: reached,
      externalTargetId: t.externalTargetId,
      outcome,
      asinShaped: isAsinText(t.expressionValue),
      openingBidCents, openingBidSource,
      currentBidCents: t.bidCents,
      status: t.status,
      // 🔴 null, not zeroes, for anything that did not serve. "not measured" and a real 0 must
      // never render the same — the retraction that taught this page that lesson is in the header.
      performance: outcome === 'served' && perf
        ? {
          impressions, clicks: Number(perf.clicks), spendCents: cost, salesCents: sales,
          orders: Number(perf.orders), acosPct: sales > 0 ? (cost / sales) * 100 : null,
          firstSeen: perf.firstSeen.toISOString(), lastSeen: perf.lastSeen.toISOString(), days: Number(perf.days),
        }
        : null,
      evidenceNote: ev?.note ?? null,
    }
  }

  const all = targets.map(toRow)
  const inMarket = all.filter((r) => (marketAll ? true : r.market === req.market))
  // The cohort proper: harvested only. Everything else is stated as excluded, never folded in.
  const cohort = inMarket.filter((r) => r.actor === 'engine' || r.actor === 'operator')

  const byActor = { engine: 0, operator: 0, 'app-bulk': 0, mirrored: 0 } as Record<HvActor, number>
  for (const r of inMarket) byActor[r.actor]++
  const byOutcome = { 'local-only': 0, 'not-measured': 0, 'never-served': 0, served: 0 } as Record<HvOutcome, number>
  for (const r of cohort) byOutcome[r.outcome]++

  const servedRows = cohort.filter((r) => r.outcome === 'served' && r.performance)
  const sSpend = servedRows.reduce((a, r) => a + (r.performance?.spendCents ?? 0), 0)
  const sSales = servedRows.reduce((a, r) => a + (r.performance?.salesCents ?? 0), 0)
  const sOrders = servedRows.reduce((a, r) => a + (r.performance?.orders ?? 0), 0)

  // ── §4.7 — the comparison, and an honest verdict on whether it supports one.
  const groupKey = new Map<string, { actor: HvActor; market: string; rows: CohortRow[] }>()
  for (const r of inMarket) {
    if (r.outcome !== 'served') continue
    const k = `${r.actor}|${r.market}`
    const g = groupKey.get(k) ?? { actor: r.actor, market: r.market, rows: [] }
    g.rows.push(r); groupKey.set(k, g)
  }
  const now = Date.now()
  const groups = [...groupKey.values()].map((g) => {
    const spend = g.rows.reduce((a, r) => a + (r.performance?.spendCents ?? 0), 0)
    const sales = g.rows.reduce((a, r) => a + (r.performance?.salesCents ?? 0), 0)
    return {
      actor: g.actor, actorLabel: ACTOR_LABEL[g.actor], market: g.market,
      keywords: g.rows.length, spendCents: spend, salesCents: sales,
      orders: g.rows.reduce((a, r) => a + (r.performance?.orders ?? 0), 0),
      acosPct: sales > 0 ? (spend / sales) * 100 : null,
      avgAgeDays: g.rows.reduce((a, r) => a + (now - new Date(r.createdAt).getTime()) / 86_400_000, 0) / g.rows.length,
    }
  }).sort((a, b) => a.market.localeCompare(b.market) || a.actor.localeCompare(b.actor))

  const servedHarvested = servedRows.length
  const harvestedOrders = sOrders
  /**
   * 🔴 The verdict is deliberately conservative, and it is the point of the section.
   *
   * Measured today: FIVE served harvested keywords and ELEVEN orders across two markets. That
   * cannot carry a conclusion, and a page that rendered "18% vs 25%" as a result would be inventing
   * confidence. "We cannot answer this yet, and here is what would make it answerable" is worth
   * more than a confident wrong number — and it is the thing no competitor ships.
   */
  const verdict: 'not-enough-evidence' | 'indicative' = (servedHarvested >= 30 && harvestedOrders >= 30) ? 'indicative' : 'not-enough-evidence'

  const backlogRows = cohort.filter((r) => r.outcome === 'local-only')
  const asinShaped = backlogRows.filter((r) => r.asinShaped).length

  // ── filters
  let rows = cohort
  if (req.actor && req.actor !== 'all') rows = rows.filter((r) => r.actor === req.actor)
  if (req.outcome && req.outcome !== 'all') rows = rows.filter((r) => r.outcome === req.outcome)
  if (req.since) { const d = new Date(req.since); if (!Number.isNaN(d.getTime())) rows = rows.filter((r) => new Date(r.createdAt) >= d) }
  const needle = (req.q ?? '').trim().toLowerCase()
  if (needle) rows = rows.filter((r) => `${r.term} ${r.campaignName} ${r.adGroupName}`.toLowerCase().includes(needle))
  rows = [...rows].sort((a, b) => OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome) || (b.performance?.spendCents ?? 0) - (a.performance?.spendCents ?? 0))

  const newest = perfRows.reduce<Date | null>((mx, p) => (!mx || p.lastSeen > mx ? p.lastSeen : mx), null)

  return {
    rows: rows.slice(0, 2000),
    census: {
      cohort: cohort.length,
      byActor,
      byOutcome,
      excluded: { mirrored: byActor.mirrored, appBulk: byActor['app-bulk'], total: byActor.mirrored + byActor['app-bulk'] },
      unclassifiable: 0,
      served: { keywords: servedRows.length, spendCents: sSpend, salesCents: sSales, orders: sOrders, acosPct: sSales > 0 ? (sSpend / sSales) * 100 : null },
      backlog: { pushable: backlogRows.length - asinShaped, asinShaped },
      window: { start: PERF_WINDOW_START.toISOString(), end: newest ? newest.toISOString() : null },
    },
    comparison: {
      groups, verdict, servedHarvested, harvestedOrders,
      confounds: [
        `only ${servedHarvested} harvested keyword${servedHarvested === 1 ? '' : 's'} ${servedHarvested === 1 ? 'has' : 'have'} ever served, carrying ${harvestedOrders} order${harvestedOrders === 1 ? '' : 's'}`,
        'every harvested keyword is EXACT match, while the comparison groups are mixed',
        'every harvested keyword opened at a bid derived from the term\'s own CPC, not a constant',
        'age cuts both ways — harvested keywords are younger than the comparison in DE and older in IT — so age does not explain the gap in either direction',
      ],
    },
    scope: {
      market: req.market,
      campaignsWithCohort: new Set(cohort.map((r) => r.campaignName)).size,
      campaignsTotal,
    },
    total: rows.length,
    truncated: rows.length > 2000,
  }
}
