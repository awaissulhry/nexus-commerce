import type { BusinessDate } from '../../core/time'
import { after, before, dayWords, endBy, MINUTE_MS, startFrom, whenWords, type Span } from './time'

/**
 * Backward scheduling and the latest safe start (B-W2a-34; PLN-129; design planning.board "Latest safe start tick per
 * work order", the tray "Sorted by latest safe start", the bar popover), pure. Infinite capacity: what other work
 * orders book is the load bar's question, not this one's.
 *
 *   durations   each operation with work left takes its standard minutes × the garments still to do there, worked by
 *               its lane: ÷ (people × efficiency) in the lane's working minutes (a line or a work centre, its calendar);
 *               an operation done by a workshop (its routing step is outside work) takes the step's transit days on
 *               the clock.
 *   backward    the last operation must be finished by the end of the work order's due date (the last working instant
 *               of its lane at or before the next day's local midnight); each operation's latest finish is the next
 *               one's latest start (finish to start); its latest start is its duration before that, walking back over
 *               the lane's working time. The first one's latest start is the work order's LATEST SAFE START: started
 *               later, it cannot be finished by its due date even with nothing else in the way.
 *   forward     the same chain from now (each operation at the first working instant of its lane): the earliest finish.
 *   the plan    the operations' slots in the site's WORKING plan (their own, else the work order's whole-order slots):
 *               planned start and finish.
 *   words       why a work order is LATE (past its due date; would finish after it even started now; the plan finishes
 *               it after it) or AT_RISK (must start within the next working day and is not wholly on the board; an
 *               operation starts in the plan after its latest start), else ON_TIME; NO_DUE_DATE and DONE apart. English
 *               sentences (`words`), with a code per reason the screens say in their language.
 * No person: per work order, operation and lane only (Statuto dei Lavoratori art. 4).
 */

export const SCHEDULE_STATUSES = ['LATE', 'AT_RISK', 'ON_TIME', 'NO_DUE_DATE', 'DONE'] as const
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number]

export const SCHEDULE_REASONS = [
  'PAST_DUE',
  'CANNOT_FINISH_IN_TIME',
  'PLAN_FINISHES_LATE',
  'START_SOON',
  'STARTS_AFTER_LATEST_START',
  'BEFORE_CALENDAR',
  'ON_TIME',
  'NO_DUE_DATE',
  'DONE',
] as const
export type ScheduleReasonCode = (typeof SCHEDULE_REASONS)[number]

export interface PlannedSpan {
  readonly start: number
  readonly end: number
}

export type Duration =
  /** Working minutes on the lane's working stretches. */
  | { readonly kind: 'WORKING'; readonly minutes: number; readonly spans: readonly Span[] }
  /** Clock minutes (an outside operation's transit days). */
  | { readonly kind: 'CLOCK'; readonly minutes: number }

export interface ScheduleOperation {
  readonly id: string
  readonly seq: number
  readonly name: string
  readonly duration: Duration
  /** Its slots in the working plan (its own, else the work order's whole-order slots); empty: not on the board. */
  readonly planned: readonly PlannedSpan[]
}

export interface ScheduleWorkOrder {
  readonly number: string
  readonly dueDate: BusinessDate | null
  /** The first instant after the due date at the site (the next day's local midnight); null without a due date. */
  readonly dueBy: number | null
  /** The operations with work left, by sequence. */
  readonly operations: readonly ScheduleOperation[]
}

export interface OperationTimes {
  readonly id: string
  /** Working minutes (or clock minutes outside) it takes. */
  readonly minutes: number
  readonly latestStart: number | null
  readonly latestFinish: number | null
  readonly earliestStart: number | null
  readonly earliestFinish: number | null
  readonly plannedStart: number | null
  readonly plannedFinish: number | null
  /** On the board and starting after its latest start. */
  readonly startsLate: boolean
}

export interface ScheduleReason {
  readonly code: ScheduleReasonCode
  readonly words: string
}

