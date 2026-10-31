import { businessDayStart, type BusinessDate } from '../core/time'

/**
 * Date timers (B-W2a-33; PLT-100 "time-based triggers"; design admin.automation "Reminders & timers"), pure. ONE service
 * fires everything that happens relative to a record's date (apps/factory-api platform/timers): 30 days before a
 * certificate's last valid day, a few working days before a DDT's invoice deadline, and the later steps' reminders
 * (a PO's confirm-by date, a payment reminder's next step, a restore drill due) set their own timers through it. The
 * table is alerts.prisma's DueTimer; the …_platform_w2a_guards triggers hold its shape.
 *
 * A timer is ONE scheduled firing of one record: its key says what date it watches and how far from it
 * (`KIND[:±N(m|h|d)]`, `CERTIFICATE_EXPIRY:-30d`), `dueAt` is the record's date, `fireAt` when it fires. One PENDING timer
 * per record and key (a partial unique index). The timer never changes what it watches: a moved date CANCELS the timer
 * (with the reason) and sets a new one; a record that no longer needs it cancels it. PENDING → FIRED | CANCELLED, then
 * frozen. Firing is the scheduler's (one replica per tick): the timer turns FIRED in the same command as its event
 * (`timer.fired`), so a replayed tick fires nothing twice.
 *
 * Days count in calendar days, or in working days of the record's place (the calendars service, B-W2a-08) when the
 * rule says so; then the API works the date out and hands `fireAt` in (the key still names the days).
 */

/** The key's shape (the database checks the same). */
export const TIMER_KEY = /^[A-Z][A-Z0-9_]*(:[+-]?[0-9]+[mhd])?$/

export const TIMER_UNITS = ['m', 'h', 'd'] as const
export type TimerUnit = (typeof TIMER_UNITS)[number]

/** How far from the date: a signed number of minutes, hours or days (negative: before it). */
export interface TimerOffset {
  readonly amount: number
  readonly unit: TimerUnit
}

/**
 * The timer kinds in use, each the date it watches. A later step adds its own (the key needs no migration): B-W2a-52 a
 * PO's confirm-by date, B-W2a-55 a reminder's next step, B-W2a-54 an invoice type's own deadline, B-W2a-36 a restore drill.
 */
export const TIMER_KINDS = {
  CERTIFICATE_EXPIRY: "A certificate's last valid day.",
  INVOICE_DEADLINE: "The last day to invoice the goods of a DDT (the 15th of the next month, a deferred invoice).",
  // B-W2a-55: the reminder ladder (record Invoice; the key's offset is the step's days from the due date).
  PAYMENT_REMINDER: "The due date of an invoice's oldest open instalment: a step of the company's reminder ladder.",
  // B-W2b-24: the restore drill's reminder (record Tenant, key RESTORE_DRILL_DUE:-14d; ops/drills): security.view is told.
  RESTORE_DRILL_DUE: 'The day the next restore drill is due (90 days after the last one that passed).',
} as const satisfies Record<string, string>
export type TimerKind = keyof typeof TIMER_KINDS

export const TIMER_STATUSES = ['PENDING', 'FIRED', 'CANCELLED'] as const
export type TimerStatus = (typeof TIMER_STATUSES)[number]

/** The key of a kind and an offset: `CERTIFICATE_EXPIRY:-30d`; no offset: the kind alone (fires on the date). */
export function timerKeyOf(kind: string, offset: TimerOffset | null = null): string {
  const key = offset === null || offset.amount === 0 ? kind : `${kind}:${offset.amount > 0 ? '+' : '-'}${Math.abs(offset.amount)}${offset.unit}`
  if (!TIMER_KEY.test(key)) throw new RangeError(`${JSON.stringify(key)} is not a timer key (KIND[:±N(m|h|d)])`)
  return key
}

/** A key's kind and offset, or null when it is not a key. */
export function parseTimerKey(key: string): { readonly kind: string; readonly offset: TimerOffset | null } | null {
  if (!TIMER_KEY.test(key)) return null
  const [kind, rest] = key.split(':') as [string, string | undefined]
  if (rest === undefined) return { kind, offset: null }
  const match = /^([+-]?)([0-9]+)([mhd])$/.exec(rest)!
  const amount = Number(match[2]) * (match[1] === '-' ? -1 : 1)
  return { kind, offset: amount === 0 ? null : { amount, unit: match[3] as TimerUnit } }
}

