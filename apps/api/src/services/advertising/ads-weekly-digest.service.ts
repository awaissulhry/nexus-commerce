/**
 * ACR.4.2 / ACR.4.3 — the week, in one object.
 *
 * The exit condition for Stage 4 is "routine work happens unattended; the digest is the only
 * routine touchpoint". That makes this the single most load-bearing read in the programme: if
 * it is wrong or flattering, the operator stops looking at everything else and the account is
 * being run by a summary nobody checks.
 *
 * ONE builder, two consumers — the Activity tab's "This week" rollup and the Monday email.
 * They must not drift: a number that appears on screen and a number that arrives in the inbox
 * disagreeing about the same week is how an operator learns to trust neither. Same discipline
 * as `profit-coverage.ts` and its four writers.
 *
 * ── What "net effect" honestly is ───────────────────────────────────────────────────────────
 * Only budget moves carry a computable €: `AD_BUDGET_UPDATE` stores the daily budget before and
 * after, so the delta is a real €/day change. Bid and placement moves do NOT. A bid change moves
 * the price of a click, and volume responds to it — the resulting spend is unknowable in advance
 * for exactly the reason `ads-proposal-pricing` gives for calling its own figures estimates. So
 * bid moves are COUNTED and never priced, and the digest says so rather than summing a number
 * that would look like money and mean nothing.
 *
 * ── acted · proposed · denied, and the fourth column people forget ─────────────────────────
 * `denied` is the OPERATOR declining a proposal. `declined` is the ENGINE declining to run one
 * of its own rules (the daily cap). They are kept apart because collapsing them would let a
 * fixed engine bug — 693,704 DAILY_CAP_EXCEEDED rows in eight weeks — read as the operator
 * rejecting the machine's work at enormous scale, which is the opposite of what happened.
 *
 * Read-only. Building a digest must never change anything it reports on.
 */
import prisma from '../../db.js'
import { pricePendingProposals } from './ads-proposal-pricing.service.js'
import { getGraduationBoard } from './ads-graduation-readiness.service.js'
import { getCoverageScoreboard } from './ads-coverage.service.js'
import { buildNegDigestSection, type NegDigestSection } from './negatives-record.service.js'

const DAY = 86_400_000

// Mirrors ads-anomaly-guard's own fallbacks. Duplicated rather than imported so a digest read can
// never drag the guard's module (and its side-effecting integrity check) into a request path.
const DEFAULT_MAX_ACTIONS_PER_HOUR = 250
const DEFAULT_MAX_HOURLY_SPEND_CENTS = 50_000
const OPERATOR_TIMEZONE = 'Europe/Rome'

export interface DigestRuleRow {
  ruleId: string
  name: string
  level: string
  /** Executions that wrote something. */
  acted: number
  /** Executions that queued a proposal instead. */
  proposed: number
  /** Proposals YOU declined this week. */
  denied: number
  /** Proposals you applied this week. */
  applied: number
  /** Runs the engine refused on its own daily cap — not your decision, not a failure. */
  declined: number
  /** Real failures. Cap rows are never counted here. */
  failed: number
}

