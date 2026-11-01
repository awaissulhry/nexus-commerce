import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { PRODUCTION_SCAN } from '@nexus/factory-domain/production/scans/permissions'
import type { ScanReason } from '@nexus/factory-domain/production/scans/reasons'
import {
  clockCheck,
  correctionAskRefusal,
  normaliseDefects,
  otherWorkerRefusal,
  reportDecision,
  scansReadyRefusal,
  scrapReasonColumn,
  standingScans,
  subjectRefusal,
  undoRefusal,
  unknownBundleRefusal,
  unknownScanRefusal,
  clientIdReusedRefusal,
  UNDO_WINDOW_MS,
  type DefectLine,
  type ScanRefusal,
} from '@nexus/factory-domain/production/scans/rules'
import type { ScanSubject } from '@nexus/factory-domain/production/settings/monitoring'
import { command, IdempotencyKeyReusedError, type CommandCaller, type CommandTools } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { floorReadinessFor } from '../../../platform/privacy/read'
import { bundleFlowOf } from '../bundles/flow'
import { lockBundleForScan, readBundle, readBundleByCode, type BundleRow } from '../bundles/store'
// W2b B-W2b-41: coupons per operation (MES-067).
import { couponForScan } from '../bundles/coupons'
import { floorRecordSubjectFor, hasAcknowledgedNotice, scanSubjectFor } from '../settings/subject'
// W2b B-W2b-29: a bundle scanned ends the running off-standard block (MES-156).
import { believedTime } from '@nexus/factory-domain/production/offstandard/rules'
import { endRunningBlock } from '../offstandard/writes'
import { startOnFirstWork } from '../work-orders/moves'
import { stationBlock } from '../../plant/checks'
import { holdOnScan } from '../../quality/holds/checks'
import { floorOf, mayScan, ScanRefusedError, refuse, systemView } from './access'
import { insertCorrectionRequest, readCorrectionRequests, type CorrectionRequest } from './corrections-store'
import { readDefects, writeDefects } from './defects-store'
import { readReasons } from './reasons-store'
import { recordRefusal, resolveRefusals, type RefusedAction } from './refusals-store'
import {
  deviceStationOf,
  latestOnDevice,
  lockBundleScans,
  readBundleScans,
  readHeader,
  readOperations,
  readScan,
  readScanByClient,
  readStations,
  scanWorkOrderLock,
  siteTimeZone,
  type OperationRow,
  type ScanHeader,
  type ScanRow,
} from './store'
// B-W2b-46 hook (modules/production/guards): the site's checks before a scan counts, the override, the lots at the operation.
import { guardReportInCommand, recordGuardsInCommand, type ComponentInput, type VerifiedOverride } from './hooks/guards'
// B-W2b-53 hook: scrap above the site's limit waits for the team leader (the answer's words).
import { scrapWaitsInCommand, type ScrapWaits } from './hooks/scrap-limit'
// B-W2b-40 hook (modules/production/terminal; MES-094): a report that ends a team's stretch names the team.
import { timingAfterReportInCommand } from './hooks/timing'

/**
 * The floor's scans (B-W1-42; MES-069, MES-090, MES-095, MES-096, MES-308; PLAN §4.7 stage 12-scans, risk 17; A1 §3.8;
 * A2 SCR-090; design floor.operation, floor.sync): report a bundle at an operation, undo one's own last report, ask a
 * correction of an older own report, online one at a time or as the offline queue's batch in device order. Each action
 * is ONE command() on the floor (production.scan, its own site) in the lock order of store.ts, judged by
 * factory-domain production/scans/rules; the …_production_guards trigger stays the last word.
 *
 * Offline (A1 §3.8): every action carries the device's id for it (`clientScanId`, unique per device) and its time on the
 * device (`occurredAt`, kept as deviceTime beside the server's time). The command's idempotency key is
 * `<deviceId>.<clientScanId>`, so a resend answers from the receipt, and the scan's unique key (tenant, device, client
 * scan id) answers a resend after the receipt is gone: either way `duplicate` with the scan recorded first, never a
 * second row. The same id for another action is refused (CLIENT_ID_REUSED). A batch is judged item by item in the order
 * sent (the queue's FIFO is the device's order): each is accepted, a duplicate, or refused with a code, its words, ONE
 * fix and whether it may pass when sent again; every refused item is kept (refusals-store.ts) for the device's queue
 * and the office's refused scans (SCR-023 data), until it is discarded or the same id is accepted later.
 *
 * Gates: a report waits for the site's floor to be ready (platform/privacy floorReadinessFor, read as the tenant's
 * system caller: FLOOR_NOT_READY in the gate's words); who a scan names is the site's floor rules' (production/settings
 * subject.ts: the signed-in worker who acknowledged the notice in force, or only the device's station). The undo and the
 * ask are not held by the readiness gate (they take a record back or ask a person to), but the ask names its asker by the
 * same rules. The first accepted report of a RELEASED work order starts it (work-orders startOnFirstWork, as the
 * tenant's system caller, after the commit; a failure there is retried by the next scan).
 */

export interface DefectInput {
  readonly reason: string
  readonly quantity: number
}

export interface ReportInput {
  readonly clientScanId: string
  /** The scanned ticket's code, or the bundle's id: exactly one. */
  readonly code?: string | undefined
  readonly bundleId?: string | undefined
  /** The operation; absent: the one this station does next for the bundle. */
  readonly workOrderOperationId?: string | undefined
  readonly good: number
  readonly scrap?: readonly DefectInput[] | undefined
  readonly rework?: readonly DefectInput[] | undefined
  /** Why a station reports an operation of another kind of work. */
  readonly kindReason?: string | undefined
  /** When it happened, by the device's clock. */
  readonly occurredAt?: string | undefined
  /** B-W2b-46 (MES-114): the lots scanned at the operation, each with the garments it traces. */
  readonly components?: readonly ComponentInput[] | undefined
  /** B-W2b-46: a team leader's verified override of the held checks (POST /production/guards/override; never a PIN). */
  readonly override?: VerifiedOverride | undefined
}

