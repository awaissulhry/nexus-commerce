/**
 * C3 (2026-10-07) — a bid steered by window evidence moves TOWARD a goal bid, never by a ratio of the bid it has now.
 *
 * The evidence (30 settled days) barely moves between two runs, so `current bid × target / ACoS` applied again and again
 * multiplies the same ratio into the bid every run: one target went 33 → 25 → 19 → 14¢ in 6 hours on 2026-10-07. The
 * goal comes from the evidence alone — target ACoS × sales per click (= average CPC × target / ACoS) — so the same
 * evidence gives the same goal, and a second run moves on toward it or does nothing. Pure; a leaf (no API imports).
 *
 * Review 2026-10-08 (B) — the dead zone grows from 5 % to 10 % of the goal, and a move smaller than 2¢ is no move: on a
 * keyword with a few clicks one order entering or leaving the window moves its goal by more than 5 %, and a 1¢ step on
 * an 8¢ bid is noise, not steering.
 */

/** A bid within 10 % of its goal is left where it is: evidence noise is not a reason to write. */
export const GOAL_TOLERANCE = 0.1
/** A bid less than this many cents from its goal is left where it is, whatever the share. */
export const GOAL_MIN_MOVE_CENTS = 2

/** True when `currentCents` sits within GOAL_TOLERANCE or GOAL_MIN_MOVE_CENTS of `goalCents` (or there is no goal to move toward). */
export function withinGoal(currentCents: number, goalCents: number): boolean {
  if (!(goalCents > 0)) return true
  const gap = Math.abs(currentCents - goalCents)
  return gap <= goalCents * GOAL_TOLERANCE || gap < GOAL_MIN_MOVE_CENTS
}

/**
 * The next bid on the way from `currentCents` to `goalCents`: one step at most (`step.down` / `step.up`, fractions),
 * never past the goal, never under `floorCents`; null when the current bid is already within the dead zone (withinGoal).
 */
export function stepTowardGoal(currentCents: number, goalCents: number, step: { down: number; up: number }, floorCents = 5): number | null {
  if (withinGoal(currentCents, goalCents)) return null
  return currentCents > goalCents
    ? Math.max(floorCents, Math.round(Math.max(goalCents, currentCents * (1 - step.down))))
    : Math.round(Math.min(goalCents, currentCents * (1 + step.up)))
}
