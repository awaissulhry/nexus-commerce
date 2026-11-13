import { TIMESHEET_HOLD_WORDS } from '@nexus/factory-domain/people/overtime/timesheets'
import { refuse } from '../employees/access'
import type { Client } from '../attendance/store'

/**
 * Nobody approves their own timesheet (B-W2b-377; follow-up XF5:01; D.Lgs. 152/1997 art. 1-bis; Owner answer Q3 of W2b-5 =
 * A, the Owner included). A person's own office account is the Employee's `userId` OR the `userId` of a floor worker linked to
 * that employee (the people guards let one of the two name none: B-W2b-42's check read only the first, so a person linked
 * through their worker only could approve their own month, and the database's refusal came back as a 500). The routes ask
 * `isOwnTimesheet` (the lead's yes, HR's yes, a send-back, and the record's held buttons); the database is the last word
 * (B-W2b-363's trigger `TimesheetApproval_not_own`: check_violation 'timesheet: timesheet … is approved by another person than
 * its own …'), answered 409 in the same words (`approvingTimesheet`) with `refusal/HELD` + `holds/OWN_TIMESHEET`.
 */

/** Whether the office account is the person's own: their Employee row, or a floor worker linked to them, names it. */
export async function isOwnTimesheet(db: Client, employeeId: string, actorId: string): Promise<boolean> {
  const employee = await db.employee.findFirst({ where: { id: employeeId, userId: actorId }, select: { id: true } })
  if (employee) return true
  return (await db.worker.findFirst({ where: { employeeId, userId: actorId }, select: { id: true } })) !== null
}

const ownRefusal = (): never => refuse('HELD', TIMESHEET_HOLD_WORDS.OWN_TIMESHEET, undefined, [{ path: 'holds/OWN_TIMESHEET', message: TIMESHEET_HOLD_WORDS.OWN_TIMESHEET }])

/** The database's refusal of a person's own approval, as a 409 in words; anything else unchanged. */
export function ownTimesheetRefusal(error: unknown): unknown {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (cause?.originalCode === '23514' && typeof cause.originalMessage === 'string' && /^timesheet: timesheet \S+ is approved by another person than its own/.test(cause.originalMessage)) return ownRefusal()
  return error
}

/** Runs the write of a lead's or HR's yes; the database's own-timesheet refusal comes back as a 409 in words. */
export async function approvingTimesheet<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    throw ownTimesheetRefusal(error)
  }
}
