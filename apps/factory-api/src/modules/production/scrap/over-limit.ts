import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  approvalStateOf,
  decisionRefusal,
  decisionWords,
  isFloorReport,
  overLimitOf,
  postingHeldWords,
  refusalReasonText,
  SCRAP_DECISION_ACTION,
  SCRAP_REFUSAL_TILES,
  type DecidedOn,
  type OverLimitRefusal,
  type ScrapApprovalState,
  type ScrapDecision,
  type ScrapRefusalReason,
} from '@nexus/factory-domain/production/scrap/approval'
import { PRODUCTION_SCRAP_OVER_LIMIT, PRODUCTION_SCRAP_VIEW } from '@nexus/factory-domain/production/scrap/permissions'
import { limitSince, scrapNeedsApproval, type LimitChange } from '@nexus/factory-domain/production/settings/floor-rules'
import type { WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { systemView } from '../scans/access'
import { lockBundleScans, scanWorkOrderLock, workerUsers } from '../scans/store'
import { floorChecksFor, FLOOR_RULES_ACTION, scrapLimitHistory } from '../settings/floor-rules'

/**
 * Scrap above a site's limit waits for the team leader's approval (B-W2b-53; MES-128; design floor.supervisor "Waiting
 * for you", production.scrap tile "Waiting for approval (over the limit)", its DetailModal and "Approve 3"). The rule is
 * factory-domain production/scrap/approval (pure); this is its API:
 *
 *   which scans wait   a standing floor REPORT whose scrap is above the limit in force when it was taken (the site's
 *                      ProductionSettings.scrapApprovalLimit and its history in the audit rows of the floor rules'
 *                      change), of a work order not CANCELLED or CLOSED, with no decision yet. The scan counted at once
 *                      (F3); what waits is its scrap's posting: a replacement (replacements.ts), a scrap of stock naming it
 *                      (stock.ts) and, once wired, the cost ledger (`scrapApprovalStatesOf`, named in the step's notes).
 *   the decision       ONE command per scan (the work order's scan lock, then the bundle's scan lock: a decision, an undo
 *                      and a correction of the bundle take turns), the facts read again under the locks: APPROVED or
 *                      REFUSED with a reason tile (OTHER with a note), never by who took the scan (four eyes: its worker,
 *                      the account that wrote it, the actors of its report's audit rows, the office users those workers
 *                      are). Recorded as the audit row `production.decideScrapOverLimit` on the scan (and one on its work
 *                      order): the decision's ledger, since the schema has no table for it (named gap); event
 *                      production.scrap_over_limit_decided.
 *   the team leader    floor.lead at the device's own site: the waiting list (no person's name: the station, the line,
 *                      the bundle and the counts; the limit is a count, no money), approve with the PIN (requireFloorStepUp,
 *                      after every other check), refuse with a reason tile.
 *   the office         production.scrap.overLimit over the work order's company and site: approve or refuse one, approve
 *                      many (each its own command, each answered); the scrap list (views.ts) carries each scan's approval
 *                      and the tile.
 *
 * The audit log is read in the office's scope or, for a floor session, in the tenant's system scope (the floor role
 * reads no audit row), always narrowed to the device's own site.
 */

type Reader = Prisma.TransactionClient

export class OverLimitRefusedError extends ConflictError {
  override name = 'OverLimitRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: { readonly code: string; readonly message: string }) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

const refused = (refusal: OverLimitRefusal): never => {
  throw new OverLimitRefusedError(refusal)
}

export const APPROVAL_SCAN = { id: true, siteId: true, workOrderId: true, bundleId: true, workOrderOperationId: true, kind: true, goodQuantity: true, scrapQuantity: true, reworkQuantity: true, serverTime: true, deviceId: true, subcontractReceiptLineId: true, stationId: true, workerId: true, createdById: true } as const satisfies Prisma.OperationScanSelect
export type ApprovalScanRow = Prisma.OperationScanGetPayload<{ select: typeof APPROVAL_SCAN }>

export interface ApprovalView {
  readonly state: ScrapApprovalState
  /** The limit in force when the scan was taken (pieces). */
  readonly limit: number | null
  readonly decidedAt: string | null
  readonly decidedOn: DecidedOn | null
  readonly reason: ScrapRefusalReason | null
  readonly note: string | null
}

interface DecisionRow {
  readonly decision: ScrapDecision
  readonly at: Date
  readonly decidedOn: DecidedOn
  readonly reason: ScrapRefusalReason | null
  readonly note: string | null
}

const objectOf = (value: Prisma.JsonValue | null): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** The decisions recorded on these scans (the first one each: a decision is taken once). Office or system scope. */
export async function readDecisions(db: Pick<CommandTx, 'auditLog'>, scanIds: readonly string[]): Promise<Map<string, DecisionRow>> {
  const decisions = new Map<string, DecisionRow>()
  if (scanIds.length === 0) return decisions
  const rows = await db.auditLog.findMany({ where: { recordType: 'OperationScan', recordId: { in: [...new Set(scanIds)] }, action: SCRAP_DECISION_ACTION }, select: { recordId: true, at: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  for (const row of rows) {
    if (decisions.has(row.recordId)) continue
    const after = objectOf(row.after)
    if (after.decision !== 'APPROVED' && after.decision !== 'REFUSED') continue
    decisions.set(row.recordId, {
      decision: after.decision,
      at: row.at,
      decidedOn: after.decidedOn === 'FLOOR' ? 'FLOOR' : 'OFFICE',
      reason: typeof after.reason === 'string' ? (after.reason as ScrapRefusalReason) : null,
      note: typeof after.note === 'string' ? after.note : null,
    })
  }
  return decisions
}

/** The site's limit now and its history, per site (office or system scope). */
async function limitsOf(db: Pick<CommandTx, 'productionSettings' | 'auditLog'>, siteIds: readonly string[]) {
  const ids = [...new Set(siteIds)]
  const current = new Map((await db.productionSettings.findMany({ where: { id: { in: ids } }, select: { id: true, scrapApprovalLimit: true } })).map((row) => [row.id, row.scrapApprovalLimit]))
  const history = await scrapLimitHistory(db, ids)
  return { current: (siteId: string) => current.get(siteId) ?? null, history: (siteId: string): LimitChange[] => history.get(siteId) ?? [] }
}

/**
 * Each scan's scrap approval (null: none needed). Office or the tenant's system scope (the audit rows). The scans need
 * not stand: a voided scan's earlier decision is still told; a voided scan with none needs nothing.
 */
export async function approvalsOf(db: Pick<CommandTx, 'productionSettings' | 'auditLog' | 'operationScan'>, scans: readonly Pick<ApprovalScanRow, 'id' | 'siteId' | 'kind' | 'scrapQuantity' | 'serverTime' | 'deviceId' | 'subcontractReceiptLineId'>[]): Promise<Map<string, ApprovalView | null>> {
  const answer = new Map<string, ApprovalView | null>()
  const reports = scans.filter((scan) => isFloorReport(scan) && scan.scrapQuantity > 1)
  for (const scan of scans) answer.set(scan.id, null)
  if (reports.length === 0) return answer
  const limits = await limitsOf(db, reports.map((scan) => scan.siteId))
  const voided = new Set((await db.operationScan.findMany({ where: { correctsId: { in: reports.map((scan) => scan.id) } }, select: { correctsId: true } })).map((row) => row.correctsId!))
  const decisions = await readDecisions(db, reports.map((scan) => scan.id))
  for (const scan of reports) {
    const { limit, over } = overLimitOf(scan, limits.history(scan.siteId), limits.current(scan.siteId))
    const decision = decisions.get(scan.id) ?? null
    const state = approvalStateOf({ over, standing: !voided.has(scan.id), decision: decision?.decision ?? null })
    answer.set(
      scan.id,
      state === null
        ? null
        : { state, limit, decidedAt: decision ? toUtcIso(decision.at) : null, decidedOn: decision?.decidedOn ?? null, reason: decision?.reason ?? null, note: decision?.note ?? null },
    )
  }
  return answer
}

/**
 * The scans waiting now, newest candidates first (at most `take`), of work orders not CANCELLED or CLOSED, within `where`
 * (the caller's scope, a site, a work order). Only sites that ever had a limit, and only scans taken since. Office or system.
 */
export async function waitingScans(db: Reader, where: Prisma.OperationScanWhereInput, take = 1000): Promise<{ scan: ApprovalScanRow; approval: ApprovalView }[]> {
  const settings = await db.productionSettings.findMany({ where: { scrapApprovalLimit: { not: null } }, select: { id: true, scrapApprovalLimit: true } })
  const changed = await db.auditLog.findMany({ where: { recordType: 'ProductionSettings', action: FLOOR_RULES_ACTION }, select: { recordId: true }, distinct: ['recordId'] })
  const siteIds = [...new Set([...settings.map((row) => row.id), ...changed.map((row) => row.recordId)])]
  if (siteIds.length === 0) return []
  const limits = await limitsOf(db, siteIds)
  const since: Prisma.OperationScanWhereInput[] = []
  for (const siteId of siteIds) {
    const from = limitSince(limits.history(siteId), limits.current(siteId))
    if (from === 'ALWAYS') since.push({ siteId })
    else if (from) since.push({ siteId, serverTime: { gte: from } })
  }
  if (since.length === 0) return []
  const scans = await db.operationScan.findMany({
    where: {
      AND: [
        where,
        { OR: since },
        { kind: 'REPORT', deviceId: { not: null }, subcontractReceiptLineId: null, scrapQuantity: { gt: 1 } },
        { workOrder: { is: { status: { notIn: ['CANCELLED', 'CLOSED'] } } } },
      ],
    },
    select: APPROVAL_SCAN,
    orderBy: [{ serverTime: 'desc' }, { id: 'desc' }],
    take,
  })
  const approvals = await approvalsOf(db, scans)
  return scans.flatMap((scan) => {
    const approval = approvals.get(scan.id)
    return approval?.state === 'WAITING' ? [{ scan, approval }] : []
  })
}

/**
 * For the modules whose posting waits (the cost ledger, B-W2a-21's costing/actual/post.ts; replacements and the scrap of
 * stock here): each scan's approval state, WAITING and REFUSED meaning "do not post its scrap". Office or system scope.
 */
export async function scrapApprovalStatesOf(db: Pick<CommandTx, 'productionSettings' | 'auditLog' | 'operationScan'>, scanIds: readonly string[]): Promise<Map<string, ScrapApprovalState | null>> {
  const scans = scanIds.length === 0 ? [] : await db.operationScan.findMany({ where: { id: { in: [...new Set(scanIds)] } }, select: APPROVAL_SCAN })
  const approvals = await approvalsOf(db, scans)
  return new Map(scanIds.map((id) => [id, approvals.get(id)?.state ?? null]))
}

/** Why a scan's scrap may not post now (WAITING or REFUSED), in words; null when it may. Office scope (inside a command too). */
export async function scrapPostingHeld(db: Pick<CommandTx, 'productionSettings' | 'auditLog' | 'operationScan'>, scanId: string): Promise<{ readonly state: 'WAITING' | 'REFUSED'; readonly words: string } | null> {
  const scan = await db.operationScan.findUnique({ where: { id: scanId }, select: APPROVAL_SCAN })
  if (!scan) return null
  const approval = (await approvalsOf(db, [scan])).get(scan.id) ?? null
  if (!approval || approval.state === 'APPROVED') return null
  return { state: approval.state, words: postingHeldWords(approval.state, scan.scrapQuantity, approval.limit)! }
}

/**
 * For the scan's answer on the tablet (the scans hook, wired at merge): does scrap of this many pieces at the device's
 * site wait for the team leader now, and the words to show. Floor or office scope (reads only the site's limit).
 */
export async function scrapWaitsAt(db: Pick<CommandTx, 'productionSettings'>, siteId: string, scrapQuantity: number): Promise<{ readonly waits: boolean; readonly limit: number | null; readonly words: string | null }> {
  const { scrapApprovalLimit: limit } = await floorChecksFor(db, siteId)
  const waits = scrapNeedsApproval(scrapQuantity, limit)
  return { waits, limit, words: waits ? postingHeldWords('WAITING', scrapQuantity, limit) : null }
}

// ---- the rows of the waiting lists -----------------------------------------------------------------------------------------

const unique = (values: readonly (string | null | undefined)[]) => [...new Set(values.filter((value): value is string => typeof value === 'string'))]

const wordsOf = (value: Prisma.JsonValue): Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

/** The rows a waiting list shows: per station, line, bundle and operation, the counts and the reasons; never a person. */
async function rowsOf(db: Reader, entries: readonly { scan: ApprovalScanRow; approval: ApprovalView }[]) {
  const scans = entries.map((entry) => entry.scan)
  const orders = new Map((await db.workOrder.findMany({ where: { id: { in: unique(scans.map((scan) => scan.workOrderId)) } }, select: { id: true, number: true, status: true } })).map((row) => [row.id, row]))
  const bundles = new Map((await db.bundle.findMany({ where: { id: { in: unique(scans.map((scan) => scan.bundleId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
  const operations = new Map((await db.workOrderOperation.findMany({ where: { id: { in: unique(scans.map((scan) => scan.workOrderOperationId)) } }, select: { id: true, seq: true, code: true, name: true } })).map((row) => [row.id, row]))
  const stations = new Map((await db.station.findMany({ where: { id: { in: unique(scans.map((scan) => scan.stationId)) } }, select: { id: true, code: true, lineId: true } })).map((row) => [row.id, row]))
  const lines = new Map((await db.line.findMany({ where: { id: { in: unique([...stations.values()].map((station) => station.lineId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
  const defects = await db.operationScanDefect.findMany({ where: { scanId: { in: scans.map((scan) => scan.id) }, kind: 'SCRAP' }, select: { scanId: true, reasonCode: true, quantity: true }, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })
  const reasons = new Map((await db.scrapReason.findMany({ where: { kind: 'SCRAP', code: { in: unique(defects.map((line) => line.reasonCode)) } }, select: { code: true, labelIt: true, labelEn: true, labelI18n: true, icon: true, colour: true } })).map((row) => [row.code, row]))
  return entries.map(({ scan, approval }) => {
    const station = scan.stationId ? stations.get(scan.stationId) : undefined
    const line = station?.lineId ? lines.get(station.lineId) : undefined
    const operation = operations.get(scan.workOrderOperationId)
    return {
      scanId: scan.id,
      at: toUtcIso(scan.serverTime),
      siteId: scan.siteId,
      workOrder: { id: scan.workOrderId, number: orders.get(scan.workOrderId)?.number ?? '', status: (orders.get(scan.workOrderId)?.status ?? 'RELEASED') as WorkOrderStatus },
      bundle: { id: scan.bundleId, code: bundles.get(scan.bundleId)?.code ?? '' },
      operation: { id: scan.workOrderOperationId, seq: operation?.seq ?? 0, code: operation?.code ?? '', name: operation?.name ?? '' },
      station: station ? { id: station.id, code: station.code } : null,
      line: line ? { id: line.id, code: line.code } : null,
      goodQuantity: scan.goodQuantity,
      scrapQuantity: scan.scrapQuantity,
      reworkQuantity: scan.reworkQuantity,
      reasons: defects
        .filter((defect) => defect.scanId === scan.id)
        .map((defect) => {
          const reason = reasons.get(defect.reasonCode)
          return { code: defect.reasonCode, quantity: defect.quantity, labelIt: reason?.labelIt ?? defect.reasonCode, labelEn: reason?.labelEn ?? defect.reasonCode, labelI18n: reason ? wordsOf(reason.labelI18n) : {}, icon: reason?.icon ?? null, colour: reason?.colour ?? null }
        }),
      approval,
    }
  })
}

// ---- deciding --------------------------------------------------------------------------------------------------------------

function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/** Who took the scan: its worker, the account that wrote it, the actors of its report's audit rows, those workers' office users. */
async function involvedOf(db: Reader, scan: ApprovalScanRow): Promise<Set<string>> {
  const ids = new Set<string>([scan.workerId, scan.createdById].filter((value): value is string => value !== null))
  // At a site that records the station only, the report's audit row still keeps who sent it.
  for (const row of await db.auditLog.findMany({ where: { recordType: 'OperationScan', recordId: scan.id, action: 'production.reportScan' }, select: { actorId: true } })) ids.add(row.actorId)
  for (const userId of await workerUsers(db, [...ids])) ids.add(userId)
  return ids
}

export interface DecideInput {
  readonly decision: ScrapDecision
  readonly reason?: ScrapRefusalReason | undefined
  readonly note?: string | undefined
}

interface Decider {
  readonly on: DecidedOn
  readonly actorId: string
  readonly tenantId: string
  /** Reads with the audit rows: the office's own client; for a floor session the tenant's system scope (its own site only). */
  read<T>(caller: CommandCaller, work: (db: Reader) => Promise<T>): Promise<T>
}

/** The facts of a decision, read on the reader given (office or system scope). */
async function factsOf(db: Reader, scan: ApprovalScanRow) {
  const workOrder = (await db.workOrder.findUnique({ where: { id: scan.workOrderId }, select: { id: true, number: true, status: true, companyId: true, siteId: true } }))!
  const bundle = await db.bundle.findUnique({ where: { id: scan.bundleId }, select: { code: true } })
  const decided = (await readDecisions(db, [scan.id])).get(scan.id) ?? null
  const standing = (await db.operationScan.count({ where: { correctsId: scan.id } })) === 0
  const limits = await limitsOf(db, [scan.siteId])
  const { limit, over } = overLimitOf(scan, limits.history(scan.siteId), limits.current(scan.siteId))
  return { workOrder, bundleCode: bundle?.code ?? '', decided, standing, limit, over }
}

const judge = (input: DecideInput, scan: ApprovalScanRow, facts: Awaited<ReturnType<typeof factsOf>>, involved: Set<string>, actorId: string) =>
  decisionRefusal({
    decision: input.decision,
    scan: { ...scan, bundleCode: facts.bundleCode },
    limit: facts.limit,
    over: facts.over,
    standing: facts.standing,
    workOrder: { number: facts.workOrder.number, status: facts.workOrder.status as WorkOrderStatus },
    decidedAlready: facts.decided?.decision ?? null,
    selfDecision: involved.has(actorId),
    reason: input.reason ?? null,
    note: input.note?.trim() || null,
  })

/**
 * ONE command: the locks (the work order's scan lock, shared; the bundle's scan lock), the facts read again (for a floor
 * session through the tenant's system scope, AFTER the locks: a decision committed by another session before is seen), the
 * rule, the decision's audit rows and the event. `stepUp` runs after every check, before the command (the floor's PIN).
 */
async function decide(caller: CommandCaller, scan: ApprovalScanRow, input: DecideInput, decider: Decider, options: { readonly stepUp?: (() => void) | undefined; readonly idempotencyKey?: string | undefined }) {
  const involved = await decider.read(caller, (db) => involvedOf(db, scan))
  const before = await decider.read(caller, (db) => factsOf(db, scan))
  const early = judge(input, scan, before, involved, decider.actorId)
  if (early) refused(early)
  options.stepUp?.()
  const note = input.note?.trim() || null
  const reason = input.decision === 'REFUSED' ? (input.reason ?? null) : null
  const { result } = await command(caller, { name: SCRAP_DECISION_ACTION, idempotencyKey: options.idempotencyKey, input: { scanId: scan.id, decision: input.decision, reason, note } }, async (tools) => {
    await scanWorkOrderLock(tools.tx, decider.tenantId, scan.workOrderId)
    await lockBundleScans(tools.tx, decider.tenantId, scan.siteId, scan.bundleId)
    const facts = decider.on === 'OFFICE' ? await factsOf(tools.tx, scan) : await decider.read(caller, (db) => factsOf(db, scan))
    const refusal = judge(input, scan, facts, involved, decider.actorId)
    if (refusal) refused(refusal)
    const after = { decision: input.decision, scrapQuantity: scan.scrapQuantity, limit: facts.limit, reason, note, decidedOn: decider.on }
    const words = input.decision === 'REFUSED' ? refusalReasonText(reason!, note) : (note ?? undefined)
    tools.audit({ action: SCRAP_DECISION_ACTION, recordType: 'OperationScan', recordId: scan.id, companyId: facts.workOrder.companyId, siteId: scan.siteId, after, ...(words ? { reason: words } : {}) })
    tools.audit({ action: SCRAP_DECISION_ACTION, recordType: 'WorkOrder', recordId: scan.workOrderId, companyId: facts.workOrder.companyId, siteId: scan.siteId, after: { scanId: scan.id, bundleId: scan.bundleId, ...after }, ...(words ? { reason: words } : {}) })
    tools.emit({
      type: 'production.scrap_over_limit_decided',
      subject: scan.workOrderId,
      companyId: facts.workOrder.companyId,
      siteId: scan.siteId,
      payload: { workOrderId: scan.workOrderId, number: facts.workOrder.number, siteId: scan.siteId, bundleId: scan.bundleId, scanId: scan.id, decision: input.decision, scrapQuantity: scan.scrapQuantity, limit: facts.limit!, decidedOn: decider.on },
    })
    const approval: ApprovalView = { state: input.decision, limit: facts.limit, decidedAt: toUtcIso(tools.now), decidedOn: decider.on, reason, note }
    return { scanId: scan.id, workOrderId: scan.workOrderId, bundleId: scan.bundleId, approval, words: decisionWords(input.decision, scan.scrapQuantity, facts.bundleCode) }
  })
  return result
}

async function readScanRow(caller: CommandCaller, scanId: string): Promise<ApprovalScanRow | null> {
  if (!isUuid(scanId)) return null
  return caller.withClient((client) => client.operationScan.findUnique({ where: { id: scanId }, select: APPROVAL_SCAN }))
}

const notFound = () => new NotFoundError('Scan not found.')

// ---- the office (production.scrap.overLimit) ------------------------------------------------------------------------------

async function officeScan(caller: CommandCaller, scanId: string): Promise<{ context: OfficeContext; scan: ApprovalScanRow }> {
  const context = officeOf(caller)
  const scan = await readScanRow(caller, scanId)
  if (!scan) throw notFound()
  const order = await caller.withClient((client) => client.workOrder.findUnique({ where: { id: scan.workOrderId }, select: { companyId: true, siteId: true } }))
  if (!order || !can(actorOf(context), PRODUCTION_SCRAP_VIEW, order)) throw notFound()
  if (!can(actorOf(context), PRODUCTION_SCRAP_OVER_LIMIT, order)) throw new ForbiddenError()
  return { context, scan }
}

const officeDecider = (context: OfficeContext): Decider => ({ on: 'OFFICE', actorId: context.actorId, tenantId: context.tenantId, read: (caller, work) => caller.withClient((client) => work(client)) })

/** POST /production/scrap/over-limit/:scanId/approve | refuse (the office). */
export async function officeDecide(caller: CommandCaller, scanId: string, input: DecideInput, idempotencyKey?: string) {
  const { context, scan } = await officeScan(caller, scanId)
  return decide(caller, scan, input, officeDecider(context), { idempotencyKey })
}

/** POST /production/scrap/over-limit/approve (the selection row's "Approve 3"): each its own command, each answered. */
export async function officeApproveMany(caller: CommandCaller, body: { readonly scanIds: readonly string[]; readonly note?: string | undefined }, idempotencyKey?: string) {
  officeOf(caller)
  const approved: string[] = []
  const held: { scanId: string; code: string; message: string }[] = []
  for (const scanId of [...new Set(body.scanIds)]) {
    try {
      await officeDecide(caller, scanId, { decision: 'APPROVED', ...(body.note ? { note: body.note } : {}) }, idempotencyKey ? `${idempotencyKey}:${scanId}` : undefined)
      approved.push(scanId)
    } catch (error) {
      if (error instanceof OverLimitRefusedError) held.push({ scanId, code: error.refusal.code, message: error.refusal.message })
      else if (error instanceof NotFoundError || error instanceof ForbiddenError) held.push({ scanId, code: error instanceof NotFoundError ? 'NOT_FOUND' : 'FORBIDDEN', message: error.message })
      else throw error
    }
  }
  return { approved, held }
}

/** The office's waiting rows within its scope (for the scrap list's filter and tile; views.ts). */
export async function officeWaiting(db: Reader, scope: Prisma.WorkOrderWhereInput, filters: readonly Prisma.OperationScanWhereInput[]) {
  return waitingScans(db, { AND: [{ workOrder: { is: scope } }, ...filters] })
}

export const scopeOfScrapView = (context: OfficeContext) => scopeWhere(actorOf(context), PRODUCTION_SCRAP_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput

// ---- the team leader on the tablet (floor.lead) ---------------------------------------------------------------------------

const floorDecider = (context: FloorContext): Decider => ({ on: 'FLOOR', actorId: context.actorId, tenantId: context.tenantId, read: (caller, work) => systemView(caller).withClient((client) => work(client)) })

/** GET /production/scrap/floor/waiting: the device's site's scrap waiting for a team leader, oldest first; never who. */
export async function floorWaiting(caller: CommandCaller, query: { readonly lineId?: string | undefined }) {
  // The route's manifest (floor.lead, scope site) pinned the session to its device's site; every read below names it.
  const context = floorOf(caller)
  return systemView(caller).withClient(async (db) => {
    const waiting = await waitingScans(db, { siteId: context.siteId })
    const rows = (await rowsOf(db, waiting.reverse())).filter((row) => !query.lineId || row.line?.id === query.lineId)
    const own = new Map(waiting.map(({ scan }) => [scan.id, scan.workerId === context.actorId || scan.createdById === context.actorId]))
    return { rows: rows.map((row) => ({ ...row, own: own.get(row.scanId) ?? false })), refusalTiles: SCRAP_REFUSAL_TILES.map((tile) => ({ ...tile })) }
  })
}

async function floorScan(caller: CommandCaller, scanId: string): Promise<{ context: FloorContext; scan: ApprovalScanRow }> {
  const context = floorOf(caller)
  const scan = await readScanRow(caller, scanId)
  if (!scan || scan.siteId !== context.siteId) throw notFound()
  const order = await caller.withClient((client) => client.workOrder.findUnique({ where: { id: scan.workOrderId }, select: { companyId: true, siteId: true } }))
  if (!order || !can(actorOf(context), 'floor.lead', order)) throw notFound()
  return { context, scan }
}

/** POST /production/scrap/floor/waiting/:scanId/approve (with the PIN) | refuse (a reason tile). */
export async function floorDecide(caller: CommandCaller, scanId: string, input: DecideInput, options: { readonly stepUp?: (() => void) | undefined; readonly idempotencyKey?: string | undefined }) {
  const { context, scan } = await floorScan(caller, scanId)
  return decide(caller, scan, input, floorDecider(context), options)
}

/** The waiting rows for the office's scope (the same row shape as the floor's, for the Scrap & rework DetailModal). */
export async function officeWaitingRows(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly workOrderId?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const waiting = await officeWaiting(db, scopeOfScrapView(context), [query.siteId ? { siteId: query.siteId } : {}, query.workOrderId ? { workOrderId: query.workOrderId } : {}])
    return { rows: await rowsOf(db, waiting.reverse()), refusalTiles: SCRAP_REFUSAL_TILES.map((tile) => ({ ...tile })) }
  })
}
