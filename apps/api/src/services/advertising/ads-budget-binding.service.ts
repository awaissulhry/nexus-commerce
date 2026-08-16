/**
 * BSP.2 · binding — which campaigns spent at or over the budget that was actually in force.
 *
 * Ported from `apps/api/scripts/_bs-page-binding.mts`, which is the reference implementation and
 * the only place this method had ever existed. Re-run against production 2026-08-16 while planning
 * this service; the numbers below are that run, not the study's.
 *
 * ── 🔴 Every number here is DERIVED, and the derivation has three known weaknesses ─────────────
 *
 * Nowhere does this system store "what was campaign X's daily budget on 2026-08-06". There is no
 * such column and no such history table. The budget in force is reconstructed by walking
 * `AdvertisingActionLog` and that log is:
 *
 *   · **41% broken at the seams** — 937 of 2,387 consecutive writes start from a value the previous
 *     write did not leave behind, because two engines write the same campaign inside one hour and
 *     each reads a value the other has already superseded.
 *   · **absent for most campaigns** — 136 of 220 non-archived campaigns have no budget write at
 *     all. Their budget in force is today's value projected backwards, which is a guess for any day
 *     on which it changed. Those rows are returned `approximate: true` and the surface marks them.
 *   · **not a complete record** — 4 MOSS campaigns' newest logged write says €1 while
 *     `Campaign.dailyBudget` reads €10.
 *
 * That does not make the answer useless; it makes the direction trustworthy and the decimals not.
 * So this service returns its own `reconstruction` census alongside the rows, and the surface is
 * required to print it. A ratio is never presented to more precision than the method supports.
 *
 * ── 🔴 The unit trap that already produced one wrong finding ────────────────────────────────────
 *
 * `AdvertisingActionLog.payload*.dailyBudget` is in **EUROS**, unlike every neighbouring money
 * field in this codebase. Verified in `_bs-page-units.mts`: for 77 of 83 campaigns the newest
 * logged value equals `Campaign.dailyBudget` exactly, and for **zero** does it equal it after
 * dividing by 100. Assuming cents produced ratios of 12,000–23,000% that looked like a spectacular
 * finding. The conversion happens once, in `payloadCents`, and nowhere else.
 */

import prisma from '../../db.js'

/** Rome, because the operator's day is Rome. `AmazonAdsHourlyPerformance.hour` is UTC (schema). */
const ROME = `AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome'`

/** A day is only usable if its hourly cost is at least this share of the daily report's. */
const COVERAGE_FLOOR = 0.8
/** "At or over the budget in force" — the section's own heading. */
const BINDING_RATIO = 1
/** The softer band the empty state speaks in ("no campaign reached 90%"). */
const NEAR_RATIO = 0.9

export interface BindingCoverage {
  from: string | null
  to: string | null
  daysUsable: number
  daysRequested: number
  firstUsableDay: string | null
  /**
   * Usable days whose hourly total could NOT be cross-checked, because
   * `AmazonAdsDailyPerformance` is itself empty for that day. Measured 3 of 13 on 2026-08-16
   * (08-09, 08-11, 08-15). Counted and surfaced rather than silently trusted or silently dropped.
   */
  daysUnverifiable: number
}

export interface BindingReconstruction {
  writesRead: number
  chainBreaks: number
  /**
   * 🔴 Counted over the campaigns actually RETURNED, not over the account.
   *
   * Account-wide, 136 of 220 non-archived campaigns have no budget write — but 130 of those spent
   * nothing in the window and so have no row. A card that said "136 campaigns have no history"
   * beside 6 visible `≈` markers would be describing a different population from the one on
   * screen, which is precisely the mismatch this section exists to remove.
   */
  campaignsWithoutLog: number
}

export interface BindingDay {
  date: string
  spendCents: number
  budgetCents: number | null
  ratio: number | null
}

export interface BindingCampaign {
  id: string
  name: string
  marketplace: string
  status: string
  currentBudgetCents: number
  daysWithSpend: number
  /** Days at or over the budget in force. */
  daysBinding: number
  /** Days at or over 90% of it — the band the empty state speaks in. */
  daysNear: number
  maxRatio: number
  spendCents: number
  /** 0..23 Rome. The modal last-delivering hour across binding days, else across all days. */
  lastDeliveringHour: number | null
  /** True when this campaign has no budget history, so every ratio is against today's budget. */
  approximate: boolean
  days: BindingDay[]
  lastBudgetWrite: { at: string; actor: string | null; fromCents: number | null; toCents: number | null } | null
}

