import type { Prisma } from '@nexus/factory-db'
import { shownLineOf } from '@nexus/factory-domain/auth/floor/modes'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  CONFLICT_DECISIONS,
  CONFLICT_LOOK,
  CONFLICT_REASONS,
  CONFLICT_SOURCES,
  conflictKindOf,
  conflictReasonProblem,
  DECISION_LOOK,
  isCrossTablet,
  keepRecordedWords,
  reasonOf,
  SENT_TO_OFFICE_ACTION,
  sendToOfficeWords,
  type ConflictDecision,
  type ConflictKind,
  type ConflictState,
} from '@nexus/factory-domain/floor-sync/conflicts/rules'
import { FLOOR_SYNC_VIEW } from '@nexus/factory-domain/floor-sync/permissions'
import { SCAN_KINDS, standingKey, standingScans, type ScanFact } from '@nexus/factory-domain/production/scans/rules'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { floorOf, officeOf, systemView } from '../../../modules/production/scans/access'
import { workerNames } from '../../../modules/production/scans/store'
import { hasAcknowledgedNotice, scanSubjectFor } from '../../../modules/production/settings/subject'
import { readRefused, readRefusedOne, type RefusedRow } from '../store'
import { discardWithModule } from '../sync'

/**
 * Offline conflicts go to the lead (B-W2b-52; MES-196; design floor.supervisor "Waiting for you"; the rules are
 * factory-domain floor-sync/conflicts/rules). A conflict is an OPEN refused queued action of the floor sync
 * (FloorRefusedAction) that a report of a bundle at an operation became, refused ALREADY_REPORTED, whose bundle-operation's
 * standing report (the count ledger: REPORT, UNDO, CORRECTION) another tablet or the office recorded. Read from the
 * floor sync's and the scans module's own rows: no table of its own.
 *
 *   GET  /floor/sync/conflicts                    the lead's line (floor.lead at the tablet's site): the conflicts of the
 *                                                 tablet's line (a line tablet's line, its station's line) or `?lineId`,
 *                                                 else the whole site; both reports side by side; never a worker's name
 *   GET  /floor/sync/conflicts/:refusedId         one conflict, with its two reporters where the site names workers
 *   POST /floor/sync/conflicts/:refusedId/decide  KEEP_RECORDED: the refused report is discarded with the lead's reason,
 *                                                 the scan module's own record of it with it (platform/floor-sync
 *                                                 discardWithModule) — a signing act: the PIN (`sign`); SEND_TO_OFFICE: one
 *                                                 command keeps the lead's reason on the refused action's history (audit
 *                                                 SENT_TO_OFFICE_ACTION) and announces floor.conflict_sent_to_office; the
 *                                                 action stays open for the office's correction or discard
 *   GET  /floor-sync/conflicts                    the office (floorsync.view, scopeWhere over company and site)
 * The "with the office" state is read from those audit rows in the tenant's system view (the floor reads no audit row).
 */

type Db = Parameters<Parameters<CommandCaller['withClient']>[0]>[0]

interface Station {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly lineId: string | null
}

export interface Conflict {
  readonly refused: RefusedRow
  readonly kind: ConflictKind
  readonly standing: ScanFact
  readonly workOrder: { readonly id: string; readonly number: string }
  readonly bundle: { readonly id: string; readonly code: string }
  readonly operation: { readonly id: string; readonly seq: number; readonly name: string }
  readonly refusedCounts: { readonly good: number; readonly scrap: number; readonly rework: number }
  readonly refusedWorkerId: string | null
  readonly devices: ReadonlyMap<string, string>
  readonly stations: ReadonlyMap<string, Station>
}

const SCAN_FACT = {
  id: true,
  kind: true,
  bundleId: true,
  workOrderOperationId: true,
  correctsId: true,
  goodQuantity: true,
  scrapQuantity: true,
  reworkQuantity: true,
  workerId: true,
  stationId: true,
  deviceId: true,
  clientScanId: true,
  deviceTime: true,
  serverTime: true,
} as const satisfies Prisma.OperationScanSelect

const byId = <Row extends { readonly id: string }>(rows: readonly Row[]): Map<string, Row> => new Map(rows.map((row) => [row.id, row]))

