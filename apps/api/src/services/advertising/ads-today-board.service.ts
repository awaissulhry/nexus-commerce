/**
 * ACR.1.4 — Today: the priced exception board.
 *
 * The Levers tab answers "what is allowed to act". This one answers the only question an
 * operator who wants to stop watching actually has: **what needs me right now, and what is
 * it costing me to ignore?**
 *
 * Two rules decide what earns a row here, both learned from the competitor teardowns and
 * from this account:
 *
 *   1. **It must be live.** 167 ad mutations failed between 2026-07-28 and 2026-08-02 and
 *      none since. A board that still shouts about them is a board an operator learns to
 *      scroll past, and then it is worth nothing on the day something real appears. Every
 *      window here is short enough that a fixed condition clears itself.
 *   2. **It must be priced, or say why it cannot be.** Same discipline as ACR.0.5: where
 *      the € is computable it is shown; where it is not, `amountCents` is null and
 *      `amountNote` says what is missing. A confident €0 next to a real problem is worse
 *      than no number, because it ranks the problem last.
 *
 * Every candidate source below was measured on prod before it was written (2026-08-05,
 * `_acr14-today-inventory.mts` / `_acr14-recheck.mts`). Sources that carried no real rows
 * were not built.
 *
 * Read-only. It reports; it never changes anything.
 */
import prisma from '../../db.js'
import { getAutomationState } from './ads-automation-state.service.js'
import { getCoverageScoreboard } from './ads-coverage.service.js'

export type Severity = 'critical' | 'warning' | 'info'

export interface Exception {
  key: string
  severity: Severity
  /** What is wrong, in the operator's words. */
  title: string
  /** The evidence, with the numbers that make it checkable. */
  detail: string
  /** How many things are in this state. */
  count: number
  /** The price of ignoring it. null when it genuinely cannot be computed. */
  amountCents: number | null
  /** What the amount measures ("wasted in 30 days"), or why there isn't one. */
  amountNote: string
  /** Where to go and do something about it. */
  action: { label: string; href: string } | null
  /** Oldest instance, so "how long has this been true" is answerable. */
  since: string | null
}

export interface TodayBoard {
  generatedAt: string
  /** The one number that belongs above the fold. */
  headline: { wastedSpend30dCents: number | null; wastedTargets: number; note: string }
  exceptions: Exception[]
  /** Counts by severity, so the tab can carry a badge without re-deriving. */
  totals: { critical: number; warning: number; info: number }
}

const DAY = 86_400_000
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

/**
 * Targets that took real clicks and returned nothing. The clicks floor matters: one click
 * and no sale is not evidence of waste, it is a sample of size one.
 */
const WASTE_MIN_CLICKS = 10
const WASTE_WINDOW_DAYS = 30

async function wastedSpend(): Promise<{ cents: number; targets: number }> {
  const rows = await prisma.$queryRawUnsafe<{ spend_c: bigint | number | null; targets: bigint | number | null }[]>(`
    SELECT COALESCE(SUM(spend), 0) AS spend_c, COUNT(*) AS targets FROM (
      SELECT d."entityId",
             SUM(d."costMicros") / 10000 AS spend,
             SUM(d.clicks) AS clicks,
             SUM(d."sales7dCents") AS sales
      FROM "AmazonAdsDailyPerformance" d
      WHERE d."entityType" = 'AD_TARGET'
        AND d.date > now() - interval '${WASTE_WINDOW_DAYS} days'
      GROUP BY 1
      HAVING SUM(d.clicks) >= ${WASTE_MIN_CLICKS} AND SUM(d."sales7dCents") = 0
    ) x
  `)
  const r = rows[0]
  return { cents: Number(r?.spend_c ?? 0), targets: Number(r?.targets ?? 0) }
}

/**
 * Rank modes with no CPC ceiling, weighted by how much they are actually used.
 *
 * This corrects the record. The open note said the risk was the ALL-OUT hours; measured,
 * `own-top-allout` is the only mode that HAS a ceiling (€2.00). The unbounded ones are the
 * everyday modes — and `rest-of-search` is the single most-scheduled window on the account.
 * An ACOS cap is not a substitute: it bounds efficiency after the fact, not price per click.
 *
 * `pause` is exempt — it only ever drives bids down, so a missing ceiling cannot cost money.
 */
