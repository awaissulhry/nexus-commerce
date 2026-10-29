import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { daysLate } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { wipOf, type Wip } from '@nexus/factory-domain/production/scans/wip'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeOf, scanWorkOrder } from './access'
import { readCorrectionRequests } from './corrections-store'
import { dayOrNull } from '../work-orders/store'
import { readCells, readLines, readOperations, readStations, readWorkOrderBundles, readWorkOrderScans, SCAN_HEADER, type Reader, type ScanHeader } from './store'

/**
 * Work in progress from the floor's scans (B-W1-42; MES-167, MES-079; A2 SCR-072 "Bundles & progress", SCR-073 "Work in
 * progress"; design production.floor fn-wip, workorder wo-flow; Owner answers W1, F2): per operation and cell of one work
 * order, per operation of every open work order of the caller's sites, and the size grid's sewn and finished garments
 * for the work order record (work-orders views.ts). Figures are sums of the standing reports of ACTIVE bundles
 * (factory-domain production/scans/wip); per line where the reporting station sits on one; never per person or per
 * station (Statuto dei Lavoratori art. 4).
 */

const OPEN = ['RELEASED', 'IN_PROGRESS'] as const

/** The WIP of one work order, as factory-domain counts it. */
export async function wipFor(db: Reader, workOrder: Pick<ScanHeader, 'id' | 'siteId'>): Promise<Wip> {
  const operations = await readOperations(db, workOrder.id)
  const cells = await readCells(db, workOrder.id)
  const bundles = (await readWorkOrderBundles(db, workOrder.id)).filter((bundle) => bundle.status === 'ACTIVE')
  const scans = await readWorkOrderScans(db, workOrder.id)
  const stations = await readStations(db, scans.map((scan) => scan.stationId))
  return wipOf({ operations, cells, bundles, scans, lineOf: (stationId) => stations.get(stationId)?.lineId ?? null })
}

/**
 * The size grid's bundled, sewn and finished garments per cell (the work order record's progress): bundled from the
 * ACTIVE whole-garment bundles, sewn and finished from the scans.
 */
export async function scanProgressOf(
  db: Reader,
  workOrder: Pick<ScanHeader, 'id' | 'siteId'>,
): Promise<Map<string, { readonly bundled: number; readonly sewn: number | null; readonly finished: number | null }>> {
  const wip = await wipFor(db, workOrder)
  return new Map(wip.cells.map((cell) => [cell.workOrderSizeId, { bundled: cell.bundled, sewn: cell.sewn, finished: cell.finished }]))
}

/** One work order's WIP for the office (SCR-072): operations × cells, lines, bundles, the size grid, corrections waiting. */
export async function workOrderWip(caller: CommandCaller, workOrderId: string) {
  officeOf(caller)
  const workOrder = await scanWorkOrder(caller, workOrderId, WORKORDERS_VIEW)
  return caller.withClient(async (db) => {
    const wip = await wipFor(db, workOrder)
    const cells = new Map((await readCells(db, workOrder.id)).map((cell) => [cell.id, cell]))
    const lines = await readLines(db, workOrder.siteId)
    const operations = await readOperations(db, workOrder.id)
    const waiting = await readCorrectionRequests(db, { siteIds: [workOrder.siteId], workOrderId: workOrder.id, status: 'PENDING' })
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, siteId: workOrder.siteId },
      operations: wip.operations.map((row) => ({
        ...row,
        workCentreKind: operations.find((operation) => operation.id === row.operationId)?.workCentreKind ?? 'SEWING',
        lines: row.lines.map((line) => ({ ...line, code: lines.get(line.lineId)?.code ?? '', name: lines.get(line.lineId)?.name ?? '' })),
        cells: row.cells.map((cell) => ({ ...cell, colourwayCode: cells.get(cell.workOrderSizeId)?.colourwayCode ?? '', size: cells.get(cell.workOrderSizeId)?.size ?? '' })),
      })),
      cells: wip.cells.map((cell) => ({ ...cell, colourwayCode: cells.get(cell.workOrderSizeId)?.colourwayCode ?? '', size: cells.get(cell.workOrderSizeId)?.size ?? '' })),
      finalOperationId: wip.finalOperationId,
      sewnOperationId: wip.sewnOperationId,
      allFinished: wip.allFinished,
      /** Every cell finished and the work order in progress: the office completes it (POST /production/work-orders/:id/complete). */
      readyToComplete: wip.allFinished && workOrder.status === 'IN_PROGRESS',
      correctionsWaiting: waiting.length,
    }
  })
}

/**
 * Every open work order of the caller's sites with its operations' WIP (SCR-073 "Floor now"; no cells, no person, no
 * station): what it is (style, site, due date and days late, pieces and finished garments) and, per operation, the pieces
 * arrived, waiting, good, scrap and rework, its bundles, and the good per line (F2: output per line only).
 */
export async function siteWip(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly limit: number }) {
  const context = officeOf(caller)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (db) => {
    const workOrders = await db.workOrder.findMany({
      where: { AND: [scopeWhere(actorOf(context), WORKORDERS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput, { status: { in: [...OPEN] } }, query.siteId ? { siteId: query.siteId } : {}] },
      select: { ...SCAN_HEADER, dueDate: true, priority: true, site: { select: { code: true } }, style: { select: { code: true, name: true } }, sizes: { select: { quantity: true } } },
      orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
      take: query.limit,
    })
    const lines = new Map<string, Map<string, { id: string; code: string; name: string }>>()
    const rows = []
    for (const workOrder of workOrders) {
      const wip = await wipFor(db, workOrder)
      if (!lines.has(workOrder.siteId)) lines.set(workOrder.siteId, await readLines(db, workOrder.siteId))
      const siteLines = lines.get(workOrder.siteId)!
      const dueDate = dayOrNull(workOrder.dueDate)
      const finished = wip.cells.some((cell) => cell.finished !== null) ? wip.cells.reduce((sum, cell) => sum + (cell.finished ?? 0), 0) : null
      rows.push({
        workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, siteId: workOrder.siteId },
        siteCode: workOrder.site.code,
        style: { code: workOrder.style.code, name: workOrder.style.name },
        dueDate,
        daysLate: daysLate(workOrder.status, dueDate, today),
        priority: workOrder.priority,
        pieces: workOrder.sizes.reduce((sum, cell) => sum + cell.quantity, 0),
        finished,
        operations: wip.operations.map((row) => ({
          operationId: row.operationId,
          seq: row.seq,
          code: row.code,
          name: row.name,
          scanRequired: row.scanRequired,
          final: row.final,
          arrived: row.arrived,
          waiting: row.waiting,
          good: row.good,
          scrap: row.scrap,
          rework: row.rework,
          bundles: { ...row.bundles },
          lines: row.lines.map((line) => ({ ...line, code: siteLines.get(line.lineId)?.code ?? '', name: siteLines.get(line.lineId)?.name ?? '' })),
        })),
        allFinished: wip.allFinished,
      })
    }
    return { workOrders: rows }
  })
}
