import type { Prisma } from '@nexus/factory-db'
import type { OwnColumnKind } from '@nexus/factory-domain/sales/own-columns/rules'
import { ownValueOf, type ValueFields } from '@nexus/factory-domain/sales/own-columns/rules'
import type { CommandTx } from '../../../core/command'
import type { FactoryClient } from '@nexus/factory-db'

/**
 * The rows of the customer's own columns (owb- order workflow, S1 po1.4; factory-db order-columns.prisma, owb-b1). Every column the
 * partner role reads (the three tables are party-scoped for it, nothing hidden); the office reads the same. Never a floor read.
 */

export type Reader = FactoryClient | CommandTx

export const COLUMN_SELECT = { id: true, partyId: true, name: true, kind: true, choices: true, seq: true, closedAt: true, version: true } as const satisfies Prisma.PartyLineColumnSelect
export type ColumnRow = Prisma.PartyLineColumnGetPayload<{ select: typeof COLUMN_SELECT }>

export const USE_SELECT = { id: true, companyId: true, partyId: true, salesOrderId: true, portalOrderRequestId: true, columnId: true, seq: true, version: true } as const satisfies Prisma.OrderLineColumnUseSelect
export type UseRow = Prisma.OrderLineColumnUseGetPayload<{ select: typeof USE_SELECT }>

export const VALUE_SELECT = { id: true, partyId: true, columnId: true, salesOrderLineId: true, portalOrderRequestLineId: true, valueText: true, valueNumber: true, valueDate: true, valueBool: true, version: true } as const satisfies Prisma.OrderLineOwnValueSelect
export type ValueRow = Prisma.OrderLineOwnValueGetPayload<{ select: typeof VALUE_SELECT }>

/** An own column as every answer shows it (the Shape's OwnColumn). */
export interface OwnColumnView {
  readonly id: string
  readonly name: string
  readonly kind: OwnColumnKind
  readonly choices: string[]
  readonly closed: boolean
  readonly version: number
}

/** A value as every answer shows it (the Shape's OwnValue): a NUMBER as decimal text, a DATE as 'YYYY-MM-DD'; cleared: null. */
export interface OwnValueView {
  readonly columnId: string
  readonly value: string | number | boolean | null
  readonly version: number
}

export const columnView = (row: ColumnRow): OwnColumnView => ({ id: row.id, name: row.name, kind: row.kind as OwnColumnKind, choices: [...row.choices], closed: row.closedAt !== null, version: row.version })

/** A stored value's fields (a decimal as text, a day as 'YYYY-MM-DD'; never a float). */
export const fieldsOf = (row: Pick<ValueRow, 'valueText' | 'valueNumber' | 'valueDate' | 'valueBool'>): ValueFields => ({
  valueText: row.valueText,
  valueNumber: row.valueNumber === null ? null : row.valueNumber.toString(),
  valueDate: row.valueDate === null ? null : row.valueDate.toISOString().slice(0, 10),
  valueBool: row.valueBool,
})

export const valueView = (kind: OwnColumnKind, row: ValueRow): OwnValueView => ({ columnId: row.columnId, value: ownValueOf(kind, fieldsOf(row)), version: row.version })

/** The customer's columns, open first by place, then the closed ones. */
export async function readPartyColumns(db: Reader, partyId: string): Promise<ColumnRow[]> {
  const rows = await db.partyLineColumn.findMany({ where: { partyId }, select: COLUMN_SELECT, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
  return [...rows.filter((row) => row.closedAt === null), ...rows.filter((row) => row.closedAt !== null)]
}

/** The uses of ONE record (on and switched off). */
export const readRecordUses = (db: Reader, record: { readonly requestId?: string; readonly orderId?: string }): Promise<UseRow[]> =>
  db.orderLineColumnUse.findMany({ where: record.requestId ? { portalOrderRequestId: record.requestId } : { salesOrderId: record.orderId! }, select: USE_SELECT, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })

/** The live lines of ONE record (a draft line taken out counts nowhere). */
export async function recordLineIds(db: Reader, record: { readonly requestId?: string; readonly orderId?: string }): Promise<string[]> {
  if (record.requestId) return (await db.portalOrderRequestLine.findMany({ where: { requestId: record.requestId, removedAt: null }, select: { id: true } })).map((line) => line.id)
  return (await db.salesOrderLine.findMany({ where: { orderId: record.orderId! }, select: { id: true } })).map((line) => line.id)
}

/** Serialises the customer's own-column writes (one value per column and line, one use per column and record: the API's). */
export async function lockParty(tx: CommandTx, partyId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.own-columns', ${partyId}::uuid::text), 0))`
}
