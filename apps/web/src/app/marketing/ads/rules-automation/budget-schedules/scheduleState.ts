/**
 * BSP-P5 — the vocabulary of a budget schedule's state, as pure functions.
 *
 * Extracted from `SchedulesSection.tsx` for the reason `bid/bidState.ts` was: a client component
 * cannot be loaded under vitest in this repo, so anything that lives inside one is untestable by
 * construction. These three decide what the operator READS about whether a schedule is working —
 * which is precisely the thing that must not be able to drift unnoticed.
 *
 * Nothing here fetches, renders or formats markup. `SchedulesSection` maps the words to pills.
 */

/** The per-campaign tally the list route computes from `BudgetSchedule.lastApplied` + the
 *  outbound queue. See `bsDelivery` in advertising.routes.ts for how each field is derived. */
export interface ScheduleDelivery {
  campaigns: number
  /** written locally and queued — NOT confirmed at Amazon */
  applied: number
  /** already on target; nothing to do */
  held: number
  /** another writer moved the budget and this schedule stood down */
  yielded: number
  /** the mutation layer declined (`ok:false`) before anything was queued */
  refused: number
  /** the call threw */
  failed: number
  /** confirmed SUCCESS on the outbound queue */
  delivered: number
  /** the write gate SKIPPED it, or the sync FAILED/was CANCELLED — it is not at Amazon */
  notDelivered: number
  /** queued and not yet resolved, or applied with no queue handle to check */
  unknown: number
  lastError: string | null
  /**
   * BSP.6 item 2 — who took the budget, counted per kind. A yield to the pacer means the monthly
   * envelope is holding, which is the system working; a yield to the operator's own hand means
   * they overrode it; a yield to a rule is a genuine automation conflict. One word for all three
   * would hide the only distinction that tells the operator what to do next.
   */
  yieldedBy?: Array<{ kind: string; label: string; count: number }>
}

export interface ScheduleStateRow {
  name: string
  enabled: boolean
  /** ISO `YYYY-MM-DD`, or '—' for "no bound on this side" */
  startDate: string
  endDate: string
  delivery: ScheduleDelivery | null
}

export interface StateWord { word: string; cls: string; why: string }

/**
 * 🔴 Today, in the LOCAL calendar.
 *
 * `new Date().toISOString().slice(0,10)` is UTC, and it was being compared against the local
 * calendar dates an operator typed into the builder. In Europe/Rome every instant between 00:00
 * and 02:00 local is still the previous day in UTC, so for the first two hours of every day a
 * finished schedule reported **Active** and a starting one reported **Scheduled**.
 * [[reference_day_grouping_utc_local_trap]] — derive from the date PARTS, never from an ISO string.
 */
export const localDayKey = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

/**
 * Scheduled / Active / Active · not in force / Completed / Off.
 *
 * Derived rather than stored, because there is no status field to drift from. ISO date strings
 * compare correctly as strings; '—' means "no bound on this side".
 *
 * 🔴 The fourth word is the BSP-P3 fix. "Active" used to assert unconditionally that "the weekly
 * windows decide each campaign's budget right now" — and on this account the pacer rewrites the
 * busiest campaign 44×/day, so the executor stands down (`yielded`) and that sentence becomes
 * false within one tick. A schedule that is in its date range but is not actually holding its
 * campaigns is a different fact from one that is, and the operator needs both.
 *
 * BSP.6 then made the tooltip NAME the counterparty (`describeYields`), because "something moved
 * it" and "the monthly envelope is holding" call for completely different responses — and the
 * second is the system working as designed, not a fault to chase.
 */