export interface UndoInput {
  readonly clientScanId: string
  /** The report to undo: its id, or the client scan id this device sent it under (an offline queue knows only that). */
  readonly scanId?: string | undefined
  readonly undoesClientScanId?: string | undefined
  readonly occurredAt?: string | undefined
}

export interface AskInput {
  readonly clientScanId: string
  /** The report to correct: its id, or the client scan id this device sent it under. */
  readonly scanId?: string | undefined
  readonly targetClientScanId?: string | undefined
  readonly good: number
  readonly scrap?: readonly DefectInput[] | undefined
  readonly rework?: readonly DefectInput[] | undefined
  readonly reason: string
  readonly occurredAt?: string | undefined
}

export type BatchItem =
  | ({ readonly action: 'REPORT'; readonly workerId?: string | undefined } & ReportInput)
  | ({ readonly action: 'UNDO'; readonly workerId?: string | undefined } & UndoInput)
  | ({ readonly action: 'ASK_CORRECTION'; readonly workerId?: string | undefined } & AskInput)

const UNDO_NOTE = 'Undone on the floor right after the report.'

const at = (value: Date | null) => (value ? toUtcIso(value) : null)
const deviceTimeOf = (occurredAt: string | undefined) => (occurredAt ? parseInstant(occurredAt) : null)
const keyOf = (context: FloorContext, clientScanId: string) => `${context.deviceId}.${clientScanId}`

// ---- views ----------------------------------------------------------------------------------------------------------------------

export interface ScanView {
  readonly id: string
  readonly kind: 'REPORT' | 'UNDO' | 'CORRECTION'
  readonly workOrderId: string
  readonly bundleId: string
  readonly bundleCode: string
  readonly operation: { readonly id: string; readonly seq: number; readonly code: string; readonly name: string }
  readonly correctsId: string | null
  readonly goodQuantity: number
  readonly scrapQuantity: number
  readonly reworkQuantity: number
  readonly defects: DefectLine[]
  readonly reason: string | null
  readonly stationId: string | null
  readonly deviceId: string | null
  readonly clientScanId: string
  readonly deviceTime: string | null
  readonly serverTime: string
  /** A REPORT: the last moment its undo is taken on the floor (or the next scan on the device, whichever first). */
  readonly undoUntil: string | null
  /** B-W2b-10: an outside operation's REPORT names the subcontract receipt line that brought the bundle back. */
  readonly subcontractReceiptLineId: string | null
  /** B-W2b-53: a floor REPORT whose scrap is above the site's limit (the answer when it was taken; null: no approval needed). */
  readonly scrapWaits?: ScrapWaits | null
}

export function scanView(scan: ScanRow, operations: readonly OperationRow[], bundleCode: string, defects: readonly DefectLine[]): ScanView {
  const operation = operations.find((row) => row.id === scan.workOrderOperationId)
  return {
    id: scan.id,
    kind: scan.kind,
    workOrderId: scan.workOrderId,
    bundleId: scan.bundleId,
    bundleCode,
    operation: { id: scan.workOrderOperationId, seq: operation?.seq ?? 0, code: operation?.code ?? '', name: operation?.name ?? '' },
    correctsId: scan.correctsId,
    goodQuantity: scan.goodQuantity,
    scrapQuantity: scan.scrapQuantity,
    reworkQuantity: scan.reworkQuantity,
    defects: [...defects],
    reason: scan.reason,
    stationId: scan.stationId,
    deviceId: scan.deviceId,
    clientScanId: scan.clientScanId,
    deviceTime: at(scan.deviceTime),
    serverTime: toUtcIso(scan.serverTime),
    undoUntil: scan.kind === 'REPORT' && scan.deviceId ? toUtcIso(new Date(scan.serverTime.getTime() + UNDO_WINDOW_MS)) : null,
    subcontractReceiptLineId: scan.subcontractReceiptLineId ?? null,
  }
}

export function requestView(request: CorrectionRequest) {
  return {
    id: request.id,
    status: request.status,
    workOrderId: request.workOrderId,
    bundleId: request.bundleId,
    workOrderOperationId: request.workOrderOperationId,
    scanId: request.scanId,
    goodQuantity: request.goodQuantity,
    scrapQuantity: request.scrapQuantity,
    reworkQuantity: request.reworkQuantity,
    defects: request.defects.map((line) => ({ ...line })),
    reason: request.reason,
    stationId: request.stationId,
    deviceId: request.deviceId,
    clientRequestId: request.clientRequestId,
    deviceTime: request.deviceTime,
    serverTime: request.serverTime,
    decidedAt: request.decidedAt,
    decisionNote: request.decisionNote,
    correctionScanId: request.correctionScanId,
  }
}
export type RequestView = ReturnType<typeof requestView>

// ---- outcomes ------------------------------------------------------------------------------------------------------------------

export type Outcome =
  | { readonly status: 'accepted' | 'duplicate'; readonly scan: ScanView; readonly request?: undefined; readonly refusal?: undefined }
  | { readonly status: 'accepted' | 'duplicate'; readonly request: RequestView; readonly scan?: undefined; readonly refusal?: undefined }
  | { readonly status: 'refused'; readonly refusal: ScanRefusal; readonly scan?: undefined; readonly request?: undefined }

const refused = (refusal: ScanRefusal): Outcome => ({ status: 'refused', refusal })

/** Online, a missing bundle or scan is a 404 (and a bad label a 400); in a batch it is a refusal kept for the queue. */
type Mode = 'online' | 'batch'