export interface WeeklyDigest {
  generatedAt: string
  window: { from: string; to: string; label: string; complete: boolean }
  /** What is gating delivery, read live so the operator never has to guess. */
  gates: {
    cronFlag: string
    cronEnabled: boolean
    outboundFlag: string
    outboundEnabled: boolean
    /** Plain-language state, so the panel does not have to reimplement the logic. */
    state: 'off' | 'dry-run' | 'live'
    explanation: string
  }
  totals: { acted: number; proposed: number; denied: number; applied: number; declined: number; failed: number }
  rules: DigestRuleRow[]
  effect: {
    /** Net change to daily budget across the week, in cents. Genuinely measurable. */
    budgetDeltaCents: number
    budgetMoves: number
    /** Counted, never priced — see the header. */
    bidMoves: number
    placementMoves: number
    note: string
  }
  proposals: { pending: number; priced: number; spendAtStakeCents: number; recoverableCents: number }
  graduation: { ready: number; unseen: number; unreviewed: number; readyNames: string[]; unseenNames: string[] }
  /**
   * ACR.4.3 — the circuit breaker, in the summary that is meant to replace watching.
   *
   * Two facts an operator cannot otherwise get. First, TRIPS: `haltAutomation` writes to a
   * singleton and `resumeAutomation` NULLS IT OUT, so the moment you resume, the trip is erased.
   * The only durable trace is the operator notification it fans out — which is what this reads.
   *
   * Second, the THRESHOLD GAP. `maxHourlySpendCentsEur` is unset on prod, so the guard falls
   * back to €500/hour on an account whose busiest hour is a rounding error against it. A safety
   * net configured above anything that can happen is not a safety net, and nothing in the console
   * said so — the number sat next to no measurement of what it was guarding.
   */
  breaker: {
    tripsThisWeek: Array<{ at: string; reason: string }>
    maxActionsPerHour: number
    maxHourlySpendCents: number
    /** True when no operator value is set and the code default is what is actually enforced. */
    spendThresholdIsDefault: boolean
    /** The busiest single hour in the window — what the threshold is really being asked about. */
    peakHourSpendCents: number
    /** Hours of data behind that peak. 0 means "unknown", never "quiet". */
    peakHoursSampled: number
    /** What a trip means. Only meaningful when one happened. */
    tripNote: string
    /** The state of the hourly spend limit. Always meaningful, trip or no trip. */
    spendNote: string
  }
  coverage: {
    marketplace: string
    week: string | null
    priorWeek: string | null
    share: number | null
    priorShare: number | null
    deltaPct: number | null
    terms: number
    measured: boolean
    note: string
  } | null
  delivery: { failedWrites: number; deadLetters: number }
  /**
   * NEG.8 — the negatives section. Built by `negatives-record.service.ts` so the number in the
   * Monday email and the number on the Negative Targeting page come from ONE builder; a second
   * digest service is how two summaries start disagreeing about the same account.
   *
   * Null when the section could not be built — never a zeroed object, which would read as a quiet
   * week rather than a failed read.
   */
  negatives: NegDigestSection | null
}

/** The operator's civil clock — same Intl approach the report schedules use, and for the same
 *  reason: `new Date(d.toLocaleString(...))` re-parses under the runtime's locale and silently
 *  yields Invalid Date, which for a scheduler means it quietly never fires. */
