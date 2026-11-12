import type { Prisma } from '@nexus/factory-db'
import { businessDayStart, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { PlanFields } from '@nexus/factory-domain/planning/actions/protect'
import { sizesOf } from '@nexus/factory-domain/planning/planned-orders/rules'
import type { PlannedRow } from '../planned-orders/store'
import { dayOf } from '../store'

/**
 * A planned work order's protectable fields as one value each (B-W2b-306; PLN-076), and back to columns: the run's pass
 * (../planned-orders/pass), the edits and Reset to plan (./edit) read and write them the same way.
 */

/** When a workshop's kit leaves on a day: 08:00 at the site (B-W2b-293's rule). */
export const KIT_HOUR_MS = 8 * 60 * 60 * 1000
export const kitAtFor = (timezone: string) => (day: BusinessDate): string => new Date(businessDayStart(day, timezone).getTime() + KIT_HOUR_MS).toISOString()

export const fieldsOfRow = (row: Pick<PlannedRow, 'sizes' | 'startDate' | 'dueDate' | 'lineId' | 'partyId' | 'operationSeqs' | 'kitDueAt' | 'styleRevisionId'>): PlanFields => ({
  sizes: sizesOf(row.sizes),
  startDate: dayOf(row.startDate),
  dueDate: dayOf(row.dueDate),
  lineId: row.lineId,
  partyId: row.partyId,
  operationSeqs: [...row.operationSeqs],
  kitDueAt: row.kitDueAt ? row.kitDueAt.toISOString() : null,
  styleRevisionId: row.styleRevisionId,
})

const day = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)

/** The columns of the values (quantity = the size run's sum, as the database checks). */
export const columnsOf = (fields: PlanFields) => ({
  sizes: fields.sizes.map((row) => ({ size: row.size, quantity: row.quantity })) as unknown as Prisma.InputJsonValue,
  quantity: fields.sizes.reduce((sum, row) => sum + row.quantity, 0),
  startDate: day(fields.startDate),
  dueDate: day(fields.dueDate),
  lineId: fields.lineId,
  partyId: fields.partyId,
  operationSeqs: [...fields.operationSeqs],
  kitDueAt: fields.kitDueAt === null ? null : new Date(fields.kitDueAt),
  styleRevisionId: fields.styleRevisionId,
})
