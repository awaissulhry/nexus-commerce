import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { CORRECTION_REFUSAL_TILES, correctionRefusalNeedsWords, correctionRefusalNote, type CorrectionRefusalReason } from '@nexus/factory-domain/production/scans/correction-refusals'
import { PRODUCTION_SCAN_CORRECT } from '@nexus/factory-domain/production/scans/permissions'
import { correctionApprovalRefusal, decidedRefusal, scrapReasonColumn, selfApprovalRefusal, standingScans, type DefectLine } from '@nexus/factory-domain/production/scans/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { workerGateFor, workersAmong } from '../../people/privacy/worker-gate'
import { bundleFlowOf } from '../bundles/flow'
import { lockBundleForScan, readBundle } from '../bundles/store'
import { floorOf, mayScan, officeOf, refuse, systemView } from './access'
import { decideCorrectionRequest, lockCorrectionRequest, readCorrectionRequest, readCorrectionRequests, type CorrectionRequest, type CorrectionStatus } from './corrections-store'
import { readDefects, writeDefects } from './defects-store'
import { refuseIfHeld, requestView, scanEvent, scanView } from './scans'
import { lockBundleScans, readBundleScans, readHeader, readOperations, readScan, readStations, scanWorkOrderLock, workerNames, workerUsers, type Reader, type ScanRow } from './store'

/**
 * The decisions on the floor's correction requests (B-W1-42; MES-096; design floor.operation "correction": W1 approval in
 * Office › Home › Approvals, W2b the Line view; A2 note 7; c.c. art. 2101: the original stays). Two deciders, one path:
 *
 *   the office       production.scan.correct over the work order's company and site.
 *   the team leader  floor.lead at the tablet's own site, with the PIN (B-W2b-83; design floor.supervisor "Waiting for you"):
 *                    requireFloorStepUp after every other check, for an approval and a refusal, which needs a reason tile.
 *                    decidedById and approvedById are the worker. The list names nobody; the one record names the person
 *                    where the scan does (no gate: a floor screen's rule, on the labour lawyer's list).
 *
 * Approve = ONE command: the request's lock → the work order's scan lock (shared) → the bundle FOR SHARE → the bundle's scan
 * lock → the rules read again (the request still PENDING; the approver neither took the scan nor asked, nor is the office
 * user of the worker who did; the scan still stands; the counts within the caps and at least what the next operation took) →
 * a CORRECTION row (the old scan's worker and station, the asked counts, the request's reason, approved by the approver; no
 * device) with its lines → the request APPROVED with it. Refuse = the same four eyes, the request REFUSED with the note.
 *
 * Four eyes on the floor: a floor session's trigger compares ids only (the role is refused Worker.userId), so the link
 * between a worker and an office account is read HERE, in the tenant's system scope, both ways: the office accounts of the
 * people involved, and the office account the deciding team leader is. The audit rows that keep who wrote a scan are
 * read in that scope too (the floor role reads none); always of the tablet's own site.
 *
 * Lists name no worker (Owner answer W1: names only inside one record); the office's record of a request does, where the
 * site records workers and its PERFORMANCE gate is on (off: it says a person is on it).
 */

/** At most this many rows on the tablet, the oldest first. */
const FLOOR_ROWS = 100

interface Decider {
  readonly on: 'OFFICE' | 'FLOOR'
  readonly tenantId: string
  /** decidedById and approvedById: the office user, or the team leader's worker. */
  readonly actorId: string
  /** Who this person is for four eyes: the actor and, for a worker, the office account they also are. */
  readonly ids: readonly string[]
  /** Reads the audit rows and the workers' office accounts: the office's client; for a floor session the tenant's system scope. */
  read<T>(work: (db: Reader) => Promise<T>): Promise<T>
}

interface DecisionOptions {
  readonly idempotencyKey?: string | undefined
  /** The floor's PIN: run after every other check, while the request still waits. */
  readonly stepUp?: (() => void) | undefined
}

async function officeRequest(caller: CommandCaller, requestId: string): Promise<CorrectionRequest> {
  const context = officeOf(caller)
  const request = await caller.withClient((client) => readCorrectionRequest(client, requestId))
  if (!request || !mayScan(context, PRODUCTION_SCAN_CORRECT, { companyId: request.companyId, siteId: request.siteId })) throw new NotFoundError('Correction request not found.')
  return request
}