const UNIT_MS: Readonly<Record<TimerUnit, number>> = Object.freeze({ m: 60_000, h: 3_600_000, d: 86_400_000 })

/** When a timer fires in calendar time: the due instant moved by the offset. */
export function fireAtOf(dueAt: Date, offset: TimerOffset | null): Date {
  if (offset === null) return dueAt
  return new Date(dueAt.getTime() + offset.amount * UNIT_MS[offset.unit])
}

/** The instant a business date "is due": the start of that day in the business time zone. */
export const dueAtOf = (date: BusinessDate): Date => businessDayStart(date)

/** The business date N calendar days from a date (negative: before). */
export function plusCalendarDays(date: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

// ---- keeping a record's timers in step with its dates ---------------------------------------------------------------------

/** A timer a record should have now. */
export interface WantedTimer {
  readonly recordType: string
  readonly recordId: string
  readonly timerKey: string
  readonly dueAt: Date
  readonly fireAt: Date
}

/** A PENDING timer as stored. */
export interface PendingTimer extends WantedTimer {
  readonly id: string
}

/** Why a PENDING timer is cancelled (its cancelReason, in words). */
export const CANCEL_REASONS = {
  MOVED: 'The date it watches moved: a new timer was set.',
  GONE: 'The record no longer needs it.',
  RULE_OFF: 'The rule that asked for it was switched off.',
  RULE_CHANGED: "The rule's numbers or place changed: a new timer was set where one is still needed.",
} as const
export type CancelReason = keyof typeof CANCEL_REASONS

export interface TimerPlan {
  /** The timers to set (none PENDING for their record and key, or the one PENDING watches another date). */
  readonly set: readonly WantedTimer[]
  /** The PENDING timers to cancel, with why. */
  readonly cancel: readonly { readonly id: string; readonly reason: CancelReason }[]
  /** How many PENDING timers stay as they are. */
  readonly kept: number
}

const timerIdentity = (timer: Pick<WantedTimer, 'recordType' | 'recordId' | 'timerKey'>): string => `${timer.recordType}|${timer.recordId}|${timer.timerKey}`

const sameTime = (a: Pick<WantedTimer, 'dueAt' | 'fireAt'>, b: Pick<WantedTimer, 'dueAt' | 'fireAt'>): boolean => a.dueAt.getTime() === b.dueAt.getTime() && a.fireAt.getTime() === b.fireAt.getTime()

/**
 * What to do so the PENDING timers are exactly the wanted ones: a wanted timer whose PENDING twin watches the same date
 * and fires at the same time stays; a twin with another date or time is cancelled (MOVED) and the wanted one set; a
 * PENDING timer nobody wants any more is cancelled (`gone`, by default GONE: the record no longer needs it). A wanted
 * timer that already FIRED for the same date and time (`fired`) is done: it is never set again.
 */
export function timerPlan(wanted: readonly WantedTimer[], pending: readonly PendingTimer[], gone: CancelReason = 'GONE', fired: readonly WantedTimer[] = []): TimerPlan {
  const byIdentity = new Map(pending.map((timer) => [timerIdentity(timer), timer]))
  const done = new Map<string, WantedTimer[]>()
  for (const timer of fired) done.set(timerIdentity(timer), [...(done.get(timerIdentity(timer)) ?? []), timer])
  const set: WantedTimer[] = []
  const cancel: { id: string; reason: CancelReason }[] = []
  const wantedIds = new Set<string>()
  let kept = 0
  for (const timer of wanted) {
    const identity = timerIdentity(timer)
    if (wantedIds.has(identity)) continue
    wantedIds.add(identity)
    const twin = byIdentity.get(identity)
    if (twin && sameTime(twin, timer)) {
      kept++
      continue
    }
    if (twin) cancel.push({ id: twin.id, reason: 'MOVED' })
    if ((done.get(identity) ?? []).some((past) => sameTime(past, timer))) {
      if (!twin) kept++
      continue
    }
    set.push(timer)
  }
  for (const timer of pending) if (!wantedIds.has(timerIdentity(timer))) cancel.push({ id: timer.id, reason: gone })
  return { set, cancel, kept }
}
