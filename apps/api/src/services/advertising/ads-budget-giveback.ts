/**
 * 6.1 — a budget schedule's give-back is not a new day move.
 *
 * A schedule raises a budget for its window (€10 → €15) and gives it back when the window closes
 * (€15 → €10). When the give-back fell on the next UTC day, the day-move bound in the write gate
 * (−30% / +50%-or-€10 per UTC day, `budgetDayMoveDenial`) read the day as having OPENED at the boosted
 * €15: the give-back's own log row is written before the gate runs, and its `payloadBefore` is the
 * boost. €15 → €10 is −33%, so any boost above +42.9% could never be given back, and the sync then
 * copied Amazon's boosted budget back into Nexus.
 *
 * The gate now recognises a give-back from the ACTION LOG, never from a flag or the payload's `force`:
 * a flag is something any writer can set, and the log is what actually happened. A write is a give-back
 * when, and only when:
 *   · its actor is a budget schedule's (`automation:budget-schedule-<id>`, written only by
 *     jobs/ad-budget-schedule.job.ts and the pause/delete give-back in ads-budget-schedule.service.ts);
 *   · the campaign's last budget writes (at most GIVE_BACK_LOOKBACK of them; rolled-back rows and this
 *     write's own row left out) are an unbroken run by that same actor — any other writer in between
 *     and the budget is no longer the schedule's to give back;
 *   · that run ends at this write's previous value and started at its new value, every step chained
 *     to the next — the schedule is putting back exactly what it moved, and nothing else moved it.
 *
 * A give-back is exempt from the day-move bound ONLY. Bounds, spend ceilings, pins, the allowlist and
 * the halt still apply to it, because those checks run before the movement bound and know nothing of it.
 *
 * Pure: the gate reads the rows and hands them over.
 */

/**
 * How many budget writes back the gate looks for a schedule's own run. 3b — above GIVE_BACK_RETRIES + 1 (24 + 1):
 * each refused retry adds a row by the schedule, and the entry row must stay in view for the last retry.
 */
export const GIVE_BACK_LOOKBACK = 32

const SCHEDULE_ACTOR_PREFIX = 'automation:budget-schedule-'

/** The schedule id in a budget schedule's actor (`automation:budget-schedule-<id>`), else null. */
export function budgetScheduleIdOf(actor: string | null | undefined): string | null {
  if (!actor || !actor.startsWith(SCHEDULE_ACTOR_PREFIX)) return null
  return actor.slice(SCHEDULE_ACTOR_PREFIX.length) || null
}

/** One AD_BUDGET_UPDATE log row as the give-back test reads it: who wrote it, and the budget before and after, in cents. */
export interface BudgetLogStep {
  actor: string | null
  beforeCents: number | null
  afterCents: number | null
}

/**
 * Read one log row. ⚠ `payloadBefore/payloadAfter.dailyBudget` is EUROS, not cents — the one ads money
 * field that is not (see budgetDayMoveDenial). null when the payload carries no budget.
 */
export function budgetLogStepOf(row: { userId: string | null; payloadBefore: unknown; payloadAfter: unknown }): BudgetLogStep {
  const cents = (payload: unknown): number | null => {
    const raw = (payload as { dailyBudget?: unknown } | null)?.dailyBudget
    const euros = raw == null || raw === '' ? NaN : Number(raw)
    return Number.isFinite(euros) ? Math.round(euros * 100) : null
  }
  return { actor: row.userId, beforeCents: cents(row.payloadBefore), afterCents: cents(row.payloadAfter) }
}

/**
 * Is this budget write a schedule giving back what it set?
 *
 * `earlierNewestFirst` — the campaign's budget log rows before this write, newest first, with rolled-back
 * rows and this write's own row already left out. Only the first GIVE_BACK_LOOKBACK are read.
 *
 * Walking back from this write's previous value, each row of the schedule's must have set the value the
 * walk stands on; its `before` is then where the walk goes next, and reaching this write's new value
 * proves the give-back. One row may be passed over: a row of the schedule's own that did not stick — the
 * budget is back at that row's `before` (the gate refused it and the sync copied Amazon's value back).
 * It moved nothing, so it neither proves nor breaks the run; this is what lets a refused give-back be
 * tried again. Anything else — another writer, a row with no budget, a value nobody logged — ends the
 * walk with "not a give-back", and the write is bounded like any other.
 */
export function isBudgetGiveBack(
  write: { actor: string | null | undefined; previousCents: number | null | undefined; newCents: number | null | undefined },
  earlierNewestFirst: readonly BudgetLogStep[],
): boolean {
  if (!budgetScheduleIdOf(write.actor)) return false
  const previous = write.previousCents
  const next = write.newCents
  if (previous == null || next == null || !Number.isFinite(previous) || !Number.isFinite(next) || previous === next) return false
  let at = previous
  for (const step of earlierNewestFirst.slice(0, GIVE_BACK_LOOKBACK)) {
    if (step.actor !== write.actor) return false
    if (step.beforeCents == null || step.afterCents == null) return false
    if (step.afterCents === at) {
      at = step.beforeCents
      if (at === next) return true
    } else if (step.beforeCents !== at) {
      return false // the budget moved between the schedule's writes and nothing logged it
    }
  }
  return false
}

/**
 * The day's opening budget for the movement bound: the `before` of today's earliest write that is NOT
 * a give-back. A give-back is not a move of the day it lands on, so it must not set that day's opening
 * either — or the first writer after it is measured from the boost the give-back just removed.
 *
 * `todayOldestFirst` — today's rows (this write's own left out); `beforeTodayNewestFirst` — the rows
 * before today, newest first (GIVE_BACK_LOOKBACK of them is enough). null when no row today counts
 * (or the counting row carries no budget): the caller falls back to this write's previous value.
 */
export function dayOpeningCents(
  todayOldestFirst: readonly BudgetLogStep[],
  beforeTodayNewestFirst: readonly BudgetLogStep[],
): number | null {
  for (let i = 0; i < todayOldestFirst.length; i++) {
    const step = todayOldestFirst[i]!
    const earlier = [...todayOldestFirst.slice(0, i).reverse(), ...beforeTodayNewestFirst]
    if (isBudgetGiveBack({ actor: step.actor, previousCents: step.beforeCents, newCents: step.afterCents }, earlier)) continue
    return step.beforeCents
  }
  return null
}
