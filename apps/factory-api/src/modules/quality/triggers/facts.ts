import { Decimal } from 'decimal.js'
import type { Prisma } from '@nexus/factory-db'
import type { ChipFacts } from '@nexus/factory-domain/quality/plans/rules'
import { occurrencesOf, type ScanFact, type ScanOccurrence } from '@nexus/factory-domain/quality/triggers/rules'
import { dimensionOf, type Uom } from '@nexus/factory-domain/product/units/units'
import { customersOf } from '../aql/chain'
import type { Db } from './store'

/**
 * What a rule is judged on (B-W2b-101): the subject an event is about, with its chip facts (chipsMatch: style, category,
 * material, supplier, operation, customer) and what the record needs to open. Read as the caller (the worker's system
 * scope; the office for the preview and the pick). One subject per lot received, per workshop receipt, per bundle at an
 * operation (its first scan there).
 *
 *   a supplier's lot     MATERIAL its item, CATEGORY the item's kind, SUPPLIER the lot's supplier; its size in the units
 *                        the decision counts: hides (HIDE) when it has hides, else what the receipt moved in, in its unit
 *   a workshop receipt   STYLE and CATEGORY of the work order's style, SUPPLIER the workshop, OPERATION the operations it
 *                        did, CUSTOMER the work order's customers; its size: the pieces back, good and defective (PCS)
 *   a bundle             STYLE, CATEGORY, OPERATION (the work order operation's library operation), CUSTOMER; its place
 *                        among the bundles of its work order at the operation; the kind of the operation's work centre
 *                        (B-W2b-213: a PACKING rule follows the reports at a PACKING work centre only)
 */

export type Subject = LotSubject | WorkshopSubject | BundleSubject

interface SubjectBase {
  readonly key: string
  readonly companyId: string
  readonly siteId: string
  /** In words, for the audit trail ("Lot LA-000123 (LEA-100)", "WO-0001 · SEW · bundle BN-0004"). */
  readonly label: string
  readonly styleId: string | null
  readonly customerIds: readonly string[]
  readonly facts: ChipFacts
}

export interface LotSubject extends SubjectBase {
  readonly type: 'LOT'
  readonly lotId: string
  readonly itemId: string
  /** Decimal text; above 0 (a lot with nothing in it is left out). */
  readonly lotSize: string
  readonly uom: Uom
  /** Counted in units (hides, rolls, pieces): an AQL sample can be drawn. */
  readonly countable: boolean
}

export interface WorkshopSubject extends SubjectBase {
  readonly type: 'WORKSHOP'
  readonly subcontractReceiptId: string
  readonly workOrderId: string
  readonly lotSize: string
  readonly uom: 'PCS'
  readonly countable: true
}

export interface BundleSubject extends SubjectBase {
  readonly type: 'BUNDLE'
  readonly workOrderId: string
  readonly workOrderOperationId: string
  readonly bundleId: string
  readonly lineId: string | null
  readonly bundleQuantity: number
  /** B-W2b-213: the kind of the operation's work centre (CUTTING … PACKING). */
  readonly workCentreKind: string
  readonly occurrence: ScanOccurrence
  /** Other bundles with any scan at the operation now (a first piece held after them would stop work in hand). */
  readonly othersAtOperation: number
}

type ScanKind = Prisma.OperationScanCreateInput['kind']
const countable = (uom: Uom): boolean => ['COUNT', 'ITEM'].includes(dimensionOf(uom))

// ---- lots received -----------------------------------------------------------------------------------------------------

