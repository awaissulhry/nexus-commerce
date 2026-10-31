import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_SCAN_CORRECT } from '@nexus/factory-domain/production/scans/permissions'
import { correctionApprovalRefusal, decidedRefusal, scrapReasonColumn, standingScans } from '@nexus/factory-domain/production/scans/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { bundleFlowOf } from '../bundles/flow'
import { lockBundleForScan, readBundle } from '../bundles/store'
import { mayScan, officeOf, refuse } from './access'
import { decideCorrectionRequest, lockCorrectionRequest, readCorrectionRequest, readCorrectionRequests, type CorrectionRequest, type CorrectionStatus } from './corrections-store'
import { readDefects, writeDefects } from './defects-store'
import { refuseIfHeld, requestView, scanEvent, scanView } from './scans'
import { lockBundleScans, readBundleScans, readHeader, readOperations, readScan, readStations, scanWorkOrderLock, workerNames, workerUsers, type Reader } from './store'

/**
 * The office's decisions on the floor's correction requests (B-W1-42; MES-096; design floor.operation "correction":
 * W1 approval in Office › Home › Approvals; A2 note 7; c.c. art. 2101: the original stays). production.scan.correct over
 * the work order's company and site. Approve = ONE command: the request's lock → the work order's scan lock (shared) →
 * the bundle FOR SHARE → the bundle's scan lock → the rules read again (the request still PENDING; the approver neither
 * took the scan nor asked, nor is the office user of the worker who did; the scan still stands; the counts within the
 * caps and at least what the next operation took) → a CORRECTION row (the old scan's worker and station, the asked
 * counts, the request's reason, approved by the approver; no device) with its lines → the request APPROVED with it.
 * Refuse = the request REFUSED with the note. Lists name no worker (Owner answer W1: names only inside one record); the
 * request's own record does, where the site records workers.
 */

async function officeRequest(caller: CommandCaller, requestId: string): Promise<CorrectionRequest> {
  const context = officeOf(caller)
  const request = await caller.withClient((client) => readCorrectionRequest(client, requestId))
  if (!request || !mayScan(context, PRODUCTION_SCAN_CORRECT, { companyId: request.companyId, siteId: request.siteId })) throw new NotFoundError('Correction request not found.')
  return request
}

/** The people a request's approver may not be: who took the scan, who asked, and the office users those workers are. */
async function involvedOf(db: Reader, request: CorrectionRequest, scan: { readonly workerId: string | null; readonly createdById: string | null }): Promise<Set<string>> {
  const ids = new Set<string>([scan.workerId, scan.createdById, request.askedById].filter((value): value is string => value !== null))
  // The audit rows keep who wrote the scan and the ask also where the site records stations only.
  const actors = await db.auditLog.findMany({
    where: { OR: [{ recordType: 'OperationScan', recordId: request.scanId }, { recordType: 'ScanCorrectionRequest', recordId: request.id, action: 'production.askScanCorrection' }] },
    select: { actorId: true },
  })
  for (const row of actors) ids.add(row.actorId)
  for (const userId of await workerUsers(db, [...ids])) ids.add(userId)
  return ids
}

