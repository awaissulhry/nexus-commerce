import { toUtcIso } from '@nexus/factory-domain/core/time'
import { finishBlockers, finishedCell, type FinishedCell } from '@nexus/factory-domain/production/completion/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'
import { defaultPlaceOf, finishedPlaces, PRODUCTION_RECEIPT, readSkus, skuKey, type FinishedPlace, type Reader, type SkuRow } from '../../inventory/finished/post'
import { LEDGER_SELECT, type LedgerRow } from '../../inventory/ledger/post-moves'
import { releasedPerCell } from '../../quality/final/store'
import { cellLabel, readCells, type CellRow, type Header } from '../work-orders/store'

/**
 * What "Report finished to stock" reads about a work order (B-W2a-12; GAP-003, MES-011), with one reader: a scoped client
 * for the pop-up, the report's transaction (under its locks) for the report. One query after another (a transaction's
 * client has one connection). Every read names its columns.
 *
 *   per cell   its quantity; garments quality released and reversed (B-W1-45's releases); on shipments that are not
 *              CANCELLED; released serials of it under an ACTIVE quality hold, unpacked; in finished goods from this work
 *              order (its SKU's PRODUCTION_RECEIPT moves less their reversals), and its SKU and FINISHED item
 *   the order  its ACTIVE quality holds (wave 6; reason codes), its site's finished-goods places
 *   reports    each report to stock (the moves one command posted: their keys share `production.finish:<key>`), its
 *              cells, and whether it was taken back
 */

export interface StyleFacts {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly companyId: string | null
  readonly garmentTracking: 'BATCH' | 'SERIAL'
}

export interface CompletionFacts {
  readonly workOrder: Header
  readonly style: StyleFacts
  readonly site: { readonly id: string; readonly code: string }
  readonly cells: readonly CellRow[]
  readonly skus: ReadonlyMap<string, SkuRow>
  readonly figures: readonly FinishedCell[]
  readonly qualityHolds: readonly string[]
  readonly places: readonly FinishedPlace[]
  readonly blockers: readonly string[]
  readonly moves: readonly LedgerRow[]
}

const sumBy = <Row>(rows: readonly Row[], key: (row: Row) => string, value: (row: Row) => number): Map<string, number> => {
  const sums = new Map<string, number>()
  for (const row of rows) sums.set(key(row), (sums.get(key(row)) ?? 0) + value(row))
  return sums
}

