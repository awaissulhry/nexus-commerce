import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { scannedBundleRefusal } from '@nexus/factory-domain/production/bundles/rules'
import { PRODUCTION_SCAN, PRODUCTION_SCAN_CORRECT } from '@nexus/factory-domain/production/scans/permissions'
import {
  alreadyReported,
  capAt,
  finalOperationOf,
  isOpen,
  isOwn,
  operationFor,
  scannedOperations,
  sewnOperationOf,
  standingKey,
  standingScans,
  undoDelay,
  UNDO_WINDOW_MS,
  voidedIds,
  type Viewer,
} from '@nexus/factory-domain/production/scans/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { bundleFlowOf } from '../bundles/flow'
import { readBundleByCode, readCellLabels } from '../bundles/store'
import { hasAcknowledgedNotice, scanSubjectFor } from '../settings/subject'
import { floorOf, floorOrOffice, mayScan, officeOf, scanWorkOrder } from './access'
import { readCorrectionRequests } from './corrections-store'
import { readDefects } from './defects-store'
import type { ScanReason } from '@nexus/factory-domain/production/scans/reasons'
import { readReasons } from './reasons-store'
import { discardRefusal, readRefusal, readRefusals, type RefusalState } from './refusals-store'
import { requestView, scanView } from './scans'
import { deviceStationOf, latestOnDevice, readBundleScans, readHeader, readOperations, readOwnScans, readStations, readWorkOrderScans, siteTimeZone, workerNames } from './store'

/**
 * The scans' reads (B-W1-42; A2 SCR-090 the operation screen, SCR-072 a work order's scans, SCR-023 the refused scans;
 * design floor.operation, floor.sync): the bundle card a scan opens (its operations, what each passed, the standing
 * reports in the viewer's words, what this station does next and up to how many), the device's own work today (the
 * undo strip, the reports a correction may be asked of, its asks, its refused scans), a work order's scans for the
 * office (one record: the worker by name per row where the site records workers), the refused scans list and the
 * reasons. A floor viewer never sees another worker's name or figures: "another person" (Statuto dei Lavoratori art. 4).
 */

/** One reason tile as the screens read it (B-W2b-10, MES-125: with its icon, colour, other languages and "needs detail"). */
function reasonView(reason: ScanReason) {
  return { kind: reason.kind, code: reason.code, label: { ...reason.label }, sortOrder: reason.sortOrder, icon: reason.icon ?? null, colour: reason.colour ?? null, labelI18n: { ...(reason.labelI18n ?? {}) }, needsDetail: reason.needsDetail ?? false }
}

/** The reasons' tiles (the seam: the tenant's ScrapReason rows). */
export async function reasons(caller: CommandCaller) {
  floorOrOffice(caller)
  return { reasons: (await caller.withClient((client) => readReasons(client))).map(reasonView) }
}

// ---- the bundle card -------------------------------------------------------------------------------------------------------------

/**
 * A scanned bundle as the operation screen opens it: the bundle, its work order, the device's station, each operation
 * with its state (DONE: a standing report; OPEN: something passed to it; NOT_REACHED), the standing report in the
 * viewer's words (own, or "another person"; the station and the time), how many it may take (`expected`: what the
 * previous operation passed), and the operation this station does next (`next`, or `choose` when two fit). A label of
 * another kind or factory, or a typo, is a 400 in words; a bundle of another site is not found.
 */
