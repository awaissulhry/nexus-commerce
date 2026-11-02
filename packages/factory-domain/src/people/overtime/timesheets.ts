import { plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'

/**
 * Timesheets (B-W2b-42; MES-230 "Timesheet approval"; design people.attendance new tab "Person timesheet"), pure. One
 * TimesheetApproval per person and month: PENDING → LEAD_APPROVED → APPROVED, two different people, and nobody approves
 * their own (the DB holds the two people; "their own" is here, because it takes the person's account). The lead confirms
 * the DAYS; the hours stay with HR: the ATTENDANCE basis never covers leads (B-W2b-27), so a lead's view has each day's
 * state and no minutes, and an absence shows as absent, never with its code (GDPR art. 9). A person's timesheet is
 * approved only once its month is over, every day approved and no overtime waits for a decision.
 */

export const TIMESHEET_STATUSES = ['PENDING', 'LEAD_APPROVED', 'APPROVED'] as const
export type TimesheetStatus = (typeof TIMESHEET_STATUSES)[number]

export const TIMESHEET_STAGES = ['LEAD', 'HR', 'DONE'] as const
export type TimesheetStage = (typeof TIMESHEET_STAGES)[number]

export const TIMESHEET_CHANGES = ['LEAD_APPROVED', 'APPROVED', 'SENT_BACK'] as const
export type TimesheetChange = (typeof TIMESHEET_CHANGES)[number]

export const TIMESHEET_RULES = Object.freeze({ listLimit: 200, reasonMin: 3, reasonMax: 500 })

export const stageOf = (status: TimesheetStatus): TimesheetStage => (status === 'PENDING' ? 'LEAD' : status === 'LEAD_APPROVED' ? 'HR' : 'DONE')

/** Why a timesheet cannot be approved now. */
export const TIMESHEET_HOLDS = ['WRONG_STAGE', 'PERIOD_NOT_OVER', 'DAYS_OPEN', 'OVERTIME_PENDING', 'OWN_TIMESHEET', 'SAME_PERSON', 'MONTH_CLOSED'] as const
export type TimesheetHold = (typeof TIMESHEET_HOLDS)[number]

export const TIMESHEET_HOLD_WORDS: Readonly<Record<TimesheetHold, string>> = Object.freeze({
  WRONG_STAGE: 'This timesheet is not at this approval.',
  PERIOD_NOT_OVER: 'The period is not over yet.',
  DAYS_OPEN: 'Some days are not approved yet.',
  OVERTIME_PENDING: 'Some overtime waits for a decision.',
  OWN_TIMESHEET: 'Nobody approves their own timesheet: another person does (D.Lgs. 152/1997 art. 1-bis).',
  SAME_PERSON: 'The lead and HR are two different people: another person approves it.',
  MONTH_CLOSED: 'This month is closed: it changes only by a correction.',
})

export interface TimesheetFacts {
  readonly stage: 'LEAD' | 'HR'
  readonly status: TimesheetStatus
  readonly periodEnd: BusinessDate
  readonly today: BusinessDate
  readonly daysOpen: number
  readonly overtimePending: number
  readonly own: boolean
  /** The caller gave the lead's approval (HR is another person). */
  readonly approvedAsLead: boolean
  readonly monthClosed: boolean
}

/** What holds an approval of `stage`, in the order a person fixes them. */
export function timesheetHolds(facts: TimesheetFacts): TimesheetHold[] {
  const holds: TimesheetHold[] = []
  if (stageOf(facts.status) !== facts.stage) holds.push('WRONG_STAGE')
  if (facts.monthClosed) holds.push('MONTH_CLOSED')
  if (facts.periodEnd >= facts.today) holds.push('PERIOD_NOT_OVER')
  if (facts.daysOpen > 0) holds.push('DAYS_OPEN')
  if (facts.overtimePending > 0) holds.push('OVERTIME_PENDING')
  if (facts.own) holds.push('OWN_TIMESHEET')
  if (facts.stage === 'HR' && facts.approvedAsLead) holds.push('SAME_PERSON')
  return holds
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/

/** The first and last day of a month (`YYYY-MM`), or null. */
export function monthPeriod(month: string): { readonly periodStart: BusinessDate; readonly periodEnd: BusinessDate } | null {
  const match = MONTH.exec(month)
  if (!match) return null
  const year = Number(match[1])
  const next = Number(match[2]) === 12 ? `${year + 1}-01-01` : `${year}-${String(Number(match[2]) + 1).padStart(2, '0')}-01`
  return { periodStart: `${month}-01`, periodEnd: plusDays(next, -1) }
}

/** What a lead reads instead of the hours. */
export const LEAD_VIEW_WORDS = "You confirm the days. The hours stay with HR: the attendance basis does not open one person's hours to leads (Statuto dei Lavoratori art. 4)."

/** An approved timesheet whose days moved since (a late event, a day entered after it). */
export const CHANGED_SINCE_WORDS = 'Something in this period changed after the approval: send it back so it is approved on what stands now.'

/** Refuses reopening what an approved timesheet covers. */
export const TIMESHEET_COVERS_WORDS = 'A timesheet approved by the lead or HR covers this day: send it back first.'