/** What one request reads once for all its actions: the device's station, the site's rules, the reasons, the gate. */
interface Session {
  readonly context: FloorContext
  readonly mode: Mode
  stationId?: string | null
  subject?: ScanSubject
  reasons?: ScanReason[]
  ready?: ScanRefusal | null
  timeZone?: string
}

function sessionOf(caller: CommandCaller, mode: Mode): Session {
  return { context: floorOf(caller), mode }
}

async function stationOf(caller: CommandCaller, session: Session): Promise<string | null> {
  if (session.stationId === undefined) session.stationId = await caller.withClient((client) => deviceStationOf(client, session.context.deviceId))
  return session.stationId
}

async function subjectOf(caller: CommandCaller, session: Session): Promise<ScanSubject> {
  if (session.subject === undefined) session.subject = await caller.withClient((client) => scanSubjectFor(client, session.context.siteId))
  return session.subject
}

async function reasonsOf(caller: CommandCaller, session: Session): Promise<ScanReason[]> {
  if (session.reasons === undefined) session.reasons = await caller.withClient((client) => readReasons(client))
  return session.reasons
}

/** The site's floor is ready (B-W1-36, B-W1-37), or the refusal in the gate's words; read once as the tenant's system caller. */
async function readyOf(caller: CommandCaller, session: Session): Promise<ScanRefusal | null> {
  if (session.ready === undefined) session.ready = scansReadyRefusal(await systemView(caller).withClient((client) => floorReadinessFor(client, session.context.siteId, serverClock.now())))
  return session.ready
}

const linesOf = (input: { readonly scrap?: readonly DefectInput[] | undefined; readonly rework?: readonly DefectInput[] | undefined }): DefectLine[] => [
  ...(input.scrap ?? []).map((line) => ({ kind: 'SCRAP' as const, reason: line.reason, quantity: line.quantity })),
  ...(input.rework ?? []).map((line) => ({ kind: 'REWORK' as const, reason: line.reason, quantity: line.quantity })),
]

/** The bundle a report names (its ticket's code, current or replaced, or its id) at the device's site. */
async function resolveBundle(caller: CommandCaller, session: Session, input: Pick<ReportInput, 'code' | 'bundleId'>): Promise<{ readonly bundle: BundleRow; readonly scanned: string } | (ScanRefusal & { readonly label: boolean })> {
  const { context } = session
  let scanned: string | null = null
  const bundle = await caller.withClient(async (client) => {
    if (input.code !== undefined) {
      const typed = input.code.trim().toUpperCase()
      const scan = parseScanId(typed, { tenantTag: tenantTag(context.tenantId), types: ['BUNDLE'] })
      if (!scan.ok && scan.problem !== 'format') return scan.message
      scanned = scan.ok ? scan.text : typed
      return readBundleByCode(client, scanned)
    }
    return input.bundleId !== undefined ? readBundle(client, input.bundleId) : null
  })
  // Another kind of label or another factory's: the label is wrong (online a 400); no such bundle here: not found.
  if (typeof bundle === 'string') return { ...unknownBundleRefusal(bundle), label: true }
  if (!bundle || bundle.siteId !== context.siteId) return { ...unknownBundleRefusal(), label: false }
  return { bundle, scanned: scanned ?? bundle.code }
}

/** The work order of a bundle or scan, reachable by the device (else null). */
async function workOrderOf(caller: CommandCaller, session: Session, workOrderId: string): Promise<ScanHeader | null> {
  const workOrder = await caller.withClient((client) => readHeader(client, workOrderId))
  return workOrder && mayScan(session.context, PRODUCTION_SCAN, workOrder) ? workOrder : null
}

/** Runs one action's command; a rule's refusal, a resent id and a race with a resend become outcomes. */
async function judged(work: () => Promise<Outcome>, raced: () => Promise<Outcome | null>, clientScanId: string): Promise<Outcome> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ScanRefusedError) return refused(error.refusal)
    if (error instanceof IdempotencyKeyReusedError) return refused(clientIdReusedRefusal(clientScanId))
    // The same action sent twice at once (the unique key refused the second): the first one's record is the answer.
    const first = await raced().catch(() => null)
    if (first) return first
    throw error
  }
}

/** The first report of a released work order starts it (as the tenant's system caller; the next scan retries a failure). */
async function startsWorkOrder(caller: CommandCaller, workOrder: ScanHeader, scanId: string): Promise<void> {
  if (workOrder.status !== 'RELEASED') return
  try {
    await startOnFirstWork(systemView(caller), workOrder.id, { what: `the scan ${scanId}` })
  } catch {
    // The scan stands; the work order stays RELEASED until the next scan starts it (or the office does).
  }
}

/**
 * W2a B-W2a-26 hook (modules/quality/holds/checks.ts): a scan of a bundle on hold, or of a work order on hold, is refused
 * with the hold's reason before the database's triggers would (MES-008: "floor devices refuse to start it and show the
 * reason"); not final: it passes once quality releases the hold.
 */
export async function refuseIfHeld(tools: CommandTools, bundleId: string, workOrderId: string): Promise<void> {
  const held = await holdOnScan(tools.tx, tools.context, { bundleId, workOrderId })
  if (held) refuse({ code: 'ON_HOLD', message: held.message, fix: held.fix, final: false })
}

// ---- report ----------------------------------------------------------------------------------------------------------------------