/** The conflicts among these refused actions (open, of a conflict kind, a standing report of another tablet). */
async function conflictsAmong(db: Db, refused: readonly RefusedRow[]): Promise<Conflict[]> {
  const candidates = refused.filter((row) => row.status === 'OPEN' && conflictKindOf(row) !== null && row.moduleRefusal?.type === 'FloorScanRefusal')
  if (candidates.length === 0) return []
  const scanRefusals = byId(
    await db.floorScanRefusal.findMany({
      where: { id: { in: candidates.map((row) => row.moduleRefusal!.id) } },
      select: { id: true, workOrderId: true, bundleId: true, workOrderOperationId: true, goodQuantity: true, scrapQuantity: true, reworkQuantity: true, workerId: true },
    }),
  )
  const placed = candidates.flatMap((row) => {
    const named = scanRefusals.get(row.moduleRefusal!.id)
    return named && named.workOrderId && named.bundleId && named.workOrderOperationId ? [{ row, named: { ...named, workOrderId: named.workOrderId, bundleId: named.bundleId, workOrderOperationId: named.workOrderOperationId } }] : []
  })
  if (placed.length === 0) return []
  // The count ledger of those bundles only (never the timing rows: B-W2b-12).
  const scans = (await db.operationScan.findMany({
    where: { bundleId: { in: [...new Set(placed.map((entry) => entry.named.bundleId))] }, kind: { in: [...SCAN_KINDS] } },
    select: SCAN_FACT,
    orderBy: [{ serverTime: 'asc' }, { id: 'asc' }],
  })) as unknown as ScanFact[]
  const standing = standingScans(scans)
  const found = placed.flatMap((entry) => {
    const stands = standing.get(standingKey(entry.named.bundleId, entry.named.workOrderOperationId))
    return stands && isCrossTablet(entry.row.deviceId, stands) ? [{ ...entry, stands }] : []
  })
  if (found.length === 0) return []
  const [workOrders, bundles, operations, devices, stations] = await Promise.all([
    db.workOrder.findMany({ where: { id: { in: [...new Set(found.map((entry) => entry.named.workOrderId))] } }, select: { id: true, number: true } }),
    db.bundle.findMany({ where: { id: { in: [...new Set(found.map((entry) => entry.named.bundleId))] } }, select: { id: true, code: true } }),
    db.workOrderOperation.findMany({ where: { id: { in: [...new Set(found.map((entry) => entry.named.workOrderOperationId))] } }, select: { id: true, seq: true, name: true } }),
    db.device.findMany({ where: { id: { in: [...new Set(found.flatMap((entry) => [entry.row.deviceId, ...(entry.stands.deviceId ? [entry.stands.deviceId] : [])]))] } }, select: { id: true, name: true } }),
    db.station.findMany({ where: { id: { in: [...new Set(found.flatMap((entry) => [entry.row.stationId, entry.stands.stationId].filter((value): value is string => value !== null)))] } }, select: { id: true, code: true, name: true, lineId: true } }),
  ])
  const [orderOf, bundleOf, operationOf] = [byId(workOrders), byId(bundles), byId(operations)]
  const deviceNames = new Map(devices.map((row) => [row.id, row.name]))
  const stationOf = byId(stations)
  return found.flatMap((entry) => {
    const workOrder = orderOf.get(entry.named.workOrderId)
    const bundle = bundleOf.get(entry.named.bundleId)
    const operation = operationOf.get(entry.named.workOrderOperationId)
    if (!workOrder || !bundle || !operation) return []
    return [
      {
        refused: entry.row,
        kind: conflictKindOf(entry.row)!,
        standing: entry.stands,
        workOrder,
        bundle,
        operation,
        refusedCounts: { good: entry.named.goodQuantity, scrap: entry.named.scrapQuantity, rework: entry.named.reworkQuantity },
        refusedWorkerId: entry.row.workerId ?? entry.named.workerId,
        devices: deviceNames,
        stations: stationOf,
      },
    ]
  })
}

/** When each refused action was sent to the office (the audit rows, read in the tenant's system view), by id. */
async function sentToOffice(caller: CommandCaller, ids: readonly string[]): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map()
  const rows = await systemView(caller).withClient((db) =>
    db.auditLog.findMany({ where: { recordType: 'FloorRefusedAction', recordId: { in: [...ids] }, action: SENT_TO_OFFICE_ACTION }, select: { recordId: true, at: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] }),
  )
  return new Map(rows.map((row) => [row.recordId, row.at]))
}

const stationRef = (stations: ReadonlyMap<string, Station>, id: string | null) => {
  const station = id ? stations.get(id) : undefined
  return station ? { id: station.id, code: station.code, name: station.name } : null
}