function romeParts(at: Date): { y: number; m: number; d: number; hour: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATOR_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0')
  const y = get('year'), m = get('month'), d = get('day')
  const hour = get('hour') === 24 ? 0 : get('hour')
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7
  return { y, m, d, hour, dow }
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Resolve the week being reported.
 *
 * `previous` is the last COMPLETE Monday–Sunday — what a Monday-morning email must cover, because
 * a digest that included today would report a partial day as a collapse. `current` is week-to-date,
 * which is what the operator standing in the Activity tab means by "this week".
 */
export function digestWindow(mode: 'current' | 'previous', now = new Date()): { from: Date; to: Date; label: string; complete: boolean } {
  const { y, m, d, dow } = romeParts(now)
  const today = new Date(Date.UTC(y, m - 1, d))
  const thisMonday = new Date(today.getTime() - (dow - 1) * DAY)
  if (mode === 'current') {
    return {
      from: thisMonday,
      to: new Date(today.getTime() + DAY - 1),
      label: `${isoDate(thisMonday)} → today`,
      complete: false,
    }
  }
  const lastMonday = new Date(thisMonday.getTime() - 7 * DAY)
  const lastSunday = new Date(thisMonday.getTime() - 1)
  return {
    from: lastMonday,
    to: lastSunday,
    label: `${isoDate(lastMonday)} → ${isoDate(lastSunday)}`,
    complete: true,
  }
}

function gateState(): WeeklyDigest['gates'] {
  const cronEnabled = process.env.NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON === '1'
  const outboundEnabled = process.env.NEXUS_ENABLE_OUTBOUND_EMAILS === 'true'
  const state = !cronEnabled ? 'off' : outboundEnabled ? 'live' : 'dry-run'
  return {
    cronFlag: 'NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON',
    cronEnabled,
    outboundFlag: 'NEXUS_ENABLE_OUTBOUND_EMAILS',
    outboundEnabled,
    state,
    explanation: !cronEnabled
      ? 'No digest is scheduled. The dispatcher only starts when NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON=1, so nothing is sent and nothing is queued — you can still build and read one here at any time.'
      : outboundEnabled
        ? 'Scheduled and sending. The digest is built every Monday morning and mailed to its recipients.'
        : 'Scheduled, but nothing leaves the building. The digest is built and logged on schedule; NEXUS_ENABLE_OUTBOUND_EMAILS is not true, so no mail is sent. This is the state that answers "is my digest right?" without mailing anyone.',
  }
}

export async function getWeeklyDigest(
  mode: 'current' | 'previous' = 'current',
  now = new Date(),
): Promise<WeeklyDigest> {
  const win = digestWindow(mode, now)

  const [rules, execs, suggestions, budgetActions, actionCounts, proposals, graduation, coverageLatest, haltNotices, guardState, peakHourRows, failedWrites, deadLetters] = await Promise.all([
    prisma.automationRule.findMany({
      where: { domain: 'advertising' },
      select: { id: true, name: true, autonomyLevel: true, enabled: true, dryRun: true },
    }),
    // Everything, INCLUDING the cap rows — this is the one read that needs them, because
    // `declined` is a column here rather than noise to be filtered.
    prisma.automationRuleExecution.groupBy({
      by: ['ruleId', 'status', 'errorMessage'],
      where: { startedAt: { gte: win.from, lte: win.to } },
      _count: { _all: true },
    }),
    prisma.adsRuleSuggestion.findMany({
      where: { decidedAt: { gte: win.from, lte: win.to } },
      select: { ruleId: true, status: true },
    }),
    /**
     * Two narrow reads, not one wide one.
     *
     * Fetching every action-log row in the week WITH both JSON payloads cost 1,896ms for 5,257
     * rows — the single most expensive thing in this digest, and almost all of it wasted: the
     * payloads are only read for `AD_BUDGET_UPDATE`, and every other action type contributes a
     * COUNT. Split, the same answers cost 48ms (195 budget rows) + 29ms (a groupBy). Measured
     * 2026-08-05; the whole digest went 7.7s → well under half of that.
     */
    prisma.advertisingActionLog.findMany({
      where: { createdAt: { gte: win.from, lte: win.to }, actionType: 'AD_BUDGET_UPDATE' },
      select: { payloadBefore: true, payloadAfter: true },
    }),
    prisma.advertisingActionLog.groupBy({
      by: ['actionType'],
      where: { createdAt: { gte: win.from, lte: win.to } },
      _count: { _all: true },
    }),
    pricePendingProposals(500).catch(() => null),
    getGraduationBoard(now).catch(() => null),
    // In the batch rather than after it: this used to run sequentially once everything else had
    // finished, adding its full latency to the wall clock instead of hiding inside it. Only the
    // PRIOR week's read has to wait, because which week that is comes out of this one.
    getCoverageScoreboard({ marketplace: 'IT', limit: 200 }).catch(() => null),
    // ACR.4.3 — breaker trips. Notifications are fanned out one row PER OPERATOR, so the same
    // trip appears as many times as there are profiles; deduped by timestamp+body below.
    prisma.notification.findMany({
      where: { type: 'ads-automation-halt', createdAt: { gte: win.from, lte: win.to } },
      select: { createdAt: true, body: true, title: true },
      orderBy: { createdAt: 'desc' },
    }).catch(() => []),
    prisma.adsAutomationState.findFirst({
      select: { maxActionsPerHour: true, maxHourlySpendCentsEur: true },
    }).catch(() => null),
    // The busiest hour in the window, which is what the hourly threshold is actually guarding.
    // `hours` alongside `peak`: with no rows at all, MAX coalesces to 0 and a €0.00 peak reads as
    // "the account spent nothing" when it means "this window has no hourly data". Last week has
    // none — the feed only reaches back a few days — so without the count the note would have
    // confidently described an unguarded threshold using a number that was really an absence.
    prisma.$queryRawUnsafe<{ peak: bigint | number | null; hours: bigint | number }[]>(`
      SELECT COALESCE(MAX(hour_cost), 0) AS peak, COUNT(*) AS hours FROM (
        SELECT SUM("costMicros") AS hour_cost
        FROM "AmazonAdsHourlyPerformance"
        WHERE "entityType" = 'CAMPAIGN' AND date >= $1::date AND date <= $2::date
        GROUP BY date, hour
      ) x
    `, isoDate(win.from), isoDate(win.to)).catch(() => []),
    prisma.adMutation.count({ where: { state: 'FAILED', createdAt: { gte: win.from, lte: win.to } } }).catch(() => 0),
    prisma.outboundSyncQueue.count({ where: { isDead: true, createdAt: { gte: win.from, lte: win.to } } }).catch(() => 0),
  ])

  const ruleName = new Map(rules.map((r) => [r.id, r]))
  const rows = new Map<string, DigestRuleRow>()
  const rowFor = (ruleId: string): DigestRuleRow => {
    let r = rows.get(ruleId)
    if (!r) {
      const meta = ruleName.get(ruleId)
      r = {
        ruleId,
        name: meta?.name ?? ruleId,
        level: meta ? (meta.enabled ? (meta.autonomyLevel ?? (meta.dryRun ? 'PROPOSE' : 'AUTO')) : 'OFF') : 'UNKNOWN',
        acted: 0, proposed: 0, denied: 0, applied: 0, declined: 0, failed: 0,
      }
      rows.set(ruleId, r)
    }
    return r
  }

  for (const g of execs) {
    // Only advertising rules — the groupBy cannot join, so unrelated domains are dropped here.
    if (!ruleName.has(g.ruleId)) continue
    const r = rowFor(g.ruleId)
    const n = g._count._all
    if (g.status === 'SUCCESS' || g.status === 'PARTIAL') r.acted += n
    else if (g.status === 'DRY_RUN') r.proposed += n
    else if (g.status === 'FAILED') {
      if (g.errorMessage === 'DAILY_CAP_EXCEEDED') r.declined += n
      else r.failed += n
    }
  }
  for (const s of suggestions) {
    if (!ruleName.has(s.ruleId)) continue
    const r = rowFor(s.ruleId)
    if (s.status === 'applied') r.applied += 1
    else if (s.status === 'dismissed') r.denied += 1
  }

  // ── net effect ────────────────────────────────────────────────────────────
  let budgetDeltaCents = 0
  let budgetMoves = 0
  for (const a of budgetActions) {
    const before = Number((a.payloadBefore as Record<string, unknown> | null)?.dailyBudget)
    const after = Number((a.payloadAfter as Record<string, unknown> | null)?.dailyBudget)
    // Both must be real numbers. A missing side is not a zero — treating it as one would
    // book the entire budget as a change in whichever direction the null happened to be.
    if (Number.isFinite(before) && Number.isFinite(after)) {
      budgetDeltaCents += Math.round((after - before) * 100)
      budgetMoves += 1
    }
  }
  const countOf = (type: string) => actionCounts.find((c) => c.actionType === type)?._count._all ?? 0
  const bidMoves = countOf('AD_BID_UPDATE')
  const placementMoves = countOf('update_placement_bidding')

  // ── coverage trend ────────────────────────────────────────────────────────
  let coverage: WeeklyDigest['coverage'] = null
  try {
    const latest = coverageLatest
    if (!latest) throw new Error('coverage unavailable')
    /**
     * The week key on CoverageWeek is `startDate`, NOT `week` — reading `w.week` yields
     * undefined for every entry, the list filters to empty, and the digest reports "no prior
     * week to compare" while six measured weeks sit in the table. Caught only because the
     * printed trend disagreed with a direct count of SQP weeks.
     *
     * `measured` is the other half: weeks the fixed parser has never re-read carry null shares
     * (2026-06-07 and earlier are all ours=0), so comparing against one would manufacture a
     * collapse out of a parser bug that was fixed on 2026-08-05.
     */
    const priorWeek = (latest.weeks ?? [])
      .find((w) => w.measured && w.startDate !== latest.week)?.startDate ?? null
    const prior = priorWeek ? await getCoverageScoreboard({ marketplace: 'IT', week: priorWeek, limit: 200 }).catch(() => null) : null
    const share = latest.totals.share
    const priorShare = prior?.totals.share ?? null
    coverage = {
      marketplace: latest.marketplace,
      week: latest.week,
      priorWeek,
      share,
      priorShare,
      // Percentage POINTS, not a percentage change. Going 0.62% → 0.75% is +0.13pp; calling it
      // "+21%" is true and useless at this scale, and invites a celebration over a rounding.
      deltaPct: share != null && priorShare != null ? (share - priorShare) * 100 : null,
      terms: latest.totals.terms,
      measured: latest.measured,
      note: !latest.measured
        ? 'Coverage is not measurable for this week: the share feed has no counts of ours in it.'
        : priorShare == null
          ? 'Impression share pooled across every tracked term. No earlier measured week to compare against yet, so there is no trend — a direction will appear once a second week has been read.'
          : 'Impression share pooled across every tracked term — our impressions over the market\'s, never an average of ratios. The change is in percentage POINTS.',
    }
  } catch { coverage = null }

  /**
   * Failing rules first, THEN by volume.
   *
   * Sorted by volume alone, the account's only genuinely failing rule sat outside the twelve
   * rows both the panel and the email show — so the header read "40 real failures" above a
   * table whose every Failed cell was a dash. A summary that can report a failure and then hide
   * which rule caused it is worse than one that reports neither.
   */
  const ordered = [...rows.values()]
    .filter((r) => r.acted + r.proposed + r.denied + r.applied + r.failed > 0 || r.declined > 0)
    .sort((a, b) =>
      Number(b.failed > 0) - Number(a.failed > 0)
      || (b.acted + b.proposed) - (a.acted + a.proposed)
      || a.name.localeCompare(b.name))

  const totals = ordered.reduce(
    (t, r) => ({
      acted: t.acted + r.acted, proposed: t.proposed + r.proposed, denied: t.denied + r.denied,
      applied: t.applied + r.applied, declined: t.declined + r.declined, failed: t.failed + r.failed,
    }),
    { acted: 0, proposed: 0, denied: 0, applied: 0, declined: 0, failed: 0 },
  )

  // ── the breaker ───────────────────────────────────────────────────────────
  // One notification row per operator profile per trip, so the same event repeats. Keyed on the
  // minute + text rather than the id, which differs per recipient.
  const seenTrip = new Set<string>()
  const tripsThisWeek: Array<{ at: string; reason: string }> = []
  for (const n of haltNotices) {
    const reason = (n.body ?? n.title ?? 'Automation halted').trim()
    const key = `${n.createdAt.toISOString().slice(0, 16)}|${reason}`
    if (seenTrip.has(key)) continue
    seenTrip.add(key)
    tripsThisWeek.push({ at: n.createdAt.toISOString(), reason })
  }
  const spendThresholdIsDefault = guardState?.maxHourlySpendCentsEur == null
  const maxHourlySpendCents = guardState?.maxHourlySpendCentsEur ?? DEFAULT_MAX_HOURLY_SPEND_CENTS
  const peakHourSpendCents = Math.round(Number(peakHourRows[0]?.peak ?? 0) / 10_000)
  const peakHoursSampled = Number(peakHourRows[0]?.hours ?? 0)
  const breaker = {
    tripsThisWeek,
    maxActionsPerHour: guardState?.maxActionsPerHour ?? DEFAULT_MAX_ACTIONS_PER_HOUR,
    maxHourlySpendCents,
    spendThresholdIsDefault,
    peakHourSpendCents,
    peakHoursSampled,
    // Two notes, because they answer different questions and a trip does not stop the threshold
    // from also being wrong. Rendering one string in both places printed the trip sentence under
    // the spend heading — the panel saying something true about the wrong subject.
    tripNote: 'A trip HALTS every engine until you resume it, so this is the account stopping rather than a warning. The halt state is cleared on resume, so this row is the only record that it happened.',
    spendNote: !spendThresholdIsDefault
      ? `The hourly spend limit is operator-set at ${(maxHourlySpendCents / 100).toFixed(0)} EUR/hour.`
      : peakHoursSampled === 0
        // No hourly rows for this window: say so instead of quoting a peak that is really an absence.
        ? `No hourly spend limit is set, so the guard enforces its ${(DEFAULT_MAX_HOURLY_SPEND_CENTS / 100).toFixed(0)} EUR/hour code default. There is no hourly spend data for this window, so how close the account came to it cannot be shown.`
        : `No hourly spend limit is set, so the guard enforces its ${(DEFAULT_MAX_HOURLY_SPEND_CENTS / 100).toFixed(0)} EUR/hour code default. The busiest of ${peakHoursSampled.toLocaleString('en-IE')} hours this week reached ${(peakHourSpendCents / 100).toFixed(2)} EUR — a limit that far above anything the account does cannot fire, so ad spend is effectively unguarded.`,
  }

  // NEG.8 — one builder, two consumers. A failure here must not blank the digest, and must not
  // fabricate a quiet week either: it degrades to null and the panel says the section is missing.
  const negatives = await buildNegDigestSection(win.from.getTime(), win.to.getTime()).catch(() => null)

  return {
    generatedAt: now.toISOString(),
    window: { from: isoDate(win.from), to: isoDate(win.to), label: win.label, complete: win.complete },
    gates: gateState(),
    negatives,
    breaker,
    totals,
    rules: ordered,
    effect: {
      budgetDeltaCents,
      budgetMoves,
      bidMoves,
      placementMoves,
      note: budgetMoves > 0
        ? 'Budget moves carry a real €/day delta. Bid and placement moves are counted but not priced — a bid changes the price of a click and volume responds to it, so the spend it causes is not knowable in advance.'
        : 'No budget moved this week. Bid and placement moves are counted but not priced: a bid changes the price of a click and volume responds, so the spend it causes cannot be stated in advance.',
    },
    proposals: {
      pending: proposals?.pending ?? 0,
      priced: proposals?.priced ?? 0,
      spendAtStakeCents: proposals?.spendAtStakeCents ?? 0,
      recoverableCents: proposals?.recoverableCents ?? 0,
    },
    graduation: {
      ready: graduation?.totals.ready ?? 0,
      unseen: graduation?.totals.unseen ?? 0,
      unreviewed: graduation?.totals.unreviewed ?? 0,
      readyNames: (graduation?.ready ?? []).map((r) => r.name),
      unseenNames: (graduation?.others ?? []).filter((o) => o.verdict === 'unseen').map((o) => o.name),
    },
    coverage,
    delivery: { failedWrites, deadLetters },
  }
}