/** The request a team leader reaches: floor.lead at the tablet's own site, else not found. */
async function floorRequest(caller: CommandCaller, requestId: string): Promise<{ context: FloorContext; request: CorrectionRequest }> {
  const context = floorOf(caller)
  const request = await caller.withClient((client) => readCorrectionRequest(client, requestId))
  if (!request || !mayScan(context, 'floor.lead', { companyId: request.companyId, siteId: request.siteId })) throw new NotFoundError('Correction request not found.')
  return { context, request }
}

const officeDecider = (caller: CommandCaller): Decider => {
  const context = officeOf(caller)
  return { on: 'OFFICE', tenantId: context.tenantId, actorId: context.actorId, ids: [context.actorId], read: (work) => caller.withClient((client) => work(client)) }
}

/** The worker and the office account they also are (system scope: the floor role is refused Worker.userId). */
const floorIds = async (db: Reader, context: FloorContext): Promise<string[]> => [context.actorId, ...(await workerUsers(db, [context.actorId]))]

async function floorDecider(caller: CommandCaller, context: FloorContext): Promise<Decider> {
  const system = systemView(caller)
  const ids = await system.withClient((db) => floorIds(db, context))
  return { on: 'FLOOR', tenantId: context.tenantId, actorId: context.actorId, ids, read: (work) => system.withClient((db) => work(db)) }
}

/** The people each request's approver may not be: who took the scan, who asked, and the office users those workers are. */
async function involvedIn(db: Reader, requests: readonly CorrectionRequest[]): Promise<Map<string, Set<string>>> {
  const scans = new Map((await db.operationScan.findMany({ where: { id: { in: requests.map((request) => request.scanId) } }, select: { id: true, workerId: true, createdById: true } })).map((row) => [row.id, row]))
  // The audit rows keep who wrote the scan and the ask also where the site records stations only.
  const actors = await db.auditLog.findMany({
    where: { OR: [{ recordType: 'OperationScan', recordId: { in: requests.map((request) => request.scanId) } }, { recordType: 'ScanCorrectionRequest', recordId: { in: requests.map((request) => request.id) }, action: 'production.askScanCorrection' }] },
    select: { recordType: true, recordId: true, actorId: true },
  })
  const involved = new Map(
    requests.map((request) => {
      const scan = scans.get(request.scanId)
      const ids = new Set<string>([scan?.workerId, scan?.createdById, request.askedById].filter((value): value is string => typeof value === 'string'))
      for (const row of actors) if (row.recordId === (row.recordType === 'OperationScan' ? request.scanId : request.id)) ids.add(row.actorId)
      return [request.id, ids]
    }),
  )
  const everyone = [...new Set([...involved.values()].flatMap((ids) => [...ids]))]
  const accounts = new Map((await db.worker.findMany({ where: { id: { in: everyone } }, select: { id: true, userId: true } })).flatMap((row) => (row.userId ? [[row.id, row.userId] as const] : [])))
  for (const ids of involved.values()) {
    for (const id of [...ids]) {
      const account = accounts.get(id)
      if (account) ids.add(account)
    }
  }
  return involved
}

const isInvolved = (involved: ReadonlySet<string> | undefined, ids: readonly string[]) => ids.some((id) => involved?.has(id))

/** Is this person someone who took the scan or asked? Read once, before the command: the scan, the ask and their actors do not change. */
const decidesOwn = (request: CorrectionRequest, decider: Decider): Promise<boolean> => decider.read(async (db) => isInvolved((await involvedIn(db, [request])).get(request.id), decider.ids))