function viewOf(conflict: Conflict, sentAt: Date | undefined) {
  const { refused, standing, stations, devices } = conflict
  const state: ConflictState = sentAt ? 'WITH_OFFICE' : 'OPEN'
  return {
    id: refused.id,
    kind: conflict.kind,
    state,
    look: CONFLICT_LOOK[conflict.kind],
    workOrder: conflict.workOrder,
    bundle: conflict.bundle,
    operation: conflict.operation,
    refused: { deviceId: refused.deviceId, deviceName: devices.get(refused.deviceId) ?? '', station: stationRef(stations, refused.stationId), deviceTime: refused.deviceTime, serverTime: refused.serverTime, ...conflict.refusedCounts },
    recorded: {
      scanId: standing.id,
      deviceId: standing.deviceId,
      deviceName: standing.deviceId ? (devices.get(standing.deviceId) ?? '') : null,
      station: stationRef(stations, standing.stationId),
      serverTime: toUtcIso(standing.serverTime),
      corrected: standing.kind === 'CORRECTION',
      good: standing.goodQuantity,
      scrap: standing.scrapQuantity,
      rework: standing.reworkQuantity,
    },
    sentToOfficeAt: sentAt ? toUtcIso(sentAt) : null,
    version: refused.version,
  }
}

/** The decisions with their reason tiles; KEEP_RECORDED signs with the PIN. */
const DECISIONS = CONFLICT_DECISIONS.map((decision) => ({
  decision,
  look: DECISION_LOOK[decision],
  signs: decision === 'KEEP_RECORDED',
  reasons: CONFLICT_REASONS[decision].map((reason) => ({ code: reason.code, look: reason.look })),
}))

const onLine = (conflict: Conflict, lineId: string): boolean =>
  [conflict.refused.stationId, conflict.standing.stationId].some((stationId) => stationId !== null && conflict.stations.get(stationId)?.lineId === lineId)

const inState = (state: 'OPEN' | 'WITH_OFFICE' | 'ALL', sentAt: Date | undefined): boolean => state === 'ALL' || (state === 'WITH_OFFICE') === (sentAt !== undefined)

/** Open first (oldest first: the longest waiting), then those with the office. */
const order = (rows: ReturnType<typeof viewOf>[]) => [...rows].sort((a, b) => (a.state === b.state ? (a.refused.serverTime < b.refused.serverTime ? -1 : a.refused.serverTime > b.refused.serverTime ? 1 : 0) : a.state === 'OPEN' ? -1 : 1))

/** The line the lead's tablet looks at: `?lineId` (a line of the site), else a line tablet's or its station's line. */
async function lineOf(db: Db, context: FloorContext, lineId: string | undefined) {
  if (lineId) {
    const line = await db.line.findFirst({ where: { id: lineId, siteId: context.siteId }, select: { id: true, code: true, name: true } })
    if (!line) throw new ValidationError('No line of this site has this id.', [{ path: 'lineId', message: 'Expected a line of the site.' }])
    return line
  }
  const device = await db.device.findUnique({ where: { id: context.deviceId }, select: { mode: true, lineId: true, station: { select: { lineId: true } } } })
  const shown = device ? shownLineOf(device, device.station?.lineId ?? null) : null
  return shown ? db.line.findUnique({ where: { id: shown }, select: { id: true, code: true, name: true } }) : null
}

export async function floorConflicts(caller: CommandCaller, query: { readonly lineId?: string | undefined; readonly state: 'OPEN' | 'WITH_OFFICE' | 'ALL' }) {
  const context = floorOf(caller)
  const { line, conflicts } = await caller.withClient(async (db) => {
    const shown = await lineOf(db, context, query.lineId)
    const refused = await readRefused(db, { siteId: context.siteId, status: 'OPEN', kind: CONFLICT_SOURCES.DOUBLE_REPORT.kind, limit: 500 })
    const found = await conflictsAmong(db, refused)
    return { line: shown, conflicts: shown ? found.filter((conflict) => onLine(conflict, shown.id)) : found }
  })
  const sent = await sentToOffice(caller, conflicts.map((conflict) => conflict.refused.id))
  return { line, conflicts: order(conflicts.filter((conflict) => inState(query.state, sent.get(conflict.refused.id))).map((conflict) => viewOf(conflict, sent.get(conflict.refused.id)))), decisions: DECISIONS }
}

/** One conflict of the tablet's site, or a 404 (another site's, not a conflict, closed). */
async function floorConflictOf(caller: CommandCaller, refusedId: string): Promise<Conflict> {
  const context = floorOf(caller)
  const conflict = await caller.withClient(async (db) => {
    const row = await readRefusedOne(db, refusedId)
    if (!row || row.siteId !== context.siteId) return null
    return (await conflictsAmong(db, [row]))[0] ?? null
  })
  if (!conflict) throw new NotFoundError('Conflict not found.')
  return conflict
}

export async function floorConflict(caller: CommandCaller, refusedId: string) {
  const conflict = await floorConflictOf(caller, refusedId)
  const sent = await sentToOffice(caller, [conflict.refused.id])
  // Names only inside this one record, where the site names workers (the rows name workers only there).
  const names = await caller.withClient((db) => workerNames(db, [conflict.refusedWorkerId, conflict.standing.workerId]))
  const personOf = (id: string | null) => (id && names.has(id) ? { id, name: names.get(id)! } : null)
  return { conflict: { ...viewOf(conflict, sent.get(conflict.refused.id)), refusedBy: personOf(conflict.refusedWorkerId), recordedBy: personOf(conflict.standing.workerId) }, decisions: DECISIONS }
}