/** The lots (not rejected), each with its facts and size. */
export async function lotSubjects(db: Db, lotIds: readonly string[]): Promise<LotSubject[]> {
  if (lotIds.length === 0) return []
  const lots = await db.lot.findMany({ where: { id: { in: [...lotIds] }, qualityStatus: { not: 'REJECTED' } }, select: { id: true, code: true, companyId: true, siteId: true, itemId: true, supplierId: true }, orderBy: { code: 'asc' } })
  if (lots.length === 0) return []
  const ids = lots.map((lot) => lot.id)
  const items = new Map((await db.item.findMany({ where: { id: { in: [...new Set(lots.map((lot) => lot.itemId))] } }, select: { id: true, code: true, kind: true } })).map((item) => [item.id, item] as const))
  const hides = new Map((await db.hide.groupBy({ by: ['lotId'], where: { lotId: { in: ids } }, _count: { _all: true } })).map((row) => [row.lotId, row._count._all] as const))
  const moves = await db.stockMove.findMany({ where: { lotId: { in: ids }, reason: 'RECEIPT', hideId: null, reversalOfId: null }, select: { lotId: true, quantity: true, uom: true }, orderBy: { id: 'asc' } })
  const found: LotSubject[] = []
  for (const lot of lots) {
    const item = items.get(lot.itemId)
    const hideCount = hides.get(lot.id) ?? 0
    const mine = moves.filter((move) => move.lotId === lot.id)
    const uom = (hideCount > 0 ? 'HIDE' : (mine[0]?.uom ?? 'PCS')) as Uom
    const size = hideCount > 0 ? new Decimal(hideCount) : mine.filter((move) => move.uom === uom).reduce((sum, move) => sum.plus(move.quantity.toString()), new Decimal(0))
    if (size.lte(0)) continue
    found.push({
      type: 'LOT',
      key: `lot:${lot.id}`,
      companyId: lot.companyId,
      siteId: lot.siteId,
      label: `Lot ${lot.code}${item ? ` (${item.code})` : ''}`,
      lotId: lot.id,
      itemId: lot.itemId,
      lotSize: size.toFixed(4),
      uom,
      countable: countable(uom),
      styleId: null,
      customerIds: [],
      facts: { MATERIAL: [lot.itemId], CATEGORY: item ? [item.kind] : [], SUPPLIER: lot.supplierId ? [lot.supplierId] : [] },
    })
  }
  return found
}

// ---- a workshop's receipt ------------------------------------------------------------------------------------------------

interface WorkOrderFacts {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly number: string
  readonly lineId: string | null
  readonly styleId: string
  readonly productType: string | null
  readonly customerIds: readonly string[]
}

export async function workOrderFacts(db: Db, workOrderIds: readonly string[]): Promise<Map<string, WorkOrderFacts>> {
  const ids = [...new Set(workOrderIds)]
  if (ids.length === 0) return new Map()
  const orders = await db.workOrder.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, siteId: true, number: true, lineId: true, styleId: true } })
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(orders.map((order) => order.styleId))] } }, select: { id: true, productType: true } })).map((style) => [style.id, style.productType as string] as const))
  const found = new Map<string, WorkOrderFacts>()
  for (const order of orders) found.set(order.id, { ...order, productType: styles.get(order.styleId) ?? null, customerIds: await customersOf(db, order.id) })
  return found
}