async function reportedBefore(caller: CommandCaller, session: Session, input: ReportInput): Promise<Outcome | null> {
  const found = await caller.withClient(async (client) => {
    const scan = await readScanByClient(client, session.context.deviceId, input.clientScanId)
    if (!scan) return null
    const bundle = await readBundle(client, scan.bundleId)
    return { scan, bundle, operations: await readOperations(client, scan.workOrderId) }
  })
  if (!found) return null
  // W2b B-W2b-41: a resent coupon's code names its bundle too (bundles/store.ts readBundleByCode reads coupons).
  const resent = input.code?.trim().toUpperCase() ?? ''
  const sameBundle =
    input.bundleId !== undefined
      ? input.bundleId === found.scan.bundleId
      : !!found.bundle && (resent === found.bundle.code || found.bundle.replacedCodes.includes(resent) || (await caller.withClient((client) => readBundleByCode(client, resent)))?.id === found.bundle.id)
  if (found.scan.kind !== 'REPORT' || !sameBundle || (input.workOrderOperationId !== undefined && input.workOrderOperationId !== found.scan.workOrderOperationId)) {
    return refused(clientIdReusedRefusal(input.clientScanId))
  }
  const defects = (await caller.withClient((client) => readDefects(client, [found.scan.id]))).get(found.scan.id) ?? []
  return { status: 'duplicate', scan: scanView(found.scan, found.operations, found.bundle?.code ?? '', defects) }
}

async function report(caller: CommandCaller, session: Session, input: ReportInput): Promise<Outcome> {
  const { context } = session
  const before = await reportedBefore(caller, session, input)
  if (before) return before
  const resolved = await resolveBundle(caller, session, input)
  if (!('bundle' in resolved)) {
    const { label, ...refusal } = resolved
    if (session.mode === 'online') throw label ? new ValidationError(refusal.message, [{ path: 'body/code', message: refusal.message }]) : new NotFoundError(refusal.message)
    return refused(refusal)
  }
  const { bundle, scanned } = resolved
  const workOrder = await workOrderOf(caller, session, bundle.workOrderId)
  if (!workOrder) {
    if (session.mode === 'online') throw new NotFoundError('Not a bundle ticket of this site.')
    return refused(unknownBundleRefusal())
  }
  const ready = await readyOf(caller, session)
  if (ready) return refused(ready)
  const normal = normaliseDefects(linesOf(input), await reasonsOf(caller, session))
  if (!normal.ok) return refused(normal.refusal)
  const counts = { good: input.good, scrap: normal.scrap, rework: normal.rework }
  const deviceTime = deviceTimeOf(input.occurredAt)
  const stationId = await stationOf(caller, session)
  const timeZone = session.timeZone ?? (session.timeZone = await caller.withClient((client) => siteTimeZone(client, context.siteId)))

  const outcome = await judged(
    async () => {
      const { result, replayed } = await command(
        caller,
        {
          name: 'production.reportScan',
          idempotencyKey: keyOf(context, input.clientScanId),
          input: { ...input, bundleId: bundle.id, lines: normal.lines },
          ...(deviceTime ? { deviceTime } : {}),
        },
        (tools) => reportInCommand(tools, { bundle, scanned, input, lines: normal.lines, counts, deviceTime, stationId, timeZone }),
      )
      return { status: replayed ? 'duplicate' : 'accepted', scan: result } as Outcome
    },
    () => reportedBefore(caller, session, input),
    input.clientScanId,
  )
  if (outcome.status === 'accepted' && outcome.scan) await startsWorkOrder(caller, workOrder, outcome.scan.id)
  return outcome
}

interface ReportWork {
  readonly bundle: BundleRow
  readonly scanned: string
  readonly input: ReportInput
  readonly lines: DefectLine[]
  readonly counts: { readonly good: number; readonly scrap: number; readonly rework: number }
  readonly deviceTime: Date | null
  readonly stationId: string | null
  readonly timeZone: string
}

