import { DomainError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { QUALITY_LOTS_REJECT, QUALITY_LOTS_RELEASE } from '@nexus/factory-domain/quality/lab/permissions'
import { blockProblem, checklistRefusal, clearHoldProblem, codeMatches, reasonProblem, rejectProblem, releaseChecklist, type ChecklistMode } from '@nexus/factory-domain/quality/lab/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { checklistFactsOf, checklistOf, lotView } from './read'
import { factsOf, lockLotStock, lotFor, officeOf, readLot, type LotRow } from './store'
import { workOrdersOf } from './trace'

/**
 * The quality decisions on a lot (B-W1-34; SCM-117, QHS-030, QHS-073; A1 §2.5 "Lot"; design answer W3 (A); design
 * lt-release-confirm, lt-reject, lt-block, lt-status). Each is ONE command on the Lot: its version is the edit-conflict
 * guard and its bump locks the row (a result, a reversal of its receipt or another decision waits or fails on it); the
 * facts are read again inside it; the …_supply_guards trigger holds the state machine and "RELEASED only with a Cr VI
 * PASS" for every login.
 *
 *   release    QUARANTINE → RELEASED (quality.lots.release): the checklist (factory-domain releaseChecklist) all passed,
 *              by a person who did not receive the lot, who typed the lot's code. The checks as they were are kept in
 *              the audit row (what the release rested on). Its stock is usable at once: planning nets it, it is issued.
 *   reject     QUARANTINE | BLOCKED → REJECTED (quality.lots.reject), final, with the reason and the typed code.
 *   block      RELEASED → BLOCKED (quality.lots.reject), with the reason, under the lot's stock locks: the work orders it
 *              went to come back (and in `lot.blocked`).
 *   unblock    BLOCKED → RELEASED (quality.lots.release), with the reason: the same checks but the receiver's hold.
 *   clear hold the receiver's hold (QUARANTINE, Lot.qualityNote) checked and cleared (quality.lots.release), with what was
 *              found, by another person than the receiver.
 */

const issuesAt = (issues: readonly (Issue | null)[]): Issue[] => issues.filter((issue): issue is Issue => issue !== null).map((issue) => ({ ...issue, path: `body/${issue.path}` }))

function assertCode(lot: LotRow, typed: string): void {
  if (!codeMatches(typed, lot.code)) throw new ValidationError(`Type the lot's code, ${lot.code}, to confirm.`, [{ path: 'body/confirmCode', message: `Type the lot's code, ${lot.code}, to confirm.` }])
}

async function afterDecision(tools: CommandTools, context: OfficeContext, lotId: string) {
  const updated = (await readLot(tools.tx, lotId))!
  return { lot: await lotView(tools.tx, updated), checklist: await checklistOf(tools.tx, context.tenantId, updated, businessDate(tools.now), context.actorId) }
}

async function checkedRelease(tools: CommandTools, context: OfficeContext, lot: LotRow, mode: ChecklistMode) {
  const facts = await checklistFactsOf(tools.tx, context.tenantId, lot, businessDate(tools.now), context.actorId)
  const list = releaseChecklist(facts, mode)
  if (!list.ready) {
    const refusal = checklistRefusal(list, lot.code)
    throw new DomainError('invalid_state', refusal.message, refusal.issues)
  }
  return list
}

/** POST /quality/lots/:lotId/release {version, confirmCode, note?}. */
export async function releaseLot(caller: CommandCaller, lotId: string, body: { readonly version: number; readonly confirmCode: string; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const lot = await lotFor(caller, lotId, QUALITY_LOTS_RELEASE)
  assertCode(lot, body.confirmCode)
  const note = body.note?.trim() || null
  if (note && note.length > 500) throw new ValidationError('The release is not valid.', [{ path: 'body/note', message: 'At most 500 characters.' }])
  const { result } = await command(caller, { name: 'quality.lots.release', idempotencyKey, input: { lotId, ...body }, record: { type: 'Lot', id: lot.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await readLot(tools.tx, lot.id))!
    const list = await checkedRelease(tools, context, current, 'RELEASE')
    const qualityNote = note ?? 'Released by the quality role: every check of the release checklist passed.'
    await tools.tx.lot.update({ where: { id: current.id }, data: { qualityStatus: 'RELEASED', qualityNote, qualityDecidedAt: tools.now, qualityDecidedById: context.actorId }, select: { id: true } })
    tools.audit({
      recordType: 'Lot',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { qualityStatus: current.qualityStatus, qualityNote: current.qualityNote },
      after: { qualityStatus: 'RELEASED', qualityNote, checks: list.checks.map((check) => ({ code: check.code, state: check.state, words: check.words })) },
    })
    tools.emit({ type: 'lot.released', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { lotId: current.id, code: current.code, itemId: current.itemId, from: 'QUARANTINE' } })
    return afterDecision(tools, context, current.id)
  })
  return result
}

/** POST /quality/lots/:lotId/unblock {version, reason}. */
export async function unblockLot(caller: CommandCaller, lotId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const lot = await lotFor(caller, lotId, QUALITY_LOTS_RELEASE)
  const problems = issuesAt([reasonProblem(body.reason)])
  if (problems.length > 0) throw new ValidationError('The release is not valid.', problems)
  const reason = body.reason.trim()
  const { result } = await command(caller, { name: 'quality.lots.unblock', idempotencyKey, input: { lotId, ...body }, record: { type: 'Lot', id: lot.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await readLot(tools.tx, lot.id))!
    const list = await checkedRelease(tools, context, current, 'UNBLOCK')
    await tools.tx.lot.update({ where: { id: current.id }, data: { qualityStatus: 'RELEASED', qualityNote: reason, qualityDecidedAt: tools.now, qualityDecidedById: context.actorId }, select: { id: true } })
    tools.audit({
      recordType: 'Lot',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      reason,
      before: { qualityStatus: current.qualityStatus, qualityNote: current.qualityNote },
      after: { qualityStatus: 'RELEASED', qualityNote: reason, checks: list.checks.map((check) => ({ code: check.code, state: check.state, words: check.words })) },
    })
    tools.emit({ type: 'lot.released', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { lotId: current.id, code: current.code, itemId: current.itemId, from: 'BLOCKED' } })
    return afterDecision(tools, context, current.id)
  })
  return result
}

/** POST /quality/lots/:lotId/reject {version, confirmCode, reason}. */
export async function rejectLot(caller: CommandCaller, lotId: string, body: { readonly version: number; readonly confirmCode: string; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const lot = await lotFor(caller, lotId, QUALITY_LOTS_REJECT)
  const problems = issuesAt([reasonProblem(body.reason)])
  if (problems.length > 0) throw new ValidationError('The rejection is not valid.', problems)
  assertCode(lot, body.confirmCode)
  const reason = body.reason.trim()
  const { result } = await command(caller, { name: 'quality.lots.reject', idempotencyKey, input: { lotId, ...body }, record: { type: 'Lot', id: lot.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await readLot(tools.tx, lot.id))!
    const refusal = rejectProblem(factsOf(current))
    if (refusal) throw new InvalidStateError(refusal)
    await tools.tx.lot.update({ where: { id: current.id }, data: { qualityStatus: 'REJECTED', qualityNote: reason, qualityDecidedAt: tools.now, qualityDecidedById: context.actorId }, select: { id: true } })
    tools.audit({ recordType: 'Lot', recordId: current.id, companyId: current.companyId, siteId: current.siteId, reason, before: { qualityStatus: current.qualityStatus, qualityNote: current.qualityNote }, after: { qualityStatus: 'REJECTED', qualityNote: reason } })
    tools.emit({ type: 'lot.rejected', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { lotId: current.id, code: current.code, itemId: current.itemId, from: current.qualityStatus as 'QUARANTINE' | 'BLOCKED' } })
    return afterDecision(tools, context, current.id)
  })
  return result
}

/** POST /quality/lots/:lotId/block {version, reason}. */
export async function blockLot(caller: CommandCaller, lotId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const lot = await lotFor(caller, lotId, QUALITY_LOTS_REJECT)
  const problems = issuesAt([reasonProblem(body.reason)])
  if (problems.length > 0) throw new ValidationError('The block is not valid.', problems)
  const reason = body.reason.trim()
  const { result } = await command(caller, { name: 'quality.lots.block', idempotencyKey, input: { lotId, ...body }, record: { type: 'Lot', id: lot.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await readLot(tools.tx, lot.id))!
    const refusal = blockProblem(factsOf(current))
    if (refusal) throw new InvalidStateError(refusal)
    // Where the lot lies, locked: an issue in flight lands before the trace, a later one is refused by the trigger.
    await lockLotStock(tools.tx, context.tenantId, current)
    const trace = await workOrdersOf(tools.tx, current.id)
    await tools.tx.lot.update({ where: { id: current.id }, data: { qualityStatus: 'BLOCKED', qualityNote: reason, qualityDecidedAt: tools.now, qualityDecidedById: context.actorId }, select: { id: true } })
    tools.audit({
      recordType: 'Lot',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      reason,
      before: { qualityStatus: current.qualityStatus, qualityNote: current.qualityNote },
      after: { qualityStatus: 'BLOCKED', qualityNote: reason, workOrderIds: trace.map((use) => use.workOrderId) },
    })
    tools.emit({ type: 'lot.blocked', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { lotId: current.id, code: current.code, itemId: current.itemId, cause: 'FINDING', workOrderIds: trace.map((use) => use.workOrderId) } })
    return { ...(await afterDecision(tools, context, current.id)), trace: { workOrders: trace } }
  })
  return result
}

/** POST /quality/lots/:lotId/hold/clear {version, reason}. */
export async function clearHold(caller: CommandCaller, lotId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const lot = await lotFor(caller, lotId, QUALITY_LOTS_RELEASE)
  const problems = issuesAt([reasonProblem(body.reason)])
  if (problems.length > 0) throw new ValidationError('The hold is not cleared.', problems)
  const reason = body.reason.trim()
  const { result } = await command(caller, { name: 'quality.lots.clearHold', idempotencyKey, input: { lotId, ...body }, record: { type: 'Lot', id: lot.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await readLot(tools.tx, lot.id))!
    const facts = factsOf(current)
    const refusal = clearHoldProblem(facts, context.actorId)
    if (refusal) throw new InvalidStateError(refusal)
    await tools.tx.lot.update({ where: { id: current.id }, data: { qualityNote: null }, select: { id: true } })
    tools.audit({ recordType: 'Lot', recordId: current.id, companyId: current.companyId, siteId: current.siteId, reason, before: { hold: facts.holdNote }, after: { hold: null } })
    tools.emit({ type: 'lot.hold_cleared', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { lotId: current.id, code: current.code } })
    return afterDecision(tools, context, current.id)
  })
  return result
}