export interface BindingResult {
  coverage: BindingCoverage
  reconstruction: BindingReconstruction
  campaigns: BindingCampaign[]
}

/** 🔴 EUROS → cents. The one place this conversion happens. See the header. */
export const payloadCents = (payload: unknown): number | null => {
  const v = (payload as Record<string, unknown> | null)?.dailyBudget
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

const eurosToCents = (v: unknown): number => Math.round(Number(v ?? 0) * 100)


// ── the pure layer ────────────────────────────────────────────────────────────────────────────
// Extracted and exported so the arithmetic that already produced one wrong finding can be pinned
// without a database. `ads-budget-binding.vitest.test.ts` is the only other caller.

export interface BudgetWrite { at: Date; actor: string | null; before: number | null; after: number | null }
export interface BudgetStep { from: Date; cents: number }

/**
 * Build the forward step function for one campaign from its writes, NEWEST FIRST.
 *
 * The seed is the oldest write's `payloadBefore` — that is what the budget was before anything in
 * the log touched it, and it is the only evidence of the past the system keeps. Each subsequent
 * `payloadAfter` opens a new step at its own timestamp.
 *
 * `chainBreaks` counts seams where a write does not start from where the previous one ended. That
 * is not noise: two engines write the same campaign inside one hour, each reading a value the other
 * has already superseded. 937 of 2,387 on production. A break does not invalidate the walk — the
 * newest value still wins — but it is why the surface must not present decimals it cannot support.
 */
export function buildSteps(newestFirst: BudgetWrite[]): { steps: BudgetStep[]; chainBreaks: number } {
  const ascending = [...newestFirst].reverse()
  let chainBreaks = 0
  for (let i = 1; i < ascending.length; i++) {
    const prev = ascending[i - 1].after
    const cur = ascending[i].before
    // Under a cent is float noise, not two engines fighting.
    if (prev != null && cur != null && Math.abs(prev - cur) > 0.5) chainBreaks++
  }
  const steps: BudgetStep[] = []
  const first = ascending[0]
  if (first?.before != null) steps.push({ from: new Date(0), cents: first.before })
  for (const w of ascending) if (w.after != null) steps.push({ from: w.at, cents: w.after })
  return { steps, chainBreaks }
}

/** The value in force at `when`: the last step that had already opened. */
export function budgetAtStep(steps: BudgetStep[] | undefined, when: Date): number | null {
  if (!steps?.length) return null
  let value: number | null = null
  for (const step of steps) if (step.from <= when) value = step.cents
  // Before the first step we have no better evidence than the earliest value we know of.
  return value ?? steps[0].cents
}

/** The hour that appears most often; ties break to the later hour, which is the safer read. */
export function modalHour(xs: number[]): number | null {
  if (!xs.length) return null
  const counts = new Map<number, number>()
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1)
  let best: number | null = null
  let bestN = -1
  for (const [h, n] of [...counts].sort((a, b) => a[0] - b[0])) if (n >= bestN) { bestN = n; best = h }
  return best
}

interface CoverageRow { d: string; hrs: number; hourly: number; daily: number }

/**
 * The usable window, computed here rather than trusted from the caller.
 *
 * `weeks=8` over today's data spans a month in which the hourly table has rows and **zero cost** —
 * the feed was dead 2026-07-03 → 08-02 and came back on 08-03. Averaging that into a ratio invents
 * a finding, so the endpoint refuses to answer over it: only complete days (24 distinct hours) that
 * carry real cost, and whose total is ≥80% of the daily report where that report exists.
 */
