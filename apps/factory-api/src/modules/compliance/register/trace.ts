import type { FactoryClient } from '@nexus/factory-db'
import type { RegisterConcern } from '@nexus/factory-domain/compliance/register/rules'
import { buildTrace, type TraceView } from '@nexus/factory-domain/compliance/register/trace'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'

/**
 * The trace of a register entry's concern (factory-domain compliance/register/trace): the rows it needs, read from the
 * production, quality and shipping tables of the entry's COMPANY only, in the caller's scope (the office's row-level
 * security). A lot → its ISSUE moves (not reversed) → work orders; a batch number → its work order; a serial → its
 * garment, cell and shipment line; a named shipment → its lines' work orders; the work orders' cells → releases less reversals, shipment lines (not on a cancelled
 * shipment) → shipments with their live DDTs → the customers. Sequential reads on one client (never Promise.all on a
 * transaction client). Names columns; no cost, price or wage is read.
 */

type Client = FactoryClient | CommandTx
export type TraceConcern = Pick<RegisterConcern, 'styleId' | 'batchNumbers' | 'serials' | 'lotIds' | 'workOrderIds' | 'shipmentIds'>

const WORK_ORDER = { id: true, number: true, batchNumber: true, styleId: true, status: true, style: { select: { code: true } }, styleRevision: { select: { revision: true } } } as const

export async function traceOf(client: Client, companyId: string, concern: TraceConcern): Promise<TraceView> {
  const serials = concern.serials.length
    ? await client.garmentSerial.findMany({
        where: { serial: { in: [...concern.serials] }, workOrderSize: { workOrder: { companyId } } },
        select: { serial: true, status: true, workOrderId: true, workOrderSizeId: true, shipmentLineId: true },
      })
    : []
  const lots = concern.lotIds.length ? await client.lot.findMany({ where: { id: { in: [...concern.lotIds] }, companyId }, select: { id: true, code: true } }) : []
  const issues = lots.length
    ? await client.stockMove.findMany({
        where: { lotId: { in: lots.map((lot) => lot.id) }, companyId, reason: 'ISSUE', workOrderId: { not: null }, reversalOfId: null, reversals: { none: {} } },
        select: { lotId: true, workOrderId: true },
      })
    : []
  const lotIssues = issues.map((move) => ({ lotId: move.lotId!, workOrderId: move.workOrderId! }))

  const named = concern.shipmentIds.length
    ? await client.shipmentLine.findMany({ where: { shipmentId: { in: [...concern.shipmentIds] }, shipment: { companyId, status: { not: 'CANCELLED' } } }, select: { workOrderId: true } })
    : []
  const workOrderIds = [
    ...new Set([...concern.workOrderIds, ...serials.map((serial) => serial.workOrderId), ...lotIssues.map((issue) => issue.workOrderId), ...named.map((line) => line.workOrderId)]),
  ]
  const orFilters = [
    ...(concern.batchNumbers.length ? [{ batchNumber: { in: [...concern.batchNumbers] } }] : []),
    ...(workOrderIds.length ? [{ id: { in: workOrderIds } }] : []),
  ]
  const workOrderRows = orFilters.length ? await client.workOrder.findMany({ where: { companyId, OR: orFilters }, select: WORK_ORDER }) : []
  const workOrders = workOrderRows.map((row) => ({
    id: row.id,
    number: row.number,
    batchNumber: row.batchNumber,
    styleId: row.styleId,
    styleCode: row.style.code,
    revision: row.styleRevision?.revision ?? null,
    status: row.status,
  }))
  const ofStyle = workOrders.filter((row) => row.styleId === concern.styleId).map((row) => row.id)

  const cellRows = ofStyle.length
    ? await client.workOrderSize.findMany({ where: { workOrderId: { in: ofStyle } }, select: { id: true, workOrderId: true, size: true, quantity: true, colourway: { select: { code: true } } } })
    : []
  const cellIds = cellRows.map((cell) => cell.id)
  const released = cellIds.length ? await client.qualityRelease.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds } }, _sum: { quantity: true } }) : []
  const reversed = cellIds.length ? await client.qualityReleaseReversal.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds } }, _sum: { quantity: true } }) : []
  const lines = cellIds.length
    ? await client.shipmentLine.findMany({
        where: { workOrderSizeId: { in: cellIds }, shipment: { status: { not: 'CANCELLED' } } },
        select: { id: true, shipmentId: true, workOrderId: true, workOrderSizeId: true, quantity: true },
      })
    : []
  const shipmentIds = [...new Set([...lines.map((line) => line.shipmentId), ...concern.shipmentIds])]
  const shipmentRows = shipmentIds.length
    ? await client.shipment.findMany({ where: { id: { in: shipmentIds }, companyId }, select: { id: true, number: true, status: true, shippedAt: true, deliveredAt: true, partyId: true } })
    : []
  const ddts = shipmentIds.length ? await client.ddt.findMany({ where: { shipmentId: { in: shipmentIds }, cancellations: { none: {} } }, select: { shipmentId: true, number: true } }) : []
  const partyIds = [...new Set(shipmentRows.map((row) => row.partyId))]
  const parties = partyIds.length ? await client.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true } }) : []

  return buildTrace({
    concern,
    workOrders,
    serials,
    lots,
    lotIssues,
    cells: cellRows.map((cell) => ({ id: cell.id, workOrderId: cell.workOrderId, colourwayCode: cell.colourway.code, size: cell.size, quantity: cell.quantity })),
    released: released.map((row) => ({ workOrderSizeId: row.workOrderSizeId, quantity: row._sum.quantity ?? 0 })),
    reversed: reversed.map((row) => ({ workOrderSizeId: row.workOrderSizeId, quantity: row._sum.quantity ?? 0 })),
    lines,
    shipments: shipmentRows.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      shippedAt: row.shippedAt ? toUtcIso(row.shippedAt) : null,
      deliveredAt: row.deliveredAt ? toUtcIso(row.deliveredAt) : null,
      partyId: row.partyId,
      ddtNumbers: ddts.filter((ddt) => ddt.shipmentId === row.id).map((ddt) => ddt.number),
    })),
    parties: parties.map((party) => ({ id: party.id, code: party.code, name: party.legalName })),
  })
}
