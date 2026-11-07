import { parseValues, valueChanges } from '@nexus/factory-domain/people/payroll/values'
import type { Client } from '../attendance/store'
import { closeOfMonth, type Place } from '../close/store'
import { dateOf } from '../employees/access'
import { monthPeople } from './facts'
import { periodDaysOf } from './store'

/**
 * "Payroll correction pending" (B-W2b-54, B-W2b-48's gap; design people.attendance: "Correction entry with reason; 'Payroll
 * correction pending' appears on Payroll export"): a closed day's corrections the month's latest file did not carry. An export
 * marks what it carried (PayrollExport.correctionsCarried, B-W2b-89); a month not exported yet has nothing pending: its first
 * file carries them all. Corrections that move nothing on the file (a figure put back, a person left out of it) are not
 * pending: no correction export could carry them. A count, no person.
 */
export async function correctionsNotCarried(db: Client, place: Place, month: string, now: Date): Promise<number> {
  const companyId = place.company.id
  const latest = await db.payrollExport.findFirst({ where: { companyId, periodStart: dateOf(periodDaysOf(month).from), status: 'EXPORTED' }, orderBy: { revision: 'desc' }, select: { correctionsCarried: true, values: true } })
  const close = latest ? await closeOfMonth(db, companyId, month) : null
  if (!latest || !close) return 0
  const carried = new Set(latest.correctionsCarried)
  const rows = await db.attendanceCorrection.findMany({ where: { monthCloseId: close.id }, select: { id: true } })
  const left = rows.filter((row) => !carried.has(row.id)).length
  if (left === 0) return 0
  const { values } = await monthPeople(db, place, month, now)
  return valueChanges(parseValues(latest.values), values).length === 0 ? 0 : left
}
