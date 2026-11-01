import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { parseInstant } from '@nexus/factory-domain/core/time'
import { PRODUCTION_CALLS_ANSWER } from '@nexus/factory-domain/production/calls/permissions'
import { CALL_REFUSALS, sentAtOf, stepRefusal, type CallStatus, type CallStep, type OutcomeType } from '@nexus/factory-domain/production/calls/rules'
import { command, type CommandCaller } from '../../../core/command'
import { assertMay, assertVersion, bodyIssue, contextOf, officeOf, refuse, type CallContext } from './access'
import { stepInCommand } from './station'
import { callRecord, lockCall, readCall, scopeOfCall, type CallRow, type Reader } from './store'

/**
 * Answering help calls (B-W2b-35; MES-145 "Responder taps 'on my way' then 'resolved'; time to acknowledge and time to
 * resolve are stored"; design floor.supervisor "Calls: On my way · Solved", production.calls "A acknowledge, D done with a
 * resolution code", "a machine call → Open a maintenance job"), from the team leader's line view (the floor, its own site)
 * or the office, with production.calls.answer:
 *
 *   POST /production/calls/:callId/seen          seen (SENT only)
 *   POST /production/calls/:callId/on-the-way    someone is coming (marks an unseen call seen at the same moment)
 *   POST /production/calls/:callId/solve         solved, with how (a code) and words
 *   POST /production/calls/:callId/cancel        cancelled, with the reason (kept on the audit row)
 *   POST /production/calls/:callId/outcome       what it led to (a maintenance job, a machine request, a nonconformance,
 *                                                a task of the same site), named once (office)
 *
 * Who answered is the actor (an office user or the floor worker signed in): a call's step, never a figure about them.
 * Anyone with the permission at the site answers; the type's team is who is told (notices.ts), not who may answer.
 */

async function knownCall(caller: CommandCaller, context: CallContext, callId: string): Promise<CallRow> {
  const call = isUuid(callId) ? await caller.withClient((db) => readCall(db, callId)) : null
  if (!call) throw new NotFoundError('Call not found.')
  assertMay(context, PRODUCTION_CALLS_ANSWER, scopeOfCall(call), 'Call')
  return call
}

const NAMES: Record<CallStep, `production.${string}`> = { SEEN: 'production.seeCall', ON_THE_WAY: 'production.comeToCall', SOLVED: 'production.solveCall', CANCELLED: 'production.cancelCall' }

export interface AnswerBody {
  readonly version?: number | undefined
  readonly occurredAt?: string | undefined
  readonly resolutionCode?: string | undefined
  readonly resolutionNote?: string | undefined
  readonly reason?: string | undefined
}

/** A responder's step (seen, on the way, solved, cancelled) in ONE command. */
export async function answerCall(caller: CommandCaller, callId: string, step: CallStep, body: AnswerBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  const known = await knownCall(caller, context, callId)
  const early = stepRefusal({ status: known.status as CallStatus, sentAt: known.sentAt, seenAt: known.seenAt, onTheWayAt: known.onTheWayAt }, step)
  if (early) refuse(early)
  // A queued answer from a tablet keeps the tablet's time when believable; the office answers now.
  const occurredAt = context.audience === 'floor' && body.occurredAt ? parseInstant(body.occurredAt) : null
  const { result, replayed } = await command(caller, { name: NAMES[step], idempotencyKey, input: { callId, step, ...body }, ...(occurredAt ? { deviceTime: occurredAt } : {}) }, async (tools) => {
    const after = await stepInCommand(tools, callId, step, {
      expectedVersion: body.version,
      at: sentAtOf(occurredAt, tools.now),
      takerId: context.actorId,
      actor: 'RESPONDER',
      resolutionCode: body.resolutionCode,
      resolutionNote: body.resolutionNote,
      reason: body.reason,
    })
    return { call: await callRecord(tools.tx, after, context, tools.now) }
  })
  return { ...result, replayed }
}

/** The outcome record must exist at the call's site (a task: of the site, or of its company with no site). */
async function outcomeAt(db: Reader, recordType: OutcomeType, recordId: string, call: CallRow): Promise<boolean> {
  const site = call.siteId
  switch (recordType) {
    case 'MaintenanceJob':
      return (await db.maintenanceJob.findUnique({ where: { id: recordId }, select: { siteId: true } }))?.siteId === site
    case 'MaintenanceRequest':
      return (await db.maintenanceRequest.findUnique({ where: { id: recordId }, select: { siteId: true } }))?.siteId === site
    case 'Nonconformance':
      return (await db.nonconformance.findUnique({ where: { id: recordId }, select: { siteId: true } }))?.siteId === site
    case 'Task': {
      const task = await db.task.findUnique({ where: { id: recordId }, select: { siteId: true, companyId: true } })
      return task !== null && (task.siteId === site || (task.siteId === null && task.companyId === call.station.companyId))
    }
  }
}

/** POST /production/calls/:callId/outcome: what the call led to, named once (open or closed). */
export async function nameOutcome(caller: CommandCaller, callId: string, body: { readonly version?: number | undefined; readonly recordType: OutcomeType; readonly recordId: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await knownCall(caller, context, callId)
  if (known.outcomeRecordType) refuse(CALL_REFUSALS.OUTCOME_NAMED)
  if (!(await caller.withClient((db) => outcomeAt(db, body.recordType, body.recordId, known)))) throw bodyIssue('recordId', `Not a ${body.recordType} of the call's site.`)
  const { result, replayed } = await command(caller, { name: 'production.nameCallOutcome', idempotencyKey, input: { callId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const call = (await lockCall(tx, callId))!
    assertVersion('call', call.version, body.version)
    if (call.outcomeRecordType) refuse(CALL_REFUSALS.OUTCOME_NAMED)
    await tx.helpCall.update({ where: { id: callId }, data: { outcomeRecordType: body.recordType, outcomeRecordId: body.recordId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const scope = scopeOfCall(call)
    tools.audit({ recordType: 'HelpCall', recordId: callId, ...scope, before: { outcomeRecordType: null, outcomeRecordId: null }, after: { outcomeRecordType: body.recordType, outcomeRecordId: body.recordId } })
    tools.emit({ type: 'help_call.changed', subject: callId, ...scope, payload: { callId, stationId: call.stationId, lineId: call.lineId, change: 'OUTCOME', outcomeRecordType: body.recordType } })
    return { call: await callRecord(tx, (await readCall(tx, callId))!, context, now) }
  })
  return { ...result, replayed }
}
