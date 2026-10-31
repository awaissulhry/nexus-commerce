import { z } from 'zod'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { id } from '@nexus/factory-domain/core/contracts'
import type { FloorSyncKind } from '@nexus/factory-domain/floor-sync/kinds'
import { badEventRefusal, errorRefusal, moduleRefusal, type ModuleRefusal, type SyncRefusal } from '@nexus/factory-domain/floor-sync/rules'
import type { CommandCaller } from '../../core/command'
import { BundleRefusedError, makeBundles } from '../../modules/production/bundles/bundles'
import { makeBundlesContract } from '../../modules/production/bundles/contract'
import { CutRefusedError, logCut } from '../../modules/production/cutting/cut'
import { cutContract, remnantContract } from '../../modules/production/cutting/contract'
import { PlantRefusedError } from '../../modules/plant/access'
import { reportContract } from '../../modules/plant/contract'
import { report } from '../../modules/plant/requests/requests'
import { ScanRefusedError } from '../../modules/production/scans/access'
import { batchContract } from '../../modules/production/scans/contract'
import { sendBatch, type BatchItem } from '../../modules/production/scans/scans'
import { ScanIdsRefusedError } from '../numbering/scan-ids'
// B-W2b-35: help calls from the floor's queue.
import { holds } from '@nexus/factory-domain/core/permissions'
import { PRODUCTION_CALLS_ANSWER } from '@nexus/factory-domain/production/calls/permissions'
import { actorOf } from '../../core/context'
import { CallRefusedError } from '../../modules/production/calls/access'
import { answerCall } from '../../modules/production/calls/answer'
import { queuedAnswerBody, sendContract } from '../../modules/production/calls/contract'
import { closeAtStation, sendCall } from '../../modules/production/calls/station'

/**
 * How each queued kind is applied (B-W0-30): through its own module command, in-process, as the tablet's request (the
 * module checks the record and its rules again; floor-sync only checked the kind's permission at the site). Each answers
 * the record it made (accepted), the record it had made before under the same id (duplicate: nothing done again), or the
 * module's refusal in its words (with the module's own record of it when it keeps one: a scan's FloorScanRefusal).
 *
 *   production.scan.report / undo / ask   modules/production/scans sendBatch, one item (the scans' own offline batch:
 *                                         its dedupe by device and client scan id, its refused scans list)
 *   production.cut.log / remnant          modules/production/cutting logCut with the client event id
 *   production.bundles.make               modules/production/bundles makeBundles with the client event id (ONE bundle)
 *                                         and the ticket code the tablet numbered from its own block, when it did
 *   plant.report                          modules/plant/requests report (B-W2a-73: a machine problem from the station;
 *                                         the tablet's time as the report's time; an unsafe one locks the machine when
 *                                         it arrives, and the station's queued scans after it are refused, not final)
 *   andon.call.send / .answer             modules/production/calls sendCall (B-W2b-35: a call from the station, the
 *                                         tablet's time when believable; the station's open call of the type answers a
 *                                         second one) and a step of a call (a responder's answerCall, else the station's
 *                                         own closeAtStation)
 *
 * The event's payload is the module's body without the envelope's fields (client event id, device time, taker).
 */

export interface QueuedEvent {
  readonly clientEventId: string
  readonly kind: FloorSyncKind
  readonly occurredAt?: string | undefined
  readonly workerId?: string | undefined
  readonly payload: Record<string, unknown>
}

export type Applied =
  | { readonly status: 'accepted' | 'duplicate'; readonly result: { readonly type: string; readonly id: string } }
  | { readonly status: 'refused'; readonly refusal: SyncRefusal; readonly moduleRefusal: { readonly type: string; readonly id: string } | null }

const refusedBy = (refusal: SyncRefusal, kept: { readonly type: string; readonly id: string } | null = null): Applied => ({ status: 'refused', refusal, moduleRefusal: kept })

