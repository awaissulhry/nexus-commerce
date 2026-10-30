import type { FactoryClient } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { workOrdersOfMaterial, type TraceFacts, type TraceIssueFact, type TraceStart, type TraceSubcontractFact } from '@nexus/factory-domain/inventory/trace/graph'
import { HOLD_SUBJECT_OF, type TraceDirection, type TraceStartKind } from '@nexus/factory-domain/inventory/trace/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { fixed, locatedBy } from '../stock/read-kit'

/**
 * The rows a trace reads (factory-domain inventory/trace/graph: TraceFacts), all of the start's COMPANY, on the caller's
 * client (the office's row-level security): no table of its own, W1's links ARE the trace. First the work orders and
 * lots it may reach (graph.ts workOrdersOfMaterial: forward from a lot or a hide, its issues, cuts and subcontract kits;
 * from a bundle, a serial, a shipment or a work order, their own work orders), then those work orders' cells, cuts,
 * bundles, serials, shipment lines, shipments and live DDTs, the lots and hides issued or cut there, their receipts,
 * suppliers, lab results and documents (counted), stock, and the ACTIVE quality holds on any of them. Sequential reads
 * on one client (never Promise.all on it but the read kit's own pair). Selects name their columns: no cost, price,
 * value or worker is read.
 */

export interface StartRecord extends TraceStart {
  readonly code: string
  readonly companyId: string
  readonly siteId: string
}

const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null)
const iso = (value: Date | null) => (value ? toUtcIso(value) : null)
const unique = (values: readonly (string | null | undefined)[]): string[] => [...new Set(values.filter((value): value is string => typeof value === 'string'))].sort()

/** The start's record with its company and site, or null when there is none (or another tenant's: row-level security). */
export async function readStart(client: FactoryClient, kind: TraceStartKind, id: string): Promise<StartRecord | null> {
  switch (kind) {
    case 'LOT': {
      const row = await client.lot.findUnique({ where: { id }, select: { id: true, code: true, companyId: true, siteId: true } })
      return row ? { kind, id: row.id, code: row.code, companyId: row.companyId, siteId: row.siteId } : null
    }
    case 'HIDE': {
      const row = await client.hide.findUnique({ where: { id }, select: { id: true, code: true, siteId: true, lot: { select: { companyId: true } } } })
      return row ? { kind, id: row.id, code: row.code, companyId: row.lot.companyId, siteId: row.siteId } : null
    }
    case 'BUNDLE': {
      const row = await client.bundle.findUnique({ where: { id }, select: { id: true, code: true, siteId: true, workOrder: { select: { companyId: true } } } })
      return row ? { kind, id: row.id, code: row.code, companyId: row.workOrder.companyId, siteId: row.siteId } : null
    }
    case 'WORK_ORDER': {
      const row = await client.workOrder.findUnique({ where: { id }, select: { id: true, number: true, companyId: true, siteId: true } })
      return row ? { kind, id: row.id, code: row.number, companyId: row.companyId, siteId: row.siteId } : null
    }
    case 'SERIAL': {
      const row = await client.garmentSerial.findUnique({ where: { id }, select: { id: true, serial: true, siteId: true, workOrderSize: { select: { workOrder: { select: { companyId: true } } } } } })
      return row ? { kind, id: row.id, code: row.serial, companyId: row.workOrderSize.workOrder.companyId, siteId: row.siteId } : null
    }
    case 'SHIPMENT': {
      const row = await client.shipment.findUnique({ where: { id }, select: { id: true, number: true, companyId: true, siteId: true } })
      return row ? { kind, id: row.id, code: row.number, companyId: row.companyId, siteId: row.siteId } : null
    }
  }
}

type MoveRow = { id: string; reason: string; lotId: string | null; hideId: string | null; workOrderId: string | null; baseQuantity: { toString(): string }; reversalOfId: string | null }
const issueOf = (move: MoveRow): TraceIssueFact => ({ id: move.id, reason: move.reason, lotId: move.lotId, hideId: move.hideId, workOrderId: move.workOrderId, baseQuantity: move.baseQuantity.toString(), reversalOfId: move.reversalOfId })
const ISSUE_SELECT = { id: true, reason: true, lotId: true, hideId: true, workOrderId: true, baseQuantity: true, reversalOfId: true } as const
const KIT_SELECT = {
  id: true,
  number: true,
  status: true,
  partyId: true,
  workOrderId: true,
  kitLines: { where: { status: 'SENT' as const, lotId: { not: null } }, select: { lotId: true, hideId: true, baseQuantity: true, status: true }, orderBy: { seq: 'asc' as const } },
} as const
type KitRow = { id: string; number: string; status: string; partyId: string; workOrderId: string; kitLines: { lotId: string | null; hideId: string | null; baseQuantity: { toString(): string }; status: string }[] }
const subcontractOf = (row: KitRow): TraceSubcontractFact => ({
  id: row.id,
  number: row.number,
  status: row.status,
  partyId: row.partyId,
  workOrderId: row.workOrderId,
  kit: row.kitLines.map((line) => ({ lotId: line.lotId!, hideId: line.hideId, baseQuantity: line.baseQuantity.toString(), status: line.status })),
})

