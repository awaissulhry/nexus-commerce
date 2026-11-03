import type { z } from 'zod'
import { DomainError, ForbiddenError } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { badEventRefusal, errorRefusal, moduleRefusal, notAllowedRefusal, type SyncRefusal } from '@nexus/factory-domain/floor-sync/rules'
import { IdempotencyKeyReusedError, StaleVersionError, type CommandCaller } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { changeIdentity, recordMeasurements, recordResults, setCount } from '../final/bench-plan'
import { putDefects, updateInspection } from '../final/inspections'
import { putHide, putResults as putIncomingResults, removeHide } from '../incoming/record'
import { InProcessRefusedError } from '../inprocess/access'
import { saveResults } from '../inprocess/checks'
import { checkPayload, finalPayload, incomingPayload, type CheckPayload, type FinalPayload, type IncomingPayload, type QueueRecordKind } from './contract'
import { modelOf, type RecordRef } from './models'

/**
 * A write of an open inspection, online or from the tablet's queue, as ONE action under ONE client id (B-W2b-106; QHS-062;
 * B-W2b-77's rule: "a floor screen that tries a route and falls back to the queue goes through onlineFirst … its module must
 * answer a known id before its state checks, and leave the tablet's time out of the command's input").
 *
 *   POST /quality/queue/record  { clientEventId, kind, payload }   the online try (floor)
 *   floor-sync kinds quality.final.record | quality.incoming.record | quality.inprocess.results   the queued retry
 *
 * Both go to the same module command (B-W2b-97's results, measurements, count, serial scans; W1's defects and checklist;
 * B-W2b-98's hide, hide out of the sample, plan checks; B-W2b-99's plan checks) under the same Idempotency-Key,
 * `<device>.<client event id>`, so:
 *
 *   - a known id is answered before anything is read: the module's receipt of the command is looked up first (`duplicate`,
 *     nothing done again: a "+ one piece" never counts twice, a hide's area is never measured twice);
 *   - the version is the record's own when the write arrives, not the one the tablet saw: each write is keyed by what it
 *     changes (a check and unit, a point, size and unit, a hide, a defect class and code) or adds (the count), so a queue sent
 *     after hours applies on the record as it stands; a decided or cancelled record refuses it in the module's words;
 *   - a retry that raced the try (both missed the receipt) answers from the first one's receipt.
 *
 * Signing, opening and cancelling are never queued (a PIN checked by the office at that moment; a number from the office).
 */

export interface QueuedWrite {
  readonly clientEventId: string
  readonly kind: QueueRecordKind
  readonly payload: Record<string, unknown>
}

interface Plan {
  readonly ref: Omit<RecordRef, 'kind'>
  /** The module command's name: the scope of its receipt. */
  readonly scope: Permission
  readonly versionOf: (caller: CommandCaller) => Promise<number | null>
  readonly run: (caller: CommandCaller, version: number, key: string) => Promise<unknown>
}

/** A payload its body refuses (400, `body/payload/<path>`; a queued one: BAD_EVENT). */
export class PayloadRefusedError extends DomainError {
  override name = 'PayloadRefusedError'
  constructor(readonly problem: string, issues: readonly { path: string; message: string }[]) {
    super('validation_failed', `The ${problem} is not valid: ${issues[0]?.message ?? 'see the issues'}.`, issues)
  }
}

function parse<Schema extends z.ZodType>(schema: Schema, payload: unknown, what: string): z.infer<Schema> {
  const result = schema.safeParse(payload)
  if (result.success) return result.data
  throw new PayloadRefusedError(what, result.error.issues.map((issue) => ({ path: `body/payload/${issue.path.join('/')}`, message: issue.message })))
}