export async function bundleCard(caller: CommandCaller, query: { readonly code: string }) {
  const context = floorOrOffice(caller)
  const typed = query.code.trim().toUpperCase()
  const scan = parseScanId(typed, { tenantTag: tenantTag(context.tenantId), types: ['BUNDLE'] })
  if (!scan.ok && scan.problem !== 'format') throw new ValidationError(scan.message, [{ path: 'querystring/code', message: scan.message }])
  const code = scan.ok ? scan.text : typed
  const card = await caller.withClient(async (db) => {
    const bundle = await readBundleByCode(db, code)
    const workOrder = bundle ? await readHeader(db, bundle.workOrderId) : null
    if (!bundle || !workOrder || !mayScan(context, PRODUCTION_SCAN, workOrder)) throw new NotFoundError('Not a bundle ticket of this site: scan the bundle’s ticket.')
    const operations = await readOperations(db, workOrder.id)
    const scans = await readBundleScans(db, bundle.id)
    // W2a B-W2a-13 hook (bundles/flow.ts): a split bundle's live garments and a child's place in the flow.
    const flow = await bundleFlowOf(db, bundle, operations, standingScans(scans))
    const standing = flow.standing
    const stationId = context.audience === 'floor' ? await deviceStationOf(db, context.deviceId) : null
    const stations = await readStations(db, [stationId, ...scans.map((row) => row.stationId)])
    const scanSubject = await scanSubjectFor(db, workOrder.siteId)
    const viewer: Viewer = { scanSubject, workerId: context.audience === 'floor' ? context.actorId : null, stationId }
    const labels = await readCellLabels(db, workOrder.id)
    const style = await db.style.findUnique({ where: { id: workOrder.styleId }, select: { code: true, name: true } })
    const station = stationId ? (stations.get(stationId) ?? null) : null
    const facts = { operations, station: station ? { code: station.code, kind: station.kind } : null, standing, bundleId: bundle.id, bundle }
    const next = operationFor(facts)
    // Every operation of this station's kind is reported: the card says so, with when and where (never who).
    const done = next.ok ? (standing.get(standingKey(bundle.id, next.operation.id)) ?? null) : null
    const timeZone = await siteTimeZone(db, workOrder.siteId)
    const final = finalOperationOf(operations)
    const sewn = sewnOperationOf(operations)
    return {
      bundle,
      workOrder,
      style,
      labels,
      station,
      operations: operations.map((operation) => {
        const report = standing.get(standingKey(bundle.id, operation.id)) ?? null
        const cap = capAt(operations, operation, { ...bundle, quantity: flow.quantity }, standing, bundle.id)
        const reached = cap.ok && cap.cap > 0
        return {
          id: operation.id,
          seq: operation.seq,
          code: operation.code,
          name: operation.name,
          scanRequired: operation.scanRequired,
          workCentreKind: operation.workCentreKind,
          final: operation.id === final?.id,
          sewn: operation.id === sewn?.id,
          state: report ? ('DONE' as const) : reached ? ('OPEN' as const) : ('NOT_REACHED' as const),
          expected: cap.ok ? cap.cap : null,
          report: report
            ? {
                scanId: report.id,
                kind: report.kind,
                goodQuantity: report.goodQuantity,
                scrapQuantity: report.scrapQuantity,
                reworkQuantity: report.reworkQuantity,
                serverTime: toUtcIso(report.serverTime),
                station: report.stationId && stations.get(report.stationId) ? { id: report.stationId, code: stations.get(report.stationId)!.code } : null,
                own: isOwn(report, viewer),
              }
            : null,
        }
      }),
      next: next.ok && !done ? next.operation.id : null,
      choose: !next.ok && next.refusal.code === 'CHOOSE_OPERATION' ? scannedOperations(operations).filter((operation) => !standing.has(standingKey(bundle.id, operation.id)) && operation.workCentreKind === station?.kind).map((operation) => operation.id) : [],
      hint: !next.ok
        ? { code: next.refusal.code, message: next.refusal.message, fix: next.refusal.fix }
        : done
          ? (({ code, message, fix }) => ({ code, message, fix }))(alreadyReported(bundle.code, done, viewer, { operation: next.operation, stationCode: done.stationId ? (stations.get(done.stationId)?.code ?? null) : null, timeZone }))
          : null,
    }
  })
  const label = card.labels.get(card.bundle.workOrderSizeId)
  const ticket = scannedBundleRefusal(card.bundle, code)
  return {
    scanned: code,
    refusal: ticket ? { code: ticket.code, message: ticket.message } : !isOpen(card.workOrder.status) ? { code: 'WORK_ORDER_NOT_OPEN' as const, message: `Work order ${card.workOrder.number} is ${card.workOrder.status}; its bundles are scanned only while it is released or in progress.` } : null,
    bundle: { id: card.bundle.id, code: card.bundle.code, status: card.bundle.status, quantity: card.bundle.quantity, part: card.bundle.part, workOrderSizeId: card.bundle.workOrderSizeId, colourwayCode: label?.colourwayCode ?? '', colourwayName: label?.colourwayName ?? '', size: label?.size ?? '' },
    workOrder: { id: card.workOrder.id, number: card.workOrder.number, batchNumber: card.workOrder.batchNumber, status: card.workOrder.status, siteId: card.workOrder.siteId, style: card.style ?? { code: '', name: '' } },
    station: card.station ? { id: card.station.id, code: card.station.code, name: card.station.name, kind: card.station.kind } : null,
    operations: card.operations,
    next: card.next,
    choose: card.choose,
    hint: card.hint,
    reasons: (await caller.withClient((client) => readReasons(client))).map(reasonView),
  }
}

