import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { believedTime } from '@nexus/factory-domain/production/offstandard/rules'
import { PRODUCTION_SCAN } from '@nexus/factory-domain/production/scans/permissions'
import { clientIdReusedRefusal, reportDecision, scansReadyRefusal, standingScans, subjectRefusal, unknownBundleRefusal, type ScanRefusal } from '@nexus/factory-domain/production/scans/rules'
import type { ScanSubject } from '@nexus/factory-domain/production/settings/monitoring'
import {
  doneWords,
  openOperationFor,
  openStretchOf,
  otherRunningRefusal,
  pauseReasonRefusal,
  piecesRefusal,
  piecesSoFarOf,
  qualificationRefusal,
  sameSubject,
  stretchesOf,
  teamMembers,
  teamRefusal,
  timingRefusal,
  timingViewOf,
  type TimingKind,
  type TimingSubject,
  type WorkPlace,
} from '@nexus/factory-domain/production/terminal/rules'
import { command, IdempotencyKeyReusedError, type CommandCaller, type CommandTools } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { membersIn, readOpenCrew } from '../../../platform/auth/floor/crew-store'
import { floorReadinessFor } from '../../../platform/privacy/read'
import { reasonFor } from '../../../platform/reasons/service'
import { stationBlock } from '../../plant/checks'
import { qualificationCheck, qualificationGuard } from '../../people/skills/check'
import { bundleFlowOf } from '../bundles/flow'
import { couponForScan } from '../bundles/coupons'
import { lockBundleForScan, readBundle, readBundleByCode, type BundleRow } from '../bundles/store'
import type { VerifiedOverride } from '../guards/override'
import { endRunningBlock } from '../offstandard/writes'
import { floorOf, mayScan, refuse as refuseScan, systemView } from '../scans/access'
import { refuseIfHeld } from '../scans/scans'
import { deviceStationOf, lockBundleScans, readBundleScans, readHeader, readOperations, readStations, scanWorkOrderLock, siteTimeZone, type OperationRow, type ScanHeader } from '../scans/store'
import { floorRecordSubjectFor, hasAcknowledgedNotice, scanSubjectFor } from '../settings/subject'
import { startOnFirstWork } from '../work-orders/moves'
import { refuseTiming } from './access'
import { employeesOf, openCandidates, readByClient, readMembers, readOperationRows, readRow, readBundlesRows, type TimingScanRow } from './store'

/**
 * Operation timing on the tablet (B-W2b-40; MES-087 start, MES-088 pause with a reason, MES-089 resume, MES-091 hand back,
 * MES-092 pieces done so far, MES-094 team operation; design floor.operation "Start, pause, finish"). Each action is ONE
 * command() on the floor (production.scan, its own site), keyed `<device>.<clientScanId>` (a resend answers from its
 * receipt; after the receipt is gone, the row's unique key (tenant, device, client scan id) answers `duplicate`), in the
 * scans' lock order (the work order's issue lock shared → the bundle FOR SHARE → the bundle's scan lock → the timing
 * trigger's own lock), judged by factory-domain production/terminal/rules; the …_floor_work_w2b_guards timing trigger
 * stays the last word.
 *
 *   START      the bundle (its ticket, a coupon of an operation, or its id) at the operation the station does next (as a
 *              report decides it: the scans' rules for a replaced or voided ticket, a work order not open, another kind
 *              of station with its reason, "already reported"); gated like a report (the floor's readiness, a hold, a
 *              machine not to be used); refused while someone's work on it is open or the subject runs another bundle;
 *              the subject's running off-standard block ends first (MES-156); B-W2b-39's qualification check: a WARN is
 *              told, a STRICT skill hold needs a team leader's override (PIN and a reason: POST …/start/override), an
 *              authorisation hold is never lifted. A team (MES-094) names the tablet's crew members asked.
 *   PAUSE      the subject's running work on the bundle, with an active code of the PAUSE reason list (a note when the
 *              code asks one); never refused by a hold (stopping the clock always works).
 *   RESUME     the subject's paused work (after a clock-out too, on any tablet of the site); the team carries on while
 *              its people are still in the tablet's crew, or the crew members asked anew.
 *   HAND_BACK  the subject's open work given back unfinished: the time is kept; anyone may start it again.
 *   PARTIAL    the pieces done so far (from 1, all of them together fewer than the bundle's live garments): the stretch
 *              closes so another person may continue; the team that did them is named.
 * The REPORT (one tap, Owner answer F3) stays the scans' (POST /production/scans): it ends a running stretch, and the
 * scans' hook (scans/hooks/timing.ts) names the stretch's team on it.
 */

