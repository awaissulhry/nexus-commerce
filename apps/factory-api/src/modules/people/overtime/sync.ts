import { newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { hasWork, overtimeSplit, planEntries, type EntryChange, type EntryPlan, type OvertimeClass } from '@nexus/factory-domain/people/overtime/rules'
import type { CommandTools } from '../../../core/command'
import { dateOf } from '../employees/access'
import { dayFactsOf } from '../attendance/compute'
import { dayOfPerson, monthClosed, type Client, type DayRow, type PersonRow } from '../attendance/store'
import { legalGateFor } from '../privacy/gate'
import { ENTRY_SELECT, plannedRequestOf, storedOf, type EntryRow } from './store'

/**
 * Overtime computed from attendance against the roster (B-W2b-42; MES-229): ONE place reads an attendance day and keeps its
 * OvertimeEntry rows, one per class, in step: new ones PENDING, a PENDING one recomputed, one with nothing left removed, and
 * a decided one whose figures no longer match taken back to PENDING (it is paid only on figures a person saw). A
 * computation records; it never approves anything (D.Lgs. 66/2003 art. 5: overtime is never automatic). Only at a site
 * whose ATTENDANCE gate is open, never in a closed month. Linked to the planned request the person agreed to, if any.
 */

interface DayPlan {
  readonly plan: EntryPlan
  readonly day: DayRow
  readonly stored: readonly EntryRow[]
  readonly requestId: string | null
}

/** What the day's entries need (read only: the handler asks before a command). Null: nothing may be written. */
async function dayPlanOf(db: Client, person: PersonRow, date: BusinessDate, now: Date): Promise<DayPlan | null> {
  const day = await dayOfPerson(db, person.id, date)
  if (!day || day.status === 'CLOSED') return null
  if (await monthClosed(db, person.companyId, date)) return null
  if (!(await legalGateFor(db, day.siteId, 'ATTENDANCE', now)).open) return null
  const stored = await db.overtimeEntry.findMany({ where: { employeeId: person.id, date: dateOf(date) }, select: ENTRY_SELECT })
  // The stored figures count (an approved day's are frozen); the night share comes from its stretches.
  const facts = await dayFactsOf(db, person, date, now)
  const wanted = overtimeSplit({ overtimeMinutes: day.overtimeMinutes, nightOvertimeMinutes: facts.computed.figures.nightOvertimeMinutes, holidayMinutes: day.holidayMinutes })
  const requestId = await plannedRequestOf(db, person.id, date, day.siteId)
  return { plan: planEntries(stored.map(storedOf), wanted, requestId), day, stored, requestId }
}

export async function entriesWouldChange(db: Client, person: PersonRow, date: BusinessDate, now: Date): Promise<boolean> {
  const found = await dayPlanOf(db, person, date, now)
  return found !== null && hasWork(found.plan)
}

export function emitEntry(tools: CommandTools, entry: { readonly id: string; readonly companyId: string; readonly siteId: string; readonly employeeId: string; readonly kind: OvertimeClass }, status: 'PENDING' | 'APPROVED' | 'REJECTED', change: EntryChange): void {
  tools.emit({ type: 'overtime_entry.changed', subject: entry.employeeId, companyId: entry.companyId, siteId: entry.siteId, payload: { entryId: entry.id, siteId: entry.siteId, employeeId: entry.employeeId, kind: entry.kind, status, change } })
}


/** Keeps the day's entries in step, inside the caller's command (the person's lock held). How many changed. */
export async function syncEntriesInCommand(tools: CommandTools, person: PersonRow, date: BusinessDate): Promise<number> {
  const { tx, now } = tools
  const found = await dayPlanOf(tx, person, date, now)
  if (!found || !hasWork(found.plan)) return 0
  const { plan, day, stored, requestId } = found
  const byId = new Map(stored.map((row) => [row.id, row]))
  const place = { companyId: person.companyId, siteId: day.siteId }
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  const write = { minutes: 0, requestId, siteId: day.siteId, version: { increment: 1 } }
  // A decision that no longer matches what was worked: cleared first, then the figures move while it is pending.
  for (const item of plan.takeBack) {
    const row = byId.get(item.id)!
    await tx.overtimeEntry.update({ where: { id: item.id }, data: { status: 'PENDING', approvedAt: null, approvedById: null, rejectedAt: null, rejectedById: null, rejectReason: null, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'people.takeBackOvertime', recordType: 'OvertimeEntry', recordId: item.id, ...place, before: { status: row.status, minutes: row.minutes }, after: { status: 'PENDING', minutes: item.minutes, employeeId: person.id, date }, reason: 'The attendance day changed: a person decides again.' })
    emitEntry(tools, { ...row, kind: item.kind }, 'PENDING', 'TAKEN_BACK')
    if (item.minutes === 0) {
      await tx.overtimeEntry.delete({ where: { id: item.id } })
      emitEntry(tools, { ...row, kind: item.kind }, 'PENDING', 'REMOVED')
    } else {
      await tx.overtimeEntry.update({ where: { id: item.id }, data: { ...write, minutes: item.minutes }, select: { id: true } })
    }
  }
  for (const id of plan.remove) {
    const row = byId.get(id)!
    await tx.overtimeEntry.delete({ where: { id } })
    tools.audit({ action: 'people.computeOvertimeEntry', recordType: 'OvertimeEntry', recordId: id, ...place, before: { kind: row.kind, minutes: row.minutes, employeeId: person.id, date }, after: { removed: true } })
    emitEntry(tools, { ...row, kind: row.kind as OvertimeClass }, 'PENDING', 'REMOVED')
  }
  for (const item of plan.update) {
    const row = byId.get(item.id)!
    await tx.overtimeEntry.update({ where: { id: item.id }, data: { ...write, minutes: item.minutes }, select: { id: true } })
    tools.audit({ action: 'people.computeOvertimeEntry', recordType: 'OvertimeEntry', recordId: item.id, ...place, before: { minutes: row.minutes, requestId: row.requestId }, after: { minutes: item.minutes, requestId, employeeId: person.id, date } })
    emitEntry(tools, { ...row, kind: item.kind }, 'PENDING', 'COMPUTED')
  }
  for (const item of plan.create) {
    const id = newId()
    await tx.overtimeEntry.create({ data: { id, ...place, employeeId: person.id, date: dateOf(date), kind: item.kind, minutes: item.minutes, requestId, status: 'PENDING', createdById: actorId }, select: { id: true } })
    tools.audit({ action: 'people.computeOvertimeEntry', recordType: 'OvertimeEntry', recordId: id, ...place, after: { kind: item.kind, minutes: item.minutes, requestId, employeeId: person.id, date } })
    emitEntry(tools, { id, ...place, employeeId: person.id, kind: item.kind }, 'PENDING', 'COMPUTED')
  }
  return plan.create.length + plan.update.length + plan.remove.length + plan.takeBack.length
}