/** Who decides on the floor, for the discard's record: the lead where the site names workers and they acknowledged the notice. */
async function floorDecider(caller: CommandCaller, context: FloorContext): Promise<string | null> {
  return caller.withClient(async (db) => ((await scanSubjectFor(db, context.siteId)) === 'WORKER' && (await hasAcknowledgedNotice(db, context.siteId, context.actorId)) ? context.actorId : null))
}

export async function decideConflict(
  caller: CommandCaller,
  refusedId: string,
  body: { readonly decision: ConflictDecision; readonly reason: string; readonly version: number },
  sign: () => void,
  idempotencyKey: string | undefined,
) {
  const context = floorOf(caller)
  const problem = conflictReasonProblem(body.decision, body.reason)
  if (problem) throw new ValidationError('Pick one of the reasons offered.', [problem])
  const conflict = await floorConflictOf(caller, refusedId)
  if (conflict.refused.version !== body.version) throw new StaleVersionError('FloorRefusedAction', conflict.refused.id, conflict.refused.version, body.version)
  const reason = reasonOf(body.decision, body.reason)!
  if (body.decision === 'KEEP_RECORDED') {
    // A signing act on the floor (c.c. art. 2101: a record of work is dropped with a trace): the PIN, after every other check.
    sign()
    const by = await floorDecider(caller, context)
    const kept = await discardWithModule(caller, conflict.refused, { discardedById: by, discardedBy: 'FLOOR', reason: keepRecordedWords(reason) }, idempotencyKey)
    return { decision: body.decision, status: kept.status, state: kept.status === 'OPEN' ? ('OPEN' as const) : ('CLOSED' as const), version: kept.version }
  }
  const already = await sentToOffice(caller, [conflict.refused.id])
  if (!already.has(conflict.refused.id)) {
    await command(caller, { name: SENT_TO_OFFICE_ACTION, idempotencyKey, input: { refusedId: conflict.refused.id, reason: body.reason, version: body.version } }, async (tools) => {
      // Under the refused action's row lock, still open at the version the lead saw.
      await tools.tx.$queryRaw`SELECT "id" FROM "FloorRefusedAction" WHERE "id" = ${conflict.refused.id}::uuid FOR UPDATE`
      const current = await readRefusedOne(tools.tx, conflict.refused.id)
      if (!current || current.status !== 'OPEN') throw new ConflictError('This conflict was closed meanwhile.')
      if (current.version !== body.version) throw new StaleVersionError('FloorRefusedAction', current.id, current.version, body.version)
      tools.audit({ action: SENT_TO_OFFICE_ACTION, recordType: 'FloorRefusedAction', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { decision: 'SEND_TO_OFFICE', reason: body.reason }, reason: sendToOfficeWords(reason) })
      tools.emit({ type: 'floor.conflict_sent_to_office', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { refusedId: current.id, deviceId: current.deviceId, kind: conflict.kind, reason: body.reason } })
      return null
    })
  }
  return { decision: body.decision, status: 'OPEN' as const, state: 'WITH_OFFICE' as const, version: conflict.refused.version }
}

/** The office's conflicts of the sites its floorsync.view reaches (the same reads; no worker named). */
export async function officeConflicts(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly state: 'OPEN' | 'WITH_OFFICE' | 'ALL'; readonly limit: number }) {
  const context = officeOf(caller)
  const conflicts = await caller.withClient(async (db) => {
    const scope = scopeWhere(actorOf(context), FLOOR_SYNC_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.FloorRefusedActionWhereInput
    const refused = await readRefused(db, { scope, ...(query.siteId ? { siteId: query.siteId } : {}), status: 'OPEN', kind: CONFLICT_SOURCES.DOUBLE_REPORT.kind, limit: 500 })
    return (await conflictsAmong(db, refused)).filter((conflict) => can(actorOf(context), FLOOR_SYNC_VIEW, { companyId: conflict.refused.companyId, siteId: conflict.refused.siteId }))
  })
  const sent = await sentToOffice(caller, conflicts.map((conflict) => conflict.refused.id))
  return {
    conflicts: order(conflicts.filter((conflict) => inState(query.state, sent.get(conflict.refused.id))).map((conflict) => viewOf(conflict, sent.get(conflict.refused.id))))
      .slice(0, query.limit)
      .map((view) => ({ ...view, siteId: conflicts.find((conflict) => conflict.refused.id === view.id)!.refused.siteId })),
  }
}