export function scheduleStatus(r: ScheduleStateRow, todayIso: string): StateWord {
  if (!r.enabled) return { word: 'Off', cls: 'off', why: 'Paused — the executor skips this schedule and campaigns hold their base budgets.' }
  if (r.startDate !== '—' && r.startDate > todayIso) return { word: 'Scheduled', cls: 'bs-sched', why: `Starts ${r.startDate}. Until then, nothing is changed.` }
  if (r.endDate !== '—' && r.endDate < todayIso) return { word: 'Completed', cls: 'bs-done', why: `Ended ${r.endDate}. Budgets have been restored to base.` }
  const d = r.delivery
  if (d && (d.yielded > 0 || d.notDelivered > 0 || d.refused > 0 || d.failed > 0)) {
    return {
      word: 'Active · not in force',
      cls: 'bs-contested',
      why: `In its date range, but the last pass did not leave every campaign on its window value${d.yielded > 0 ? ` — ${describeYields(d)}` : ' — a write did not reach Amazon'}. See the Delivery column.`,
    }
  }
  return { word: 'Active', cls: 'bs-active', why: 'In its date range — the weekly windows decide each campaign’s budget right now.' }
}

/**
 * BSP.6 — the yield, in words, listing every counterparty. Shared by the Status tooltip and the
 * Delivery tooltip so the two can never describe the same fact differently.
 *
 * ⚠ Returns a clause with **no trailing period** — every caller sits it inside a longer sentence
 * and punctuates for itself. Caught on screen: the Status tooltip read "…rather than
 * re-fighting.. See the Delivery column." A shared fragment that punctuates itself will always
 * collide with whichever caller punctuates too.
 */
export function describeYields(d: ScheduleDelivery): string {
  const by = d.yieldedBy ?? []
  if (by.length === 0) return `${d.yielded} of ${d.campaigns} were moved by another writer, so this schedule stood down for the rest of the window`
  const parts = by.map((b) => `${b.count} to ${b.label}`)
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `${d.yielded} of ${d.campaigns} yielded — ${list}; a schedule owns a campaign only while its own window is open, so it stands down for the rest of this one rather than re-fighting`
}

/** True when every yield was the operator's own hand — not an automation conflict at all. */
const allOperator = (d: ScheduleDelivery): boolean => {
  const by = d.yieldedBy ?? []
  return by.length === 1 && by[0].kind === 'operator' && by[0].count === d.yielded
}

/**
 * 🔴 The one place "applied" becomes words, so a cell and its tooltip cannot disagree.
 *
 * The order is the point. A refusal outranks a delivery success because a schedule that
 * half-landed is not a schedule that worked, and `notDelivered` outranks everything because it is
 * the failure the old screen could not express at all: the local budget changed, Amazon's did not.
 */
export function deliveryCell(d: ScheduleDelivery | null): StateWord {
  if (!d || d.campaigns === 0) return { word: '—', cls: 'none', why: 'This schedule has not evaluated any campaign yet.' }
  if (d.notDelivered > 0) return { word: `${d.notDelivered} not at Amazon`, cls: 'bad', why: `${d.notDelivered} of ${d.campaigns} writes were rejected before reaching Amazon${d.lastError ? ` — ${d.lastError}` : ''}. The local budget was changed; the channel was not.` }
  if (d.refused + d.failed > 0) return { word: `${d.refused + d.failed} refused`, cls: 'bad', why: `${d.refused + d.failed} of ${d.campaigns} writes were refused before they were queued${d.lastError ? ` — ${d.lastError}` : ''}. They are retried on the next tick.` }
  // A budget the OPERATOR moved is not a conflict the operator needs to investigate — say so.
  if (d.yielded > 0) return { word: allOperator(d) ? `${d.yielded} held by you` : `${d.yielded} yielded`, cls: 'warn', why: `${describeYields(d)}. Those campaigns are NOT on their window value.` }
  if (d.unknown > 0) return { word: 'in flight', cls: 'wait', why: `${d.unknown} of ${d.campaigns} writes are queued and not yet confirmed at Amazon.` }
  if (d.delivered > 0) return { word: `${d.delivered} at Amazon`, cls: 'ok', why: `${d.delivered} of ${d.campaigns} writes are confirmed delivered to Amazon.` }
  return { word: 'nothing to do', cls: 'none', why: `All ${d.campaigns} campaigns already sit at the value this schedule wants, so it has written nothing.` }
}