export interface BundleRef {
  /** The scanned ticket's code (a bundle's, current or replaced, or a coupon's), or the bundle's id: exactly one. */
  readonly code?: string | undefined
  readonly bundleId?: string | undefined
  /** The operation; absent: START the one this station does next, the others the subject's open work on the bundle. */
  readonly workOrderOperationId?: string | undefined
}

export interface TimingInput extends BundleRef {
  readonly clientScanId: string
  /** When it happened, by the device's clock (offline: the queue's time). */
  readonly occurredAt?: string | undefined
  /** START: why a station starts an operation of another kind of work. */
  readonly kindReason?: string | undefined
  /** START, RESUME, PARTIAL: a team's members, people of the tablet's crew (the one signed in is added). */
  readonly memberIds?: readonly string[] | undefined
  /** PAUSE: a code of the PAUSE reason list, and a note when the code asks one. */
  readonly reasonCode?: string | undefined
  readonly note?: string | undefined
  /** PARTIAL: the pieces done so far. */
  readonly pieces?: number | undefined
}

const COMMAND: Readonly<Record<TimingKind, `production.${string}`>> = Object.freeze({
  START: 'production.startOperation',
  PAUSE: 'production.pauseOperation',
  RESUME: 'production.resumeOperation',
  HAND_BACK: 'production.handBackOperation',
  PARTIAL: 'production.reportPiecesSoFar',
})

const at = (value: Date | null) => (value ? toUtcIso(value) : null)
const keyOf = (context: FloorContext, clientScanId: string) => `${context.deviceId}.${clientScanId}`
const opRef = (operation: Pick<OperationRow, 'id' | 'seq' | 'code' | 'name'>) => ({ id: operation.id, seq: operation.seq, code: operation.code, name: operation.name })

// ---- views ------------------------------------------------------------------------------------------------------------------------

export interface TimingScanView {
  readonly id: string
  readonly kind: TimingKind
  readonly workOrderId: string
  readonly bundleId: string
  readonly bundleCode: string
  readonly operation: { readonly id: string; readonly seq: number; readonly code: string; readonly name: string }
  readonly pauseReasonCode: string | null
  readonly pieces: number
  /** A team's members on it (0: one person, or a station). */
  readonly team: number
  readonly stationId: string | null
  readonly deviceId: string | null
  readonly clientScanId: string
  readonly deviceTime: string | null
  readonly serverTime: string
}

export function timingScanView(row: TimingScanRow, operation: Pick<OperationRow, 'id' | 'seq' | 'code' | 'name'>, bundleCode: string, team: number): TimingScanView {
  return {
    id: row.id,
    kind: row.kind as TimingKind,
    workOrderId: row.workOrderId,
    bundleId: row.bundleId,
    bundleCode,
    operation: opRef(operation),
    pauseReasonCode: row.pauseReasonCode,
    pieces: row.kind === 'PARTIAL' ? row.goodQuantity + row.scrapQuantity + row.reworkQuantity : 0,
    team,
    stationId: row.stationId,
    deviceId: row.deviceId,
    clientScanId: row.clientScanId,
    deviceTime: at(row.deviceTime),
    serverTime: toUtcIso(row.serverTime),
  }
}

