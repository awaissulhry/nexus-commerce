import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { openSteps, stepsClosedRefusal, stepUnknownRefusal, standingTicks, type ChecklistOutcome } from '@nexus/factory-domain/production/checklists/rules'
import { clientIdReusedRefusal, standingKey, standingScans, subjectRefusal } from '@nexus/factory-domain/production/scans/rules'
import { command, IdempotencyKeyReusedError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { lockBundleForScan, readBundleByCode } from '../bundles/store'
import { floorOf, refuse as refuseScan } from '../scans/access'
import { refuseIfHeld } from '../scans/scans'
import { lockBundleScans, readBundleScans, readHeader, readOperations, scanWorkOrderLock } from '../scans/store'
import { floorRecordSubjectFor, hasAcknowledgedNotice } from '../settings/subject'
import { employeesOf } from '../terminal/store'
import { resolveBundle, type BundleRef } from '../terminal/timing'
import { readTickByClient, readTicks, stepsOfOperation, TICK, type TickRow } from './store'
import { checklistView, floorViewerOf, tickNames, type ChecklistView } from './views'

/**
 * A step ticked inside an operation (B-W2b-47; MES-102): ONE command on the floor (production.scan, its own site), keyed
 * `<device>.<clientEventId>`, in the scans' lock order, so a tick and the bundle's Finish take turns: the report sees every
 * tick before it, a tick after the report is refused. Who: the signed-in worker, or the station where the site records
 * stations, by the site's floor rules (the database's guard is the last word: the work order open and not held, the bundle
 * ACTIVE). The same outcome again answers the tick that stands and writes nothing; another outcome is a new row that
 * stands from now on (factory-domain checklists/rules: a wrong tick is never removed).
 */

export interface TickInput extends BundleRef {
  readonly workOrderOperationId: string
  readonly clientEventId: string
  readonly stepCode: string
  readonly outcome?: ChecklistOutcome | undefined
  readonly occurredAt?: string | undefined
}

export interface TickAnswer {
  readonly tick: { readonly id: string; readonly stepCode: string; readonly outcome: ChecklistOutcome; readonly at: string }
  readonly checklist: ChecklistView
}

const keyOf = (context: FloorContext, clientEventId: string) => `${context.deviceId}.${clientEventId}`

/** A tick as a command answers it: plain JSON. */
interface Ticked extends TickOf {
  readonly bundleId: string
  readonly workOrderOperationId: string
}
type TickOf = TickAnswer['tick']

const plain = (row: TickRow): Ticked => ({ id: row.id, bundleId: row.bundleId, workOrderOperationId: row.workOrderOperationId, stepCode: row.stepCode, outcome: row.outcome as ChecklistOutcome, at: toUtcIso(row.serverTime) })

/** The same tile tapped again: nothing to write; the answer is the tick that stands (thrown out of the command). */
class SameOutcome extends Error {
  constructor(readonly tick: Ticked) {
    super('The step stands as it is.')
  }
}

async function answerOf(caller: CommandCaller, context: FloorContext, row: Ticked): Promise<TickAnswer> {
  const { bundleId, workOrderOperationId, ...tick } = row
  return caller.withClient(async (db) => {
    const viewer = await floorViewerOf(db, context)
    const ticks = await readTicks(db, bundleId, workOrderOperationId)
    return { tick, checklist: checklistView(await stepsOfOperation(db, workOrderOperationId), ticks, viewer, await tickNames(db, ticks, viewer, holds(actorOf(context), 'floor.lead'))) }
  })
}

/** A resend under the same client event id: the tick recorded first (same step and bundle), else CLIENT_ID_REUSED. */
async function sentBefore(caller: CommandCaller, context: FloorContext, input: TickInput): Promise<Ticked | null> {
  const row = await caller.withClient((db) => readTickByClient(db, context.deviceId, input.clientEventId))
  if (!row) return null
  // The code sent again names the same bundle (its ticket, an old ticket or one of its coupons: readBundleByCode reads them all).
  const named = input.bundleId ?? (input.code !== undefined ? (await caller.withClient((db) => readBundleByCode(db, input.code!.trim().toUpperCase())))?.id : undefined)
  if (row.stepCode !== input.stepCode || row.workOrderOperationId !== input.workOrderOperationId || named !== row.bundleId) refuseScan(clientIdReusedRefusal(input.clientEventId))
  return plain(row)
}

export async function tickStep(caller: CommandCaller, input: TickInput): Promise<TickAnswer & { readonly replayed: boolean }> {
  const context = floorOf(caller)
  const before = await sentBefore(caller, context, input)
  if (before) return { ...(await answerOf(caller, context, before)), replayed: true }
  const { bundle, scanned } = await resolveBundle(caller, context, input)
  const deviceTime = input.occurredAt ? parseInstant(input.occurredAt) : null
  try {
    const { result, replayed } = await command(
      caller,
      { name: 'production.tickChecklistStep', idempotencyKey: keyOf(context, input.clientEventId), input: { ...input, bundleId: bundle.id }, ...(deviceTime ? { deviceTime } : {}) },
      (tools) => tickInCommand(tools, context, input, bundle.id, bundle.workOrderId, scanned, deviceTime),
    )
    return { ...(await answerOf(caller, context, result)), replayed }
  } catch (error) {
    if (error instanceof SameOutcome) return { ...(await answerOf(caller, context, error.tick)), replayed: true }
    if (error instanceof IdempotencyKeyReusedError) refuseScan(clientIdReusedRefusal(input.clientEventId))
    // The same tick sent twice at once (the unique key refused the second): the first one's record is the answer.
    const first = await sentBefore(caller, context, input).catch(() => null)
    if (first) return { ...(await answerOf(caller, context, first)), replayed: true }
    throw error
  }
}

async function tickInCommand(tools: CommandTools, context: FloorContext, input: TickInput, bundleId: string, workOrderId: string, scanned: string, deviceTime: Date | null): Promise<Ticked> {
  const { tx, now } = tools
  await scanWorkOrderLock(tx, context.tenantId, workOrderId)
  const locked = await lockBundleForScan(tx, bundleId, scanned)
  if (!locked) throw new NotFoundError('Not a bundle ticket of this site.')
  await lockBundleScans(tx, context.tenantId, locked.bundle.siteId, locked.bundle.id)
  await refuseIfHeld(tools, locked.bundle.id, workOrderId)
  const workOrder = (await readHeader(tx, workOrderId))!
  const operation = (await readOperations(tx, workOrder.id)).find((entry) => entry.id === input.workOrderOperationId)
  if (!operation) refuseScan({ code: 'NOT_AN_OPERATION', message: `This is not an operation of work order ${workOrder.number}.`, fix: 'Scan the bundle again and pick one of its operations.', final: true })
  const steps = await stepsOfOperation(tx, operation!.id)
  if (!steps.some((step) => step.code === input.stepCode)) refuseScan(stepUnknownRefusal(input.stepCode))
  if (standingScans(await readBundleScans(tx, locked.bundle.id)).has(standingKey(locked.bundle.id, operation!.id))) refuseScan(stepsClosedRefusal(locked.bundle.code))
  const viewer = await floorViewerOf(tx, context)
  const acknowledged = viewer.scanSubject === 'WORKER' ? await hasAcknowledgedNotice(tx, workOrder.siteId, context.actorId) : false
  const notNamed = subjectRefusal({ scanSubject: viewer.scanSubject, workerId: context.actorId, acknowledged, stationId: viewer.stationId })
  if (notNamed) refuseScan(notNamed)
  const ticks = await readTicks(tx, locked.bundle.id, operation!.id)
  const outcome = input.outcome ?? 'DONE'
  const stands = standingTicks(ticks).get(input.stepCode)
  if (stands?.outcome === outcome) throw new SameOutcome(plain(stands))
  const subject = await floorRecordSubjectFor(tx, { siteId: workOrder.siteId, workerId: context.actorId, stationId: viewer.stationId })
  const employees = subject.workerId ? await employeesOf(tx, [subject.workerId]) : new Map<string, string | null>()
  const row = await tx.operationChecklistResult.create({
    data: {
      id: newId(),
      siteId: workOrder.siteId,
      workOrderId: workOrder.id,
      workOrderOperationId: operation!.id,
      bundleId: locked.bundle.id,
      stepCode: input.stepCode,
      outcome,
      workerId: subject.workerId,
      employeeId: subject.workerId ? (employees.get(subject.workerId) ?? null) : null,
      stationId: subject.stationId,
      deviceId: context.deviceId,
      clientEventId: input.clientEventId,
      deviceTime,
      serverTime: now,
      createdById: subject.workerId ? context.actorId : null,
    },
    select: TICK,
  })
  const open = openSteps(steps, [...ticks, row]).length
  tools.audit({ action: 'production.tickChecklistStep', recordType: 'OperationChecklistResult', recordId: row.id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { workOrderId: workOrder.id, bundleId: locked.bundle.id, operationId: operation!.id, stepCode: row.stepCode, outcome, workerId: subject.workerId, stationId: subject.stationId } })
  tools.emit({
    type: 'production.checklist_step_ticked',
    subject: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    payload: { workOrderId: workOrder.id, number: workOrder.number, siteId: workOrder.siteId, bundleId: locked.bundle.id, operationId: operation!.id, stepCode: row.stepCode, outcome, open },
  })
  return plain(row)
}