/** A payload its module's body refuses: the first problem in words. */
function parsed<Schema extends z.ZodType>(schema: Schema, value: unknown): { ok: true; value: z.infer<Schema> } | { ok: false; refusal: SyncRefusal } {
  const result = schema.safeParse(value)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  return { ok: false, refusal: badEventRefusal(issue ? `${issue.message} (${issue.path.join('/') || 'payload'})` : 'the payload is not valid.') }
}

/** A module's error as a refusal: its own refusal (code and words, maybe fix and final), else by the error's code. */
export function refusalOfError(error: unknown): SyncRefusal | null {
  if (error instanceof ScanRefusedError) return moduleRefusal(error.refusal)
  if (error instanceof BundleRefusedError || error instanceof CutRefusedError) return moduleRefusal(error.refusal as ModuleRefusal)
  if (error instanceof PlantRefusedError) return moduleRefusal({ code: error.refusal.code, message: error.refusal.message, fix: error.refusal.fix })
  if (error instanceof CallRefusedError) return moduleRefusal({ code: error.refusal.code, message: error.refusal.message, fix: error.refusal.fix })
  if (error instanceof ScanIdsRefusedError) {
    const first = error.refusals[0]
    return first ? moduleRefusal({ code: first.code, message: first.message, fix: first.fix }) : moduleRefusal({ code: 'NUMBER_REFUSED', message: error.message })
  }
  if (error instanceof DomainError) return errorRefusal({ code: error.code, message: error.message, issues: error.issues })
  return null
}

const scanItem = batchContract.body.shape.items.element
const ACTION_OF = { 'production.scan.report': 'REPORT', 'production.scan.undo': 'UNDO', 'production.scan.ask': 'ASK_CORRECTION' } as const

async function applyScan(caller: CommandCaller, event: QueuedEvent, sentAt: string | undefined): Promise<Applied> {
  const item = parsed(scanItem, {
    ...event.payload,
    action: ACTION_OF[event.kind as keyof typeof ACTION_OF],
    clientScanId: event.clientEventId,
    ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
    ...(event.workerId ? { workerId: event.workerId } : {}),
  })
  if (!item.ok) return refusedBy(item.refusal)
  const answer = (await sendBatch(caller, { ...(sentAt ? { sentAt } : {}), items: [item.value as BatchItem] })).items[0]!
  if (answer.status === 'refused') return refusedBy(moduleRefusal(answer.refusal!), { type: 'FloorScanRefusal', id: answer.refusal!.refusalId })
  const result = answer.scan ? { type: 'OperationScan', id: answer.scan.id } : { type: 'ScanCorrectionRequest', id: answer.request!.id }
  return { status: answer.status, result }
}

const withWorkOrder = <Shape extends z.ZodRawShape>(body: z.ZodObject<Shape>) => body.extend({ workOrderId: id() })

async function applyCut(caller: CommandCaller, event: QueuedEvent, key: string): Promise<Applied> {
  const envelope = { clientEventId: event.clientEventId, ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}) }
  if (event.kind === 'production.cut.remnant') {
    const body = parsed(withWorkOrder(remnantContract.body as z.ZodObject<z.ZodRawShape>).extend({ hideId: id() }), { ...event.payload, ...envelope })
    if (!body.ok) return refusedBy(body.refusal)
    const { workOrderId, hideId, remnant, note } = body.value as { workOrderId: string; hideId: string; remnant: { area: string; uom?: 'DM2' | 'FT2' | 'M2'; toLocationId: string } | null; note?: string | null }
    const result = await logCut(caller, workOrderId, { hideId, lines: [], done: { remnant }, note, ...envelope }, key)
    return { status: result.replayed ? 'duplicate' : 'accepted', result: result.cut ? { type: 'CutLog', id: result.cut.id } : { type: 'Hide', id: result.hide.id } }
  }
  const body = parsed(withWorkOrder(cutContract.body as z.ZodObject<z.ZodRawShape>), { ...event.payload, ...envelope })
  if (!body.ok) return refusedBy(body.refusal)
  const { workOrderId, ...input } = body.value as unknown as { workOrderId: string } & Parameters<typeof logCut>[2]
  const result = await logCut(caller, workOrderId, input, key)
  return { status: result.replayed ? 'duplicate' : 'accepted', result: result.cut ? { type: 'CutLog', id: result.cut.id } : { type: 'Hide', id: result.hide.id } }
}

