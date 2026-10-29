import type { Prisma } from '@nexus/factory-db'
import { PRINT_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { PRODUCTION_BUNDLES } from '@nexus/factory-domain/production/bundles/permissions'
import { scannedBundleRefusal, splitBundles, targetBundleSize } from '@nexus/factory-domain/production/bundles/rules'
import { CUTTABLE_STATUSES } from '@nexus/factory-domain/production/cutting/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { standardBundleSizeFor } from '../settings/bundle-size'
import { bundleView, bundleWorkOrder, cellView, countsOf, mayBundle, ticketBase, ticketOf, workerOf } from './bundles'
import { BUNDLE_HEADER, readBundleByCode, readBundles, readCellLabels, readHeader, readOperations, readReprints, readScans, readTicketJobs, stationPrinterOf, type Reader, type ScanRow } from './store'

/**
 * The bundles screens' reads (B-W1-41; A2 SCR-095 floor bundles, SCR-072 the work order's bundles; MES-065, MES-066,
 * MES-073, MES-184): the work orders whose cut garments wait for bundles, a work order as the bundles step sees it (its
 * cells with what is cut, in bundles and still to bundle, the proposed bundles in the site's standard bundle size, its
 * bundles, its operations, the site's label printers and the one the tickets go to), a scanned ticket (the bundle card:
 * its operations with ticks, an old ticket refused with the new code), and for the office a work order's bundles with
 * their genealogy, scans, tickets and reprints. The floor sees no worker's name; nothing here carries money.
 */

const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null)

/** The REPORT and CORRECTION scans no later scan voids: the operations a bundle is done at. */
function standingOperations(scans: readonly ScanRow[]): Set<string> {
  const voided = new Set(scans.flatMap((scan) => (scan.correctsId ? [scan.correctsId] : [])))
  return new Set(scans.filter((scan) => scan.kind !== 'UNDO' && !voided.has(scan.id)).map((scan) => scan.workOrderOperationId))
}

// ---- the work orders whose cut waits for bundles ----------------------------------------------------------------------------

export interface BundleWorkOrdersQuery {
  readonly number?: string | undefined
  readonly limit: number
}

/** RELEASED and IN_PROGRESS work orders at the caller's sites with garments cut and not yet in bundles ("Cut, not in bundles"). */
export async function bundleWorkOrders(caller: CommandCaller, query: BundleWorkOrdersQuery) {
  const context = workerOf(caller)
  const where: Prisma.WorkOrderWhereInput = {
    AND: [
      scopeWhere(actorOf(context), PRODUCTION_BUNDLES, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput,
      { status: { in: [...CUTTABLE_STATUSES] } },
      context.audience === 'floor' ? { siteId: context.siteId } : {},
      query.number ? { number: query.number.trim() } : {},
    ],
  }
  return caller.withClient(async (db) => {
    const rows = await db.workOrder.findMany({ where, orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { number: 'asc' }], take: query.number ? 1 : 200, select: BUNDLE_HEADER })
    const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.styleId))] } }, select: { id: true, code: true, name: true } })).map((style) => [style.id, style]))
    const workOrders = []
    for (const row of rows) {
      if (workOrders.length >= query.limit) break
      const { cells } = await countsOf(db, row)
      const toBundle = cells.reduce((sum, cell) => sum + cell.toBundle, 0)
      if (toBundle === 0 && !query.number) continue
      const labels = await readCellLabels(db, row.id)
      workOrders.push({
        id: row.id,
        number: row.number,
        batchNumber: row.batchNumber,
        status: row.status,
        siteId: row.siteId,
        dueDate: day(row.dueDate),
        priority: row.priority,
        style: styles.get(row.styleId) ?? { id: row.styleId, code: '', name: '' },
        toBundle,
        cells: cells.filter((cell) => cell.cut !== null).map((cell) => cellView(cell, labels.get(cell.cellId))),
      })
    }
    return { workOrders }
  })
}

// ---- a work order at the bundles step -----------------------------------------------------------------------------------------