/** The report INSIDE its command: the locks, the facts read again, the rules, the row, its lines, audits and event. */
async function reportInCommand(tools: CommandTools, work: ReportWork): Promise<ScanView> {
  const context = floorOf({ factoryContext: tools.context })
  const { tx } = tools
  await scanWorkOrderLock(tx, context.tenantId, work.bundle.workOrderId)
  const locked = await lockBundleForScan(tx, work.bundle.id, work.scanned)
  if (!locked) throw new NotFoundError('Not a bundle ticket of this site.')
  await lockBundleScans(tx, context.tenantId, locked.bundle.siteId, locked.bundle.id)
  await refuseIfHeld(tools, locked.bundle.id, locked.bundle.workOrderId)
  // W2a B-W2a-35b hook (plant/checks.ts, Owner answer H1): a station whose machines are all do-not-use takes no report; not final: it passes once one of them may be used again (a technician signed it safe).
  const unsafe = await stationBlock(tx, work.stationId)
  if (unsafe) refuse({ code: 'MACHINE_UNSAFE', message: unsafe.message, fix: unsafe.fix, final: false })
  const workOrder = (await readHeader(tx, locked.bundle.workOrderId))!
  const operations = await readOperations(tx, workOrder.id)
  const scans = await readBundleScans(tx, locked.bundle.id)
  const standing = standingScans(scans)
  const stations = await readStations(tx, [work.stationId, ...scans.map((scan) => scan.stationId)])
  const station = work.stationId ? (stations.get(work.stationId) ?? null) : null
  const scanSubject = await scanSubjectFor(tx, workOrder.siteId)
  const acknowledged = scanSubject === 'WORKER' ? await hasAcknowledgedNotice(tx, workOrder.siteId, context.actorId) : false
  const notNamed = subjectRefusal({ scanSubject, workerId: context.actorId, acknowledged, stationId: work.stationId })
  if (notNamed) refuse(notNamed)
  // W2a B-W2a-13 hook (bundles/flow.ts): a split bundle's live garments, a child's place in the flow, rework back in it.
  const flow = await bundleFlowOf(tx, locked.bundle, operations, standing)
  if (flow.refusal) refuse(flow.refusal)
  // W2b B-W2b-41 hook (bundles/coupons.ts couponForScan; MES-067): a scanned coupon reports its own operation; an old or
  // voided coupon, or a coupon of another operation than the one named, is refused.
  const coupon = await couponForScan(tx, locked.bundle.id, work.scanned, work.input.workOrderOperationId ?? null)
  if (coupon && !coupon.ok) refuse({ code: coupon.code, message: coupon.message, fix: coupon.fix, final: true })

  const decision = reportDecision({
    workOrder,
    bundleId: locked.bundle.id,
    bundle: { code: locked.bundle.code, quantity: flow.quantity, status: locked.bundle.status, replacedCodes: locked.bundle.replacedCodes },
    scanned: work.scanned,
    operations,
    operationId: work.input.workOrderOperationId ?? (coupon?.ok ? coupon.operationId : null),
    station: station ? { code: station.code, kind: station.kind } : null,
    kindReason: work.input.kindReason?.trim() || null,
    standing: flow.standing,
    counts: work.counts,
    viewer: { scanSubject, workerId: context.actorId, stationId: work.stationId },
    stationCodes: new Map([...stations.values()].map((row) => [row.id, row.code])),
    timeZone: work.timeZone,
    guarded: true,
  })
  if (!decision.ok) return refuse(decision.refusal)
  // B-W2b-46 hook (production/guards): the site's checks hold the report (or a team leader's override lifts them); the lots at the operation.
  const guard = await guardReportInCommand(tools, { workOrder, bundle: { id: locked.bundle.id, code: locked.bundle.code, workOrderSizeId: work.bundle.workOrderSizeId }, quantity: flow.quantity, operations, operation: decision.operation, standing: flow.standing, counts: work.counts, stationId: work.stationId, components: work.input.components, override: work.input.override })
  // Who it names: the site's floor rules (the trigger checks the same).
  const subject = await floorRecordSubjectFor(tx, { siteId: workOrder.siteId, workerId: context.actorId, stationId: work.stationId })
  const otherKind = station !== null && station.kind !== decision.operation.workCentreKind
  const id = newId()
  await tx.operationScan.create({
    data: {
      id,
      siteId: workOrder.siteId,
      workOrderId: workOrder.id,
      workOrderOperationId: decision.operation.id,
      bundleId: locked.bundle.id,
      kind: 'REPORT',
      goodQuantity: work.counts.good,
      scrapQuantity: work.counts.scrap,
      reworkQuantity: work.counts.rework,
      scrapReason: scrapReasonColumn(work.lines),
      reason: otherKind ? work.input.kindReason!.trim() : null,
      workerId: subject.workerId,
      stationId: subject.stationId,
      deviceId: context.deviceId,
      clientScanId: work.input.clientScanId,
      deviceTime: work.deviceTime,
      serverTime: tools.now,
      createdById: subject.workerId ? context.actorId : null,
    },
    select: { id: true },
  })
  await writeDefects(tools, { scanId: id, siteId: workOrder.siteId, createdById: subject.workerId ? context.actorId : null }, work.lines)
  // A refused send of this action that the device's queue sent again under the same id is resolved by it.
  await resolveRefusals(tx, tools.now, { deviceId: context.deviceId, clientScanId: work.input.clientScanId, scanId: id })
  // W2b B-W2b-29 hook (offstandard/writes.ts; MES-156): scanning a bundle returns to standard work — the subject's running off-standard block ends at the scan.
  await endRunningBlock(tools, { tenantId: context.tenantId, siteId: workOrder.siteId, subject, at: believedTime(work.deviceTime, tools.now), endedBy: 'SCAN' })
  // B-W2b-40 hook (hooks/timing.ts; MES-094, F3): the report ends the running stretch (the database's rule); its team is named on it.
  await timingAfterReportInCommand(tools, { scanId: id, siteId: workOrder.siteId, bundleId: locked.bundle.id, workOrderOperationId: decision.operation.id, subject, createdById: subject.workerId ? context.actorId : null })
  const row = (await readScan(tx, id))!
  const after = { workOrderId: workOrder.id, bundleId: locked.bundle.id, operationId: decision.operation.id, operationSeq: decision.operation.seq, goodQuantity: row.goodQuantity, scrapQuantity: row.scrapQuantity, reworkQuantity: row.reworkQuantity, cap: guard.cap, workerId: row.workerId, stationId: row.stationId, clientScanId: row.clientScanId }
  tools.audit({ action: 'production.reportScan', recordType: 'OperationScan', recordId: id, companyId: workOrder.companyId, siteId: workOrder.siteId, after, ...(row.reason ? { reason: row.reason } : {}) })
  tools.audit({ action: 'production.reportScan', recordType: 'WorkOrder', recordId: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { scanId: id, bundleId: locked.bundle.id, operationId: decision.operation.id, goodQuantity: row.goodQuantity, scrapQuantity: row.scrapQuantity, reworkQuantity: row.reworkQuantity } })
  tools.emit(scanEvent(workOrder, row, decision.operation.seq, 'FLOOR'))
  // B-W2b-46 hook: what the checks found, the override and the lots, kept and told.
  recordGuardsInCommand(tools, guard, { scan: row, workOrder, bundleId: locked.bundle.id, operation: decision.operation })
  // B-W2b-53 hook: the scrap above the site's limit waits for the team leader before it posts; the tablet is told.
  return { ...scanView(row, operations, locked.bundle.code, work.lines), scrapWaits: await scrapWaitsInCommand(tools, workOrder.siteId, row.scrapQuantity) }
}