async function applyBundle(caller: CommandCaller, event: QueuedEvent, key: string): Promise<Applied> {
  const body = parsed(withWorkOrder(makeBundlesContract.body as z.ZodObject<z.ZodRawShape>), { ...event.payload, clientEventId: event.clientEventId })
  if (!body.ok) return refusedBy(body.refusal)
  const { workOrderId, ...input } = body.value as unknown as { workOrderId: string } & Parameters<typeof makeBundles>[2]
  const result = await makeBundles(caller, workOrderId, input, key)
  const bundle = result.bundles[0]
  if (!bundle) return refusedBy(badEventRefusal('the make answered no bundle.'))
  return { status: result.replayed ? 'duplicate' : 'accepted', result: { type: 'Bundle', id: bundle.id } }
}

async function applyPlantReport(caller: CommandCaller, event: QueuedEvent, key: string): Promise<Applied> {
  const body = parsed(reportContract.body, { ...event.payload, ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}) })
  if (!body.ok) return refusedBy(body.refusal)
  const result = await report(caller, body.value, key)
  return { status: result.replayed ? 'duplicate' : 'accepted', result: { type: 'MaintenanceRequest', id: result.request.id } }
}

/** B-W2b-35: a queued call or a step of one, through the calls' own commands (the key: `<device>.<client event id>`). */
async function applyCall(caller: CommandCaller, event: QueuedEvent, key: string): Promise<Applied> {
  const occurredAt = event.occurredAt ? { occurredAt: event.occurredAt } : {}
  if (event.kind === 'andon.call.send') {
    const body = parsed(sendContract.body, { ...event.payload, clientEventId: event.clientEventId, ...occurredAt })
    if (!body.ok) return refusedBy(body.refusal)
    const result = await sendCall(caller, body.value, key)
    return { status: result.replayed || result.existing ? 'duplicate' : 'accepted', result: { type: 'HelpCall', id: result.call.id } }
  }
  const body = parsed(queuedAnswerBody, { ...event.payload, ...occurredAt })
  if (!body.ok) return refusedBy(body.refusal)
  const { callId, step, ...rest } = body.value
  const context = caller.factoryContext
  const responder = context !== null && holds(actorOf(context), PRODUCTION_CALLS_ANSWER)
  const result = !responder && (step === 'SOLVED' || step === 'CANCELLED') ? await closeAtStation(caller, callId, step, rest, key) : await answerCall(caller, callId, step, rest, key)
  return { status: result.replayed ? 'duplicate' : 'accepted', result: { type: 'HelpCall', id: result.call.id } }
}

/**
 * Applies one event through its module. `key`: the module command's Idempotency-Key (`<device>.<client event id>`); a
 * module refusal or a domain error is a refusal, anything else is thrown (the send fails; resending it is safe).
 */
export async function applyQueued(caller: CommandCaller, event: QueuedEvent, context: { readonly key: string; readonly sentAt?: string | undefined }): Promise<Applied> {
  try {
    switch (event.kind) {
      case 'production.scan.report':
      case 'production.scan.undo':
      case 'production.scan.ask':
        return await applyScan(caller, event, context.sentAt)
      case 'production.cut.log':
      case 'production.cut.remnant':
        return await applyCut(caller, event, context.key)
      case 'production.bundles.make':
        return await applyBundle(caller, event, context.key)
      case 'plant.report':
        return await applyPlantReport(caller, event, context.key)
      case 'andon.call.send':
      case 'andon.call.answer':
        return await applyCall(caller, event, context.key)
    }
  } catch (error) {
    const refusal = refusalOfError(error)
    if (refusal) return refusedBy(refusal)
    throw error
  }
}