async function usableDays(daysRequested: number): Promise<{ days: string[]; unverifiable: number }> {
  const rows = await prisma.$queryRawUnsafe<CoverageRow[]>(
    `WITH h AS (
       SELECT to_char(("date" + make_interval(hours => "hour")) ${ROME}, 'YYYY-MM-DD') AS d,
              COUNT(DISTINCT "hour") AS hrs,
              SUM("costMicros")::numeric / 1e6 AS hourly
       FROM "AmazonAdsHourlyPerformance"
       WHERE "entityType" = 'CAMPAIGN' AND "date" >= now() - make_interval(days => $1::int)
       GROUP BY 1),
     dd AS (
       SELECT to_char("date", 'YYYY-MM-DD') AS d, SUM("costMicros")::numeric / 1e6 AS daily
       FROM "AmazonAdsDailyPerformance"
       WHERE "entityType" = 'CAMPAIGN' AND "date" >= now() - make_interval(days => $1::int)
       GROUP BY 1)
     SELECT h.d, h.hrs::int AS hrs, h.hourly::float8 AS hourly, COALESCE(dd.daily, 0)::float8 AS daily
     FROM h LEFT JOIN dd USING (d)
     ORDER BY h.d`,
    daysRequested + 2,
  )

  // The last complete Rome day is the newest one holding 24 distinct hours; anything after it is
  // in progress and would drag every ratio down for a reason that is not about budget.
  const days: string[] = []
  let unverifiable = 0
  for (const r of rows) {
    if (Number(r.hrs) < 24 || Number(r.hourly) <= 0) continue
    if (Number(r.daily) > 0) {
      if (Number(r.hourly) / Number(r.daily) < COVERAGE_FLOOR) continue
    } else {
      // No denominator: the DAILY report is empty for a day the hourly feed clearly covered.
      // Usable, but say so — it is the one class of day this guard cannot verify.
      unverifiable++
    }
    days.push(r.d)
  }
  return { days: days.slice(-daysRequested), unverifiable }
}