/** What a bundle at an operation shows on the operation screen (state, its own clock, buttons), as JSON. */
export function stateView(rows: readonly TimingScanRow[], viewer: TimingSubject, members: ReadonlyMap<string, readonly string[]>) {
  const view = timingViewOf(rows, viewer, members)
  return { ...view, startedAt: at(view.startedAt), runningSince: at(view.runningSince), pausedAt: at(view.pausedAt), actions: [...view.actions] }
}
export type StateView = ReturnType<typeof stateView>

export interface TimingAnswer {
  readonly scan: TimingScanView
  readonly timing: StateView
  readonly words: string
  /** START: the qualification check's warning (WARN: told, not held), or null. */
  readonly qualification: { readonly mode: 'WARN'; readonly message: string; readonly fix: string } | null
  /** START: the team leader's override that lifted a qualification hold, or null. */
  readonly override: { readonly reasonCode: string } | null
}

// ---- the subject and the bundle -------------------------------------------------------------------------------------------------

interface Facts {
  readonly context: FloorContext
  readonly stationId: string | null
  readonly scanSubject: ScanSubject
  readonly timeZone: string
}

async function factsOf(caller: CommandCaller): Promise<Facts> {
  const context = floorOf(caller)
  return caller.withClient(async (db) => ({ context, stationId: await deviceStationOf(db, context.deviceId), scanSubject: await scanSubjectFor(db, context.siteId), timeZone: await siteTimeZone(db, context.siteId) }))
}

/** The viewer as a timing subject: the signed-in worker where the site names workers, else the device's station. */
export const subjectOf = (facts: Pick<Facts, 'context' | 'stationId' | 'scanSubject'>): TimingSubject =>
  facts.scanSubject === 'WORKER' ? { workerId: facts.context.actorId, stationId: facts.stationId } : { workerId: null, stationId: facts.stationId }

/** The bundle a request names (its ticket's code, a coupon's or its id) at the device's site, with the code scanned; or a 400 / 404. */
export async function resolveBundle(caller: CommandCaller, context: FloorContext, ref: BundleRef): Promise<{ readonly bundle: BundleRow; readonly scanned: string; readonly workOrder: ScanHeader }> {
  if ((ref.code === undefined) === (ref.bundleId === undefined)) {
    throw new ValidationError("Scan the bundle's ticket, or name the bundle.", [{ path: 'body/code', message: 'Send a code or a bundle id, not both.' }])
  }
  let scanned: string | null = null
  const bundle = await caller.withClient(async (client) => {
    if (ref.code !== undefined) {
      const typed = ref.code.trim().toUpperCase()
      const scan = parseScanId(typed, { tenantTag: tenantTag(context.tenantId), types: ['BUNDLE'] })
      if (!scan.ok && scan.problem !== 'format') return scan.message
      scanned = scan.ok ? scan.text : typed
      return readBundleByCode(client, scanned)
    }
    return readBundle(client, ref.bundleId!)
  })
  if (typeof bundle === 'string') throw new ValidationError(unknownBundleRefusal(bundle).message, [{ path: 'body/code', message: bundle }])
  if (!bundle || bundle.siteId !== context.siteId) throw new NotFoundError(unknownBundleRefusal().message)
  const workOrder = await caller.withClient((client) => readHeader(client, bundle.workOrderId))
  if (!workOrder || !mayScan(context, PRODUCTION_SCAN, workOrder)) throw new NotFoundError('Not a bundle ticket of this site.')
  return { bundle, scanned: scanned ?? bundle.code, workOrder }
}

/** The subject's open stretches on these rows (any bundles and operations), one per bundle and operation. */
export function openOfSubject(rows: readonly TimingScanRow[], subject: TimingSubject, members: ReadonlyMap<string, readonly string[]> = new Map()) {
  const groups = new Map<string, TimingScanRow[]>()
  for (const row of rows) groups.set(`${row.bundleId}|${row.workOrderOperationId}`, [...(groups.get(`${row.bundleId}|${row.workOrderOperationId}`) ?? []), row])
  const open = []
  for (const group of groups.values()) {
    const stretch = openStretchOf(stretchesOf(group, members))
    if (stretch && sameSubject(stretch, subject)) open.push({ bundleId: group[0]!.bundleId, workOrderOperationId: group[0]!.workOrderOperationId, workOrderId: group[0]!.workOrderId, stretch, rows: group })
  }
  return open
}