const inspectionVersion = (id: string) => (caller: CommandCaller) => caller.withClient(async (db) => (await db.inspection.findUnique({ where: { id }, select: { version: true } }))?.version ?? null)
const incomingVersion = (id: string) => (caller: CommandCaller) => caller.withClient(async (db) => (await db.incomingInspection.findUnique({ where: { id }, select: { version: true } }))?.version ?? null)
const checkVersion = (id: string) => (caller: CommandCaller) => caller.withClient(async (db) => (await db.inProcessCheck.findUnique({ where: { id }, select: { version: true } }))?.version ?? null)

function finalPlan(body: FinalPayload): Plan {
  const id = body.inspectionId
  const ref = { recordType: 'Inspection' as const, id }
  const base = { ref, versionOf: inspectionVersion(id) }
  switch (body.what) {
    case 'RESULTS': {
      const { what: _what, inspectionId: _id, ...rest } = body
      return { ...base, scope: 'quality.inspection.results', run: (caller, version, key) => recordResults(caller, id, { ...rest, version }, key) }
    }
    case 'MEASUREMENTS': {
      const { what: _what, inspectionId: _id, ...rest } = body
      return { ...base, scope: 'quality.inspection.measurements', run: (caller, version, key) => recordMeasurements(caller, id, { ...rest, version }, key) }
    }
    case 'COUNT': {
      const { what: _what, inspectionId: _id, ...rest } = body
      return { ...base, scope: 'quality.inspection.count', run: (caller, version, key) => setCount(caller, id, { ...rest, version }, key) }
    }
    case 'IDENTITY': {
      const { what: _what, inspectionId: _id, ...rest } = body
      return { ...base, scope: 'quality.inspection.identity', run: (caller, version, key) => changeIdentity(caller, id, { ...rest, version }, key) }
    }
    case 'DEFECTS': {
      const { what: _what, inspectionId: _id, ...rest } = body
      return { ...base, scope: 'quality.inspection.defects', run: (caller, version, key) => putDefects(caller, id, { ...rest, version }, key) }
    }
    case 'CHECKLIST': {
      const { what: _what, inspectionId: _id, ...rest } = body
      return { ...base, scope: 'quality.inspection.record', run: (caller, version, key) => updateInspection(caller, id, { ...rest, version }, key) }
    }
  }
}

function incomingPlan(body: IncomingPayload): Plan {
  const id = body.inspectionId
  const ref = { recordType: 'IncomingInspection' as const, id }
  const base = { ref, versionOf: incomingVersion(id) }
  switch (body.what) {
    case 'HIDE': {
      const { what: _what, inspectionId: _id, hideId, ...rest } = body
      return { ...base, scope: 'quality.incoming.recordHide', run: (caller, version, key) => putHide(caller, id, hideId, { ...rest, version }, key) }
    }
    case 'HIDE_REMOVED':
      return { ...base, scope: 'quality.incoming.removeHide', run: (caller, version, key) => removeHide(caller, id, body.hideId, version, key) }
    case 'RESULTS': {
      const { what: _what, inspectionId: _id, ...rest } = body
      return { ...base, scope: 'quality.incoming.recordResults', run: (caller, version, key) => putIncomingResults(caller, id, { ...rest, version }, key) }
    }
  }
}

function checkPlan(body: CheckPayload): Plan {
  const { checkId, ...rest } = body
  return { ref: { recordType: 'InProcessCheck', id: checkId }, scope: 'quality.inprocess.results', versionOf: checkVersion(checkId), run: (caller, version, key) => saveResults(caller, checkId, { ...rest, version }, key) }
}

function planOf(write: QueuedWrite): Plan {
  switch (write.kind) {
    case 'quality.final.record':
      return finalPlan(parse(finalPayload, write.payload, 'final inspection write'))
    case 'quality.incoming.record':
      return incomingPlan(parse(incomingPayload, write.payload, 'incoming inspection write'))
    case 'quality.inprocess.results':
      return checkPlan(parse(checkPayload, write.payload, 'check results'))
  }
}

const known = (caller: CommandCaller, scope: string, key: string): Promise<boolean> => caller.withClient(async (db) => (await db.idempotencyReceipt.count({ where: { scope, key } })) > 0)