export async function computeBudgetBinding(opts: {
  market?: string
  campaignIds?: string[]
  weeks?: number
}): Promise<BindingResult> {
  const weeks = Number.isFinite(Number(opts.weeks)) ? Math.min(26, Math.max(1, Math.trunc(Number(opts.weeks)))) : 8
  const daysRequested = weeks * 7

  const { days: window, unverifiable } = await usableDays(daysRequested)
  const coverage: BindingCoverage = {
    from: window[0] ?? null,
    to: window[window.length - 1] ?? null,
    daysUsable: window.length,
    daysRequested,
    firstUsableDay: window[0] ?? null,
    daysUnverifiable: unverifiable,
  }

  // Nothing usable is an answer, not an empty grid. The surface renders `broke` with the reason.
  if (window.length === 0) {
    return { coverage, reconstruction: { writesRead: 0, chainBreaks: 0, campaignsWithoutLog: 0 }, campaigns: [] }
  }

  // PAUSED is included: a campaign that was bound yesterday and is paused today is a fact about
  // yesterday. ARCHIVED is not — it cannot bind again and would only pad the grid.
  const campaigns = await prisma.campaign.findMany({
    where: {
      status: { not: 'ARCHIVED' },
      ...(opts.market && opts.market !== 'all' ? { marketplace: opts.market } : {}),
      ...(opts.campaignIds?.length ? { id: { in: opts.campaignIds } } : {}),
    },
    select: { id: true, name: true, marketplace: true, status: true, dailyBudget: true },
  })
  if (campaigns.length === 0) {
    return { coverage, reconstruction: { writesRead: 0, chainBreaks: 0, campaignsWithoutLog: 0 }, campaigns: [] }
  }
  const byId = new Map(campaigns.map((c) => [c.id, c]))

  // ── the walk-back ───────────────────────────────────────────────────────────────────────────
  // `entityId` on an AD_BUDGET_UPDATE row is the LOCAL campaign id, not the Amazon one — verified
  // against `Campaign.id` in the reference script.
  const writes = await prisma.advertisingActionLog.findMany({
    where: { actionType: 'AD_BUDGET_UPDATE' },
    select: { entityId: true, createdAt: true, userId: true, payloadBefore: true, payloadAfter: true },
    orderBy: { createdAt: 'desc' },
  })

  const perCampaign = new Map<string, BudgetWrite[]>()
  for (const w of writes) {
    const list = perCampaign.get(w.entityId) ?? []
    list.push({ at: w.createdAt, actor: w.userId, before: payloadCents(w.payloadBefore), after: payloadCents(w.payloadAfter) })
    perCampaign.set(w.entityId, list)
  }

  let chainBreaks = 0
  const steps = new Map<string, BudgetStep[]>()
  const lastWrite = new Map<string, BindingCampaign['lastBudgetWrite']>()
  for (const [cid, list] of perCampaign) {
    const built = buildSteps(list)
    chainBreaks += built.chainBreaks
    if (built.steps.length) steps.set(cid, built.steps)
    const newest = list[0]
    if (newest) lastWrite.set(cid, { at: newest.at.toISOString(), actor: newest.actor, fromCents: newest.before, toCents: newest.after })
  }

  // A campaign with no usable log keeps today's budget for the whole window — and says so.
  const approximate = new Set<string>()
  for (const c of campaigns) {
    if (!steps.has(c.id)) {
      steps.set(c.id, [{ from: new Date(0), cents: eurosToCents(c.dailyBudget) }])
      approximate.add(c.id)
    }
  }

  const budgetAt = (cid: string, when: Date): number | null => budgetAtStep(steps.get(cid), when)

  // ── spend per campaign-day, and the last hour each one delivered ────────────────────────────
  const spend = await prisma.$queryRawUnsafe<Array<{ cid: string; d: string; spend: number; lasthour: number | null }>>(
    `SELECT "localEntityId" AS cid,
            to_char(("date" + make_interval(hours => "hour")) ${ROME}, 'YYYY-MM-DD') AS d,
            (SUM("costMicros")::numeric / 1e6)::float8 AS spend,
            MAX(CASE WHEN "costMicros" > 0
                     THEN EXTRACT(hour FROM ("date" + make_interval(hours => "hour")) ${ROME})
                END)::int AS lasthour
     FROM "AmazonAdsHourlyPerformance"
     WHERE "entityType" = 'CAMPAIGN'
       AND "localEntityId" = ANY($1::text[])
       AND to_char(("date" + make_interval(hours => "hour")) ${ROME}, 'YYYY-MM-DD') = ANY($2::text[])
     GROUP BY 1, 2
     HAVING SUM("costMicros") > 0`,
    campaigns.map((c) => c.id),
    window,
  )

  const acc = new Map<string, { days: BindingDay[]; hours: number[]; bindingHours: number[] }>()
  for (const row of spend) {
    const c = byId.get(row.cid)
    if (!c) continue
    // End of the Rome day: the budget in force for a day is the one standing when it closed.
    const endOfDay = new Date(`${row.d}T23:59:59Z`)
    const budgetCents = budgetAt(row.cid, endOfDay)
    const spendCents = Math.round(Number(row.spend) * 100)
    const ratio = budgetCents && budgetCents > 0 ? spendCents / budgetCents : null
    const e = acc.get(row.cid) ?? { days: [], hours: [], bindingHours: [] }
    e.days.push({ date: row.d, spendCents, budgetCents, ratio })
    if (row.lasthour != null) {
      e.hours.push(Number(row.lasthour))
      if (ratio != null && ratio >= BINDING_RATIO) e.bindingHours.push(Number(row.lasthour))
    }
    acc.set(row.cid, e)
  }

  const rows: BindingCampaign[] = []
  for (const [cid, e] of acc) {
    const c = byId.get(cid)
    if (!c) continue
    const withRatio = e.days.filter((d) => d.ratio != null)
    rows.push({
      id: c.id,
      name: c.name,
      marketplace: c.marketplace,
      status: c.status,
      currentBudgetCents: eurosToCents(c.dailyBudget),
      daysWithSpend: e.days.length,
      daysBinding: withRatio.filter((d) => (d.ratio as number) >= BINDING_RATIO).length,
      daysNear: withRatio.filter((d) => (d.ratio as number) >= NEAR_RATIO).length,
      maxRatio: withRatio.reduce((m, d) => Math.max(m, d.ratio as number), 0),
      spendCents: e.days.reduce((s, d) => s + d.spendCents, 0),
      lastDeliveringHour: modalHour(e.bindingHours.length ? e.bindingHours : e.hours),
      approximate: approximate.has(cid),
      days: e.days.sort((a, b) => (a.date < b.date ? 1 : -1)),
      lastBudgetWrite: lastWrite.get(cid) ?? null,
    })
  }

  // Days binding first, then how far over it went — the operator's own priority order.
  rows.sort((a, b) => b.daysBinding - a.daysBinding || b.maxRatio - a.maxRatio)

  return {
    coverage,
    // Counted over the emitted rows — see `BindingReconstruction.campaignsWithoutLog`.
    reconstruction: { writesRead: writes.length, chainBreaks, campaignsWithoutLog: rows.filter((r) => r.approximate).length },
    campaigns: rows,
  }
}