/** The subject's open work at the site now (running or paused), read in the caller's scope (a command's tx, or a client). */
export async function openWorkOf(db: Parameters<typeof openCandidates>[0], siteId: string, subject: TimingSubject, now: Date) {
  const candidates = await openCandidates(db, { siteId, workerId: subject.workerId, stationId: subject.workerId ? null : subject.stationId, now })
  if (candidates.length === 0) return []
  const rows = await readBundlesRows(db, [...new Set(candidates.map((entry) => entry.bundleId))])
  const wanted = new Set(candidates.map((entry) => `${entry.bundleId}|${entry.workOrderOperationId}`))
  const members = await readMembers(db, rows.filter((row) => row.kind === 'START' || row.kind === 'RESUME').map((row) => row.id))
  return openOfSubject(rows.filter((row) => wanted.has(`${row.bundleId}|${row.workOrderOperationId}`)), subject, members)
}

// ---- the action --------------------------------------------------------------------------------------------------------------------

/** A resend under the same client scan id: the row recorded first (same kind and bundle), else CLIENT_ID_REUSED. */
async function sentBefore(caller: CommandCaller, context: FloorContext, action: TimingKind, input: TimingInput): Promise<TimingAnswer | null> {
  const found = await caller.withClient(async (db) => {
    const row = await readByClient(db, context.deviceId, input.clientScanId)
    if (!row) return null
    const bundle = await readBundle(db, row.bundleId)
    const operation = (await readOperations(db, row.workOrderId)).find((entry) => entry.id === row.workOrderOperationId)
    const rows = await readOperationRows(db, row.bundleId, row.workOrderOperationId)
    const members = await readMembers(db, rows.map((entry) => entry.id))
    // The code sent again names the same bundle (its ticket, an old ticket or one of its coupons: readBundleByCode reads them all).
    const named = input.bundleId !== undefined ? input.bundleId : input.code !== undefined ? ((await readBundleByCode(db, input.code.trim().toUpperCase()))?.id ?? null) : null
    return { row, bundle, operation, rows, members, sameBundle: named === row.bundleId }
  })
  if (!found) return null
  const { sameBundle } = found
  if (found.row.kind !== action || !sameBundle || !found.operation || (input.workOrderOperationId !== undefined && input.workOrderOperationId !== found.row.workOrderOperationId)) refuseScan(clientIdReusedRefusal(input.clientScanId))
  const facts = await factsOf(caller)
  const place: WorkPlace = { bundleCode: found.bundle?.code ?? '', operation: found.operation! }
  return {
    scan: timingScanView(found.row, found.operation!, found.bundle?.code ?? '', found.members.get(found.row.id)?.length ?? 0),
    timing: stateView(found.rows, subjectOf(facts), found.members),
    words: doneWords(action, place, found.row.kind === 'PARTIAL' ? found.row.goodQuantity : 0),
    qualification: null,
    override: null,
  }
}

/**
 * One timing action of the signed-in worker (or the device's station) on the floor: online (the routes) and from the
 * offline queue (platform/floor-sync kinds.ts, which maps a refusal to the queue's words). Answers the record and whether
 * it was a resend.
 */
