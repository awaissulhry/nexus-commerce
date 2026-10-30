import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { costingCurrency, pickOverhead, type LabourRate } from '@nexus/factory-domain/costing/inputs'
import type { CostEntryKind, LockedPeriod, StandardRef } from '@nexus/factory-domain/costing/ledger/entries'
import { standardOn, type StandardPeriod } from '@nexus/factory-domain/costing/standards/rules'
import { businessDate } from '@nexus/factory-domain/core/time'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'
import { companyOrTenant, dayOf, RATE_COLUMNS, rateOf, SETTINGS_COLUMNS } from '../inputs'

/**
 * What the work-order cost ledger reads (B-W2a-21), with one client (no relation selects: inside a transaction Prisma
 * would send them at once on its one connection): the work order and its company's currency, its entries, the frozen
 * standards of a company's items, the labour rates and overhead, the locked periods. Reads only; the writers are
 * ./post.ts and ./reverse.ts.
 */

export type Reader = FactoryClient | CommandTx

const text = (value: { toString(): string }): string => decimalText(value.toString())
export const textOrNull = (value: { toString(): string } | null): string | null => (value === null ? null : text(value))
export const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]

export const WORK_ORDER_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  status: true,
  kind: true,
  styleId: true,
  releasedAt: true,
  completedAt: true,
  createdAt: true,
} as const satisfies Prisma.WorkOrderSelect
export type WorkOrderRow = Prisma.WorkOrderGetPayload<{ select: typeof WORK_ORDER_COLUMNS }>

/** A work order as the ledger needs it, with the currency of its company (the ledger's currency). */
export interface CostedWorkOrder extends WorkOrderRow {
  readonly currency: string
}

export async function readWorkOrders(db: Reader, where: Prisma.WorkOrderWhereInput, take?: number, orderBy: Prisma.WorkOrderOrderByWithRelationInput = { id: 'desc' }): Promise<CostedWorkOrder[]> {
  const rows = await db.workOrder.findMany({ where, select: WORK_ORDER_COLUMNS, orderBy, ...(take === undefined ? {} : { take }) })
  const companies = new Map((await db.company.findMany({ where: { id: { in: unique(rows.map((row) => row.companyId)) } }, select: { id: true, currency: true } })).map((row) => [row.id, row.currency]))
  return rows.map((row) => ({ ...row, currency: costingCurrency(companies.get(row.companyId) ?? null) }))
}

export async function readWorkOrder(db: Reader, workOrderId: string): Promise<CostedWorkOrder | null> {
  return (await readWorkOrders(db, { id: workOrderId }))[0] ?? null
}

/** One work order's ledger is posted by one command at a time (a scan's handler and a catch-up never post twice). */
export async function lockWorkOrderCosts(tx: CommandTx, tenantId: string, workOrderId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.costing.work-order', ${tenantId}::uuid, ${workOrderId}::uuid), 0))`
}

export const ENTRY_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  workOrderId: true,
  kind: true,
  occurredAt: true,
  itemId: true,
  quantity: true,
  minutes: true,
  unitCost: true,
  standardUnitCost: true,
  amount: true,
  currency: true,
  costingMethod: true,
  standardCostId: true,
  stockMoveId: true,
  operationScanId: true,
  subcontractOrderId: true,
  supplierInvoiceLineId: true,
  sourceType: true,
  sourceId: true,
  reversalOfId: true,
  reason: true,
  idempotencyKey: true,
  createdAt: true,
} as const satisfies Prisma.WorkOrderCostEntrySelect
export type EntryRow = Prisma.WorkOrderCostEntryGetPayload<{ select: typeof ENTRY_COLUMNS }>

/** An entry as plain facts (decimals as text). */
export interface EntryFactsRow {
  readonly id: string
  readonly workOrderId: string
  readonly kind: CostEntryKind
  readonly occurredAt: Date
  readonly itemId: string | null
  readonly quantity: string | null
  readonly minutes: string | null
  readonly unitCost: string | null
  readonly standardUnitCost: string | null
  readonly standardCostId: string | null
  readonly amount: number
  readonly stockMoveId: string | null
  readonly operationScanId: string | null
  readonly sourceType: string | null
  readonly sourceId: string | null
  readonly reversalOfId: string | null
  readonly idempotencyKey: string
}