export interface WorkOrderSchedule {
  readonly status: ScheduleStatus
  readonly latestSafeStart: number | null
  /** The end of work on the due date (the last operation's latest finish). */
  readonly latestFinish: number | null
  readonly earliestFinish: number | null
  readonly plannedStart: number | null
  readonly plannedFinish: number | null
  /** ALL: every operation with work left has a slot; PART: some; NONE: none (the tray). */
  readonly placed: 'ALL' | 'PART' | 'NONE'
  readonly reasons: readonly ScheduleReason[]
  /** The first reason's words. */
  readonly words: string
  readonly operations: readonly OperationTimes[]
}

export interface ScheduleWhen {
  readonly now: number
  /** The end of the site's next working day: a latest safe start before it is soon. */
  readonly soon: number
  readonly timeZone: string
}

const latestBack = (duration: Duration, finishBy: number): { start: number; finish: number } | null => {
  if (duration.kind === 'CLOCK') return { start: finishBy - duration.minutes * MINUTE_MS, finish: finishBy }
  const finish = endBy(duration.spans, finishBy)
  if (finish === null) return null
  const start = before(duration.spans, finish, duration.minutes)
  return start === null ? null : { start, finish }
}

const earliestForward = (duration: Duration, startAt: number): { start: number; finish: number } | null => {
  if (duration.kind === 'CLOCK') return { start: startAt, finish: startAt + duration.minutes * MINUTE_MS }
  const start = startFrom(duration.spans, startAt)
  if (start === null) return null
  const finish = after(duration.spans, start, duration.minutes)
  return finish === null ? null : { start, finish }
}