export async function timeOperation(caller: CommandCaller, action: TimingKind, input: TimingInput, options: { readonly override?: VerifiedOverride | undefined } = {}): Promise<TimingAnswer & { readonly replayed: boolean }> {
  const context = floorOf(caller)
  const before = await sentBefore(caller, context, action, input)
  if (before) return { ...before, replayed: true }
  const { bundle, scanned, workOrder } = await resolveBundle(caller, context, input)
  const facts = await factsOf(caller)
  const working = action === 'START' || action === 'RESUME' || action === 'PARTIAL'
  if (working) {
    // The floor's readiness (B-W1-36, B-W1-37), read as the tenant's system caller, as a report's.
    const ready = scansReadyRefusal(await systemView(caller).withClient((client) => floorReadinessFor(client, context.siteId, serverClock.now())))
    if (ready) refuseScan(ready)
  }
  const deviceTime = input.occurredAt ? parseInstant(input.occurredAt) : null
  try {
    const { result, replayed } = await command(
      caller,
      { name: COMMAND[action], idempotencyKey: keyOf(context, input.clientScanId), input: { ...input, bundleId: bundle.id }, ...(deviceTime ? { deviceTime } : {}) },
      (tools) => timeInCommand(tools, { action, input, bundle, scanned, workOrder, facts, deviceTime, override: options.override }),
    )
    if (!replayed && action === 'START') await startsWorkOrder(caller, workOrder, result.scan.id)
    return { ...result, replayed }
  } catch (error) {
    if (error instanceof IdempotencyKeyReusedError) refuseScan(clientIdReusedRefusal(input.clientScanId))
    // The same action sent twice at once (the unique key refused the second): the first one's record is the answer.
    const first = await sentBefore(caller, context, action, input).catch(() => null)
    if (first) return { ...first, replayed: true }
    throw error
  }
}

/** The first START of a released work order starts it (as the tenant's system caller; the next scan retries a failure). */
async function startsWorkOrder(caller: CommandCaller, workOrder: ScanHeader, scanId: string): Promise<void> {
  if (workOrder.status !== 'RELEASED') return
  try {
    await startOnFirstWork(systemView(caller), workOrder.id, { what: `the start ${scanId}` })
  } catch {
    // The start stands; the work order stays RELEASED until the next scan starts it (or the office does).
  }
}

interface Work {
  readonly action: TimingKind
  readonly input: TimingInput
  readonly bundle: BundleRow
  readonly scanned: string
  readonly workOrder: ScanHeader
  readonly facts: Facts
  readonly deviceTime: Date | null
  readonly override: VerifiedOverride | undefined
}

const refusalOf = (refusal: ScanRefusal) => refuseScan(refusal)