/** Σ of the moves less Σ of their reversals (a reversal is the same move with its locations swapped). */
function netOf(rows: readonly { baseQuantity: { toString(): string }; reversalOfId: string | null }[]): Decimal {
  return rows.reduce<Decimal>((total, row) => (row.reversalOfId === null ? total.plus(new Dec(row.baseQuantity.toString())) : total.minus(new Dec(row.baseQuantity.toString()))), ZERO)
}

export async function loadTraceFacts(client: FactoryClient, start: StartRecord, direction: TraceDirection): Promise<TraceFacts> {
  const companyId = start.companyId
  const forward = direction !== 'BACKWARD'

  // ---- 1. the work orders it may reach ---------------------------------------------------------------------------------
  const seedLots = new Set<string>()
  const seedHides = new Set<string>()
  const workOrderIds = new Set<string>()
  const seedShipments = new Set<string>()
  if (start.kind === 'LOT') seedLots.add(start.id)
  if (start.kind === 'HIDE') {
    seedHides.add(start.id)
    const hide = await client.hide.findUnique({ where: { id: start.id }, select: { lotId: true } })
    if (hide) seedLots.add(hide.lotId)
  }
  if (start.kind === 'WORK_ORDER') workOrderIds.add(start.id)
  if (start.kind === 'BUNDLE') {
    const bundle = await client.bundle.findUnique({ where: { id: start.id }, select: { workOrderId: true } })
    if (bundle) workOrderIds.add(bundle.workOrderId)
  }
  if (start.kind === 'SERIAL') {
    const serial = await client.garmentSerial.findUnique({ where: { id: start.id }, select: { workOrderId: true } })
    if (serial) workOrderIds.add(serial.workOrderId)
  }
  if (start.kind === 'SHIPMENT') {
    seedShipments.add(start.id)
    for (const line of await client.shipmentLine.findMany({ where: { shipmentId: start.id }, select: { workOrderId: true } })) workOrderIds.add(line.workOrderId)
  }
  let materialKits: KitRow[] = []
  if (forward && (start.kind === 'LOT' || start.kind === 'HIDE')) {
    const material = start.kind === 'HIDE' ? { hideId: start.id } : { lotId: start.id }
    const moves = await client.stockMove.findMany({ where: { ...material, companyId, reason: { in: ['ISSUE', 'RETURN'] }, workOrderId: { not: null } }, select: ISSUE_SELECT })
    const cuts = await client.cutLog.findMany({ where: material, select: { id: true, workOrderId: true, hideId: true, lotId: true, reversalOfId: true } })
    materialKits = (await client.subcontractOrder.findMany({ where: { companyId, kitLines: { some: { ...material, status: 'SENT' } } }, select: KIT_SELECT })) as KitRow[]
    const reach = workOrdersOfMaterial(
      moves.map(issueOf),
      cuts.map((cut) => ({ id: cut.id, workOrderId: cut.workOrderId, hideId: cut.hideId, lotId: cut.lotId, baseAreaUsed: '0', pieces: 0, live: cut.reversalOfId === null })),
      materialKits.map(subcontractOf),
    )
    for (const id of reach) workOrderIds.add(id)
  }
  const woIds = [...workOrderIds].sort()

  // ---- 2. the work orders' records ---------------------------------------------------------------------------------------
  const workOrderRows = woIds.length
    ? await client.workOrder.findMany({
        where: { id: { in: woIds }, companyId },
        select: { id: true, companyId: true, siteId: true, number: true, batchNumber: true, status: true, kind: true, style: { select: { code: true, garmentTracking: true } } },
      })
    : []
  const wos = workOrderRows.map((row) => row.id)
  const finished = wos.length ? await client.stockMove.findMany({ where: { workOrderId: { in: wos }, reason: 'PRODUCTION_RECEIPT' }, select: { workOrderId: true, baseQuantity: true, reversalOfId: true } }) : []
  const cells = wos.length ? await client.workOrderSize.findMany({ where: { workOrderId: { in: wos } }, select: { id: true, workOrderId: true, size: true, quantity: true, colourway: { select: { code: true } } }, orderBy: [{ workOrderId: 'asc' }, { id: 'asc' }] }) : []
  const cellIds = cells.map((cell) => cell.id)
  const released = cellIds.length ? await client.qualityRelease.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds } }, _sum: { quantity: true } }) : []
  const reversed = cellIds.length ? await client.qualityReleaseReversal.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds } }, _sum: { quantity: true } }) : []
  const materialWhere = [
    ...(wos.length ? [{ workOrderId: { in: wos } }] : []),
    ...(forward && start.kind === 'LOT' ? [{ lotId: start.id }] : []),
    ...(forward && start.kind === 'HIDE' ? [{ hideId: start.id }] : []),
  ]
  const cutRows = materialWhere.length
    ? await client.cutLog.findMany({ where: { OR: materialWhere }, select: { id: true, workOrderId: true, hideId: true, lotId: true, baseAreaUsed: true, reversalOfId: true }, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })
    : []
  const cutIds = cutRows.map((cut) => cut.id)
  const reversedCuts = new Set(cutRows.flatMap((cut) => (cut.reversalOfId ? [cut.reversalOfId] : [])))
  if (cutIds.length) for (const row of await client.cutLog.findMany({ where: { reversalOfId: { in: cutIds } }, select: { reversalOfId: true } })) reversedCuts.add(row.reversalOfId!)
  const pieces = cutIds.length ? await client.cutLogPiece.groupBy({ by: ['cutLogId'], where: { cutLogId: { in: cutIds } }, _sum: { pieces: true } }) : []
  const bundles = wos.length
    ? await client.bundle.findMany({ where: { workOrderId: { in: wos } }, select: { id: true, code: true, workOrderId: true, workOrderSizeId: true, quantity: true, part: true, status: true, cutLogIds: true, parentBundleId: true }, orderBy: { id: 'asc' } })
    : []
  const serials = wos.length
    ? await client.garmentSerial.findMany({ where: { workOrderId: { in: wos } }, select: { id: true, serial: true, workOrderId: true, workOrderSizeId: true, bundleId: true, status: true, shipmentLineId: true }, orderBy: { id: 'asc' } })
    : []
  const lines = wos.length || seedShipments.size
    ? await client.shipmentLine.findMany({
        where: { OR: [...(wos.length ? [{ workOrderId: { in: wos } }] : []), ...(seedShipments.size ? [{ shipmentId: { in: [...seedShipments] } }] : [])], shipment: { companyId } },
        select: { id: true, shipmentId: true, workOrderId: true, workOrderSizeId: true, quantity: true },
        orderBy: { id: 'asc' },
      })
    : []
  const shipmentIds = unique([...lines.map((line) => line.shipmentId), ...seedShipments])
  const shipments = shipmentIds.length
    ? await client.shipment.findMany({ where: { id: { in: shipmentIds }, companyId }, select: { id: true, companyId: true, siteId: true, number: true, status: true, partyId: true, shippedAt: true, deliveredAt: true } })
    : []
  const ddts = shipmentIds.length ? await client.ddt.findMany({ where: { shipmentId: { in: shipmentIds }, cancellations: { none: {} } }, select: { shipmentId: true, number: true }, orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }] }) : []
  const issueWhere = [
    ...(wos.length ? [{ workOrderId: { in: wos } }] : []),
    ...(forward && start.kind === 'LOT' ? [{ lotId: start.id }] : []),
    ...(forward && start.kind === 'HIDE' ? [{ hideId: start.id }] : []),
  ]
  const issues = issueWhere.length
    ? await client.stockMove.findMany({ where: { companyId, reason: { in: ['ISSUE', 'RETURN'] }, workOrderId: { not: null }, OR: issueWhere }, select: ISSUE_SELECT, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })
    : []
  const orders = wos.length ? ((await client.subcontractOrder.findMany({ where: { workOrderId: { in: wos }, companyId }, select: KIT_SELECT })) as KitRow[]) : []
  const subcontracts = [...new Map([...orders, ...materialKits].map((row) => [row.id, subcontractOf(row)])).values()]

  // ---- 3. the lots and hides, where they came from and where they are ---------------------------------------------------
  const lotIds = unique([...seedLots, ...issues.map((move) => move.lotId), ...cutRows.map((cut) => cut.lotId), ...subcontracts.flatMap((order) => order.kit.map((line) => line.lotId))])
  const lotRows = lotIds.length
    ? await client.lot.findMany({
        where: { id: { in: lotIds }, companyId },
        select: {
          id: true,
          code: true,
          companyId: true,
          siteId: true,
          supplierId: true,
          supplierLotRef: true,
          dyeBatch: true,
          receivedAt: true,
          receiptLineId: true,
          qualityStatus: true,
          crViStatus: true,
          crViMgKg: true,
          crViLimitMgKg: true,
          item: { select: { id: true, code: true, name: true, baseUom: true, tracking: true } },
          itemColour: { select: { code: true } },
          receiptLine: { select: { receiptId: true, purchaseOrderLine: { select: { seq: true, purchaseOrder: { select: { id: true, number: true } } } } } },
        },
      })
    : []
  const lots = lotRows.map((lot) => lot.id)
  const labResults = lots.length ? await client.labResult.groupBy({ by: ['lotId'], where: { lotId: { in: lots } }, _count: { _all: true } }) : []
  const documents = lots.length ? await client.lotDocument.groupBy({ by: ['lotId'], where: { lotId: { in: lots }, status: 'ACTIVE' }, _count: { _all: true } }) : []
  const lotStock = lots.length ? await locatedBy(client, 'lotId', { lotId: { in: lots } }) : new Map()
  const scraps = lots.length ? await client.stockMove.findMany({ where: { lotId: { in: lots }, reason: 'SCRAP' }, select: { lotId: true, baseQuantity: true, reversalOfId: true } }) : []
  const hideIds = unique([
    ...seedHides,
    ...issues.map((move) => move.hideId),
    ...cutRows.map((cut) => cut.hideId),
    ...subcontracts.flatMap((order) => order.kit.map((line) => line.hideId)),
  ])
  const hideRows = hideIds.length || (forward && start.kind === 'LOT')
    ? await client.hide.findMany({
        where: { OR: [...(hideIds.length ? [{ id: { in: hideIds } }] : []), ...(forward && start.kind === 'LOT' ? [{ lotId: start.id }] : [])], lotId: { in: lots } },
        select: { id: true, code: true, lotId: true, state: true, baseArea: true },
        orderBy: { code: 'asc' },
      })
    : []
  const hideStock = hideRows.length ? await locatedBy(client, 'hideId', { hideId: { in: hideRows.map((hide) => hide.id) } }) : new Map()
  const receiptIds = unique(lotRows.map((lot) => lot.receiptLine?.receiptId))
  const receipts = receiptIds.length
    ? await client.goodsReceipt.findMany({ where: { id: { in: receiptIds }, companyId }, select: { id: true, number: true, status: true, receivedAt: true, supplierId: true, supplierDdtNumber: true, supplierDdtDate: true } })
    : []

  // ---- 4. the parties and the holds ----------------------------------------------------------------------------------------
  const partyIds = unique([...lotRows.map((lot) => lot.supplierId), ...receipts.map((receipt) => receipt.supplierId), ...shipments.map((shipment) => shipment.partyId), ...subcontracts.map((order) => order.partyId)])
  const parties = partyIds.length ? await client.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, companyId: true, code: true, legalName: true, tradeName: true } }) : []
  const subjectIds = unique([...lots, ...hideRows.map((hide) => hide.id), ...wos, ...bundles.map((bundle) => bundle.id), ...serials.map((serial) => serial.id), ...shipments.map((shipment) => shipment.id)])
  const holds = subjectIds.length
    ? await client.qualityHold.findMany({
        where: { status: 'ACTIVE', companyId, subjectType: { in: Object.values(HOLD_SUBJECT_OF) as string[] }, subjectIds: { hasSome: subjectIds } },
        select: { id: true, subjectType: true, subjectIds: true, reasonCode: true, placedAt: true },
        orderBy: [{ placedAt: 'asc' }, { id: 'asc' }],
      })
    : []

  const piecesOf = new Map(pieces.map((row) => [row.cutLogId, row._sum.pieces ?? 0]))
  const releasedOf = new Map(released.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
  const reversedOf = new Map(reversed.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
  const countOf = (rows: readonly { lotId: string; _count: { _all: number } }[], lotId: string) => rows.find((row) => row.lotId === lotId)?._count._all ?? 0
  return {
    lots: lotRows.map((lot) => ({
      id: lot.id,
      code: lot.code,
      companyId: lot.companyId,
      siteId: lot.siteId,
      item: lot.item,
      colourCode: lot.itemColour?.code ?? null,
      supplierId: lot.supplierId,
      supplierLotRef: lot.supplierLotRef,
      dyeBatch: lot.dyeBatch,
      receiptId: lot.receiptLine?.receiptId ?? null,
      purchaseOrder: lot.receiptLine?.purchaseOrderLine ? { id: lot.receiptLine.purchaseOrderLine.purchaseOrder.id, number: lot.receiptLine.purchaseOrderLine.purchaseOrder.number, lineSeq: lot.receiptLine.purchaseOrderLine.seq } : null,
      receivedAt: iso(lot.receivedAt),
      qualityStatus: lot.qualityStatus,
      crVi: { status: lot.crViStatus, valueMgKg: lot.crViMgKg ? new Dec(lot.crViMgKg.toString()).toFixed(3) : null, limitMgKg: lot.crViLimitMgKg ? new Dec(lot.crViLimitMgKg.toString()).toFixed(3) : null },
      labResults: countOf(labResults, lot.id),
      documents: countOf(documents, lot.id),
      onHand: fixed(lotStock.get(lot.id)?.onHand),
      scrapped: fixed(netOf(scraps.filter((move) => move.lotId === lot.id))),
    })),
    hides: hideRows.map((hide) => ({ id: hide.id, code: hide.code, lotId: hide.lotId, state: hide.state, baseArea: fixed(new Dec(hide.baseArea.toString())), onHand: fixed(hideStock.get(hide.id)?.onHand) })),
    receipts: receipts.map((receipt) => ({
      id: receipt.id,
      number: receipt.number,
      status: receipt.status,
      receivedAt: toUtcIso(receipt.receivedAt),
      supplierId: receipt.supplierId,
      supplierDdtNumber: receipt.supplierDdtNumber,
      supplierDdtDate: day(receipt.supplierDdtDate),
    })),
    parties: parties.map((party) => ({ id: party.id, companyId: party.companyId, code: party.code, name: party.tradeName ?? party.legalName })),
    issues: issues.map(issueOf),
    workOrders: workOrderRows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      number: row.number,
      batchNumber: row.batchNumber,
      status: row.status,
      kind: row.kind,
      styleCode: row.style.code,
      tracking: row.style.garmentTracking === 'SERIAL' ? ('SERIAL' as const) : ('BATCH' as const),
      finishedReceived: Number(netOf(finished.filter((move) => move.workOrderId === row.id)).toFixed(0)),
    })),
    cells: cells.map((cell) => ({ id: cell.id, workOrderId: cell.workOrderId, colourwayCode: cell.colourway.code, size: cell.size, quantity: cell.quantity, released: (releasedOf.get(cell.id) ?? 0) - (reversedOf.get(cell.id) ?? 0) })),
    cuts: cutRows.map((cut) => ({
      id: cut.id,
      workOrderId: cut.workOrderId,
      hideId: cut.hideId,
      lotId: cut.lotId,
      baseAreaUsed: fixed(new Dec(cut.baseAreaUsed.toString())),
      pieces: piecesOf.get(cut.id) ?? 0,
      live: cut.reversalOfId === null && !reversedCuts.has(cut.id),
    })),
    bundles: bundles.map((bundle) => ({ id: bundle.id, code: bundle.code, workOrderId: bundle.workOrderId, cellId: bundle.workOrderSizeId, quantity: bundle.quantity, part: bundle.part, status: bundle.status, cutLogIds: bundle.cutLogIds, parentBundleId: bundle.parentBundleId })),
    serials: serials.map((serial) => ({ id: serial.id, serial: serial.serial, workOrderId: serial.workOrderId, cellId: serial.workOrderSizeId, bundleId: serial.bundleId, status: serial.status, shipmentLineId: serial.shipmentLineId })),
    lines: lines.map((line) => ({ id: line.id, shipmentId: line.shipmentId, workOrderId: line.workOrderId, cellId: line.workOrderSizeId, quantity: line.quantity })),
    shipments: shipments.map((shipment) => ({
      id: shipment.id,
      companyId: shipment.companyId,
      siteId: shipment.siteId,
      number: shipment.number,
      status: shipment.status,
      partyId: shipment.partyId,
      shippedAt: iso(shipment.shippedAt),
      deliveredAt: iso(shipment.deliveredAt),
      ddtNumbers: ddts.filter((ddt) => ddt.shipmentId === shipment.id).map((ddt) => ddt.number),
    })),
    subcontracts,
    holds: holds.map((hold) => ({ id: hold.id, subjectType: hold.subjectType, subjectIds: hold.subjectIds, reasonCode: hold.reasonCode, placedAt: toUtcIso(hold.placedAt) })),
  }
}
