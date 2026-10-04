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
  /** another writer moved the budget inside the window and this schedule stood down */
  yielded: number
  /** 3c — the window closed after someone else changed the budget, so nothing was given back and their change stays */
  kept?: number
  /** the mutation layer declined (`ok:false`) before anything was queued, or the write gate refused a window change */
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
  if (!r.enabled) return { word: 'Off', cls: 'off', why: 'Paused — this schedule changes nothing now. Pausing gives back each budget it still holds; a budget someone changed since stays as it is.' }
  if (r.startDate !== '—' && r.startDate > todayIso) return { word: 'Scheduled', cls: 'bs-sched', why: `Starts ${r.startDate}. Until then, nothing is changed.` }
  if (r.endDate !== '—' && r.endDate < todayIso) return { word: 'Completed', cls: 'bs-done', why: `Ended ${r.endDate}. It gives back each budget it still holds and leaves a budget someone changed since as it is.` }
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
  if (by.length === 0) return `${d.yielded} of ${d.campaigns} were moved by another writer, so this schedule stood down and leaves that budget in place when the window closes`
  const parts = by.map((b) => `${b.count} to ${b.label}`)
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `${d.yielded} of ${d.campaigns} yielded — ${list}; a schedule owns a campaign only while its own window is open, so it stands down rather than re-fighting and leaves their budget in place when the window closes`
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
  // 3c — since 4k a write the gate refused is undone in Nexus too, so "the local budget was changed" is no longer true of it.
  if (d.notDelivered > 0) return { word: `${d.notDelivered} not at Amazon`, cls: 'bad', why: `${d.notDelivered} of ${d.campaigns} writes were not applied at Amazon${d.lastError ? ` — ${d.lastError}` : ''}. Amazon’s budget did not change; a write the gate refused is also undone in Nexus.` }
  // 3b — "24 times" is GIVE_BACK_RETRIES in apps/api/src/jobs/ad-budget-schedule.job.ts. 3c — a window change the gate
  // refused is not tried again inside that window (it would be refused every run); the next window tries it.
  if (d.refused + d.failed > 0) return { word: `${d.refused + d.failed} refused`, cls: 'bad', why: `${d.refused + d.failed} of ${d.campaigns} writes were refused${d.lastError ? ` — ${d.lastError}` : ''}. A window change refused before it was queued is tried again on the next run; one the write gate refused, at the next window; a refused give-back once an hour, up to 24 times.` }
  // A budget the OPERATOR moved is not a conflict the operator needs to investigate — say so.
  if (d.yielded > 0) return { word: allOperator(d) ? `${d.yielded} held by you` : `${d.yielded} yielded`, cls: 'warn', why: `${describeYields(d)}. Those campaigns are NOT on their window value.` }
  // 3c — a closed window that gave nothing back because someone changed the budget: their change stays, by design (3b).
  const kept = d.kept ?? 0
  if (kept > 0) return { word: `${kept} kept a later change`, cls: 'warn', why: `${kept} of ${d.campaigns} campaigns had their budget changed by someone else after this schedule set it, so the schedule gave nothing back when the window closed and that change stays.` }
  if (d.unknown > 0) return { word: 'in flight', cls: 'wait', why: `${d.unknown} of ${d.campaigns} writes are queued and not yet confirmed at Amazon.` }
  if (d.delivered > 0) return { word: `${d.delivered} at Amazon`, cls: 'ok', why: `${d.delivered} of ${d.campaigns} writes are confirmed delivered to Amazon.` }
  return { word: 'nothing to do', cls: 'none', why: `All ${d.campaigns} campaigns already sit at the value this schedule wants, so it has written nothing.` }
}

/** 3c — what a pause, a delete or a campaigns edit did with the budgets the schedule held (`restore` in the API answer). */
export interface ScheduleRestore { restored: number; kept: number; refused: number }

/**
 * 3c (review 6.5) — the give-back result in words. The API has always answered it (BSP-P3) and the screen dropped it,
 * so a pause that gave nothing back looked exactly like one that gave every budget back. `null` when there is nothing to
 * report (no answer at all). The counts are summed by the caller when several schedules were deleted at once.
 */
export function restoreSummary(r: ScheduleRestore | null, did: string): { tone: 'success' | 'warning'; title: string; text: string } | null {
  if (!r) return null
  const { restored, kept, refused } = r
  if (restored + kept + refused === 0) {
    return { tone: 'success', title: `${did}.`, text: 'It held no budget it had set, so nothing needed to be given back.' }
  }
  const parts = [
    restored > 0 ? 'given back: the budget from before the window is queued for Amazon' : null,
    kept > 0 ? 'kept a later change: someone changed the budget after this schedule set it, so that change stays' : null,
    refused > 0 ? 'refused: the give-back did not go through, so the campaign keeps the schedule’s budget — change it by hand if it should go back' : null,
  ].filter(Boolean) as string[]
  return {
    tone: refused > 0 ? 'warning' : 'success',
    title: `${did}: ${restored} given back · ${kept} kept a later change · ${refused} refused`,
    text: `${parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('. ')}.`,
  }
}
