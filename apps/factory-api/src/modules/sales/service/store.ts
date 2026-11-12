import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { buyerOfParty, coverStateOf, isFinal, SERVICE_CASE_RECORD, statusWords, summaryOf, warrantyCheckOf, type BuyerKind, type CaseStatus, type Cover, type WarrantyCheck } from '@nexus/factory-domain/sales/service/rules'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { StaleVersionError, type CommandTools, type CommandTx } from '../../../core/command'

/**
 * The reads and the one row write of a service case (B-W2b-345): its row, our garment its serial names (style, colourway,
 * size, made on, its work order's batch, the shipment it left on and when it was delivered), the batch it names (the work
 * order and its deliveries to the customer), the rows the list and the record show, and the version bump every change
 * takes. Every read names its columns and runs one after another on the client it is given (a command's transaction or a
 * scoped client: row-level security decides what it finds). Office people by id, their names in `people`; no worker's
 * name; no amount anywhere.
 */

export type Reader = FactoryClient | CommandTx

export const CASE_COLUMNS = {
  id: true,
  companyId: true,
  number: true,
  kind: true,
  channel: true,
  partyId: true,
  contactId: true,
  serial: true,
  garmentSerial: true,
  batchNumber: true,
  garmentBatch: true,
  styleId: true,
  colourwayId: true,
  size: true,
  problem: true,
  customerWants: true,
  priority: true,
  status: true,
  deliveredOn: true,
  legalGuaranteeEndsOn: true,
  factoryGuaranteeEndsOn: true,
  cover: true,
  coverDecision: true,
  coverNote: true,
  coverDecidedAt: true,
  coverDecidedById: true,
  notifyCustomer: true,
  ownerId: true,
  resolvedAt: true,
  resolution: true,
  closedAt: true,
  closedById: true,
  closeReason: true,
  internalNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.ServiceCaseSelect

export type CaseRow = Prisma.ServiceCaseGetPayload<{ select: typeof CASE_COLUMNS }>

export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dayOrNull = (value: Date | null): BusinessDate | null => (value ? dayOf(value) : null)
export const asDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
export const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

export async function readCase(db: Reader, caseId: string): Promise<CaseRow | null> {
  return db.serviceCase.findUnique({ where: { id: caseId }, select: CASE_COLUMNS })
}

/** command()'s record guard by hand: the case's row FOR UPDATE, not closed, at the version the caller read. */
export async function lockCase(tools: Pick<CommandTools, 'tx'>, caseId: string, expectedVersion: number | undefined, options: { readonly closedToo?: boolean } = {}): Promise<CaseRow> {
  const [locked] = await tools.tx.$queryRaw<{ version: number; status: CaseStatus; number: string }[]>`SELECT "version", "status"::text AS "status", "number" FROM "ServiceCase" WHERE "id" = ${caseId}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Service case not found.')
  if (!options.closedToo && isFinal(locked.status)) throw new InvalidStateError(`Case ${locked.number} is ${statusWords(locked.status)}: it changes no more (open a new case).`)
  if (expectedVersion !== undefined && locked.version !== expectedVersion) throw new StaleVersionError(SERVICE_CASE_RECORD, caseId, locked.version, expectedVersion)
  return (await readCase(tools.tx, caseId))!
}

/** Writes the case with its version moved on (every change of it, its links included). */
export async function touchCase(tools: Pick<CommandTools, 'tx' | 'now'>, row: Pick<CaseRow, 'id'>, data: Prisma.ServiceCaseUncheckedUpdateInput = {}): Promise<CaseRow> {
  return tools.tx.serviceCase.update({ where: { id: row.id }, data: { ...data, updatedAt: tools.now, version: { increment: 1 } }, select: CASE_COLUMNS })
}

export async function peopleOf(db: Reader, ids: readonly (string | null | undefined)[]): Promise<{ id: string; name: string }[]> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return []
  return (await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true }, orderBy: { id: 'asc' } })).map((row) => ({ id: row.id, name: row.displayName }))
}

// ---- our garment and our batch ----------------------------------------------------------------------------------------

/** Only a shipment that left with the garment counts (a DRAFT or PACKED one may still change). */
const LEFT = new Set(['SHIPPED', 'DELIVERED', 'RETURNED'])

export interface Delivery {
  readonly shipmentId: string
  readonly number: string
  readonly partyId: string
  readonly companyId: string
  readonly salesOrderId: string
  /** The day it was delivered (from the carrier), else the day it left; `delivered` says which. */
  readonly day: BusinessDate | null
  readonly delivered: boolean
}

const deliveryOf = (shipment: { id: string; number: string; partyId: string; companyId: string; salesOrderId: string; shippedAt: Date | null; deliveredAt: Date | null }): Delivery => ({
  shipmentId: shipment.id,
  number: shipment.number,
  partyId: shipment.partyId,
  companyId: shipment.companyId,
  salesOrderId: shipment.salesOrderId,
  day: shipment.deliveredAt ? businessDate(shipment.deliveredAt) : shipment.shippedAt ? businessDate(shipment.shippedAt) : null,
  delivered: shipment.deliveredAt !== null,
})

const SHIPMENT_FACTS = { id: true, number: true, partyId: true, companyId: true, salesOrderId: true, status: true, shippedAt: true, deliveredAt: true } as const

/** Our garment with this serial (as read from its label): its style, colourway, size, batch, customer, the shipment it left on. */
export interface GarmentFacts {
  readonly serial: string
  readonly companyId: string
  readonly styleId: string
  readonly colourwayId: string
  readonly size: string
  /** The customer its order line is for (null: made for stock or a sample). */
  readonly partyId: string | null
  readonly salesOrderLineId: string | null
  readonly salesOrderId: string | null
  readonly madeOn: BusinessDate
  readonly workOrderId: string
  readonly workOrderNumber: string
  readonly batchNumber: string | null
  readonly shipment: (Delivery & { readonly salesOrderLineId: string; readonly size: string }) | null
}

export async function garmentOf(db: Reader, serial: string | null | undefined): Promise<GarmentFacts | null> {
  const wanted = (serial ?? '').trim()
  if (wanted === '') return null
  const row = await db.garmentSerial.findFirst({
    where: { serial: wanted },
    select: {
      serial: true,
      createdAt: true,
      workOrderSize: { select: { styleId: true, colourwayId: true, size: true, partyId: true, salesOrderLineId: true, salesOrderLine: { select: { orderId: true } }, workOrder: { select: { id: true, number: true, batchNumber: true, companyId: true } } } },
      shipmentLine: { select: { salesOrderLineId: true, size: true, shipment: { select: SHIPMENT_FACTS } } },
    },
  })
  if (!row) return null
  const cell = row.workOrderSize
  const line = row.shipmentLine
  const shipment = line && LEFT.has(line.shipment.status) ? { ...deliveryOf(line.shipment), salesOrderLineId: line.salesOrderLineId, size: line.size } : null
  return {
    serial: row.serial,
    companyId: cell.workOrder.companyId,
    styleId: cell.styleId,
    colourwayId: cell.colourwayId,
    size: cell.size,
    partyId: cell.partyId,
    salesOrderLineId: cell.salesOrderLineId,
    salesOrderId: cell.salesOrderLine?.orderId ?? null,
    madeOn: businessDate(row.createdAt),
    workOrderId: cell.workOrder.id,
    workOrderNumber: cell.workOrder.number,
    batchNumber: cell.workOrder.batchNumber,
    shipment,
  }
}

/** Our batch with this number (the work order that made it) and its deliveries (to the customer, when one is named). */
export interface BatchFacts {
  readonly batchNumber: string
  readonly companyId: string
  readonly styleId: string
  readonly workOrderId: string
  readonly workOrderNumber: string
  readonly deliveries: readonly Delivery[]
}

export async function batchOf(db: Reader, batchNumber: string | null | undefined, partyId: string | null): Promise<BatchFacts | null> {
  const wanted = (batchNumber ?? '').trim()
  if (wanted === '') return null
  const order = await db.workOrder.findFirst({ where: { batchNumber: wanted }, select: { id: true, number: true, companyId: true, styleId: true, batchNumber: true } })
  if (!order) return null
  const lines = await db.shipmentLine.findMany({
    where: { workOrderId: order.id, ...(partyId ? { partyId } : {}), shipment: { status: { in: [...LEFT] as ('SHIPPED' | 'DELIVERED' | 'RETURNED')[] } } },
    select: { shipment: { select: SHIPMENT_FACTS } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 200,
  })
  const seen = new Map<string, Delivery>()
  for (const line of lines) if (!seen.has(line.shipment.id)) seen.set(line.shipment.id, deliveryOf(line.shipment))
  return { batchNumber: wanted, companyId: order.companyId, styleId: order.styleId, workOrderId: order.id, workOrderNumber: order.number, deliveries: [...seen.values()] }
}

/** The delivery day the facts give: the serial's shipment, else the batch's only delivery day (several: the office types it). */
export function deliveredOnOf(garment: GarmentFacts | null, batch: BatchFacts | null): { day: BusinessDate | null; delivered: boolean; from: 'SERIAL' | 'BATCH' | null; days: BusinessDate[] } {
  if (garment?.shipment?.day) return { day: garment.shipment.day, delivered: garment.shipment.delivered, from: 'SERIAL', days: [garment.shipment.day] }
  const days = [...new Set((batch?.deliveries ?? []).map((delivery) => delivery.day).filter((day): day is BusinessDate => day !== null))].sort()
  if (days.length === 1) return { day: days[0]!, delivered: batch!.deliveries.every((delivery) => delivery.delivered), from: 'BATCH', days }
  return { day: null, delivered: false, from: null, days }
}

export async function partyOf(db: Reader, partyId: string | null): Promise<{ id: string; code: string; legalName: string; kind: string; language: string; companyId: string | null; roles: string[]; status: string } | null> {
  if (!partyId) return null
  return db.party.findUnique({ where: { id: partyId }, select: { id: true, code: true, legalName: true, kind: true, language: true, companyId: true, roles: true, status: true } })
}

/** What the screens show of our garment and batch (no amount; the customer by id). */
export function garmentSummary(plan: { readonly garment: GarmentFacts | null; readonly batch: BatchFacts | null }) {
  const g = plan.garment
  const b = plan.batch
  return {
    serial: g
      ? {
          serial: g.serial,
          madeOn: g.madeOn,
          workOrderNumber: g.workOrderNumber,
          batchNumber: g.batchNumber,
          madeForPartyId: g.partyId,
          salesOrderId: g.salesOrderId,
          shipment: g.shipment ? { id: g.shipment.shipmentId, number: g.shipment.number, partyId: g.shipment.partyId, day: g.shipment.day, delivered: g.shipment.delivered } : null,
        }
      : null,
    batch: b ? { batchNumber: b.batchNumber, workOrderNumber: b.workOrderNumber, deliveries: b.deliveries.map((delivery) => ({ id: delivery.shipmentId, number: delivery.number, partyId: delivery.partyId, day: delivery.day, delivered: delivery.delivered })) } : null,
  }
}

// ---- the rows the list and the record show ----------------------------------------------------------------------------

const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]
const byId = <T extends { id: string }>(list: readonly T[]) => new Map(list.map((row) => [row.id, row]))

/** What every row of a page names, read once per page. */
export async function rowFacts(db: Reader, rows: readonly CaseRow[]) {
  const partyIds = unique(rows.map((row) => row.partyId))
  const parties = partyIds.length ? await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true, kind: true } }) : []
  const styleIds = unique(rows.map((row) => row.styleId))
  const styles = styleIds.length ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } }) : []
  const ids = rows.map((row) => row.id)
  const counts = ids.length ? await db.serviceCaseLink.groupBy({ by: ['caseId'], where: { caseId: { in: ids } }, _count: { _all: true } }) : []
  return { partyOf: byId(parties), styleOf: byId(styles), linksOf: new Map(counts.map((entry) => [entry.caseId, entry._count._all])) }
}

export type RowFacts = Awaited<ReturnType<typeof rowFacts>>

/** The warranty check of a row as it stands (its days; the buyer from its customer). */
export function checkOfRow(row: Pick<CaseRow, 'deliveredOn' | 'legalGuaranteeEndsOn' | 'factoryGuaranteeEndsOn'>, buyer: BuyerKind, today: BusinessDate): WarrantyCheck {
  return warrantyCheckOf({ today, buyer, deliveredOn: dayOrNull(row.deliveredOn), legalGuaranteeEndsOn: dayOrNull(row.legalGuaranteeEndsOn), factoryGuaranteeEndsOn: dayOrNull(row.factoryGuaranteeEndsOn) })
}

/** One list row (contract caseRow). */
export function rowView(row: CaseRow, facts: RowFacts, today: BusinessDate) {
  const party = row.partyId ? facts.partyOf.get(row.partyId) : undefined
  const style = row.styleId ? facts.styleOf.get(row.styleId) : undefined
  const check = checkOfRow(row, buyerOfParty(party ?? null), today)
  return {
    id: row.id,
    number: row.number,
    companyId: row.companyId,
    kind: row.kind,
    channel: row.channel,
    status: row.status,
    priority: row.priority,
    party: party ? { id: party.id, code: party.code, legalName: party.legalName } : null,
    serial: row.serial,
    garmentSerial: row.garmentSerial,
    batchNumber: row.batchNumber,
    garmentBatch: row.garmentBatch,
    style: style ? { id: style.id, code: style.code, name: style.name } : null,
    size: row.size,
    customerWants: row.customerWants,
    /** The Cover column: the decided cover, else what the check points to. */
    cover: { state: coverStateOf(row.cover as Cover | null, check), decided: row.coverDecision !== null, decision: row.coverDecision },
    openedAt: toUtcIso(row.createdAt),
    ownerId: row.ownerId,
    notifyCustomer: row.notifyCustomer,
    links: facts.linksOf.get(row.id) ?? 0,
    summary: summaryOf(row.problem),
    version: row.version,
  }
}

export type CaseRowView = ReturnType<typeof rowView>
