import { DomainError, type Issue } from '../../core/errors'

/**
 * Stable codes for the planning board's refusals and held publishes (B-W2b-20; B-W2a-45's gap: the board's screens read
 * the shape of the API's English sentences). Every 409 of the schedule's writes carries one issue `refusal/<CODE>`
 * after its other issues (their order is W2a's) (as the quality holds' refusals do, B-W2a-F1), the board's `plan.publishHold` and the publish
 * dialog's `heldCode` say why publishing is held, and each skipped placement of "Place all by due date" carries its
 * `code`. The words stay the API's (English, for logs and the API's own callers); a screen says its own words from the
 * code and the numbers.
 */

export const SCHEDULE_REFUSALS = [
  /** A line that does not do the operation's work centre, or another work centre than the operation's. */
  'LANE_DOES_NOT',
  /** A part of an order (whole-order slot) on a work centre: parts go to a line or a workshop. */
  'PART_LANE',
  /** The work order is not open any more (completed, closed, cancelled). */
  'NOT_OPEN',
  /** The work does not fit in the lane's working time loaded (give an end). */
  'NO_WORKING_TIME',
  /** The operation is done: nothing to place. */
  'OPERATION_DONE',
  /** The operation already has a bar on the board. */
  'ALREADY_ON_BOARD',
  /** The work order already has a part on that lane. */
  'PART_THERE',
  /** The lane would go over its available minutes: keep it with a reason. */
  'OVERLOAD',
  /** The slot was moved by someone since it was read (the issue `updatedAt` says when). */
  'MOVED_BY',
  /** The slot changed between the read and the write inside the command. */
  'SLOT_MOVED',
  /** The working plan changed since it was read (a publish or a placement reviewed an older plan). */
  'PLAN_CHANGED',
  /** The line or work centre is archived, or the workshop is not active. */
  'LANE_ARCHIVED',
  /** "Place all by due date" found nothing to place. */
  'NOTHING_TO_PLACE',
  /** Publish: nothing changed since the last version on those days. */
  'NOTHING_CHANGED',
  /** Publish: the working plan has nothing on those days. */
  'NOTHING_ON_DAYS',
  /** Allocation: the work order is completed, closed or cancelled: its allocation is kept. */
  'WORK_ORDER_LOCKED',
  /** Allocation: the work order is already allocated so. */
  'ALREADY_ALLOCATED',
] as const
export type ScheduleRefusalCode = (typeof SCHEDULE_REFUSALS)[number]

/** Why "Publish to floor" is held (the board's band; the dialog's `heldCode`). */
export const PUBLISH_HOLDS = ['NOTHING_CHANGED', 'NOTHING_ON_DAYS', 'NO_PERMISSION', 'RANGE_NOT_VALID'] as const
export type PublishHoldCode = (typeof PUBLISH_HOLDS)[number]

/** Why "Place all by due date" leaves a work order or an operation out. */
export const SKIP_CODES = ['NOT_OPEN', 'ON_HOLD', 'NO_DUE_DATE', 'LANE_NOT_ACTIVE', 'NO_WORKING_TIME'] as const
export type SkipCode = (typeof SKIP_CODES)[number]

/** The issue that carries a refusal's code. */
export const refusalIssue = (code: ScheduleRefusalCode, message: string = code): Issue => ({ path: `refusal/${code}`, message })

/** The code of a refusal's issues, when one carries it. */
export function refusalCodeOf(issues: readonly Issue[] | undefined): ScheduleRefusalCode | null {
  const issue = (issues ?? []).find((candidate) => candidate.path.startsWith('refusal/'))
  const code = issue?.path.slice('refusal/'.length)
  return code && (SCHEDULE_REFUSALS as readonly string[]).includes(code) ? (code as ScheduleRefusalCode) : null
}

/** A 409 of the planning board with its stable code (after any other issues: the over days, the version). */
export class ScheduleRefusal extends DomainError {
  override name = 'ScheduleRefusal'
  constructor(
    readonly refusal: ScheduleRefusalCode,
    message: string,
    issues: readonly Issue[] = [],
  ) {
    super('conflict', message, [...issues, refusalIssue(refusal)])
  }
}