export function scanEvent(workOrder: Pick<ScanHeader, 'id' | 'number' | 'companyId' | 'siteId'>, scan: ScanRow, operationSeq: number, postedBy: 'FLOOR' | 'OFFICE' | 'SYSTEM') {
  return {
    type: 'production.scan_recorded',
    subject: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    payload: {
      workOrderId: workOrder.id,
      number: workOrder.number,
      bundleId: scan.bundleId,
      scanId: scan.id,
      kind: scan.kind,
      operationId: scan.workOrderOperationId,
      operationSeq,
      correctsId: scan.correctsId,
      goodQuantity: scan.goodQuantity,
      scrapQuantity: scan.scrapQuantity,
      reworkQuantity: scan.reworkQuantity,
      postedBy,
    },
  }
}

// ---- undo ------------------------------------------------------------------------------------------------------------------------

/** The device's scan a request names: by id, or by the client scan id this device sent it under. */
async function namedScan(caller: CommandCaller, session: Session, ref: { readonly scanId?: string | undefined; readonly clientScanId?: string | undefined }): Promise<ScanRow | null> {
  return caller.withClient(async (client) => {
    if (ref.scanId !== undefined) return readScan(client, ref.scanId)
    if (ref.clientScanId !== undefined) return readScanByClient(client, session.context.deviceId, ref.clientScanId)
    return null
  })
}

async function undoneBefore(caller: CommandCaller, session: Session, input: UndoInput): Promise<Outcome | null> {
  const found = await caller.withClient(async (client) => {
    const scan = await readScanByClient(client, session.context.deviceId, input.clientScanId)
    if (!scan) return null
    return { scan, bundle: await readBundle(client, scan.bundleId), operations: await readOperations(client, scan.workOrderId), target: scan.correctsId ? await readScan(client, scan.correctsId) : null }
  })
  if (!found) return null
  const sameTarget = input.scanId !== undefined ? input.scanId === found.scan.correctsId : found.target?.clientScanId === input.undoesClientScanId && found.target?.deviceId === session.context.deviceId
  if (found.scan.kind !== 'UNDO' || !sameTarget) return refused(clientIdReusedRefusal(input.clientScanId))
  return { status: 'duplicate', scan: scanView(found.scan, found.operations, found.bundle?.code ?? '', []) }
}

