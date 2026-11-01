import type { BusinessDate } from '../../core/time'

/**
 * The dispatch list per line or station (B-W2a-34; MES-021; design floor.mywork "Next" and "Then": "The station's or
 * line's queue: rush first, then due date, then sequence"), pure. It is read from the site's CURRENT published version
 * of the plan (Owner answer P3: the floor sees nothing of the working plan), one entry per operation the version puts
 * on the line or station, with where the work stands from the floor's own scans.
 *
 *   order      rush first (the work order's rush flag, B-W2b-51 MES-009), then the higher priority, then the due date
 *              (none last), then the planned start, then the operation's sequence and the work order number.
 *   state      DONE (every garment done there: good or scrapped), ON_HOLD (the work order is held: its reason), NOT_RELEASED
 *              (a draft), READY (the first operation, or garments waiting there that the operation before passed on),
 *              WAITING_FOR_PREVIOUS (nothing passed on to it yet: the operation before it is named).
 *   next       the first entry that is READY (the one next task, big).
 * Per work order, operation, line and station only: never a person (Statuto dei Lavoratori art. 4; Owner answer F2).
 */

export const DISPATCH_STATES = ['READY', 'WAITING_FOR_PREVIOUS', 'NOT_RELEASED', 'ON_HOLD', 'DONE'] as const
export type DispatchState = (typeof DISPATCH_STATES)[number]

export interface DispatchFacts {
  readonly workOrderNumber: string
  readonly workOrderStatus: string
  readonly holdReason: string | null
  readonly operation: { readonly seq: number; readonly name: string }
  /** The scanned operation before it on the work order; null: the first. */
  readonly previous: { readonly seq: number; readonly name: string } | null
  /** The garments the entry is about (the work order's, or the part's). */
  readonly garments: number
  /** At the operation: arrived from the one before, waiting (arrived, not reported), done (good + scrapped). */
  readonly arrived: number
  readonly waiting: number
  readonly done: number
}

export function dispatchState(facts: DispatchFacts): { state: DispatchState; words: string } {
  const op = `Op ${facts.operation.seq} ${facts.operation.name}`
  if (facts.done >= facts.garments && facts.garments > 0) return { state: 'DONE', words: `${op} is done for ${facts.workOrderNumber}.` }
  if (facts.workOrderStatus === 'ON_HOLD') return { state: 'ON_HOLD', words: `${facts.workOrderNumber} is on hold${facts.holdReason ? `: ${facts.holdReason}` : ''}.` }
  if (facts.workOrderStatus === 'DRAFT') return { state: 'NOT_RELEASED', words: `${facts.workOrderNumber} is not released yet.` }
  if (facts.previous === null) return { state: 'READY', words: `${op} of ${facts.workOrderNumber} is ready to start.` }
  if (facts.waiting > 0) return { state: 'READY', words: `${facts.waiting} ${facts.waiting === 1 ? 'garment waits' : 'garments wait'} at ${op} for ${facts.workOrderNumber}.` }
  return { state: 'WAITING_FOR_PREVIOUS', words: `Waiting for Op ${facts.previous.seq} ${facts.previous.name}.` }
}

export interface DispatchOrderKey {
  /** B-W2b-51: the work order's rush flag (absent: not rush). */
  readonly rush?: boolean
  readonly priority: number
  readonly dueDate: BusinessDate | null
  readonly startAt: number
  readonly seq: number
  readonly workOrderNumber: string
}

/** Rush first, then the higher priority, then due date, then the planned start, then sequence. */
export function dispatchOrder(a: DispatchOrderKey, b: DispatchOrderKey): number {
  if ((a.rush ?? false) !== (b.rush ?? false)) return a.rush ? -1 : 1
  if (a.priority !== b.priority) return b.priority - a.priority
  const da = a.dueDate ?? '9999-12-31'
  const db = b.dueDate ?? '9999-12-31'
  if (da !== db) return da < db ? -1 : 1
  if (a.startAt !== b.startAt) return a.startAt - b.startAt
  if (a.seq !== b.seq) return a.seq - b.seq
  return a.workOrderNumber < b.workOrderNumber ? -1 : a.workOrderNumber > b.workOrderNumber ? 1 : 0
}