/** The approval's facts and rule on the reader given: under the command's locks, and once on the floor before a PIN is asked. */
async function approvalFacts(db: Reader, request: CorrectionRequest, bundle: { readonly id: string; readonly code: string; readonly quantity: number }, own: boolean) {
  const workOrder = (await readHeader(db, request.workOrderId))!
  const operations = await readOperations(db, workOrder.id)
  const scans = await readBundleScans(db, request.bundleId)
  const target = scans.find((scan) => scan.id === request.scanId) ?? null
  // W2b B-W2b-10 hook (bundles/flow.ts): a split parent's correction is capped at its live garments.
  const flow = await bundleFlowOf(db, bundle, operations, standingScans(scans))
  const refusal = correctionApprovalRefusal({
    workOrder,
    bundle: { code: bundle.code, quantity: flow.quantity },
    standing: flow.standing,
    target,
    operations,
    scans,
    counts: { good: request.goodQuantity, scrap: request.scrapQuantity, rework: request.reworkQuantity },
    lines: request.defects,
    targetLines: target ? ((await readDefects(db, [target.id])).get(target.id) ?? []) : [],
    status: request.status,
    approverInvolved: own,
  })
  return { workOrder, operations, target, refusal }
}

/** A version sent with the decision still stands (the tablet's row): after the DECIDED_ALREADY check, which says more. */
const sameVersion = (request: CorrectionRequest, version: number | undefined) => {
  if (version !== undefined && version !== request.version) throw new StaleVersionError('ScanCorrectionRequest', request.id, request.version, version)
}

interface Approved {
  readonly request: CorrectionRequest
  readonly scan: ScanRow
  readonly operations: Parameters<typeof scanView>[1]
  readonly bundleCode: string
}

/**
 * ONE command for either decider. On the floor every other check runs before the PIN, while the request waits. A request
 * decided already signs nothing, so it asks no PIN: `command` answers a repeat from its receipt, or refuses in words.
 */
async function approveRequest<Answer>(caller: CommandCaller, named: CorrectionRequest, input: { readonly note?: string | undefined; readonly version?: number | undefined }, decider: Decider, options: DecisionOptions, answer: (approved: Approved) => Answer): Promise<Answer> {
  const note = input.note?.trim() || null
  const own = await decidesOwn(named, decider)
  if (options.stepUp && named.status === 'PENDING') {
    const early = await caller.withClient(async (db) => {
      const bundle = await readBundle(db, named.bundleId)
      return bundle ? (await approvalFacts(db, named, bundle, own)).refusal : null
    })
    if (early) refuse(early)
    options.stepUp()
  }
  const { result } = await command(caller, { name: 'production.approveScanCorrection', idempotencyKey: options.idempotencyKey, input: { requestId: named.id, note, ...(input.version === undefined ? {} : { version: input.version }) } }, async (tools: CommandTools) => {
    const { tx } = tools
    const request = (await lockCorrectionRequest(tx, decider.tenantId, named.id))!
    const stale = decidedRefusal(request.status)
    if (stale) refuse(stale)
    sameVersion(request, input.version)
    await scanWorkOrderLock(tx, decider.tenantId, request.workOrderId)
    const locked = await lockBundleForScan(tx, request.bundleId)
    if (!locked) throw new NotFoundError('Correction request not found.')
    await lockBundleScans(tx, decider.tenantId, request.siteId, request.bundleId)
    // W2a B-W2a-26 hook: a correction of a bundle or work order on hold waits for the hold's release.
    await refuseIfHeld(tools, request.bundleId, request.workOrderId)
    const { workOrder, operations, target, refusal } = await approvalFacts(tx, request, locked.bundle, own)
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
        approvedById: decider.actorId,
        // The corrected scan's own worker and station (the trigger's rule): the record still says who did the work.
        workerId: target!.workerId,
        stationId: target!.stationId,
        deviceId: null,
        clientScanId: `correction.${request.id}`,
        deviceTime: null,
        serverTime: tools.now,
        createdById: decider.actorId,
      },
      select: { id: true },
    })
    await writeDefects(tools, { scanId: id, siteId: workOrder.siteId, createdById: decider.actorId }, request.defects)
    const after: CorrectionRequest = { ...request, status: 'APPROVED', decidedById: decider.actorId, decidedAt: toUtcIso(tools.now), decisionNote: note, correctionScanId: id, version: request.version + 1 }
    await decideCorrectionRequest(tools, request, after)
    const row = (await readScan(tx, id))!
    const operation = operations.find((entry) => entry.id === request.workOrderOperationId)!
    tools.audit({ action: 'production.approveScanCorrection', recordType: 'OperationScan', recordId: id, companyId: workOrder.companyId, siteId: workOrder.siteId, before: { scanId: target!.id, goodQuantity: target!.goodQuantity, scrapQuantity: target!.scrapQuantity, reworkQuantity: target!.reworkQuantity }, after: { correctsId: target!.id, requestId: request.id, goodQuantity: row.goodQuantity, scrapQuantity: row.scrapQuantity, reworkQuantity: row.reworkQuantity, decidedOn: decider.on }, reason: request.reason })
    tools.audit({ action: 'production.approveScanCorrection', recordType: 'WorkOrder', recordId: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { scanId: id, correctsId: target!.id, requestId: request.id, decidedOn: decider.on }, reason: request.reason })
    tools.emit(scanEvent(workOrder, row, operation.seq, decider.on))
    tools.emit({ type: 'production.scan_correction_decided', subject: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, payload: { workOrderId: workOrder.id, number: workOrder.number, requestId: request.id, scanId: target!.id, decision: 'APPROVED', correctionScanId: id } })
    return answer({ request: after, scan: row, operations, bundleCode: locked.bundle.code })
  })
  return result
}