export const entryFacts = (row: EntryRow): EntryFactsRow => ({
  id: row.id,
  workOrderId: row.workOrderId,
  kind: row.kind,
  occurredAt: row.occurredAt,
  itemId: row.itemId,
  quantity: textOrNull(row.quantity),
  minutes: textOrNull(row.minutes),
  unitCost: textOrNull(row.unitCost),
  standardUnitCost: textOrNull(row.standardUnitCost),
  standardCostId: row.standardCostId,
  amount: row.amount,
  stockMoveId: row.stockMoveId,
  operationScanId: row.operationScanId,
  sourceType: row.sourceType,
  sourceId: row.sourceId,
  reversalOfId: row.reversalOfId,
  idempotencyKey: row.idempotencyKey,
})

export async function readEntries(db: Reader, workOrderIds: readonly string[]): Promise<EntryRow[]> {
  if (workOrderIds.length === 0) return []
  return db.workOrderCostEntry.findMany({ where: { workOrderId: { in: [...workOrderIds] } }, select: ENTRY_COLUMNS, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })
}

// ---- standards ---------------------------------------------------------------------------------------------------------

export interface FrozenStandard extends StandardPeriod {
  readonly companyId: string
  readonly itemId: string
  readonly materialCost: string
  readonly labourCost: string
  readonly subcontractCost: string
  readonly overheadCost: string
  readonly unitCost: string
}

/** The FROZEN standards of these companies' items, per company and item. */
export async function frozenStandards(db: Reader, companyIds: readonly string[], itemIds: readonly string[]): Promise<Map<string, FrozenStandard[]>> {
  const out = new Map<string, FrozenStandard[]>()
  if (companyIds.length === 0 || itemIds.length === 0) return out
  const rows = await db.standardCost.findMany({
    where: { companyId: { in: [...companyIds] }, itemId: { in: [...itemIds] }, status: 'FROZEN' },
    select: { id: true, companyId: true, itemId: true, status: true, validFrom: true, validTo: true, currency: true, materialCost: true, labourCost: true, subcontractCost: true, overheadCost: true, unitCost: true },
  })
  for (const row of rows) {
    const key = `${row.companyId}|${row.itemId}`
    const list = out.get(key) ?? []
    list.push({
      id: row.id,
      companyId: row.companyId,
      itemId: row.itemId,
      status: row.status,
      validFrom: dayOf(row.validFrom),
      validTo: row.validTo ? dayOf(row.validTo) : null,
      currency: row.currency,
      materialCost: text(row.materialCost),
      labourCost: text(row.labourCost),
      subcontractCost: text(row.subcontractCost),
      overheadCost: text(row.overheadCost),
      unitCost: text(row.unitCost),
    })
    out.set(key, list)
  }
  return out
}

/** The frozen standard of a company's item in force on a day, in the currency. */
export function standardFor(standards: ReadonlyMap<string, readonly FrozenStandard[]>, companyId: string, itemId: string | null, day: string, currency: string): FrozenStandard | null {
  if (itemId === null) return null
  return standardOn(standards.get(`${companyId}|${itemId}`) ?? [], day, currency)
}

export const standardRef = (row: FrozenStandard | null): StandardRef | null => (row ? { id: row.id, unitCost: row.unitCost } : null)

// ---- rates, overhead, locks --------------------------------------------------------------------------------------------

/** Every rate that may apply to a company (its own and the tenant-wide ones, any status: pickRate chooses). */
export async function ratesOf(db: Reader, companyId: string): Promise<LabourRate[]> {
  return (await db.labourRate.findMany({ where: companyOrTenant(companyId), select: RATE_COLUMNS, orderBy: [{ validFrom: 'asc' }, { id: 'asc' }] })).map(rateOf)
}

/** The overhead percent in force for a company now (its own settings, else the tenant-wide ones); null: none set. */
export async function overheadPctOf(db: Reader, companyId: string): Promise<string | null> {
  const rows = await db.costingSettings.findMany({ where: companyOrTenant(companyId), select: SETTINGS_COLUMNS })
  const rule = pickOverhead(
    rows.map((row) => ({ id: row.id, companyId: row.companyId, overheadPct: text(row.overheadPct), updatedAt: null })),
    companyId,
  )
  return rule?.overheadPct ?? null
}

/** The company's locked periods (HARD or SOFT, LOCKED): an event of a locked month is posted dated now. */
export async function lockedPeriods(db: Reader, companyId: string): Promise<LockedPeriod[]> {
  const rows = await db.periodLock.findMany({ where: { companyId, status: 'LOCKED' }, select: { periodStart: true, periodEnd: true } })
  return rows.map((row) => ({ periodStart: dayOf(row.periodStart), periodEnd: dayOf(row.periodEnd) }))
}

/** The Europe/Rome day of an instant. */
export const romeDay = (at: Date): string => businessDate(at)