async function undo(caller: CommandCaller, session: Session, input: UndoInput): Promise<Outcome> {
  const { context } = session
  const before = await undoneBefore(caller, session, input)
  if (before) return before
  const target = await namedScan(caller, session, { scanId: input.scanId, clientScanId: input.undoesClientScanId })
  const workOrder = target ? await workOrderOf(caller, session, target.workOrderId) : null
  if (!target || !workOrder) {
    if (session.mode === 'online') throw new NotFoundError('Scan not found.')
    return refused(unknownScanRefusal())
  }
  const deviceTime = deviceTimeOf(input.occurredAt)
  const stationId = await stationOf(caller, session)
  return judged(
    async () => {
      const { result, replayed } = await command(
        caller,
        { name: 'production.undoScan', idempotencyKey: keyOf(context, input.clientScanId), input: { ...input, scanId: target.id }, ...(deviceTime ? { deviceTime } : {}) },
        async (tools) => {
          const { tx } = tools
          await scanWorkOrderLock(tx, context.tenantId, target.workOrderId)
          const locked = await lockBundleForScan(tx, target.bundleId)
          if (!locked) throw new NotFoundError('Scan not found.')
          await lockBundleScans(tx, context.tenantId, target.siteId, target.bundleId)
          await refuseIfHeld(tools, target.bundleId, target.workOrderId)
          const current = (await readHeader(tx, target.workOrderId))!
          const operations = await readOperations(tx, current.id)
          const scans = await readBundleScans(tx, target.bundleId)
          const scanSubject = await scanSubjectFor(tx, current.siteId)
          const refusal = undoRefusal({
            workOrder: current,
            target: scans.find((scan) => scan.id === target.id) ?? null,
            operations,
            scans,
            latestOnDevice: await latestOnDevice(tx, context.deviceId),
            deviceId: context.deviceId,
            viewer: { scanSubject, workerId: context.actorId, stationId },
            deviceTime,
            now: tools.now,
          })
          if (refusal) refuse(refusal)
          const id = newId()
          await tx.operationScan.create({
            data: {
              id,
              siteId: current.siteId,
              workOrderId: current.id,
              workOrderOperationId: target.workOrderOperationId,
              bundleId: target.bundleId,
              kind: 'UNDO',
              correctsId: target.id,
              reason: UNDO_NOTE,
              // The undo names the report's own worker and station (the trigger's rule): the person undoing is that worker.
              workerId: target.workerId,
              stationId: target.stationId,
              deviceId: context.deviceId,
              clientScanId: input.clientScanId,
              deviceTime,
              serverTime: tools.now,
              createdById: target.workerId ? context.actorId : null,
            },
            select: { id: true },
          })
          await resolveRefusals(tx, tools.now, { deviceId: context.deviceId, clientScanId: input.clientScanId, scanId: id })
          const row = (await readScan(tx, id))!
          const operation = operations.find((entry) => entry.id === target.workOrderOperationId)!
          tools.audit({ action: 'production.undoScan', recordType: 'OperationScan', recordId: id, companyId: current.companyId, siteId: current.siteId, after: { correctsId: target.id, bundleId: target.bundleId, operationId: operation.id, clientScanId: input.clientScanId }, reason: UNDO_NOTE })
          tools.audit({ action: 'production.undoScan', recordType: 'WorkOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { scanId: id, undoneId: target.id, bundleId: target.bundleId, operationId: operation.id }, reason: UNDO_NOTE })
          tools.emit(scanEvent(current, row, operation.seq, 'FLOOR'))
          return scanView(row, operations, locked.bundle.code, [])
        },
      )
      return { status: replayed ? 'duplicate' : 'accepted', scan: result } as Outcome
    },
    () => undoneBefore(caller, session, input),
    input.clientScanId,
  )
}

// ---- ask a correction ------------------------------------------------------------------------------------------------------------

async function askedBefore(caller: CommandCaller, session: Session, input: AskInput): Promise<Outcome | null> {
  const [request] = await caller.withClient((client) => readCorrectionRequests(client, { siteIds: [session.context.siteId], deviceId: session.context.deviceId, clientRequestId: input.clientScanId }))
  if (!request) return null
  if (input.scanId !== undefined && input.scanId !== request.scanId) return refused(clientIdReusedRefusal(input.clientScanId))
  return { status: 'duplicate', request: requestView(request) }
}

async function ask(caller: CommandCaller, session: Session, input: AskInput): Promise<Outcome> {
  const { context } = session
  const before = await askedBefore(caller, session, input)
  if (before) return before
  const target = await namedScan(caller, session, { scanId: input.scanId, clientScanId: input.targetClientScanId })
  const workOrder = target ? await workOrderOf(caller, session, target.workOrderId) : null
  if (!target || !workOrder) {
    if (session.mode === 'online') throw new NotFoundError('Scan not found.')
    return refused(unknownScanRefusal())
  }
  const normal = normaliseDefects(linesOf(input), await reasonsOf(caller, session))
  if (!normal.ok) return refused(normal.refusal)
  const deviceTime = deviceTimeOf(input.occurredAt)
  const stationId = await stationOf(caller, session)
  const counts = { good: input.good, scrap: normal.scrap, rework: normal.rework }
  return judged(
    async () => {
      const { result, replayed } = await command(
        caller,
        { name: 'production.askScanCorrection', idempotencyKey: keyOf(context, input.clientScanId), input: { ...input, scanId: target.id, lines: normal.lines }, ...(deviceTime ? { deviceTime } : {}) },
        async (tools) => {
          const { tx } = tools
          await scanWorkOrderLock(tx, context.tenantId, target.workOrderId)
          await lockBundleScans(tx, context.tenantId, target.siteId, target.bundleId)
          const current = (await readHeader(tx, target.workOrderId))!
          const operations = await readOperations(tx, current.id)
          const scans = await readBundleScans(tx, target.bundleId)
          const bundle = (await readBundle(tx, target.bundleId))!
          const scanSubject = await scanSubjectFor(tx, current.siteId)
          // The ask names its asker by the site's floor rules, as a scan does (the trigger checks the same).
          const acknowledged = scanSubject === 'WORKER' ? await hasAcknowledgedNotice(tx, current.siteId, context.actorId) : false
          const notNamed = subjectRefusal({ scanSubject, workerId: context.actorId, acknowledged, stationId })
          if (notNamed) refuse(notNamed)
          // Under the bundle's scan lock: the target's own lines, and a pending ask of it (two asks of one scan take turns).
          const facts = {
            targetLines: (await readDefects(tx, [target.id])).get(target.id) ?? [],
            pending: (await readCorrectionRequests(tx, { scanIds: [target.id], status: 'PENDING' })).length > 0,
          }
          // W2b B-W2b-10 hook (bundles/flow.ts): a split parent's correction is capped at its live garments.
          const flow = await bundleFlowOf(tx, bundle, operations, standingScans(scans))
          const refusal = correctionAskRefusal({
            workOrder: current,
            bundle: { code: bundle.code, quantity: flow.quantity },
            standing: flow.standing,
            target: scans.find((scan) => scan.id === target.id) ?? null,
            operations,
            scans,
            counts,
            lines: normal.lines,
            targetLines: facts.targetLines,
            viewer: { scanSubject, workerId: context.actorId, stationId },
            pending: facts.pending,
          })
          if (refusal) refuse(refusal)
          const request: CorrectionRequest = {
            id: newId(),
            companyId: current.companyId,
            siteId: current.siteId,
            workOrderId: current.id,
            bundleId: target.bundleId,
            workOrderOperationId: target.workOrderOperationId,
            scanId: target.id,
            goodQuantity: counts.good,
            scrapQuantity: counts.scrap,
            reworkQuantity: counts.rework,
            defects: normal.lines,
            reason: input.reason.trim(),
            status: 'PENDING',
            askedById: scanSubject === 'WORKER' ? context.actorId : null,
            stationId,
            deviceId: context.deviceId,
            clientRequestId: input.clientScanId,
            deviceTime: at(deviceTime),
            serverTime: toUtcIso(tools.now),
            decidedById: null,
            decidedAt: null,
            decisionNote: null,
            correctionScanId: null,
            version: 1,
          }
          await insertCorrectionRequest(tools, request)
          await resolveRefusals(tx, tools.now, { deviceId: context.deviceId, clientScanId: input.clientScanId, requestId: request.id })
          tools.audit({ action: 'production.askScanCorrection', recordType: 'WorkOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { requestId: request.id, scanId: target.id, bundleId: target.bundleId }, reason: request.reason })
          tools.emit({
            type: 'production.scan_correction_requested',
            subject: current.id,
            companyId: current.companyId,
            siteId: current.siteId,
            payload: { workOrderId: current.id, number: current.number, requestId: request.id, scanId: target.id, bundleId: target.bundleId, operationId: target.workOrderOperationId },
          })
          return requestView(request)
        },
      )
      return { status: replayed ? 'duplicate' : 'accepted', request: result } as Outcome
    },
    () => askedBefore(caller, session, input),
    input.clientScanId,
  )
}

// ---- the routes' entry points ------------------------------------------------------------------------------------------------------

/** An online action's outcome as the route answers it: the record (201, or 200 for a resend), or the 409 in words. */
function scanAnswer(outcome: Outcome): { scan: ScanView; replayed: boolean } {
  if (outcome.status === 'refused') throw new ScanRefusedError(outcome.refusal)
  return { scan: outcome.scan!, replayed: outcome.status === 'duplicate' }
}

export async function reportScan(caller: CommandCaller, input: ReportInput) {
  return scanAnswer(await report(caller, sessionOf(caller, 'online'), input))
}

export async function undoScan(caller: CommandCaller, input: UndoInput) {
  return scanAnswer(await undo(caller, sessionOf(caller, 'online'), input))
}

export async function askCorrection(caller: CommandCaller, input: AskInput): Promise<{ request: RequestView; replayed: boolean }> {
  const outcome = await ask(caller, sessionOf(caller, 'online'), input)
  if (outcome.status === 'refused') throw new ScanRefusedError(outcome.refusal)
  return { request: outcome.request!, replayed: outcome.status === 'duplicate' }
}

interface Where {
  readonly workOrderId: string | null
  readonly bundleId: string | null
  readonly workOrderOperationId: string | null
}

/** Where a refused item was about (its bundle's work order, the bundle, the operation), as far as it can be told. */
async function whereOf(caller: CommandCaller, session: Session, item: BatchItem): Promise<Where> {
  if (item.action === 'REPORT') {
    const resolved = await resolveBundle(caller, session, item)
    if (!('bundle' in resolved)) return { workOrderId: null, bundleId: null, workOrderOperationId: item.workOrderOperationId ?? null }
    return { workOrderId: resolved.bundle.workOrderId, bundleId: resolved.bundle.id, workOrderOperationId: item.workOrderOperationId ?? null }
  }
  const target = await namedScan(caller, session, item.action === 'UNDO' ? { scanId: item.scanId, clientScanId: item.undoesClientScanId } : { scanId: item.scanId, clientScanId: item.targetClientScanId })
  return { workOrderId: target?.workOrderId ?? null, bundleId: target?.bundleId ?? null, workOrderOperationId: target?.workOrderOperationId ?? null }
}

/** What a refused item sent, for the refused scans list. */
function refusalDraft(session: Session, item: BatchItem, refusal: ScanRefusal, where: Where, facts: { readonly stationId: string | null; readonly subject: ScanSubject; readonly acknowledged: boolean }) {
  const lines = item.action === 'UNDO' ? [] : linesOf(item)
  const sum = (kind: 'SCRAP' | 'REWORK') => lines.filter((line) => line.kind === kind).reduce((total, line) => total + line.quantity, 0)
  return {
    companyId: null,
    siteId: session.context.siteId,
    deviceId: session.context.deviceId,
    clientScanId: item.clientScanId,
    action: item.action as RefusedAction,
    code: refusal.code,
    message: refusal.message,
    fix: refusal.fix,
    final: refusal.final,
    ...where,
    scanned: item.action === 'REPORT' ? (item.code?.trim().toUpperCase() ?? null) : null,
    goodQuantity: item.action === 'UNDO' ? 0 : item.good,
    scrapQuantity: sum('SCRAP'),
    reworkQuantity: sum('REWORK'),
    // No floor record names a worker before they acknowledged the notice in force (Statuto art. 4 c.3), a refusal neither.
    workerId: facts.subject === 'WORKER' && facts.acknowledged ? session.context.actorId : null,
    stationId: facts.stationId,
    deviceTime: item.occurredAt ? toUtcIso(parseInstant(item.occurredAt)!) : null,
  }
}

/** The device recorded this action already (a scan, or an ask, under its client scan id). */
async function recordedAlready(caller: CommandCaller, session: Session, item: BatchItem): Promise<boolean> {
  if (item.action === 'ASK_CORRECTION') return (await askedBefore(caller, session, item)) !== null
  return (await caller.withClient((client) => readScanByClient(client, session.context.deviceId, item.clientScanId))) !== null
}

/**
 * The offline queue's batch (A1 §3.8): every item judged in the order sent, each its own command, each answered
 * accepted, duplicate or refused (with the refusal kept for the queue and the office). `sentAt`: the device's clock at
 * the send, for the clock check (PLT-240).
 */
export async function sendBatch(caller: CommandCaller, body: { readonly sentAt?: string | undefined; readonly items: readonly BatchItem[] }) {
  const session = sessionOf(caller, 'batch')
  const { context } = session
  const subject = await subjectOf(caller, session)
  const stationId = await stationOf(caller, session)
  const acknowledged = subject === 'WORKER' ? await caller.withClient((client) => hasAcknowledgedNotice(client, context.siteId, context.actorId)) : false
  const answers = []
  for (const item of body.items) {
    let outcome: Outcome
    // A scan is recorded only under the name of the person who took it: another person's queued scan waits for them (a
    // resend of one recorded already is still a duplicate).
    if (subject === 'WORKER' && item.workerId !== undefined && item.workerId !== context.actorId && !(await recordedAlready(caller, session, item))) outcome = refused(otherWorkerRefusal())
    else if (item.action === 'REPORT') outcome = await report(caller, session, item)
    else if (item.action === 'UNDO') outcome = await undo(caller, session, item)
    else outcome = await ask(caller, session, item)
    if (outcome.status !== 'refused') {
      answers.push({ clientScanId: item.clientScanId, action: item.action, status: outcome.status, scan: outcome.scan ?? null, request: outcome.request ?? null, refusal: null })
      continue
    }
    const kept = await recordRefusal(caller, refusalDraft(session, item, outcome.refusal, await whereOf(caller, session, item), { stationId, subject, acknowledged }))
    answers.push({ clientScanId: item.clientScanId, action: item.action, status: 'refused' as const, scan: null, request: null, refusal: { ...outcome.refusal, refusalId: kept.id } })
  }
  const now = serverClock.now()
  const sentAt = body.sentAt ? parseInstant(body.sentAt) : null
  return { serverTime: toUtcIso(now), clock: sentAt ? { deviceSentAt: toUtcIso(sentAt), ...clockCheck(sentAt, now) } : null, items: answers }
}