export async function approveCorrection(caller: CommandCaller, requestId: string, body: { readonly note?: string | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const named = await officeRequest(caller, requestId)
  const note = body.note?.trim() || null
  const { result } = await command(caller, { name: 'production.approveScanCorrection', idempotencyKey, input: { requestId, note } }, async (tools: CommandTools) => {
    const { tx } = tools
    const request = (await lockCorrectionRequest(tx, context.tenantId, named.id))!
    const stale = decidedRefusal(request.status)
    if (stale) refuse(stale)
    await scanWorkOrderLock(tx, context.tenantId, request.workOrderId)
    const locked = await lockBundleForScan(tx, request.bundleId)
    if (!locked) throw new NotFoundError('Correction request not found.')
    await lockBundleScans(tx, context.tenantId, request.siteId, request.bundleId)
    // W2a B-W2a-26 hook: a correction of a bundle or work order on hold waits for the hold's release.
    await refuseIfHeld(tools, request.bundleId, request.workOrderId)
    const workOrder = (await readHeader(tx, request.workOrderId))!
    const operations = await readOperations(tx, workOrder.id)
    const scans = await readBundleScans(tx, request.bundleId)
    const target = scans.find((scan) => scan.id === request.scanId) ?? null
    const involved = target ? await involvedOf(tx, request, target) : new Set<string>()
    // W2b B-W2b-10 hook (bundles/flow.ts): a split parent's correction is capped at its live garments.
    const flow = await bundleFlowOf(tx, locked.bundle, operations, standingScans(scans))
    const refusal = correctionApprovalRefusal({
      workOrder,
      bundle: { code: locked.bundle.code, quantity: flow.quantity },
      standing: flow.standing,
      target,
      operations,
      scans,
      counts: { good: request.goodQuantity, scrap: request.scrapQuantity, rework: request.reworkQuantity },
      lines: request.defects,
      targetLines: target ? ((await readDefects(tx, [target.id])).get(target.id) ?? []) : [],
      status: request.status,
      approverInvolved: involved.has(context.actorId),
    })
    if (refusal) refuse(refusal)
    const id = newId()
    await tx.operationScan.create({
      data: {
        id,
        siteId: request.siteId,
        workOrderId: workOrder.id,
        workOrderOperationId: request.workOrderOperationId,
        bundleId: request.bundleId,
        kind: 'CORRECTION',
        correctsId: target!.id,
        goodQuantity: request.goodQuantity,
        scrapQuantity: request.scrapQuantity,
        reworkQuantity: request.reworkQuantity,
        scrapReason: scrapReasonColumn(request.defects),
        reason: request.reason,
        approvedById: context.actorId,
        // The corrected scan's own worker and station (the trigger's rule): the record still says who did the work.
        workerId: target!.workerId,
        stationId: target!.stationId,
        deviceId: null,
        clientScanId: `correction.${request.id}`,
        deviceTime: null,
        serverTime: tools.now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    await writeDefects(tools, { scanId: id, siteId: workOrder.siteId, createdById: context.actorId }, request.defects)
    const after: CorrectionRequest = { ...request, status: 'APPROVED', decidedById: context.actorId, decidedAt: toUtcIso(tools.now), decisionNote: note, correctionScanId: id, version: request.version + 1 }
    await decideCorrectionRequest(tools, request, after)
    const row = (await readScan(tx, id))!
    const operation = operations.find((entry) => entry.id === request.workOrderOperationId)!
    tools.audit({ action: 'production.approveScanCorrection', recordType: 'OperationScan', recordId: id, companyId: workOrder.companyId, siteId: workOrder.siteId, before: { scanId: target!.id, goodQuantity: target!.goodQuantity, scrapQuantity: target!.scrapQuantity, reworkQuantity: target!.reworkQuantity }, after: { correctsId: target!.id, requestId: request.id, goodQuantity: row.goodQuantity, scrapQuantity: row.scrapQuantity, reworkQuantity: row.reworkQuantity }, reason: request.reason })
    tools.audit({ action: 'production.approveScanCorrection', recordType: 'WorkOrder', recordId: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { scanId: id, correctsId: target!.id, requestId: request.id }, reason: request.reason })
    tools.emit(scanEvent(workOrder, row, operation.seq, 'OFFICE'))
    tools.emit({ type: 'production.scan_correction_decided', subject: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, payload: { workOrderId: workOrder.id, number: workOrder.number, requestId: request.id, scanId: target!.id, decision: 'APPROVED', correctionScanId: id } })
    return { request: requestView(after), scan: scanView(row, operations, locked.bundle.code, request.defects) }
  })
  return result
}

export async function refuseCorrection(caller: CommandCaller, requestId: string, body: { readonly note: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const named = await officeRequest(caller, requestId)
  const note = body.note.trim()
  const { result } = await command(caller, { name: 'production.refuseScanCorrection', idempotencyKey, input: { requestId, note } }, async (tools) => {
    const request = (await lockCorrectionRequest(tools.tx, context.tenantId, named.id))!
    const stale = decidedRefusal(request.status)
    if (stale) refuse(stale)
    const workOrder = (await readHeader(tools.tx, request.workOrderId))!
    const after: CorrectionRequest = { ...request, status: 'REFUSED', decidedById: context.actorId, decidedAt: toUtcIso(tools.now), decisionNote: note, version: request.version + 1 }
    await decideCorrectionRequest(tools, request, after)
    tools.audit({ action: 'production.refuseScanCorrection', recordType: 'WorkOrder', recordId: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { requestId: request.id, scanId: request.scanId }, reason: note })
    tools.emit({ type: 'production.scan_correction_decided', subject: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, payload: { workOrderId: workOrder.id, number: workOrder.number, requestId: request.id, scanId: request.scanId, decision: 'REFUSED', correctionScanId: null } })
    return { request: requestView(after) }
  })
  return result
}

// ---- reads ---------------------------------------------------------------------------------------------------------------------------

/** One line of the Approvals list: what, where and the counts asked vs recorded; never who (a list). */
async function listRows(db: Reader, requests: readonly CorrectionRequest[]) {
  const rows = []
  for (const request of requests) {
    const workOrder = await readHeader(db, request.workOrderId)
    const operations = workOrder ? await readOperations(db, workOrder.id) : []
    const operation = operations.find((entry) => entry.id === request.workOrderOperationId)
    const bundle = await readBundle(db, request.bundleId)
    const scan = await readScan(db, request.scanId)
    rows.push({
      ...requestView(request),
      workOrder: { id: request.workOrderId, number: workOrder?.number ?? '', status: workOrder?.status ?? 'RELEASED' },
      bundleCode: bundle?.code ?? '',
      operation: { id: request.workOrderOperationId, seq: operation?.seq ?? 0, code: operation?.code ?? '', name: operation?.name ?? '' },
      recorded: scan ? { goodQuantity: scan.goodQuantity, scrapQuantity: scan.scrapQuantity, reworkQuantity: scan.reworkQuantity, serverTime: toUtcIso(scan.serverTime) } : null,
    })
  }
  return rows
}

export async function listCorrections(caller: CommandCaller, query: { readonly status?: CorrectionStatus | undefined; readonly workOrderId?: string | undefined; readonly siteId?: string | undefined; readonly limit: number }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const sites = await db.site.findMany({ where: { AND: [scopeWhere(actor, PRODUCTION_SCAN_CORRECT, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, query.siteId ? { id: query.siteId } : {}] }, select: { id: true } })
    const requests = await readCorrectionRequests(db, { siteIds: sites.map((site) => site.id), ...(query.status ? { status: query.status } : {}), ...(query.workOrderId ? { workOrderId: query.workOrderId } : {}) })
    const newestFirst = [...requests].reverse().slice(0, query.limit)
    return { requests: await listRows(db, newestFirst) }
  })
}

/** One request: the list's facts, plus who asked and who took the scan by name where the site records workers (one record). */
export async function correctionOf(caller: CommandCaller, requestId: string) {
  const request = await officeRequest(caller, requestId)
  return caller.withClient(async (db) => {
    const [row] = await listRows(db, [request])
    const scan = await readScan(db, request.scanId)
    const names = await workerNames(db, [request.askedById, scan?.workerId ?? null])
    const stations = await readStations(db, [request.stationId, scan?.stationId ?? null])
    const person = (id: string | null) => (id ? { id, name: names.get(id) ?? '' } : null)
    const station = (id: string | null) => (id && stations.get(id) ? { id, code: stations.get(id)!.code, name: stations.get(id)!.name } : null)
    return {
      request: {
        ...row!,
        askedBy: person(request.askedById),
        askedAt: station(request.stationId),
        decidedById: request.decidedById,
        scan: scan ? { id: scan.id, kind: scan.kind, worker: person(scan.workerId), station: station(scan.stationId), defects: (await readDefects(db, [scan.id])).get(scan.id) ?? [] } : null,
      },
    }
  })
}