/** Writes once: answered from the module's receipt when the id is known, else run on the record as it stands. */
async function writeOnce(caller: CommandCaller, plan: Plan, key: string): Promise<'accepted' | 'duplicate'> {
  if (await known(caller, plan.scope, key)) return 'duplicate'
  for (let attempt = 1; ; attempt++) {
    const version = await plan.versionOf(caller)
    // Not found as the caller reads it: the module says so in its own words (404).
    try {
      await plan.run(caller, version ?? 1, key)
      return 'accepted'
    } catch (error) {
      // The try and the retry raced: the other one's receipt is the answer.
      if (error instanceof IdempotencyKeyReusedError && (await known(caller, plan.scope, key))) return 'duplicate'
      // Another write of the record came between our read of its version and its lock: read it again (once).
      if (error instanceof StaleVersionError && attempt < 2) {
        if (await known(caller, plan.scope, key)) return 'duplicate'
        continue
      }
      throw error
    }
  }
}

const floorOf = (caller: CommandCaller): FloorContext => {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError('A queued inspection write comes from a floor tablet.')
  return context
}

/** POST /quality/queue/record: the online try (the module's errors are the answer; a network failure: the screen queues it under the same id). */
export async function recordOnline(caller: CommandCaller, body: QueuedWrite) {
  const context = floorOf(caller)
  const plan = planOf(body)
  const status = await writeOnce(caller, plan, `${context.deviceId}.${body.clientEventId}`)
  const ref = { ...plan.ref }
  return { status, result: { type: ref.recordType, id: ref.id }, model: await modelOf(caller, ref) }
}

export type QueueApplied =
  | { readonly status: 'accepted' | 'duplicate'; readonly result: { readonly type: string; readonly id: string } }
  | { readonly status: 'refused'; readonly refusal: SyncRefusal; readonly moduleRefusal: null }

const DISCARD = 'Discard it: the inspection is as the office has it now.'

/**
 * A module's refusal of a queued write, final unless it may pass when sent again: a record changed under it twice running
 * (sent again by itself). A record decided, cancelled or taken by someone else, a check no longer in the plan, a sample
 * already full are said in the module's words and are final (the tablet shows them; a person discards them).
 */
export function queuedRefusal(error: unknown): SyncRefusal | null {
  if (error instanceof PayloadRefusedError) return badEventRefusal(`${error.issues?.[0]?.message ?? error.message} (${error.issues?.[0]?.path.replace(/^body\/payload\/?/, '') || 'payload'})`)
  if (error instanceof StaleVersionError) return { code: 'CONFLICT', message: error.message, fix: 'It is sent again by itself; if it stays here, ask your team leader.', final: false }
  if (error instanceof InProcessRefusedError) return moduleRefusal({ code: error.refusal.code, message: error.refusal.message, fix: error.refusal.fix, final: true })
  if (error instanceof DomainError) {
    if (error.code === 'forbidden') return { ...notAllowedRefusal(), message: error.message === 'You may not do this.' ? notAllowedRefusal().message : error.message }
    if (error.code === 'conflict' || error.code === 'invalid_state') return { code: 'CONFLICT', message: error.message, fix: DISCARD, final: true }
    return errorRefusal({ code: error.code, message: error.message, issues: error.issues })
  }
  return null
}

/** floor-sync: a queued write through its module (`key` = `<device>.<client event id>`, the online try's key too). */
export async function recordFromQueue(caller: CommandCaller, write: QueuedWrite, key: string): Promise<QueueApplied> {
  try {
    const plan = planOf(write)
    const status = await writeOnce(caller, plan, key)
    return { status, result: { type: plan.ref.recordType, id: plan.ref.id } }
  } catch (error) {
    const refusal = queuedRefusal(error)
    if (refusal) return { status: 'refused', refusal, moduleRefusal: null }
    throw error
  }
}
