import type { Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { EntryStatus, OvertimeClass, StoredEntry } from '@nexus/factory-domain/people/overtime/rules'
import { dateOf } from '../employees/access'
import type { Client } from '../attendance/store'

/** What overtime and timesheets read (B-W2b-42), office or system scope; every read names its columns. */

export const ENTRY_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  employeeId: true,
  date: true,
  kind: true,
  minutes: true,
  requestId: true,
  status: true,
  approvedAt: true,
  approvedById: true,
  rejectedAt: true,
  rejectedById: true,
  rejectReason: true,
  version: true,
} as const satisfies Prisma.OvertimeEntrySelect
export type EntryRow = Prisma.OvertimeEntryGetPayload<{ select: typeof ENTRY_SELECT }>

export const storedOf = (row: EntryRow): StoredEntry => ({ id: row.id, kind: row.kind as OvertimeClass, minutes: row.minutes, requestId: row.requestId, status: row.status as EntryStatus })

/** The planned request the person said yes to for that day at that site, approved by a person (else none). */
export async function plannedRequestOf(db: Client, employeeId: string, date: BusinessDate, siteId: string): Promise<string | null> {
  const row = await db.overtimeAgreement.findFirst({
    where: { employeeId, answer: 'AGREED', request: { date: dateOf(date), siteId, status: { in: ['APPROVED', 'DONE'] } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { requestId: true },
  })
  return row?.requestId ?? null
}