/** The action INSIDE its command: the locks, the facts read again, the rules, the row, its members, audit and event. */
async function timeInCommand(tools: CommandTools, work: Work): Promise<TimingAnswer> {
  const { tx } = tools
  const { context, stationId, scanSubject, timeZone } = work.facts
  const { action, input } = work
  const working = action === 'START' || action === 'RESUME' || action === 'PARTIAL'
  await scanWorkOrderLock(tx, context.tenantId, work.bundle.workOrderId)
  const locked = await lockBundleForScan(tx, work.bundle.id, work.scanned)
  if (!locked) throw new NotFoundError('Not a bundle ticket of this site.')
  if (working && locked.refusal) {
    refusalOf(
      locked.refusal.code === 'REPLACED'
        ? { code: 'REPLACED', message: locked.refusal.message, fix: `Scan the new ticket ${locked.bundle.code}.`, final: true }
        : { code: 'VOIDED', message: locked.refusal.message, fix: 'Discard it: the bundle was voided.', final: true },
    )
  }
  await lockBundleScans(tx, context.tenantId, locked.bundle.siteId, locked.bundle.id)
  // A hold, or a station whose machines may not be used, stops work going on — never a pause or a hand back.
  if (action === 'START' || action === 'RESUME' || action === 'PARTIAL') await refuseIfHeld(tools, locked.bundle.id, locked.bundle.workOrderId)
  if (action === 'START' || action === 'RESUME') {
    const unsafe = await stationBlock(tx, stationId)
    if (unsafe) refusalOf({ code: 'MACHINE_UNSAFE', message: unsafe.message, fix: unsafe.fix, final: false })
  }
  const workOrder = (await readHeader(tx, locked.bundle.workOrderId))!
  const operations = await readOperations(tx, workOrder.id)
  const acknowledged = scanSubject === 'WORKER' ? await hasAcknowledgedNotice(tx, workOrder.siteId, context.actorId) : false
  const notNamed = subjectRefusal({ scanSubject, workerId: context.actorId, acknowledged, stationId })
  if (notNamed) refusalOf(notNamed)
  const subject: TimingSubject = scanSubject === 'WORKER' ? { workerId: context.actorId, stationId } : { workerId: null, stationId }
  const now = tools.now
  const when = believedTime(work.deviceTime, now)

  // The operation: START as a report decides it; the others, the subject's open work on the bundle.
  const countRows = await readBundleScans(tx, locked.bundle.id)
  const flow = working ? await bundleFlowOf(tx, locked.bundle, operations, standingScans(countRows)) : null
  if (flow?.refusal) refusalOf(flow.refusal)
  const coupon = await couponForScan(tx, locked.bundle.id, work.scanned, input.workOrderOperationId ?? null)
  if (coupon && !coupon.ok && working) refusalOf({ code: coupon.code, message: coupon.message, fix: coupon.fix, final: true })
  const namedOperation = input.workOrderOperationId ?? (coupon?.ok ? coupon.operationId : null)
  let operation: OperationRow
  if (action === 'START') {
    const stations = await readStations(tx, [stationId, ...countRows.map((row) => row.stationId)])
    const station = stationId ? (stations.get(stationId) ?? null) : null
    const decision = reportDecision({
      workOrder,
      bundleId: locked.bundle.id,
      bundle: { code: locked.bundle.code, quantity: flow!.quantity, status: locked.bundle.status, replacedCodes: locked.bundle.replacedCodes },
      scanned: work.scanned,
      operations,
      operationId: namedOperation,
      station: station ? { code: station.code, kind: station.kind } : null,
      kindReason: input.kindReason?.trim() || null,
      standing: flow!.standing,
      // A START carries no counts: one garment stands in for the bundle so the report's rules decide the operation only.
      counts: { good: 1, scrap: 0, rework: 0 },
      viewer: { scanSubject, workerId: context.actorId, stationId },
      stationCodes: new Map([...stations.values()].map((row) => [row.id, row.code])),
      timeZone,
      guarded: true,
    })
    if (!decision.ok) refusalOf(decision.refusal)
    operation = operations.find((entry) => entry.id === (decision as { operation: { id: string } }).operation.id)!
  } else if (namedOperation) {
    const named = operations.find((entry) => entry.id === namedOperation)
    if (!named) refusalOf({ code: 'NOT_AN_OPERATION', message: `This is not an operation of work order ${workOrder.number}.`, fix: 'Scan the bundle again and pick one of its operations.', final: true })
    operation = named!
  } else {
    const rows = (await readBundlesRows(tx, [locked.bundle.id]))
    const open = openOfSubject(rows, subject).flatMap((entry) => {
      const found = operations.find((candidate) => candidate.id === entry.workOrderOperationId)
      return found ? [{ operation: found, state: entry.stretch.open! }] : []
    })
    const picked = openOperationFor(action, open, locked.bundle.code)
    if (!picked.ok) refuseTiming(picked.refusal)
    operation = (picked as { operation: OperationRow }).operation
  }
  const place: WorkPlace = { bundleCode: locked.bundle.code, operation }
  const rows = await readOperationRows(tx, locked.bundle.id, operation.id)
  const stateRefusal = timingRefusal(action, { rows, subject, place, scanSubject })
  if (stateRefusal) refuseTiming(stateRefusal)
  const runsMembers = await readMembers(tx, rows.filter((row) => row.kind === 'START' || row.kind === 'RESUME').map((row) => row.id))

  // One bundle at a time: starting or resuming while another of the subject's runs is refused.
  if (action === 'START' || action === 'RESUME') {
    const running = (await openWorkOf(tx, workOrder.siteId, subject, now)).find((entry) => entry.stretch.open === 'RUNNING' && !(entry.bundleId === locked.bundle.id && entry.workOrderOperationId === operation.id))
    if (running) {
      const [code] = (await tx.bundle.findMany({ where: { id: running.bundleId }, select: { code: true } })).map((row) => row.code)
      const runningOp = (await readOperations(tx, running.workOrderId)).find((entry) => entry.id === running.workOrderOperationId)
      refuseTiming(otherRunningRefusal({ bundleCode: code ?? '', operation: runningOp ?? { seq: 0, name: '' } }, scanSubject))
    }
  }

  // PARTIAL: the pieces so far, against the bundle's live garments (a split parent counts its own).
  const pieces = action === 'PARTIAL' ? (input.pieces ?? 0) : 0
  if (action === 'PARTIAL') {
    const tooMany = piecesRefusal(pieces, { earlier: piecesSoFarOf(rows), bundleQuantity: Math.min(flow!.quantity, locked.bundle.quantity), place })
    if (tooMany) refuseTiming(tooMany)
  }

  // PAUSE: an active code of the PAUSE list (MES-088), with a note when the code asks one.
  const note = input.note?.trim() || null
  if (action === 'PAUSE') {
    const code = (input.reasonCode ?? '').trim()
    const wrong = pauseReasonRefusal(code, code ? await reasonFor(tx, 'PAUSE', code) : null, note)
    if (wrong) refuseTiming(wrong)
  }

  // The team (MES-094): the crew members asked; a RESUME or PARTIAL with none asked carries the running team on while its
  // people are still in the tablet's crew.
  let members: string[] = []
  if (action === 'START' || action === 'RESUME' || action === 'PARTIAL') {
    const crew = await readOpenCrew(tx, context.deviceId)
    const crewIds = crew ? membersIn(crew).map((member) => member.workerId) : []
    let asked = [...(input.memberIds ?? [])]
    if (asked.length === 0 && action !== 'START') {
      const open = openStretchOf(stretchesOf(rows, runsMembers))
      const last = open?.runs.at(-1)
      const before = last ? (runsMembers.get(last.openedBy) ?? []) : []
      asked = before.length > 1 ? before.filter((workerId) => workerId === context.actorId || crewIds.includes(workerId)) : []
      if (asked.length < 2) asked = []
    }
    if (asked.length > 0) {
      const askedOthers = asked.filter((workerId) => workerId !== context.actorId)
      const acked = new Set<string>()
      for (const workerId of new Set([context.actorId, ...asked])) if (scanSubject === 'WORKER' && (await hasAcknowledgedNotice(tx, workOrder.siteId, workerId))) acked.add(workerId)
      const team = teamRefusal({ scanSubject, asked: teamMembers(asked, context.actorId), crew: [...new Set([context.actorId, ...crewIds])], acknowledged: acked })
      if (team) refuseTiming(team)
      members = askedOthers.length > 0 ? teamMembers(asked, context.actorId) : []
    }
  }

  // B-W2b-39's qualification check at the start (MES-024, MES-246): told (WARN) or held (STRICT); a team leader's override
  // lifts a skill hold, never an authorisation.
  let warning: TimingAnswer['qualification'] = null
  let overridden: TimingAnswer['override'] = null
  if (action === 'START') {
    const guard = qualificationGuard(await qualificationCheck(tx, { workerId: context.actorId, workOrderOperationId: operation.id, stationId }, { names: 'DISPLAY', now }))
    if (guard) {
      const held = qualificationRefusal(guard)
      if (held && !(work.override && guard.overridable)) refuseTiming(held)
      if (held) overridden = { reasonCode: work.override!.reasonCode }
      else warning = { mode: 'WARN', message: guard.message, fix: guard.fix }
      tools.audit({ action: held ? 'production.startQualificationOverridden' : 'production.startQualificationWarned', recordType: 'WorkOrder', recordId: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { bundleId: locked.bundle.id, operationId: operation.id, mode: guard.mode, findings: guard.findings.map((finding) => finding.code), ...(held ? { leadWorkerId: work.override!.leadWorkerId, reasonCode: work.override!.reasonCode, note: work.override!.note } : {}) } })
    }
  }

  // MES-156: scanning a bundle returns to standard work — the subject's running off-standard block ends first.
  if (action === 'START' || action === 'RESUME') await endRunningBlock(tools, { tenantId: context.tenantId, siteId: workOrder.siteId, subject, at: when, endedBy: 'SCAN' })

  const named = await floorRecordSubjectFor(tx, { siteId: workOrder.siteId, workerId: context.actorId, stationId })
  const id = newId()
  const otherKind = action === 'START' && !!input.kindReason?.trim()
  await tx.operationScan.create({
    data: {
      id,
      siteId: workOrder.siteId,
      workOrderId: workOrder.id,
      workOrderOperationId: operation.id,
      bundleId: locked.bundle.id,
      kind: action,
      goodQuantity: pieces,
      pauseReasonCode: action === 'PAUSE' ? input.reasonCode!.trim() : null,
      reason: action === 'PAUSE' ? note : otherKind ? input.kindReason!.trim() : null,
      workerId: named.workerId,
      stationId: named.stationId,
      deviceId: context.deviceId,
      clientScanId: input.clientScanId,
      deviceTime: work.deviceTime,
      serverTime: now,
      createdById: named.workerId ? context.actorId : null,
    },
    select: { id: true },
  })
  if (members.length > 0) {
    const employees = await employeesOf(tx, members)
    await tx.operationScanMember.createMany({ data: members.map((workerId) => ({ id: newId(), siteId: workOrder.siteId, scanId: id, workerId, employeeId: employees.get(workerId) ?? null, createdById: context.actorId })) })
  }
  const row = (await readRow(tx, id))!
  const after = { workOrderId: workOrder.id, bundleId: locked.bundle.id, operationId: operation.id, operationSeq: operation.seq, kind: action, pauseReasonCode: row.pauseReasonCode, pieces, team: members.length, workerId: row.workerId, stationId: row.stationId, clientScanId: row.clientScanId }
  tools.audit({ action: COMMAND[action], recordType: 'OperationScan', recordId: id, companyId: workOrder.companyId, siteId: workOrder.siteId, after, ...(row.reason ? { reason: row.reason } : {}) })
  tools.emit(timedEvent(workOrder, row, operation.seq, members.length, 'FLOOR'))
  const allRows = [...rows, row]
  const allMembers = new Map(runsMembers)
  if (members.length > 0) allMembers.set(id, members)
  return {
    scan: timingScanView(row, operation, locked.bundle.code, members.length),
    timing: stateView(allRows, subject, allMembers),
    words: doneWords(action, place, pieces),
    qualification: warning,
    override: overridden,
  }
}

/** production.operation_timed: ids, the kind, a pause's code, the pieces so far and the team's size; never a person, station or minutes. */
export function timedEvent(workOrder: Pick<ScanHeader, 'id' | 'number' | 'companyId' | 'siteId'>, row: Pick<TimingScanRow, 'id' | 'bundleId' | 'workOrderOperationId' | 'kind' | 'pauseReasonCode' | 'goodQuantity' | 'scrapQuantity' | 'reworkQuantity'>, operationSeq: number, team: number, postedBy: 'FLOOR' | 'SYSTEM') {
  return {
    type: 'production.operation_timed',
    subject: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    payload: {
      workOrderId: workOrder.id,
      number: workOrder.number,
      siteId: workOrder.siteId,
      bundleId: row.bundleId,
      scanId: row.id,
      operationId: row.workOrderOperationId,
      operationSeq,
      kind: row.kind as TimingKind,
      pauseReasonCode: row.pauseReasonCode,
      pieces: row.kind === 'PARTIAL' ? row.goodQuantity + row.scrapQuantity + row.reworkQuantity : 0,
      team,
      postedBy,
    },
  }
}