/** A work order as the bundles step sees it: cells with counts and the proposed bundles, its bundles, operations, printers. */
export async function bundlesOfWorkOrder(caller: CommandCaller, workOrderId: string, query: { readonly bundleSize?: number | undefined }) {
  const workOrder = await bundleWorkOrder(caller, workOrderId, PRODUCTION_BUNDLES)
  const context = workerOf(caller)
  const singlePiece = workOrder.kind === 'MADE_TO_MEASURE'
  return caller.withClient(async (db) => {
    // The proposal's size: asked, else the site's standard bundle size (production settings), one for made-to-measure.
    const standardBundleSize = await standardBundleSizeFor(db, workOrder.siteId)
    const size = targetBundleSize(workOrder.kind, query.bundleSize, standardBundleSize)
    const style = await db.style.findUnique({ where: { id: workOrder.styleId }, select: { id: true, code: true, name: true } })
    const labels = await readCellLabels(db, workOrder.id)
    const bundles = await readBundles(db, workOrder.id)
    const { cells } = await countsOf(db, workOrder)
    const scans = await readScans(db, bundles.map((bundle) => bundle.id))
    const printers = await db.printer.findMany({ where: { siteId: workOrder.siteId, kind: 'LABEL_ZPL', status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } })
    const stationPrinterId = context.audience === 'floor' ? await stationPrinterOf(db, context.deviceId) : null
    return {
      workOrder: {
        id: workOrder.id,
        number: workOrder.number,
        batchNumber: workOrder.batchNumber,
        status: workOrder.status,
        kind: workOrder.kind,
        companyId: workOrder.companyId,
        siteId: workOrder.siteId,
        dueDate: day(workOrder.dueDate),
        open: CUTTABLE_STATUSES.includes(workOrder.status),
        style: style ?? { id: workOrder.styleId, code: '', name: '' },
      },
      bundleSize: size,
      standardBundleSize,
      singlePiece,
      cells: cells.filter((cell) => cell.cut !== null).map((cell) => ({ ...cellView(cell, labels.get(cell.cellId)), proposal: splitBundles(cell.toBundle, size) })),
      bundles: bundles.map((bundle) => ({ ...bundleView(bundle, labels), scans: scans.filter((scan) => scan.bundleId === bundle.id).length })),
      operations: (await readOperations(db, workOrder.id)).map((operation) => ({ id: operation.id, seq: operation.seq, code: operation.code, name: operation.name, scanRequired: operation.scanRequired })),
      /** The site's ACTIVE label printers. */
      printers,
      /** The floor device's station's label printer (MES-184), or null. */
      stationPrinterId,
      /** Where the tickets go when the make names no printer: the station's, else the site's only one; null: name one. */
      defaultPrinterId: stationPrinterId ?? (printers.length === 1 ? printers[0]!.id : null),
    }
  })
}

// ---- a scanned ticket -----------------------------------------------------------------------------------------------------------

/**
 * A scanned bundle ticket (the floor's bundle card; A2 SCR-095 "bundle-card", SCR-090's scan router): the bundle, its
 * work order, its operations with ticks (a standing report), and `refusal` when the code takes it no more: an old
 * ticket (REPLACED, with the new code in the words) or a void bundle. A label of another kind or another factory, or a
 * typo, is a 400 in words; a bundle of another site is not found.
 */
export async function scanBundle(caller: CommandCaller, query: { readonly code: string }) {
  const context = workerOf(caller)
  const typed = query.code.trim().toUpperCase()
  const scan = parseScanId(typed, { tenantTag: tenantTag(context.tenantId), types: ['BUNDLE'] })
  if (!scan.ok && scan.problem !== 'format') throw new ValidationError(scan.message, [{ path: 'querystring/code', message: scan.message }])
  const code = scan.ok ? scan.text : typed
  return caller.withClient(async (db) => {
    const bundle = await readBundleByCode(db, code)
    const workOrder = bundle ? await readHeader(db, bundle.workOrderId) : null
    if (!bundle || !workOrder || !mayBundle(context, PRODUCTION_BUNDLES, workOrder)) throw new NotFoundError('Not a bundle ticket of this site: scan the bundle’s ticket.')
    const labels = await readCellLabels(db, workOrder.id)
    const scans = await readScans(db, [bundle.id])
    const done = standingOperations(scans)
    const style = await db.style.findUnique({ where: { id: workOrder.styleId }, select: { id: true, code: true, name: true } })
    const operations = await readOperations(db, workOrder.id)
    return {
      scanned: code,
      refusal: scannedBundleRefusal(bundle, code),
      bundle: { ...bundleView(bundle, labels), scans: scans.length },
      workOrder: { id: workOrder.id, number: workOrder.number, batchNumber: workOrder.batchNumber, status: workOrder.status, siteId: workOrder.siteId, style: style ?? { id: workOrder.styleId, code: '', name: '' } },
      operations: operations.map((operation) => ({ id: operation.id, seq: operation.seq, code: operation.code, name: operation.name, scanRequired: operation.scanRequired, done: done.has(operation.id) })),
      ticket: ticketOf(await ticketBase(db, workOrder, 'it'), bundle, labels),
    }
  })
}