/** The work order's PRODUCTION_RECEIPT moves and their reversals, oldest first. */
export async function readReceiptMoves(db: Reader, workOrderId: string): Promise<LedgerRow[]> {
  return db.stockMove.findMany({ where: { workOrderId, reason: PRODUCTION_RECEIPT }, select: LEDGER_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
}

export async function readCompletionFacts(db: Reader, workOrder: Header): Promise<CompletionFacts> {
  const style = (await db.style.findUniqueOrThrow({ where: { id: workOrder.styleId }, select: { id: true, code: true, name: true, companyId: true, sizes: true, garmentTracking: true } })) as StyleFacts & { sizes: string[] }
  const site = await db.site.findUniqueOrThrow({ where: { id: workOrder.siteId }, select: { id: true, code: true } })
  const cells = await readCells(db, workOrder.id, style.sizes)
  const cellIds = cells.map((cell) => cell.id)
  const skus = await readSkus(db, style.id, cells)
  const released = await releasedPerCell(db, cellIds)
  const lines = cellIds.length > 0 ? await db.shipmentLine.findMany({ where: { workOrderSizeId: { in: cellIds }, shipment: { status: { not: 'CANCELLED' } } }, select: { workOrderSizeId: true, quantity: true } }) : []
  const onShipments = sumBy(lines, (line) => line.workOrderSizeId, (line) => line.quantity)

  // Quality holds (wave 6): of the work order itself, and of its released serials that are not on a shipment.
  const holds = await db.qualityHold.findMany({
    where: { siteId: workOrder.siteId, status: 'ACTIVE', subjectType: { in: ['WorkOrder', 'GarmentSerial'] } },
    select: { subjectType: true, subjectIds: true, reasonCode: true },
  })
  const qualityHolds = holds.filter((hold) => hold.subjectType === 'WorkOrder' && hold.subjectIds.includes(workOrder.id)).map((hold) => hold.reasonCode)
  const heldSerialIds = [...new Set(holds.filter((hold) => hold.subjectType === 'GarmentSerial').flatMap((hold) => hold.subjectIds))]
  const heldSerials =
    heldSerialIds.length > 0
      ? await db.garmentSerial.findMany({ where: { id: { in: heldSerialIds }, workOrderId: workOrder.id, status: 'RELEASED', shipmentLineId: null }, select: { workOrderSizeId: true } })
      : []
  const held = sumBy(heldSerials, (serial) => serial.workOrderSizeId, () => 1)

  const moves = await readReceiptMoves(db, workOrder.id)
  const receivedByItem = sumBy(moves, (move) => move.itemId, (move) => Number(new Dec(move.baseQuantity.toString()).toFixed(0)) * (move.reversalOfId ? -1 : 1))
  const figures = cells.map((cell) => {
    const itemId = skus.get(skuKey(cell.colourwayId, cell.size))?.itemId ?? null
    const counts = released.get(cell.id) ?? { released: 0, reversed: 0 }
    return finishedCell({
      cellId: cell.id,
      label: cellLabel(cell),
      quantity: cell.quantity,
      released: counts.released,
      reversed: counts.reversed,
      onShipments: onShipments.get(cell.id) ?? 0,
      received: itemId ? (receivedByItem.get(itemId) ?? 0) : 0,
      heldSerials: held.get(cell.id) ?? 0,
    })
  })
  const places = await finishedPlaces(db, workOrder.siteId)
  const blockers = finishBlockers({ number: workOrder.number, kind: workOrder.kind, status: workOrder.status, holdReason: await holdReasonOf(db, workOrder), qualityHolds, siteCode: site.code, places: places.length })
  return { workOrder, style, site, cells, skus, figures, qualityHolds, places, blockers, moves }
}

/** The reason a work order is ON_HOLD (wave 5's hold columns; not in the work orders' header). */
async function holdReasonOf(db: Reader, workOrder: Header): Promise<string | null> {
  if (workOrder.status !== 'ON_HOLD') return null
  return (await db.workOrder.findUnique({ where: { id: workOrder.id }, select: { holdReason: true } }))?.holdReason ?? null
}

// ---- reports -------------------------------------------------------------------------------------------------------------

/** A report's key: the command's (`production.finish:<key>`), the move's key less its `:<n>`. */
export const reportKeyOf = (move: Pick<LedgerRow, 'idempotencyKey'>): string => move.idempotencyKey.replace(/:\d+$/, '')

export interface ReportMove {
  readonly move: LedgerRow
  readonly reversal: LedgerRow | null
}

export interface Report {
  /** Its first move's id. */
  readonly id: string
  readonly key: string
  readonly moves: readonly ReportMove[]
}

/** The receipts grouped into reports (oldest first), each move with its reversal when it has one. */
export function reportsOf(moves: readonly LedgerRow[]): Report[] {
  const reversalOf = new Map(moves.filter((move) => move.reversalOfId).map((move) => [move.reversalOfId!, move]))
  const groups = new Map<string, LedgerRow[]>()
  for (const move of moves.filter((entry) => !entry.reversalOfId)) {
    const key = reportKeyOf(move)
    groups.set(key, [...(groups.get(key) ?? []), move])
  }
  return [...groups.entries()].map(([key, rows]) => ({ id: rows[0]!.id, key, moves: rows.map((move) => ({ move, reversal: reversalOf.get(move.id) ?? null })) }))
}

/** The pop-up's answer (design production.workorders "Report finished to stock"). */
export function completionView(facts: CompletionFacts) {
  const { workOrder, figures, places, skus, cells } = facts
  const cellOf = new Map(cells.map((cell) => [cell.id, cell]))
  const cellOfItem = new Map(cells.flatMap((cell) => {
    const itemId = skus.get(skuKey(cell.colourwayId, cell.size))?.itemId
    return itemId ? [[itemId, cell] as const] : []
  }))
  const placeCode = new Map(places.map((place) => [place.id, place.code]))
  const total = (pick: (cell: FinishedCell) => number) => figures.reduce((sum, cell) => sum + pick(cell), 0)
  const canReport = total((cell) => cell.canReport)
  const fallback = defaultPlaceOf(places)
  return {
    workOrderId: workOrder.id,
    number: workOrder.number,
    batchNumber: workOrder.batchNumber,
    kind: workOrder.kind,
    status: workOrder.status,
    version: workOrder.version,
    siteId: facts.site.id,
    siteCode: facts.site.code,
    blockers: [...facts.blockers],
    reportable: facts.blockers.length === 0 && canReport > 0,
    places: places.map((place) => ({ id: place.id, code: place.code, name: place.name, kind: place.kind, parentId: place.parentId, status: place.status })),
    defaultLocationId: fallback?.id ?? null,
    cells: figures.map((cell) => {
      const row = cellOf.get(cell.cellId)!
      const sku = skus.get(skuKey(row.colourwayId, row.size)) ?? null
      return {
        cellId: cell.cellId,
        colourwayId: row.colourwayId,
        colourwayCode: row.colourwayCode,
        colourwayName: row.colourwayName,
        size: row.size,
        sku: sku?.sku ?? null,
        itemId: sku?.itemId ?? null,
        quantity: cell.quantity,
        released: cell.released,
        reversed: cell.reversed,
        netReleased: cell.netReleased,
        onShipments: cell.onShipments,
        heldSerials: cell.heldSerials,
        inStock: cell.received,
        canReport: cell.canReport,
        why: cell.why,
      }
    }),
    garments: { pieces: total((cell) => cell.quantity), netReleased: total((cell) => cell.netReleased), inStock: total((cell) => cell.received), canReport },
    allInStock: figures.length > 0 && figures.every((cell) => cell.received >= cell.quantity),
    tracking: facts.style.garmentTracking,
    valuation:
      "Valued at the standard cost (the item's frozen standard for the period, else its own): the company's costing method waits for the accountant. Values show with the cost grain in the stock screens.",
    reports: reportsOf(facts.moves)
      .reverse()
      .map((report) => {
        const first = report.moves[0]!.move
        const reversal = report.moves.find((entry) => entry.reversal)?.reversal ?? null
        return {
          id: report.id,
          at: toUtcIso(first.createdAt),
          byId: first.createdById,
          locationId: first.toLocationId!,
          locationCode: placeCode.get(first.toLocationId!) ?? null,
          note: first.note,
          cells: report.moves.map(({ move, reversal: back }) => {
            const cell = cellOfItem.get(move.itemId)
            return { moveId: move.id, cellId: cell?.id ?? null, label: cell ? cellLabel(cell) : '', itemId: move.itemId, quantity: Number(new Dec(move.baseQuantity.toString()).toFixed(0)), reversedById: back?.id ?? null }
          }),
          pieces: report.moves.reduce((sum, { move }) => sum + Number(new Dec(move.baseQuantity.toString()).toFixed(0)), 0),
          open: report.moves.filter((entry) => !entry.reversal).reduce((sum, { move }) => sum + Number(new Dec(move.baseQuantity.toString()).toFixed(0)), 0),
          reversed: reversal ? { at: toUtcIso(reversal.createdAt), byId: reversal.createdById, reason: reversal.note } : null,
        }
      }),
  }
}

export type CompletionView = ReturnType<typeof completionView>

/** The work order's gate (wave 5), SHARED: a hold, a close or a cancel waits for this report, a later one sees it. */
export async function shareGate(tx: CommandTx, tenantId: string, workOrderId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(concat_ws('|', 'factory.work-order-gate', ${tenantId}::uuid, ${workOrderId}::uuid), 0))`
}