async function refuseRequest<Answer>(caller: CommandCaller, named: CorrectionRequest, input: { readonly note: string; readonly version?: number | undefined }, decider: Decider, options: DecisionOptions, answer: (request: CorrectionRequest) => Answer): Promise<Answer> {
  const { note } = input
  const own = await decidesOwn(named, decider)
  if (options.stepUp && named.status === 'PENDING') {
    if (own) refuse(selfApprovalRefusal())
    options.stepUp()
  }
  const { result } = await command(caller, { name: 'production.refuseScanCorrection', idempotencyKey: options.idempotencyKey, input: { requestId: named.id, note, ...(input.version === undefined ? {} : { version: input.version }) } }, async (tools) => {
    const request = (await lockCorrectionRequest(tools.tx, decider.tenantId, named.id))!
    const stale = decidedRefusal(request.status)
    if (stale) refuse(stale)
    if (own) refuse(selfApprovalRefusal())
    sameVersion(request, input.version)
    const workOrder = (await readHeader(tools.tx, request.workOrderId))!
    const after: CorrectionRequest = { ...request, status: 'REFUSED', decidedById: decider.actorId, decidedAt: toUtcIso(tools.now), decisionNote: note, version: request.version + 1 }
    await decideCorrectionRequest(tools, request, after)
    tools.audit({ action: 'production.refuseScanCorrection', recordType: 'WorkOrder', recordId: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { requestId: request.id, scanId: request.scanId, decidedOn: decider.on }, reason: note })
    tools.emit({ type: 'production.scan_correction_decided', subject: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, payload: { workOrderId: workOrder.id, number: workOrder.number, requestId: request.id, scanId: request.scanId, decision: 'REFUSED', correctionScanId: null } })
    return answer(after)
  })
  return result
}

export async function approveCorrection(caller: CommandCaller, requestId: string, body: { readonly note?: string | undefined }, idempotencyKey?: string) {
  const named = await officeRequest(caller, requestId)
  return approveRequest(caller, named, body, officeDecider(caller), { idempotencyKey }, ({ request, scan, operations, bundleCode }) => ({ request: requestView(request), scan: scanView(scan, operations, bundleCode, request.defects) }))
}

export async function refuseCorrection(caller: CommandCaller, requestId: string, body: { readonly note: string }, idempotencyKey?: string) {
  const named = await officeRequest(caller, requestId)
  return refuseRequest(caller, named, { note: body.note.trim() }, officeDecider(caller), { idempotencyKey }, (request) => ({ request: requestView(request) }))
}

// ---- the team leader on the tablet (floor.lead, with the PIN) ---------------------------------------------------------------------------

/** The tablet's answer: what happened, no counts and no person (it is kept as the command's receipt). */
const decidedOnTablet = (request: CorrectionRequest) => ({ id: request.id, status: request.status, correctionScanId: request.correctionScanId })

/** POST /production/scans/floor/corrections/:requestId/approve: the CORRECTION scan posts in this command. */
export async function floorApproveCorrection(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly note?: string | undefined }, options: DecisionOptions) {
  const { context, request } = await floorRequest(caller, requestId)
  return approveRequest(caller, request, body, await floorDecider(caller, context), options, (approved) => decidedOnTablet(approved.request))
}