// ---- the office's bundles of a work order ---------------------------------------------------------------------------------------

async function hidesOf(db: Reader, cutLogIds: readonly string[]) {
  if (cutLogIds.length === 0) return new Map<string, { hideId: string; code: string; lotId: string; lotCode: string }>()
  const entries = await db.cutLog.findMany({ where: { id: { in: [...cutLogIds] } }, select: { id: true, hideId: true, lotId: true } })
  const hides = new Map((await db.hide.findMany({ where: { id: { in: [...new Set(entries.map((entry) => entry.hideId))] } }, select: { id: true, code: true } })).map((hide) => [hide.id, hide.code]))
  const lots = new Map((await db.lot.findMany({ where: { id: { in: [...new Set(entries.map((entry) => entry.lotId))] } }, select: { id: true, code: true } })).map((lot) => [lot.id, lot.code]))
  return new Map(entries.map((entry) => [entry.id, { hideId: entry.hideId, code: hides.get(entry.hideId) ?? '', lotId: entry.lotId, lotCode: lots.get(entry.lotId) ?? '' }]))
}

/**
 * A work order's bundles for the office (SCR-072 "Bundles"): each with its cell, part, garments, state, the operations
 * it is done at and its last scan (time, operation, station; never who), its genealogy (the hides and lots of its cut
 * log entries), its tickets' print jobs (with print.view) and its reprints with their reasons; and each cell's cut,
 * bundled and still-to-bundle counts.
 */
export async function workOrderBundles(caller: CommandCaller, workOrderId: string) {
  const workOrder = await bundleWorkOrder(caller, workOrderId, WORKORDERS_VIEW)
  const context = workerOf(caller)
  const seesPrints = can(actorOf(context), PRINT_VIEW, { companyId: workOrder.companyId, siteId: workOrder.siteId })
  return caller.withClient(async (db) => {
    const labels = await readCellLabels(db, workOrder.id)
    const bundles = await readBundles(db, workOrder.id)
    const { cells } = await countsOf(db, workOrder)
    const scans = await readScans(db, bundles.map((bundle) => bundle.id))
    const operations = new Map((await readOperations(db, workOrder.id)).map((operation) => [operation.id, operation]))
    const stations = new Map(
      (await db.station.findMany({ where: { id: { in: [...new Set(scans.flatMap((scan) => (scan.stationId ? [scan.stationId] : [])))] } }, select: { id: true, code: true, name: true } })).map((station) => [station.id, station]),
    )
    const genealogy = await hidesOf(db, [...new Set(bundles.flatMap((bundle) => bundle.cutLogIds))])
    const jobs = seesPrints ? await readTicketJobs(db, bundles.map((bundle) => bundle.id)) : []
    const reprints = await readReprints(db, bundles.map((bundle) => bundle.id))
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, siteId: workOrder.siteId },
      cells: cells.filter((cell) => cell.cut !== null).map((cell) => cellView(cell, labels.get(cell.cellId))),
      bundles: bundles.map((bundle) => {
        const own = scans.filter((scan) => scan.bundleId === bundle.id)
        const last = own.at(-1)
        const done = standingOperations(own)
        const hides = new Map(bundle.cutLogIds.flatMap((id) => (genealogy.has(id) ? [[genealogy.get(id)!.hideId, genealogy.get(id)!] as const] : [])))
        return {
          ...bundleView(bundle, labels),
          scans: own.length,
          doneAt: [...operations.values()].filter((operation) => done.has(operation.id)).map((operation) => operation.seq),
          lastScan: last
            ? { at: toUtcIso(last.serverTime), operation: { seq: operations.get(last.workOrderOperationId)?.seq ?? 0, code: operations.get(last.workOrderOperationId)?.code ?? '' }, station: last.stationId ? (stations.get(last.stationId) ?? null) : null }
            : null,
          hides: [...hides.values()].sort((a, b) => (a.code < b.code ? -1 : 1)),
          tickets: seesPrints ? jobs.filter((job) => job.recordId === bundle.id).map((job) => ({ jobId: job.id, printerId: job.printerId, scanId: job.scanId, status: job.status, lastError: job.lastError, createdAt: toUtcIso(job.createdAt) })) : null,
          // Its tickets printed again, oldest first, with why; on the floor or in the office (never who).
          reprints: reprints
            .filter((row) => row.bundleId === bundle.id)
            .map((row) => ({ code: row.code, replacedCode: row.replacedCode, reason: row.reason, printerId: row.printerId, postedBy: row.deviceId ? ('FLOOR' as const) : ('OFFICE' as const), at: toUtcIso(row.createdAt) })),
        }
      }),
    }
  })
}
