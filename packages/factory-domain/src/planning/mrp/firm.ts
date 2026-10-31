import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { decimalOf } from '../../product/units/units'
import type { Decision, RunStatus } from '../decisions'

/**
 * A firm planned order (B-W2a-22; PLN-075 "firming planned orders"; MaterialRequirement's firm columns), pure. A planner
 * fixes what a line of the LATEST plan brings: how much (in the line's suggested unit), by when, and for a buy from which
 * supplier. The next run keeps it as planned supply and carries it to its own line instead of planning it again (./net,
 * ../explode); it never changes it. While the line is ORDERED (a purchase order line buys it) the firm order is fixed;
 * a set-aside line is never firm. Making it planned again (unfirm) clears all six columns.
 *
 * B-W2b-20: the carried line is written WITH `firmCarriedFromId` (the earlier run's firm line); the guard of
 * …_followups_quality_money_w2b_guards (B-W2b-02) keeps it firm at insert and lets it be made planned again later (the
 * six firm columns cleared, `firmCarriedFromId` kept as its history). The firm columns are copied as they were (when and
 * by whom it was made firm).
 */

export interface FirmLine {
  readonly decision: Decision
  readonly action: 'BUY' | 'MAKE'
}

/** Why the line cannot be made firm (or planned again) now: a 409 for the caller, or null. */
export function firmProblem(line: FirmLine, runStatus: RunStatus, to: 'FIRM' | 'PLANNED', firm: boolean): string | null {
  if (runStatus === 'SUPERSEDED') return 'A newer plan replaced this one: make the lines of the latest plan firm.'
  if (runStatus !== 'DONE') return `The plan is ${runStatus === 'RUNNING' ? 'still running' : 'a failed run'}; its lines cannot be made firm.`
  if (line.decision === 'IGNORED') return 'The line is set aside: open it again first.'
  if (line.decision === 'ORDERED') return 'The line is ordered already: its purchase order line says how much and when.'
  if (to === 'PLANNED' && !firm) return 'The line is not firm.'
  return null
}

/** What the planner typed, as typed: a quantity above 0 and a calendar day not before today. */
export function firmInputProblems(input: { readonly quantity: string; readonly date: string }, today: BusinessDate): Issue[] {
  const problems: Issue[] = []
  if (!/^\d+(\.\d{1,4})?$/.test(input.quantity) || !decimalOf(input.quantity).gt(0)) problems.push({ path: 'body/quantity', message: 'Give a quantity above 0, with at most four decimals.' })
  if (!isBusinessDate(input.date)) problems.push({ path: 'body/date', message: 'Give the day as YYYY-MM-DD.' })
  else if (input.date < today) problems.push({ path: 'body/date', message: `A firm planned order is not dated in the past (today is ${today}).` })
  return problems
}