/** POST /production/scans/floor/corrections/:requestId/refuse: a reason tile; OTHER with the lead's words. */
export async function floorRefuseCorrection(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly reason: CorrectionRefusalReason; readonly note?: string | undefined }, options: DecisionOptions) {
  const { context, request } = await floorRequest(caller, requestId)
  const words = body.note?.trim() || null
  if (correctionRefusalNeedsWords(body.reason, words)) throw new ValidationError('Say in a few words why it is refused.', [{ path: 'body/note', message: 'Required with OTHER.' }])
  return refuseRequest(caller, request, { note: correctionRefusalNote(body.reason, words), version: body.version }, await floorDecider(caller, context), options, decidedOnTablet)
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

/** One request: the list's facts, plus who asked and who took the scan by name where the site records workers and its PERFORMANCE gate is on (one record). */
export async function correctionOf(caller: CommandCaller, requestId: string) {
  const request = await officeRequest(caller, requestId)
  return caller.withClient(async (db) => {
    const [row] = await listRows(db, [request])
    const scan = await readScan(db, request.scanId)
    const who = await workerGateFor(db, request.siteId)
    // A team leader's tablet decides as the worker (B-W2b-83): an author column, the gate's rule.
    const decidedBy = who.author(request.decidedById, (await workersAmong(db, [request.decidedById])).has(request.decidedById ?? ''))
    const names = await workerNames(db, who.lookup([request.askedById, scan?.workerId]))
    const stations = await readStations(db, [request.stationId, scan?.stationId ?? null])
    const station = (id: string | null) => (id && stations.get(id) ? { id, code: stations.get(id)!.code, name: stations.get(id)!.name } : null)
    return {
      request: {
        ...row!,
        askedBy: who.person(request.askedById, names),
        askedByHidden: who.hidden(request.askedById),
        askedAt: station(request.stationId),
        decidedById: decidedBy.id,
        decidedByHidden: decidedBy.hidden,
        scan: scan ? { id: scan.id, kind: scan.kind, worker: who.person(scan.workerId, names), workerHidden: who.hidden(scan.workerId), station: station(scan.stationId), defects: (await readDefects(db, [scan.id])).get(scan.id) ?? [] } : null,
      },
    }
  })
}

// ---- what waits for the team leader (floor.lead at the tablet's site, in the tenant's system scope: the audit rows and Worker.userId) -----

/** The rows of the Waiting list: what, where, the counts recorded and asked; `own`: this person decides nothing of it. Never who. */
async function floorRows(db: Reader, requests: readonly CorrectionRequest[], ids: readonly string[]) {
  if (requests.length === 0) return []
  const unique = (values: readonly (string | null | undefined)[]) => [...new Set(values.filter((value): value is string => typeof value === 'string'))]
  const scans = new Map((await db.operationScan.findMany({ where: { id: { in: requests.map((request) => request.scanId) } }, select: { id: true, goodQuantity: true, scrapQuantity: true, reworkQuantity: true, serverTime: true, stationId: true, deviceId: true } })).map((row) => [row.id, row]))
  const placeOf = (request: CorrectionRequest) => ({ stationId: scans.get(request.scanId)?.stationId ?? request.stationId, deviceId: scans.get(request.scanId)?.deviceId ?? request.deviceId })
  const orders = new Map((await db.workOrder.findMany({ where: { id: { in: unique(requests.map((request) => request.workOrderId)) } }, select: { id: true, number: true } })).map((row) => [row.id, row]))
  const bundles = new Map((await db.bundle.findMany({ where: { id: { in: unique(requests.map((request) => request.bundleId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
  const operations = new Map((await db.workOrderOperation.findMany({ where: { id: { in: unique(requests.map((request) => request.workOrderOperationId)) } }, select: { id: true, seq: true, name: true } })).map((row) => [row.id, row]))
  const stations = new Map((await db.station.findMany({ where: { id: { in: unique(requests.map((request) => placeOf(request).stationId)) } }, select: { id: true, code: true, lineId: true } })).map((row) => [row.id, row]))
  // A report's line: its station's, else its station-less tablet's (B-W2b-52), as a line's labour day counts it.
  const devices = new Map((await db.device.findMany({ where: { id: { in: unique(requests.map((request) => placeOf(request).deviceId)) }, stationId: null }, select: { id: true, lineId: true } })).map((row) => [row.id, row.lineId]))
  const lineIdOf = (request: CorrectionRequest) => {
    const place = placeOf(request)
    return place.stationId ? (stations.get(place.stationId)?.lineId ?? null) : place.deviceId ? (devices.get(place.deviceId) ?? null) : null
  }
  const lines = new Map((await db.line.findMany({ where: { id: { in: unique(requests.map(lineIdOf)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
  const involved = await involvedIn(db, requests)
  return requests.map((request) => {
    const scan = scans.get(request.scanId)
    const place = placeOf(request)
    const station = place.stationId ? stations.get(place.stationId) : undefined
    const line = lines.get(lineIdOf(request) ?? '')
    const operation = operations.get(request.workOrderOperationId)
    return {
      id: request.id,
      version: request.version,
      at: request.serverTime,
      workOrder: { id: request.workOrderId, number: orders.get(request.workOrderId)?.number ?? '' },
      bundle: { id: request.bundleId, code: bundles.get(request.bundleId)?.code ?? '' },
      operation: { seq: operation?.seq ?? 0, name: operation?.name ?? '' },
      station: station ? { id: station.id, code: station.code } : null,
      line: line ? { id: line.id, code: line.code } : null,
      recorded: { good: scan?.goodQuantity ?? 0, scrap: scan?.scrapQuantity ?? 0, rework: scan?.reworkQuantity ?? 0, at: toUtcIso(scan?.serverTime ?? new Date(request.serverTime)) },
      asked: { good: request.goodQuantity, scrap: request.scrapQuantity, rework: request.reworkQuantity },
      own: isInvolved(involved.get(request.id), ids),
    }
  })
}

/** GET /production/scans/floor/corrections: what waits at the tablet's site, oldest first; never who. */
export async function floorCorrections(caller: CommandCaller) {
  // The route's manifest (floor.lead, scope site) pinned the session to its device's site; the read below names it.
  const context = floorOf(caller)
  return systemView(caller).withClient(async (db) => {
    const requests = await readCorrectionRequests(db, { siteIds: [context.siteId], status: 'PENDING', take: FLOOR_ROWS })
    return { rows: await floorRows(db, requests, await floorIds(db, context)), refusalTiles: CORRECTION_REFUSAL_TILES.map((tile) => ({ ...tile })) }
  })
}

/** The lines of a record with the reason's words (a code stays a code when its reason is gone). */
async function reasonWordsOf(db: Reader, lines: readonly DefectLine[]) {
  const rows = await db.scrapReason.findMany({ where: { code: { in: [...new Set(lines.map((line) => line.reason))] } }, select: { kind: true, code: true, labelIt: true, labelEn: true, labelI18n: true } })
  const words = (value: Prisma.JsonValue): Record<string, string> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {})
  return lines.map((line) => {
    const row = rows.find((entry) => entry.kind === line.kind && entry.code === line.reason)
    return { kind: line.kind, code: line.reason, quantity: line.quantity, labelIt: row?.labelIt ?? line.reason, labelEn: row?.labelEn ?? line.reason, labelI18n: row ? words(row.labelI18n) : {} }
  })
}

/**
 * GET /production/scans/floor/corrections/:requestId: the one record the decision opens. It adds the asker's words, the
 * reasons and who took the scan, where the scan names one (design floor.supervisor: the name shows only where the decision
 * needs it; a station-only site names nobody). The worker's name alone: no figure about them.
 */
export async function floorCorrection(caller: CommandCaller, requestId: string) {
  const { context, request } = await floorRequest(caller, requestId)
  return systemView(caller).withClient(async (db) => {
    const [row] = await floorRows(db, [request], await floorIds(db, context))
    const scan = await readScan(db, request.scanId)
    const names = await workerNames(db, [scan?.workerId ?? null])
    const recorded = scan ? ((await readDefects(db, [scan.id])).get(scan.id) ?? []) : []
    return { request: { ...row!, status: request.status, reason: request.reason, person: scan?.workerId ? (names.get(scan.workerId) ?? null) : null, reasons: await reasonWordsOf(db, request.defects), recordedReasons: await reasonWordsOf(db, recorded) } }
  })
}
