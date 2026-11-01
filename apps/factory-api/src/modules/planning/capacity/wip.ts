import type { WorkCentreKind } from '@nexus/factory-domain/product/routing/operations'
import { SCAN_KINDS, type ScanFact } from '@nexus/factory-domain/production/scans/rules'
import { wipOf, type Wip, type WipRework } from '@nexus/factory-domain/production/scans/wip'
import { SCAN_COLUMNS } from '../../production/scans/store'
import type { Reader } from '../store'

/**
 * The WIP of many work orders in one go (B-W2b-20; B-W2a-16's gap "capacityWorld reads WIP per IN_PROGRESS work order
 * (wipFor: ~5 queries each) … a bulk WIP read would help a busy site"): the same reads as production/scans `wipFor`
 * (operations with their work centre's kind, cells with their colourway, bundles as cut with their parents, scans,
 * rework orders that are not CANCELLED, the scans' stations and lines), each ONE query for every work order asked, in
 * the same orders, then factory-domain `wipOf` per work order: the answer equals `wipFor` of each (the PG test of this
 * folder compares them). Seven queries whatever the number of work orders; one after another (the client may be a
 * command's transaction). No person: scans are read for their counts and stations only (per line, F2).
 */
export async function wipForMany(db: Reader, workOrderIds: readonly string[]): Promise<Map<string, Wip>> {
  const ids = [...new Set(workOrderIds)]
  const out = new Map<string, Wip>()
  if (ids.length === 0) return out
  const operations = await db.workOrderOperation.findMany({ where: { workOrderId: { in: ids } }, select: { id: true, workOrderId: true, seq: true, code: true, name: true, scanRequired: true, workCentreId: true }, orderBy: [{ workOrderId: 'asc' }, { seq: 'asc' }] })
  const centreIds = [...new Set(operations.map((row) => row.workCentreId))]
  const kinds = new Map(centreIds.length === 0 ? [] : (await db.workCentre.findMany({ where: { id: { in: centreIds } }, select: { id: true, kind: true } })).map((row) => [row.id, row.kind as WorkCentreKind]))
  const cells = await db.workOrderSize.findMany({ where: { workOrderId: { in: ids } }, select: { id: true, workOrderId: true, colourwayId: true, size: true, quantity: true }, orderBy: [{ colourwayId: 'asc' }, { size: 'asc' }] })
  const colourwayIds = [...new Set(cells.map((cell) => cell.colourwayId))]
  const colourways = new Map(colourwayIds.length === 0 ? [] : (await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const bundles = await db.bundle.findMany({ where: { workOrderId: { in: ids } }, select: { id: true, workOrderId: true, workOrderSizeId: true, part: true, quantity: true, status: true, parentBundleId: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  // W2b (B-W2b-40): the count ledger only (a timing row — START, PAUSE … — is no report).
  const scans = (await db.operationScan.findMany({ where: { workOrderId: { in: ids }, kind: { in: [...SCAN_KINDS] } }, select: SCAN_COLUMNS, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })) as (Awaited<ReturnType<typeof db.operationScan.findMany<{ select: typeof SCAN_COLUMNS }>>>[number] & ScanFact)[]
  const reworks = await db.reworkOrder.findMany({
    where: { workOrderId: { in: ids }, status: { not: 'CANCELLED' } },
    select: { id: true, workOrderId: true, workOrderSizeId: true, bundleId: true, sourceScanId: true, foundAtOperationId: true, reworkAtOperationId: true, status: true, quantity: true, goodQuantity: true, scrapQuantity: true, reasonCode: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const stationIds = [...new Set(scans.flatMap((scan) => (scan.stationId ? [scan.stationId] : [])))]
  const lineOfStation = new Map(stationIds.length === 0 ? [] : (await db.station.findMany({ where: { id: { in: stationIds } }, select: { id: true, lineId: true } })).map((row) => [row.id, row.lineId]))
  const byWorkOrder = <Row extends { workOrderId: string }>(rows: readonly Row[]) => {
    const map = new Map<string, Row[]>()
    for (const row of rows) map.set(row.workOrderId, [...(map.get(row.workOrderId) ?? []), row])
    return map
  }
  const operationsOf = byWorkOrder(operations)
  const cellsOf = byWorkOrder(cells)
  const bundlesOf = byWorkOrder(bundles)
  const scansOf = byWorkOrder(scans)
  const reworksOf = byWorkOrder(reworks)
  for (const id of ids) {
    out.set(
      id,
      wipOf({
        operations: (operationsOf.get(id) ?? []).map(({ workOrderId: _workOrderId, ...row }) => ({ ...row, workCentreKind: kinds.get(row.workCentreId) ?? 'SEWING' })),
        cells: (cellsOf.get(id) ?? []).map((cell) => ({ id: cell.id, colourwayCode: colourways.get(cell.colourwayId) ?? '', size: cell.size, quantity: cell.quantity })),
        bundles: (bundlesOf.get(id) ?? []).map(({ workOrderId: _workOrderId, ...bundle }) => bundle),
        scans: scansOf.get(id) ?? [],
        reworks: (reworksOf.get(id) ?? []).map(({ workOrderId: _workOrderId, ...rework }) => rework) as WipRework[],
        lineOf: (stationId) => lineOfStation.get(stationId) ?? null,
      }),
    )
  }
  return out
}