// ---- the device's own work ---------------------------------------------------------------------------------------------------------

/**
 * The floor's own work today (design floor.operation: the undo strip, "Ask a correction → your reports today"; floor.sync
 * the refused list): own = the signed-in worker's at a site that names workers, the device's station's at a site that
 * records stations. Other people's refused scans of this device are a count, never shown.
 */
export async function mine(caller: CommandCaller) {
  const context = floorOf(caller)
  const now = serverClock.now()
  const own = await caller.withClient(async (db) => {
    const scanSubject = await scanSubjectFor(db, context.siteId)
    const stationId = await deviceStationOf(db, context.deviceId)
    const timeZone = await siteTimeZone(db, context.siteId)
    const since = businessDayStart(businessDate(now, timeZone), timeZone)
    const viewer: Viewer = { scanSubject, workerId: context.actorId, stationId }
    const scans = scanSubject === 'WORKER' ? await readOwnScans(db, { siteId: context.siteId, workerId: context.actorId, since }) : stationId ? await readOwnScans(db, { siteId: context.siteId, stationId, since }) : []
    const latestId = await latestOnDevice(db, context.deviceId)
    const rows = []
    const operationsOf = new Map<string, Awaited<ReturnType<typeof readOperations>>>()
    const scansOf = new Map<string, Awaited<ReturnType<typeof readBundleScans>>>()
    const codes = new Map((await db.bundle.findMany({ where: { id: { in: [...new Set(scans.map((scan) => scan.bundleId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    for (const scan of scans.filter((row) => row.kind !== 'UNDO')) {
      if (!scansOf.has(scan.bundleId)) scansOf.set(scan.bundleId, await readBundleScans(db, scan.bundleId))
      if (!operationsOf.has(scan.workOrderId)) operationsOf.set(scan.workOrderId, await readOperations(db, scan.workOrderId))
      rows.push({ scan, operations: operationsOf.get(scan.workOrderId)!, code: codes.get(scan.bundleId) ?? '', standing: !voidedIds(scansOf.get(scan.bundleId)!).has(scan.id) })
    }
    const latest = latestId ? rows.find((row) => row.scan.id === latestId) : undefined
    const undoable = latest && latest.scan.kind === 'REPORT' && latest.standing && latest.scan.deviceId === context.deviceId && isOwn(latest.scan, viewer) && undoDelay(latest.scan, null, now) <= UNDO_WINDOW_MS
    return { scanSubject, stationId, since, rows, undoable: undoable ? latest! : null }
  })
  const extra = await caller.withClient(async (db) => {
    const defects = await readDefects(db, own.rows.map((row) => row.scan.id))
    const requests = await readCorrectionRequests(db, { siteIds: [context.siteId], since: own.since, ...(own.scanSubject === 'WORKER' ? { askedById: context.actorId } : own.stationId ? { stationId: own.stationId } : { deviceId: context.deviceId }) })
    const pending = new Set((await readCorrectionRequests(db, { siteIds: [context.siteId], status: 'PENDING', scanIds: own.rows.map((row) => row.scan.id) })).map((request) => request.scanId))
    const refused = await readRefusals(db, { siteIds: [context.siteId], deviceId: context.deviceId, open: true })
    return { defects, requests, pending, refused }
  })
  const mineRefused = extra.refused.filter((row) => (own.scanSubject === 'WORKER' ? row.workerId === context.actorId : true))
  return {
    since: toUtcIso(own.since),
    undo: own.undoable ? { scanId: own.undoable.scan.id, bundleCode: own.undoable.code, until: toUtcIso(new Date(own.undoable.scan.serverTime.getTime() + UNDO_WINDOW_MS)) } : null,
    reports: own.rows.map((row) => ({ ...scanView(row.scan, row.operations, row.code, extra.defects.get(row.scan.id) ?? []), standing: row.standing, correctionPending: extra.pending.has(row.scan.id) })),
    requests: extra.requests.map(requestView).reverse(),
    refused: mineRefused.map(refusalRow),
    /** Other people's open refused scans on this device: counted, never shown (their team leader sees them). */
    othersRefused: extra.refused.length - mineRefused.length,
  }
}

// ---- a work order's scans (the office) ------------------------------------------------------------------------------------------------

/**
 * Every scan of a work order (or one bundle of it), oldest first, for the office's work order record and bundle drawer
 * (design bd-scans): kind, operation, counts, reasons, device and server time, station, the worker by name where the scan
 * names one (one record: Owner answer W1), who approved a correction, and the scan that voids it.
 */
export async function workOrderScans(caller: CommandCaller, workOrderId: string, query: { readonly bundleId?: string | undefined }) {
  officeOf(caller)
  const workOrder = await scanWorkOrder(caller, workOrderId, WORKORDERS_VIEW)
  return caller.withClient(async (db) => {
    const scans = (await readWorkOrderScans(db, workOrder.id)).filter((scan) => query.bundleId === undefined || scan.bundleId === query.bundleId)
    const operations = await readOperations(db, workOrder.id)
    const bundles = new Map((await db.bundle.findMany({ where: { workOrderId: workOrder.id }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const defects = await readDefects(db, scans.map((scan) => scan.id))
    const names = await workerNames(db, scans.map((scan) => scan.workerId))
    const stations = await readStations(db, scans.map((scan) => scan.stationId))
    const voidedBy = new Map(scans.flatMap((scan) => (scan.correctsId ? [[scan.correctsId, scan.id] as const] : [])))
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, siteId: workOrder.siteId },
      scans: scans.map((scan) => ({
        ...scanView(scan, operations, bundles.get(scan.bundleId) ?? '', defects.get(scan.id) ?? []),
        scrapReason: scan.scrapReason,
        worker: scan.workerId ? { id: scan.workerId, name: names.get(scan.workerId) ?? '' } : null,
        station: scan.stationId && stations.get(scan.stationId) ? { id: scan.stationId, code: stations.get(scan.stationId)!.code, name: stations.get(scan.stationId)!.name } : null,
        approvedById: scan.approvedById,
        voidedById: voidedBy.get(scan.id) ?? null,
      })),
    }
  })
}

// ---- refused scans ----------------------------------------------------------------------------------------------------------------------

function refusalRow(row: RefusalState) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    clientScanId: row.clientScanId,
    action: row.action,
    code: row.code,
    message: row.message,
    fix: row.fix,
    final: row.final,
    workOrderId: row.workOrderId,
    bundleId: row.bundleId,
    workOrderOperationId: row.workOrderOperationId,
    scanned: row.scanned,
    goodQuantity: row.goodQuantity,
    scrapQuantity: row.scrapQuantity,
    reworkQuantity: row.reworkQuantity,
    stationId: row.stationId,
    deviceTime: row.deviceTime,
    serverTime: row.serverTime,
    discardedAt: row.discardedAt,
    resolvedByScanId: row.resolvedByScanId,
    resolvedByRequestId: row.resolvedByRequestId,
  }
}

/** The refused scans of the caller's sites (SCR-023's data for the office; design floor.sync): open ones by default; no names (a list). */
export async function listRefusals(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly deviceId?: string | undefined; readonly workOrderId?: string | undefined; readonly all?: boolean | undefined; readonly limit: number }) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const sites = await db.site.findMany({ where: { AND: [scopeWhere(actorOf(context), PRODUCTION_SCAN_CORRECT, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, query.siteId ? { id: query.siteId } : {}] }, select: { id: true } })
    if (sites.length === 0) return { refusals: [] }
    const rows = await readRefusals(db, { siteIds: sites.map((site) => site.id), ...(query.deviceId ? { deviceId: query.deviceId } : {}), ...(query.workOrderId ? { workOrderId: query.workOrderId } : {}), open: !query.all })
    const devices = new Map((await db.device.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.deviceId))] } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]))
    return { refusals: rows.slice(0, query.limit).map((row) => ({ ...refusalRow(row), siteId: row.siteId, device: { id: row.deviceId, name: devices.get(row.deviceId) ?? '' } })) }
  })
}

/** One refused scan for the office (one record: who sent it, by name, where the site names workers). */
export async function refusalOf(caller: CommandCaller, refusalId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const row = await readRefusal(db, refusalId)
    const site = row ? await db.site.findUnique({ where: { id: row.siteId }, select: { id: true, companyId: true } }) : null
    if (!row || !site || !mayScan(context, PRODUCTION_SCAN_CORRECT, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Refused scan not found.')
    const names = await workerNames(db, [row.workerId])
    const device = await db.device.findUnique({ where: { id: row.deviceId }, select: { id: true, name: true } })
    return { refusal: { ...refusalRow(row), siteId: row.siteId, device: { id: row.deviceId, name: device?.name ?? '' }, worker: row.workerId ? { id: row.workerId, name: names.get(row.workerId) ?? '' } : null, discardedById: row.discardedById } }
  })
}

/** "Discard" (design sync.discard): the device's own refused scan, or the office's for its sites. Once. */
export async function discard(caller: CommandCaller, refusalId: string, idempotencyKey?: string) {
  const context = floorOrOffice(caller)
  const row = await caller.withClient((db) => readRefusal(db, refusalId))
  if (!row) throw new NotFoundError('Refused scan not found.')
  if (context.audience === 'floor') {
    if (row.deviceId !== context.deviceId) throw new NotFoundError('Refused scan not found.')
  } else {
    const site = await caller.withClient((db) => db.site.findUnique({ where: { id: row.siteId }, select: { id: true, companyId: true } }))
    if (!site || !mayScan(context, PRODUCTION_SCAN_CORRECT, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Refused scan not found.')
  }
  // Who discarded it: the office user; on the floor the worker, where the site names workers and they acknowledged the
  // notice in force (no floor record names a worker before that), else nobody (the station's tablet did).
  const by =
    context.audience === 'office'
      ? context.actorId
      : await caller.withClient(async (db) => ((await scanSubjectFor(db, row.siteId)) === 'WORKER' && (await hasAcknowledgedNotice(db, row.siteId, context.actorId)) ? context.actorId : null))
  // A floor write needs an Idempotency-Key: the device's own, else one per refusal (a repeat answers the first discard).
  const kept = await discardRefusal(caller, row, { discardedById: by, idempotencyKey: idempotencyKey ?? (context.audience === 'floor' ? `d.${row.id}` : undefined) })
  return { refusal: refusalRow({ ...row, ...kept }) }
}