/** The receipt of goods back from a workshop; null when only material came back (no pieces to inspect). */
export async function workshopSubject(db: Db, receiptId: string): Promise<WorkshopSubject | null> {
  const receipt = await db.subcontractReceipt.findUnique({ where: { id: receiptId }, select: { id: true, siteId: true, workOrderId: true, subcontractOrderId: true, seq: true } })
  if (!receipt) return null
  const order = await db.subcontractOrder.findUnique({ where: { id: receipt.subcontractOrderId }, select: { companyId: true, partyId: true, number: true } })
  const lines = await db.subcontractReceiptLine.findMany({ where: { receiptId: receipt.id }, select: { goodQuantity: true, defectiveQuantity: true, subcontractOperationId: true } })
  const pieces = lines.reduce((sum, line) => sum + line.goodQuantity + line.defectiveQuantity, 0)
  if (!order || pieces === 0) return null
  const steps = await db.subcontractOperation.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.subcontractOperationId))] } }, select: { workOrderOperationId: true } })
  const operations = await db.workOrderOperation.findMany({ where: { id: { in: steps.map((step) => step.workOrderOperationId) } }, select: { operationId: true } })
  const work = (await workOrderFacts(db, [receipt.workOrderId])).get(receipt.workOrderId)
  if (!work) return null
  return {
    type: 'WORKSHOP',
    key: `receipt:${receipt.id}`,
    companyId: order.companyId,
    siteId: receipt.siteId,
    label: `${work.number}: goods back from ${order.number} (receipt ${receipt.seq})`,
    subcontractReceiptId: receipt.id,
    workOrderId: receipt.workOrderId,
    lotSize: new Decimal(pieces).toFixed(4),
    uom: 'PCS',
    countable: true,
    styleId: work.styleId,
    customerIds: work.customerIds,
    facts: {
      STYLE: [work.styleId],
      CATEGORY: work.productType ? [work.productType] : [],
      SUPPLIER: [order.partyId],
      OPERATION: operations.flatMap((operation) => (operation.operationId ? [operation.operationId] : [])),
      CUSTOMER: [...work.customerIds],
    },
  }
}

// ---- a bundle at an operation ----------------------------------------------------------------------------------------------

const SCAN_SELECT = { id: true, workOrderId: true, workOrderOperationId: true, bundleId: true, kind: true, serverTime: true } as const
type ScanRow = { id: string; workOrderId: string; workOrderOperationId: string; bundleId: string; kind: string; serverTime: Date }
const factOf = (scan: ScanRow): ScanFact => ({ id: scan.id, workOrderId: scan.workOrderId, workOrderOperationId: scan.workOrderOperationId, bundleId: scan.bundleId, kind: scan.kind, at: scan.serverTime })
/** Scans that are not work at the operation (an undo, a correction). */
const NOT_WORK = new Set(['UNDO', 'CORRECTION'])

interface BundleBits {
  readonly operations: ReadonlyMap<string, { readonly code: string; readonly operationId: string | null; readonly workCentre: { readonly kind: string } }>
  readonly bundles: ReadonlyMap<string, { readonly code: string; readonly quantity: number }>
  readonly orders: ReadonlyMap<string, WorkOrderFacts>
}

async function bundleBits(db: Db, occurrences: readonly ScanOccurrence[]): Promise<BundleBits> {
  const operations = new Map((await db.workOrderOperation.findMany({ where: { id: { in: [...new Set(occurrences.map((o) => o.workOrderOperationId))] } }, select: { id: true, code: true, operationId: true, workCentre: { select: { kind: true } } } })).map((row) => [row.id, row] as const))
  const bundles = new Map((await db.bundle.findMany({ where: { id: { in: [...new Set(occurrences.map((o) => o.bundleId))] } }, select: { id: true, code: true, quantity: true } })).map((row) => [row.id, row] as const))
  return { operations, bundles, orders: await workOrderFacts(db, occurrences.map((o) => o.workOrderId)) }
}

function bundleSubjectOf(occurrence: ScanOccurrence, bits: BundleBits, others: number): BundleSubject | null {
  const work = bits.orders.get(occurrence.workOrderId)
  const operation = bits.operations.get(occurrence.workOrderOperationId)
  const bundle = bits.bundles.get(occurrence.bundleId)
  if (!work || !operation || !bundle) return null
  return {
    type: 'BUNDLE',
    key: `bundle:${occurrence.bundleId}:${occurrence.workOrderOperationId}`,
    companyId: work.companyId,
    siteId: work.siteId,
    label: `${work.number} · ${operation.code} · bundle ${bundle.code}`,
    workOrderId: work.id,
    workOrderOperationId: occurrence.workOrderOperationId,
    bundleId: occurrence.bundleId,
    lineId: work.lineId,
    bundleQuantity: bundle.quantity,
    workCentreKind: operation.workCentre.kind,
    occurrence,
    othersAtOperation: others,
    styleId: work.styleId,
    customerIds: work.customerIds,
    facts: { STYLE: [work.styleId], CATEGORY: work.productType ? [work.productType] : [], OPERATION: operation.operationId ? [operation.operationId] : [], CUSTOMER: [...work.customerIds] },
  }
}