/** The work order's latest safe start, earliest finish, plan and words. */
export function scheduleWorkOrder(workOrder: ScheduleWorkOrder, when: ScheduleWhen): WorkOrderSchedule {
  const say = (instant: number) => whenWords(instant, when.timeZone)
  const ops = [...workOrder.operations].sort((a, b) => a.seq - b.seq)
  const back = new Map<string, { start: number; finish: number } | null>()
  let beforeCalendar = false
  if (workOrder.dueBy !== null) {
    let finishBy: number | null = workOrder.dueBy
    for (const op of [...ops].reverse()) {
      const times: { start: number; finish: number } | null = finishBy === null ? null : latestBack(op.duration, finishBy)
      if (times === null) beforeCalendar = true
      back.set(op.id, times)
      finishBy = times?.start ?? null
    }
  }
  const forward = new Map<string, { start: number; finish: number } | null>()
  let startAt: number | null = when.now
  for (const op of ops) {
    const times: { start: number; finish: number } | null = startAt === null ? null : earliestForward(op.duration, startAt)
    forward.set(op.id, times)
    startAt = times?.finish ?? null
  }
  // Started now, the chain ran out of the loaded working time (which reaches past the due date): it cannot be in time.
  const beyondCalendar = ops.length > 0 && startAt === null
  const operations: OperationTimes[] = ops.map((op) => {
    const latest = back.get(op.id) ?? null
    const earliest = forward.get(op.id) ?? null
    const plannedStart = op.planned.length ? Math.min(...op.planned.map((span) => span.start)) : null
    const plannedFinish = op.planned.length ? Math.max(...op.planned.map((span) => span.end)) : null
    return {
      id: op.id,
      minutes: op.duration.minutes,
      latestStart: latest?.start ?? null,
      latestFinish: latest?.finish ?? null,
      earliestStart: earliest?.start ?? null,
      earliestFinish: earliest?.finish ?? null,
      plannedStart,
      plannedFinish,
      startsLate: plannedStart !== null && latest !== null && plannedStart > latest.start,
    }
  })
  const placedCount = ops.filter((op) => op.planned.length > 0).length
  const placed = placedCount === 0 ? 'NONE' : placedCount === ops.length ? 'ALL' : 'PART'
  const plannedStarts = operations.map((op) => op.plannedStart).filter((value): value is number => value !== null)
  const plannedFinishes = operations.map((op) => op.plannedFinish).filter((value): value is number => value !== null)
  const plannedStart = plannedStarts.length ? Math.min(...plannedStarts) : null
  const plannedFinish = plannedFinishes.length ? Math.max(...plannedFinishes) : null
  const latestSafeStart = operations.length && !beforeCalendar ? (operations[0]!.latestStart ?? null) : null
  const latestFinish = operations.length ? (operations[operations.length - 1]!.latestFinish ?? null) : null
  const last = operations[operations.length - 1]
  const earliestFinish = last?.earliestFinish ?? null
  const base = { latestSafeStart, latestFinish, earliestFinish, plannedStart, plannedFinish, placed, operations } as const

  const out = (status: ScheduleStatus, reasons: ScheduleReason[]): WorkOrderSchedule => ({ ...base, status, reasons, words: reasons[0]!.words })
  if (ops.length === 0) return out('DONE', [{ code: 'DONE', words: `${workOrder.number} has no work left at any operation.` }])
  if (workOrder.dueDate === null || workOrder.dueBy === null) {
    return out('NO_DUE_DATE', [{ code: 'NO_DUE_DATE', words: `${workOrder.number} has no due date: there is nothing to schedule it back from.` }])
  }
  const due = dayWords(workOrder.dueDate)
  const late: ScheduleReason[] = []
  if (when.now >= workOrder.dueBy) {
    late.push({ code: 'PAST_DUE', words: `${workOrder.number} was due on ${due} and ${ops.length === 1 ? 'one operation still has' : `${ops.length} operations still have`} work left.` })
  } else if (earliestFinish !== null && earliestFinish > workOrder.dueBy) {
    late.push({ code: 'CANNOT_FINISH_IN_TIME', words: `Even started now, ${workOrder.number} finishes on ${say(earliestFinish)}, after its due date ${due}.` })
  } else if (beyondCalendar) {
    late.push({ code: 'CANNOT_FINISH_IN_TIME', words: `Even started now, ${workOrder.number} does not finish by its due date ${due}: its operations take more working time than its lanes have before then.` })
  } else if (beforeCalendar || (latestSafeStart !== null && latestSafeStart < when.now)) {
    late.push({ code: 'BEFORE_CALENDAR', words: `${workOrder.number} should have started already to finish by ${due}: its operations take more working time than is left.` })
  }
  if (placed === 'ALL' && plannedFinish !== null && plannedFinish > workOrder.dueBy) {
    late.push({ code: 'PLAN_FINISHES_LATE', words: `The working plan finishes ${workOrder.number} on ${say(plannedFinish)}, after its due date ${due}.` })
  }
  if (late.length > 0) return out('LATE', late)

  const risk: ScheduleReason[] = []
  if (placed !== 'ALL' && latestSafeStart !== null && latestSafeStart <= when.soon) {
    const left = ops.length - placedCount
    risk.push({ code: 'START_SOON', words: `${workOrder.number} must start by ${say(latestSafeStart)} (its latest safe start) and ${left === 1 ? 'one operation is' : `${left} operations are`} not on the board.` })
  }
  for (const op of operations) {
    if (!op.startsLate) continue
    const name = ops.find((candidate) => candidate.id === op.id)!.name
    risk.push({ code: 'STARTS_AFTER_LATEST_START', words: `${name} starts on ${say(op.plannedStart!)} in the plan, after its latest start ${say(op.latestStart!)}: what follows has no time to spare.` })
  }
  if (risk.length > 0) return out('AT_RISK', risk)
  const onBoard = plannedFinish !== null && placed === 'ALL' ? `the plan finishes it on ${say(plannedFinish)}` : placed === 'NONE' ? 'it is not on the board yet' : 'part of it is on the board'
  return out('ON_TIME', [{ code: 'ON_TIME', words: `${workOrder.number} can start as late as ${say(latestSafeStart!)} and still finish by ${due}; ${onBoard}.` }])
}

/** The tray's order: the earliest latest safe start first (none last), then the due date, then the number. */
export function trayOrder(
  a: { readonly latestSafeStart: number | null; readonly dueDate: BusinessDate | null; readonly number: string },
  b: { readonly latestSafeStart: number | null; readonly dueDate: BusinessDate | null; readonly number: string },
): number {
  const x = a.latestSafeStart ?? Number.POSITIVE_INFINITY
  const y = b.latestSafeStart ?? Number.POSITIVE_INFINITY
  if (x !== y) return x < y ? -1 : 1
  const da = a.dueDate ?? '9999-12-31'
  const db = b.dueDate ?? '9999-12-31'
  if (da !== db) return da < db ? -1 : 1
  return a.number < b.number ? -1 : a.number > b.number ? 1 : 0
}