async function unboundedRankModes(): Promise<{ modes: { key: string; name: string; windows: number; acosCapPct: number | null }[] }> {
  const targets = await prisma.rankTarget.findMany({
    where: { maxCpcCents: null, key: { not: 'pause' } },
    select: { key: true, name: true, acosCapPct: true },
  })
  if (targets.length === 0) return { modes: [] }
  const usage = await prisma.$queryRawUnsafe<{ window_target: string | null; windows: bigint | number }[]>(`
    SELECT w->>'targetKey' AS window_target, COUNT(*) AS windows
    FROM "AdSchedule" s, jsonb_array_elements(s.windows::jsonb) w
    WHERE s.enabled = true
    GROUP BY 1
  `).catch(() => [])
  const byKey = new Map<string, number>(
    usage.filter((u) => u.window_target != null).map((u) => [u.window_target as string, Number(u.windows)] as const),
  )
  return {
    modes: targets
      .map((t) => ({ key: t.key, name: t.name, windows: byKey.get(t.key) ?? 0, acosCapPct: t.acosCapPct }))
      .filter((m) => m.windows > 0)
      .sort((a, b) => b.windows - a.windows),
  }
}

export async function getTodayBoard(): Promise<TodayBoard> {
  const now = new Date()
  const since48h = new Date(now.getTime() - 2 * DAY)
  const since24h = new Date(now.getTime() - DAY)

  const [
    coverage,
    waste,
    unbounded,
    pending,
    pendingOld,
    pendingOldest,
    notDelivering,
    failedMutations,
    failedMutationNewest,
    cronFails,
    advertisedWithoutCost,
    advertisedOnEstimate,
    advertisedTotal,
    state,
    allowlisted,
    withoutFloor,
  ] = await Promise.all([
    // ACR.2.6 — the coverage board's most actionable fact belongs here too. Fails soft: Today
    // must still render if SQP is unavailable, because every other row on it is unrelated.
    getCoverageScoreboard({ marketplace: 'IT', limit: 200 }).catch(() => null),
    wastedSpend(),
    unboundedRankModes(),
    prisma.adsRuleSuggestion.count({ where: { status: 'pending' } }),
    prisma.adsRuleSuggestion.count({ where: { status: 'pending', createdAt: { lt: new Date(now.getTime() - 7 * DAY) } } }),
    prisma.adsRuleSuggestion.findFirst({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    prisma.campaign.findMany({
      where: { status: 'ENABLED', deliveryStatus: 'NOT_DELIVERING', name: { not: { startsWith: 'ZZ_e2e' } } },
      select: { id: true, name: true, deliveryReasons: true },
    }),
    prisma.adMutation.count({ where: { state: 'FAILED', createdAt: { gte: since48h } } }),
    prisma.adMutation.findFirst({ where: { state: 'FAILED' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, lastError: true } }),
    prisma.cronRun.groupBy({
      by: ['jobName'],
      where: { status: 'FAILED', startedAt: { gte: since24h }, jobName: { startsWith: 'ads-' } },
      _count: { _all: true },
      _max: { startedAt: true },
    }).catch(() => []),
    /**
     * ACR.4 — count products with no REAL cost price, not products with no cogsCents.
     *
     * The interim estimate writes a positive cogsCents, so the original `cogsCents > 0` test
     * silently started counting estimated products as costed: this row fell from "223 of 223"
     * to "206 of 223" and downgraded itself from warning to info, reporting progress that had
     * not happened. `coverage.hasCostPrice` is the flag that means measured, and it is the only
     * one this row may read.
     */
    prisma.$queryRawUnsafe<{ n: bigint | number }[]>(`
      SELECT COUNT(DISTINCT pa."productId") AS n
      FROM "AdProductAd" pa
      WHERE pa."productId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "ProductProfitDaily" d
          WHERE d."productId" = pa."productId"
            AND (d."coverage"->>'hasCostPrice')::boolean IS TRUE
        )
    `),
    // How many of those are at least running on the interim estimate, so the row can say so.
    prisma.$queryRawUnsafe<{ n: bigint | number }[]>(`
      SELECT COUNT(DISTINCT pa."productId") AS n
      FROM "AdProductAd" pa
      WHERE pa."productId" IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM "ProductProfitDaily" d
          WHERE d."productId" = pa."productId"
            AND (d."coverage"->>'costEstimated')::boolean IS TRUE
        )
    `),
    prisma.$queryRawUnsafe<{ n: bigint | number }[]>(`
      SELECT COUNT(DISTINCT pa."productId") AS n FROM "AdProductAd" pa WHERE pa."productId" IS NOT NULL
    `),
    getAutomationState(),
    prisma.campaign.count({ where: { liveBidWritesEnabled: true } }),
    prisma.campaign.count({ where: { liveBidWritesEnabled: true, minBidCents: null } }),
  ])

  const ex: Exception[] = []

  // ── The account is stopped ────────────────────────────────────────────
  // First, always, when true: every other row is moot if nothing can act.
  if (state.effectivelyStopped) {
    ex.push({
      key: 'automation-stopped',
      severity: 'critical',
      title: 'Automation is stopped — nothing below can act',
      detail: state.haltReason
        ? `${state.haltReason} Every write is refused at the gate until this is resumed; suppression stays allowed, so bids can still come down.`
        : `The account dial is ${state.autonomy}. Writes are refused at the gate until it is raised.`,
      count: 1,
      amountCents: null,
      amountNote: 'Cost depends on how long it stays stopped',
      action: { label: 'Open the kill switch', href: '/marketing/ads/rules-automation/control-room' },
      since: state.haltedAt, // already an ISO string on the state object
    })
  }

  // ── Wasted spend ──────────────────────────────────────────────────────
  if (waste.targets > 0) {
    ex.push({
      key: 'wasted-spend',
      severity: waste.cents >= 10_000 ? 'critical' : 'warning',
      title: 'Keywords taking clicks and returning nothing',
      detail: `${waste.targets} target${waste.targets === 1 ? '' : 's'} took ${WASTE_MIN_CLICKS}+ clicks in ${WASTE_WINDOW_DAYS} days and converted zero times. Judged at target grain, so each one is a keyword you could bid down or negate.`,
      count: waste.targets,
      amountCents: waste.cents,
      amountNote: `spent, last ${WASTE_WINDOW_DAYS} days`,
      action: { label: 'Open Recommendations', href: '/marketing/ads/recommendations' },
      since: null,
    })
  }

  // ── Unbounded rank modes ──────────────────────────────────────────────
  if (unbounded.modes.length > 0) {
    const totalWindows = unbounded.modes.reduce((a, m) => a + m.windows, 0)
    const worst = unbounded.modes[0]
    ex.push({
      key: 'rank-modes-no-cpc-ceiling',
      severity: 'critical',
      title: `${unbounded.modes.length} rank mode${unbounded.modes.length === 1 ? '' : 's'} can bid without a price ceiling`,
      detail:
        `${unbounded.modes.map((m) => `${m.name} (${m.windows} windows${m.acosCapPct != null ? `, ACOS cap ${m.acosCapPct}%` : ', no ACOS cap'})`).join(' · ')}. ` +
        `Most-scheduled is ${worst.name}. An ACOS cap bounds efficiency after the spend has happened; it does not bound what a single click may cost. ` +
        `Note the all-out mode is NOT among these — it is the one mode that carries a ceiling.`,
      // Count the modes, not the windows. `count` is "how many things are in this state"
      // everywhere else on this board, and 1,980 windows next to "3 rank modes" reads as a
      // different, much larger problem than the one being reported.
      count: unbounded.modes.length,
      amountCents: null,
      amountNote: `Exposure across ${totalWindows.toLocaleString('en-IE')} scheduled windows — no ceiling means no computable worst case`,
      action: { label: 'Open rank schedules', href: '/marketing/ads/rules-automation/dayparting' },
      since: null,
    })
  }

  // ── Proposals waiting on a human ──────────────────────────────────────
  if (pending > 0) {
    ex.push({
      key: 'decisions-waiting',
      severity: pendingOld > 0 ? 'warning' : 'info',
      title: `${pending} proposal${pending === 1 ? '' : 's'} waiting for you`,
      detail:
        `Rules in PROPOSE mode queue their changes instead of applying them. ${pending - pendingOld} arrived recently; ` +
        `${pendingOld === 0 ? 'none are' : `${pendingOld} ${pendingOld === 1 ? 'is' : 'are'}`} older than a week. ` +
        `Nothing here has been applied, so whatever they were reacting to is still true.`,
      count: pending,
      amountCents: null,
      amountNote: 'Proposals carry no € estimate yet',
      action: { label: 'Review proposals', href: '/marketing/ads/suggestions' },
      since: iso(pendingOldest?.createdAt),
    })
  }

  // ── Enabled but not serving ───────────────────────────────────────────
  if (notDelivering.length > 0) {
    const reasons = new Map<string, number>()
    for (const c of notDelivering) for (const r of c.deliveryReasons ?? []) reasons.set(r, (reasons.get(r) ?? 0) + 1)
    const reasonText = [...reasons.entries()].map(([r, n]) => `${n}× ${r.replace(/_/g, ' ').toLowerCase()}`).join(', ')
    ex.push({
      key: 'not-delivering',
      severity: 'warning',
      title: `${notDelivering.length} enabled campaign${notDelivering.length === 1 ? '' : 's'} ${notDelivering.length === 1 ? 'is' : 'are'} not serving`,
      detail: `${reasonText || 'Amazon reports them as not delivering'}. They are switched on, so they read as live everywhere else in the console.`,
      count: notDelivering.length,
      amountCents: null,
      amountNote: 'The cost is the sales not made, which cannot be measured',
      action: { label: 'Open Ad Manager', href: '/marketing/ads/campaigns' },
      since: null,
    })
  }

  // ── Writes that Amazon refused, recently ──────────────────────────────
  if (failedMutations > 0) {
    ex.push({
      key: 'failed-mutations',
      severity: 'critical',
      title: `${failedMutations} change${failedMutations === 1 ? '' : 's'} Amazon refused in the last 48 hours`,
      detail: failedMutationNewest?.lastError
        ? `Most recent: ${failedMutationNewest.lastError.slice(0, 180)}`
        : 'Intended changes that never landed. Local state and Amazon may disagree until the reconcile sweep catches up.',
      count: failedMutations,
      amountCents: null,
      amountNote: 'A refused write costs nothing directly; the risk is drift',
      action: { label: 'Open Activity', href: '/marketing/ads/rules-automation/control-room?tab=activity' },
      since: iso(failedMutationNewest?.createdAt),
    })
  }

  // ── Ads jobs failing ──────────────────────────────────────────────────
  if (cronFails.length > 0) {
    let total = 0
    for (const c of cronFails) total += c._count?._all ?? 0
    const newest = cronFails
      .map((c) => c._max?.startedAt)
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null
    ex.push({
      key: 'engine-failures',
      severity: 'warning',
      title: `${cronFails.length} ads job${cronFails.length === 1 ? '' : 's'} failed in the last 24 hours`,
      detail: cronFails.map((c) => `${c.jobName} (${c._count?._all ?? 0}×)`).join(' · '),
      count: total,
      amountCents: null,
      amountNote: 'A failed ingest costs data, not money',
      action: { label: 'Open Levers', href: '/marketing/ads/rules-automation/control-room?tab=levers' },
      since: iso(newest),
    })
  }

  // ── No cost data ──────────────────────────────────────────────────────
  const noCost = Number(advertisedWithoutCost[0]?.n ?? 0)
  const onEstimate = Number(advertisedOnEstimate[0]?.n ?? 0)
  const advertised = Number(advertisedTotal[0]?.n ?? 0)
  if (noCost > 0) {
    ex.push({
      key: 'no-cost-data',
      severity: noCost === advertised ? 'warning' : 'info',
      title: `${noCost} of ${advertised} advertised products have no real cost price`,
      detail:
        (onEstimate > 0
          ? `${onEstimate} are running on the interim estimate, so their profit figures are shown but labelled — an estimate is not a measurement and never sets a bid target. `
          : '') +
        'Target ACOS uses the flat 30% default instead of the product\'s real break-even until a real cost lands. ' +
        'Loading costs is an operator action through the product cost grid — no engineering is waiting on it.',
      count: noCost,
      amountCents: null,
      amountNote: 'Unmeasurable by definition — this IS the missing measurement',
      action: { label: 'Open product costs', href: '/products/costs' },
      since: null,
    })
  }

  // ── Big markets with no keyword at all ────────────────────────────────
  // The one coverage fact that is directly actionable: a term with real volume that nothing of
  // ours bids on. Deliberately NOT priced — the € of a keyword we do not run is a forecast, and
  // this board reports measurements. The market size is the fact; its value would be a guess.
  if (coverage?.measured) {
    const gaps = coverage.rows
      .filter((r) => r.targets === 0 && r.marketImpressions >= 25_000)
      .sort((a, b) => b.marketImpressions - a.marketImpressions)
    if (gaps.length > 0) {
      const top = gaps.slice(0, 3).map((g) => `${g.term} (${g.marketImpressions.toLocaleString('en-IE')})`)
      const totalImpr = gaps.reduce((a, g) => a + g.marketImpressions, 0)
      ex.push({
        key: 'coverage-gaps',
        severity: 'warning',
        title: `${gaps.length} large search terms have no keyword at all`,
        detail:
          `${top.join(' · ')}${gaps.length > 3 ? ` and ${gaps.length - 3} more` : ''}. ` +
          `${totalImpr.toLocaleString('en-IE')} impressions a week that nothing of ours bids on. ` +
          'Counted against positive keywords only — a negative on the term is not holding it.',
        count: gaps.length,
        amountCents: null,
        amountNote: `${totalImpr.toLocaleString('en-IE')} weekly impressions unbid — a value here would be a forecast, not a measurement`,
        action: { label: 'Open Coverage', href: '/marketing/ads/analytics' },
        since: null,
      })
    }
  }

  // ── Campaigns automation may write to with no floor ───────────────────
  if (withoutFloor > 0) {
    ex.push({
      key: 'no-min-bid',
      severity: 'info',
      title: `${withoutFloor} of ${allowlisted} allowlisted campaigns have no minimum bid`,
      detail:
        'The write gate enforces a maximum on all of them, so nothing can bid up without limit. There is no floor, which means a suppression ' +
        'or a down-only engine can take a bid as low as Amazon allows and quietly stop delivery under the no-pause rule.',
      count: withoutFloor,
      amountCents: null,
      amountNote: 'A missing floor risks silence, not spend',
      action: { label: 'Open Guardrails', href: '/marketing/ads/rules-automation/control-room?tab=guardrails' },
      since: null,
    })
  }

  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }
  ex.sort((a, b) => (rank[a.severity] - rank[b.severity]) || ((b.amountCents ?? -1) - (a.amountCents ?? -1)))

  return {
    generatedAt: now.toISOString(),
    headline: {
      wastedSpend30dCents: waste.targets > 0 ? waste.cents : null,
      wastedTargets: waste.targets,
      note:
        waste.targets > 0
          ? `Spend on targets that took ${WASTE_MIN_CLICKS}+ clicks and converted nothing, last ${WASTE_WINDOW_DAYS} days.`
          : `No target took ${WASTE_MIN_CLICKS}+ clicks without converting in the last ${WASTE_WINDOW_DAYS} days.`,
    },
    exceptions: ex,
    totals: {
      critical: ex.filter((e) => e.severity === 'critical').length,
      warning: ex.filter((e) => e.severity === 'warning').length,
      info: ex.filter((e) => e.severity === 'info').length,
    },
  }
}
