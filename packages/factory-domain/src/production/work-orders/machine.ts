import type { BusinessDate } from '../../core/time'
import { defineMachine, nextStates } from '../../state/machine'

/**
 * A work order's life (B-W1-38; features MES-001, MES-007, MES-305; plan A1 §2.5 "Work order"), pure. apps/factory-api's
 * modules/production/work-orders moves it, one command per move, and the …_production_guards trigger holds the same
 * moves and their times for every login.
 *
 *   DRAFT → RELEASED → IN_PROGRESS → COMPLETED → CLOSED; CANCELLED (with a reason) from DRAFT, RELEASED or IN_PROGRESS.
 *   CLOSED and CANCELLED are final. ON_HOLD (MES-008, W2a schema wave 5/7) is a state of the schema here; its hold and
 *   lift moves (back to the status it was held from) are B-W2a-26's, so this machine has none yet.
 *
 * RELEASED needs the release check passed (./release: every blocker in words); CANCELLED needs a reason. Each move
 * sets its time in the same row update (the trigger refuses a status without its time): RELEASED the release and the
 * batch number (./release), IN_PROGRESS `startedAt`, COMPLETED `completedAt`, CLOSED `closedAt`, CANCELLED
 * `cancelledAt` with `cancelReason`.
 */

// W2a wave 5 (factory-db production.prisma): ON_HOLD, held from DRAFT, RELEASED or IN_PROGRESS.
export const WORK_ORDER_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED', 'ON_HOLD'] as const
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number]

// W2a wave 5: REPAIR, a repair of returned garments (MES-019).
export const WORK_ORDER_KINDS = ['SIZE_GRID', 'MADE_TO_MEASURE', 'REPAIR'] as const
export type WorkOrderKind = (typeof WORK_ORDER_KINDS)[number]

/** What a move's guard reads. */
export interface WorkOrderFacts {
  /** RELEASED: what still holds the release, each in words (empty: nothing). Absent: not checked, so refused. */
  readonly releaseBlockers?: readonly string[]
  /** CANCELLED: the reason given. */
  readonly reason?: string | null
}

export const workOrderMachine = defineMachine<WorkOrderStatus, WorkOrderFacts>({
  name: 'work order',
  states: WORK_ORDER_STATUSES,
  transitions: {
    DRAFT: ['RELEASED', 'CANCELLED'],
    RELEASED: ['IN_PROGRESS', 'CANCELLED'],
    IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
    COMPLETED: ['CLOSED'],
  },
  guards: {
    RELEASED: (facts) => facts.releaseBlockers ?? ['the release check'],
    CANCELLED: (facts) => (typeof facts.reason === 'string' && facts.reason.trim() !== '' ? [] : ['a reason for the cancellation']),
  },
})

/** The moves the office makes by hand after the release (the release itself is its own command). */
export const MANUAL_MOVES = ['IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const satisfies readonly WorkOrderStatus[]
export type ManualMove = (typeof MANUAL_MOVES)[number]

/** The time column each move sets (with the cancellation's reason). */
export const MOVE_TIME: Readonly<Record<ManualMove, 'startedAt' | 'completedAt' | 'closedAt' | 'cancelledAt'>> = Object.freeze({
  IN_PROGRESS: 'startedAt',
  COMPLETED: 'completedAt',
  CLOSED: 'closedAt',
  CANCELLED: 'cancelledAt',
})

/** The row change of a move: the status, its time and (CANCELLED) the reason. */
export function moveChange(to: ManualMove, now: Date, reason?: string): Record<string, unknown> {
  return { status: to, [MOVE_TIME[to]]: now, ...(to === 'CANCELLED' ? { cancelReason: (reason ?? '').trim() } : {}) }
}

/** Released work orders still to be issued their material: what they still need is promised to them. */
// W2a wave 5: a held work order keeps what is promised to it (the hold is lifted back to where it was).
export const COMMITTED_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['RELEASED', 'IN_PROGRESS', 'ON_HOLD'])

/** Work orders not finished yet: a due date in the past makes them late (MES-305). */
// W2a wave 5: a held work order is not finished either.
export const OPEN_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'])

/** Whole days past the due date for an open work order (0 when on time, null without a due date or when finished). */
export function daysLate(status: WorkOrderStatus, dueDate: BusinessDate | null, today: BusinessDate): number | null {
  if (dueDate === null || !OPEN_STATUSES.includes(status)) return null
  if (today <= dueDate) return 0
  // Both are calendar days: midnight UTC to midnight UTC is a whole number of days.
  return Math.round((Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${dueDate}T00:00:00.000Z`)) / 86_400_000)
}

/** What the office may do next on a work order in this status (the record's actions; the release is `RELEASED`). */
export function nextActions(status: WorkOrderStatus): readonly WorkOrderStatus[] {
  return nextStates(workOrderMachine, status)
}