/** The bundle a scan is about, when the scan is the bundle's first of `kinds` at its operation; else null. */
export async function bundleSubject(db: Db, scanId: string, kinds: readonly string[]): Promise<BundleSubject | null> {
  const scan = await db.operationScan.findUnique({ where: { id: scanId }, select: SCAN_SELECT })
  if (!scan || !kinds.includes(scan.kind)) return null
  const group = await db.operationScan.findMany({ where: { workOrderId: scan.workOrderId, workOrderOperationId: scan.workOrderOperationId }, select: SCAN_SELECT })
  const occurrence = occurrencesOf(group.map(factOf), kinds).find((entry) => entry.scanId === scan.id)
  if (!occurrence) return null
  const others = new Set(group.filter((row) => row.bundleId !== scan.bundleId && !NOT_WORK.has(row.kind)).map((row) => row.bundleId)).size
  return bundleSubjectOf(occurrence, await bundleBits(db, [occurrence]), others)
}

/**
 * Every bundle's first scan of `kinds` at an operation of the company's work orders between `from` and `to` (the preview),
 * at most `limit` (then `truncated`). The places count every scan of those operations, also before `from`.
 */
export async function bundleSubjectsBetween(db: Db, companyId: string, from: Date, to: Date, kinds: readonly string[], limit: number): Promise<{ subjects: BundleSubject[]; truncated: boolean }> {
  const touched = await db.operationScan.findMany({ where: { serverTime: { gte: from, lt: to }, kind: { in: [...kinds] as ScanKind[] }, workOrder: { companyId } }, select: { workOrderId: true }, distinct: ['workOrderId'] })
  if (touched.length === 0) return { subjects: [], truncated: false }
  const scans = await db.operationScan.findMany({ where: { workOrderId: { in: touched.map((row) => row.workOrderId) }, kind: { in: [...kinds] as ScanKind[] }, serverTime: { lt: to } }, select: SCAN_SELECT, take: limit + 1 })
  const truncated = scans.length > limit
  const inWindow = occurrencesOf(scans.slice(0, limit).map(factOf), kinds).filter((entry) => {
    const at = entry.at instanceof Date ? entry.at : new Date(entry.at)
    return at >= from && at < to
  })
  const bits = await bundleBits(db, inWindow)
  return { subjects: inWindow.flatMap((entry) => bundleSubjectOf(entry, bits, 0) ?? []), truncated }
}

/** The supplier lots received and the workshop receipts of the company between `from` and `to` (the preview). */
export async function receiptSubjectsBetween(db: Db, companyId: string, from: Date, to: Date, limit: number): Promise<{ subjects: (LotSubject | WorkshopSubject)[]; truncated: boolean }> {
  const lots = await db.lot.findMany({ where: { companyId, receiptLineId: { not: null }, receivedAt: { gte: from, lt: to } }, select: { id: true }, orderBy: { receivedAt: 'asc' }, take: limit + 1 })
  const receipts = await db.subcontractReceipt.findMany({ where: { receivedAt: { gte: from, lt: to }, subcontractOrder: { companyId } }, select: { id: true }, orderBy: { receivedAt: 'asc' }, take: limit + 1 })
  const subjects: (LotSubject | WorkshopSubject)[] = await lotSubjects(db, lots.slice(0, limit).map((lot) => lot.id))
  for (const receipt of receipts.slice(0, limit)) {
    const subject = await workshopSubject(db, receipt.id)
    if (subject) subjects.push(subject)
  }
  return { subjects, truncated: lots.length > limit || receipts.length > limit }
}
