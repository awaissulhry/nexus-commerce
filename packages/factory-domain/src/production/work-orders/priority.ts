import type { BusinessDate } from '../../core/time'
import type { WorkOrderStatus } from './machine'

/**
 * Priority and the rush flag (B-W2b-51; MES-009 "Priority and rush flag"; design production.workorders wo-grid "Priority
 * (number; W2b rush flag)", selection row "Change priority (W2b)"; floor.mywork "a Rush flag (icon + word)", "rush
 * first, then due date, then sequence"; floor.operation "Rush flag"), pure.
 *
 *   priority   a whole number from −1000 to 1000, higher first, 0 normal (W1).
 *   rush       a flag beside it (WorkOrder.rush, B-W2b-12): a rush work order goes before every one without it, whatever
 *              their priority, on the dispatch board, the tablet's My work and the planning board. The office sets it on
 *              the record, in the list (a cell, or Edit N for the selected rows) or when it makes the work order.
 *   when       both change until the work order is CLOSED or CANCELLED (the …_floor_work_w2b_guards trigger holds the
 *              same rule for every login).
 *   order      rush first, then the higher priority, then the earlier due date (none last), then the number.
 *
 * Per work order only: never a person, never money.
 */

export const PRIORITY_LIMITS = Object.freeze({ min: -1000, max: 1000 })

/** The statuses that keep the priority and the rush flag as they are (only the note changes). */
export const URGENCY_KEPT: readonly WorkOrderStatus[] = Object.freeze(['CLOSED', 'CANCELLED'])

/** The rush flag as a list's bulk field writes it (a choice: the list frame edits no yes/no field). */
export const RUSH_CHOICES = ['RUSH', 'NORMAL'] as const
export type RushChoice = (typeof RUSH_CHOICES)[number]

export const rushChoiceOf = (rush: boolean): RushChoice => (rush ? 'RUSH' : 'NORMAL')
export const rushOfChoice = (choice: string): boolean => choice === 'RUSH'

/** What orders work orders by urgency. */
export interface UrgencyKey {
  readonly rush: boolean
  readonly priority: number
  readonly dueDate: BusinessDate | null
  readonly number: string
}

/** Rush first, then the higher priority, then the earlier due date (none last), then the number. */
export function urgencyOrder(a: UrgencyKey, b: UrgencyKey): number {
  if (a.rush !== b.rush) return a.rush ? -1 : 1
  if (a.priority !== b.priority) return b.priority - a.priority
  const da = a.dueDate ?? '9999-12-31'
  const db = b.dueDate ?? '9999-12-31'
  if (da !== db) return da < db ? -1 : 1
  return a.number < b.number ? -1 : a.number > b.number ? 1 : 0
}

/** Why a work order keeps its priority and rush flag now (`CLOSED`: "only its note changes"), or null. */
export function urgencyHeld(number: string, status: WorkOrderStatus): string | null {
  return URGENCY_KEPT.includes(status) ? `Work order ${number} is ${status}; only its note changes.` : null
}
