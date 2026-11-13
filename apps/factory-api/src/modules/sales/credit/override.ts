import { DomainError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { CREDIT_LIMITS, findingsOf, ORDER_STEPS, overrideResult, type CreditReading, type CreditResult, type CreditStep } from '@nexus/factory-domain/sales/credit/credit'
import { SALES_CREDIT_CHECKS } from '@nexus/factory-domain/sales/credit/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf as grantsOf, type OfficeContext } from '../../../core/context'
import { withdrawPending } from '../../../platform/approvals/engine'
import type { TaskRef } from '../../../platform/approvals/kinds/kind'
import { askOverride, newestCheck, planCredit, writeCheck, type CreditPlan } from './check'
import { readAmounts, type Reader } from './reading'
import { officeOf } from './access'
// B-W2b-358 (SAL-292): a made-to-measure unit's measures are confirmed before the order goes on.
import { waitsForMeasures } from '../mtm/order-gate'

/**
 * What a yes, a "check again" and an "ask for a yes" do to a credit hold (B-W2b-304; SAL-237, SAL-241).
 *
 *   overrideInCommand(tools, task)   CREDIT_OVERRIDE's onApproved, in the approver's command: a NEW check of the same
 *                                    step and record with what it sees now (PASS when nothing is found any more, else
 *                                    WARN: let through), naming the HOLD and the request; a waiting order is CONFIRMED
 *                                    (unless another yes is still asked on it: a SALES_ORDER request, B-W2b-303); a
 *                                    work order or a shipment goes on at its next release or shipment
 *   checkAgain(caller, …)            POST …/check: the record checked again (after a payment, a raised limit): PASS or
 *                                    WARN → the waiting order CONFIRMED and the yes asked on the old HOLD withdrawn;
 *                                    still HOLD → a new HOLD and a new request (the old one withdrawn)
 *   askAgain(caller, checkId, …)     POST /sales/credit/checks/:checkId/ask: a yes asked on a HOLD that has none (the
 *                                    system's hold of an accepted quote, a request turned down, withdrawn or stale);
 *                                    asked for the person whose step was held when the office made it
 *   recheckHeldOrders(tools, …)      every order of the customer with the company waiting for credit, checked again in
 *                                    the caller's command (a limit changed, a payment allocated): those that pass go on
 */

const actorOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

const HOLD_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  step: true,
  recordType: true,
  recordId: true,
  currency: true,
  result: true,
  overridesCheckId: true,
  createdById: true,
  checkedAt: true,
} as const

type HoldRow = { id: string; companyId: string; partyId: string; step: string; recordType: string; recordId: string; currency: string; result: string; overridesCheckId: string | null; createdById: string | null; checkedAt: Date }

/** What a check of the record counts as its subject now: a waiting order is the subject (its gross); anything else 0. */
async function subjectOf(db: Reader, hold: Pick<HoldRow, 'step' | 'recordType' | 'recordId'>): Promise<{ amount: number; currency: string; exclude: string[] } | null> {
  if (hold.recordType !== 'SalesOrder' || !ORDER_STEPS.includes(hold.step as CreditStep)) return null
  const order = await db.salesOrder.findUnique({ where: { id: hold.recordId }, select: { id: true, status: true, grossAmount: true, currency: true } })
  if (!order || order.status !== 'PENDING_APPROVAL') return null
  return { amount: order.grossAmount, currency: order.currency, exclude: [order.id] }
}

/** The plan of the record's check now; without a limit (cleared since), the amounts in the hold's currency and no limit. */
async function planNow(db: Reader, hold: HoldRow, now: Date, askers: readonly string[]): Promise<CreditPlan> {
  const subject = await subjectOf(db, hold)
  const input = { step: hold.step as CreditStep, partyId: hold.partyId, companyId: hold.companyId, subject: subject ? { amount: subject.amount, currency: subject.currency } : null, exclude: subject?.exclude ?? [], now, askers }
  const plan = await planCredit(db, input)
  if (plan) return plan
  const reading: CreditReading = await readAmounts(db, { partyId: hold.partyId, companyId: hold.companyId, exclude: input.exclude, now, currency: hold.currency, limit: null, subject: subject && subject.currency === hold.currency ? subject.amount : 0 })
  const party = await db.party.findUnique({ where: { id: hold.partyId }, select: { code: true } })
  const findings = findingsOf(reading)
  const result: CreditResult = findings.length === 0 ? 'PASS' : 'WARN'
  return { step: input.step, partyId: hold.partyId, companyId: hold.companyId, customerCode: party?.code ?? '', reading, findings, result, words: '', approver: null }
}

/** A waiting order goes on (PENDING_APPROVAL → CONFIRMED) unless another yes is still asked on it; true when it moved. */
export async function confirmWaitingOrder(tools: CommandTools, orderId: string, words: string): Promise<boolean> {
  const order = await tools.tx.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, number: true, status: true, companyId: true, partyId: true } })
  if (!order || order.status !== 'PENDING_APPROVAL') return false
  // B-W2b-303's SALES_ORDER rule may ask a yes on the same order: it keeps waiting for that one.
  const other = await tools.tx.approvalTask.findFirst({ where: { kind: 'SALES_ORDER', recordType: 'SalesOrder', recordId: order.id, status: 'PENDING' }, select: { id: true } })
  if (other) return false
  // B-W2b-358: a made-to-measure unit's measures the factory has not confirmed: it keeps waiting (the review's CONFIRM lets it go on).
  if (await waitsForMeasures(tools.tx, order.id)) {
    tools.audit({ action: 'credit.orderGoesOn', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { status: 'PENDING_APPROVAL', stillWaitsFor: 'MEASUREMENTS' }, reason: words })
    return false
  }
  await tools.tx.salesOrder.update({ where: { id: order.id }, data: { status: 'CONFIRMED', version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
  tools.audit({ action: 'credit.orderGoesOn', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { status: 'PENDING_APPROVAL' }, after: { status: 'CONFIRMED' }, reason: words })
  tools.emit({ type: 'sales_order.status_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, from: 'PENDING_APPROVAL', to: 'CONFIRMED', by: tools.context.audience === 'office' ? 'person' : 'system' } })
  return true
}

/** CREDIT_OVERRIDE's yes (platform/approvals/kinds/credit-override.ts onApproved), in the approver's command. */
export async function overrideInCommand(tools: CommandTools, task: TaskRef): Promise<void> {
  const hold = (await tools.tx.creditCheck.findUnique({ where: { id: task.recordId }, select: HOLD_COLUMNS })) as HoldRow | null
  if (!hold || hold.result !== 'HOLD' || hold.overridesCheckId !== null) throw new InvalidStateError('The credit hold this yes is about is gone: nothing to let through.')
  const plan = await planNow(tools.tx, hold, tools.now, [])
  const result = overrideResult(plan.reading)
  await writeCheck(tools, { ...plan, result }, { recordType: hold.recordType, recordId: hold.recordId }, { checkId: hold.id, taskId: task.id })
  if (hold.recordType === 'SalesOrder') await confirmWaitingOrder(tools, hold.recordId, 'A credit override was approved.')
}

/** Re-checks a held record in a command: the new check, the old request withdrawn, a waiting order on when it passes. */
async function checkAgainInCommand(tools: CommandTools, hold: HoldRow, note: string | null): Promise<{ checkId: string; result: CreditResult; asked: boolean; orderGoesOn: boolean }> {
  const actor = actorOf(tools)
  const requester = hold.createdById ?? actor
  const askers = [...new Set([requester, actor].filter((id): id is string => id !== null))]
  const plan = await planNow(tools.tx, hold, tools.now, askers)
  // The yes asked on the old HOLD is no longer about the newest check.
  await withdrawPending(tools, { kind: 'CREDIT_OVERRIDE', recordId: hold.id, byId: actor, words: 'Checked again.' })
  const checkId = await writeCheck(tools, plan, { recordType: hold.recordType, recordId: hold.recordId })
  if (plan.result === 'HOLD') {
    const asked = actor === null ? { asked: false } : await askOverride(tools, checkId, requester, plan, note)
    return { checkId, result: plan.result, asked: asked.asked, orderGoesOn: false }
  }
  const orderGoesOn = hold.recordType === 'SalesOrder' ? await confirmWaitingOrder(tools, hold.recordId, 'Checked again: within what the company lets through.') : false
  return { checkId, result: plan.result, asked: false, orderGoesOn }
}

/** Every order of the customer with the company waiting for credit, checked again in the caller's command; how many went on. */
export async function recheckHeldOrders(tools: CommandTools, partyId: string, companyId: string, onlyWhenTheyPass = false): Promise<number> {
  const waiting = await tools.tx.salesOrder.findMany({ where: { partyId, companyId, status: 'PENDING_APPROVAL' }, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 50 })
  let moved = 0
  for (const order of waiting) {
    const step = (await tools.tx.creditCheck.findFirst({ where: { recordType: 'SalesOrder', recordId: order.id, step: { in: [...ORDER_STEPS] } }, orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }], select: { step: true } }))?.step
    if (!step) continue
    const last = await newestCheck(tools.tx, { step: step as CreditStep, recordType: 'SalesOrder', recordId: order.id })
    if (!last?.held) continue
    const hold = (await tools.tx.creditCheck.findUnique({ where: { id: last.id }, select: HOLD_COLUMNS })) as HoldRow
    if (onlyWhenTheyPass) {
      const plan = await planNow(tools.tx, hold, tools.now, [])
      if (plan.result === 'HOLD') continue
    }
    const outcome = await checkAgainInCommand(tools, hold, null)
    if (outcome.orderGoesOn) moved++
  }
  return moved
}

// ---- the routes ----------------------------------------------------------------------------------------------------------

/** The newest check of the record is an un-overridden HOLD the reader may act on (sales.credit.checks over its place). */
async function heldOf(caller: CommandCaller, context: OfficeContext, recordType: string, recordId: string): Promise<HoldRow> {
  if (!isUuid(recordId)) throw new NotFoundError('Record not found.')
  const hold = await caller.withClient(async (db) => {
    const newest = await db.creditCheck.findFirst({ where: { recordType, recordId }, orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }], select: HOLD_COLUMNS })
    if (!newest) return null
    // The newest check of the newest HOLD's step for its customer (a record may be checked at one step only).
    const last = await newestCheck(db, { step: newest.step as CreditStep, recordType, recordId, partyId: newest.partyId })
    return last ? ((await db.creditCheck.findUnique({ where: { id: last.id }, select: HOLD_COLUMNS })) as HoldRow) : null
  })
  if (!hold) throw new NotFoundError('This record has no credit check.')
  if (!can(grantsOf(context), SALES_CREDIT_CHECKS, { companyId: hold.companyId, partyId: hold.partyId })) throw new NotFoundError('This record has no credit check you may see.')
  if (hold.result !== 'HOLD' || hold.overridesCheckId !== null) throw new InvalidStateError('This record is not held for credit: nothing to check again.')
  return hold
}

const noteOf = (note: string | null | undefined): string | null => {
  const words = note?.trim() ? note.trim() : null
  if (words && words.length > CREDIT_LIMITS.note) throw new ValidationError(`At most ${CREDIT_LIMITS.note} characters.`, [{ path: 'body/note', message: `At most ${CREDIT_LIMITS.note} characters.` }])
  return words
}

/** POST /sales/credit/records/:recordType/:recordId/check (sales.credit.checks): the held record checked again. */
export async function checkAgain(caller: CommandCaller, recordType: string, recordId: string, body: { readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const note = noteOf(body.note)
  const hold = await heldOf(caller, context, recordType, recordId)
  const { result } = await command(caller, { name: 'credit.checkAgain', idempotencyKey, input: { recordType, recordId, ...body } }, async (tools) => {
    await lockSubject(tools, hold)
    const last = await newestCheck(tools.tx, { step: hold.step as CreditStep, recordType, recordId, partyId: hold.partyId })
    if (last?.id !== hold.id) throw new DomainError('conflict', 'It was checked meanwhile: reload it.', [{ path: 'credit', message: 'Checked meanwhile.' }])
    return checkAgainInCommand(tools, hold, note)
  })
  return result
}

/** POST /sales/credit/checks/:checkId/ask (sales.credit.checks): a yes asked on a HOLD that has none waiting. */
export async function askAgain(caller: CommandCaller, checkId: string, body: { readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const note = noteOf(body.note)
  const row = isUuid(checkId) ? await caller.withClient((db) => db.creditCheck.findUnique({ where: { id: checkId }, select: HOLD_COLUMNS })) : null
  if (!row || !can(grantsOf(context), SALES_CREDIT_CHECKS, { companyId: row.companyId, partyId: row.partyId })) throw new NotFoundError('Credit check not found.')
  const hold = await heldOf(caller, context, row.recordType, row.recordId)
  if (hold.id !== row.id) throw new InvalidStateError('A newer check of this record was made: ask on that one.')
  const { result } = await command(caller, { name: 'credit.askOverride', idempotencyKey, input: { checkId, ...body } }, async (tools) => {
    await lockSubject(tools, hold)
    const last = await newestCheck(tools.tx, { step: hold.step as CreditStep, recordType: hold.recordType, recordId: hold.recordId, partyId: hold.partyId })
    if (last?.id !== hold.id) throw new DomainError('conflict', 'It was checked meanwhile: reload it.', [{ path: 'credit', message: 'Checked meanwhile.' }])
    if (last.pendingTaskId) throw new DomainError('conflict', 'A yes is asked on this hold already.', [{ path: 'credit', message: 'Asked already.' }])
    const requester = hold.createdById ?? context.actorId
    const askers = [...new Set([requester, context.actorId])]
    const plan = await planNow(tools.tx, hold, tools.now, askers)
    if (plan.approver === null) throw new DomainError('conflict', 'No credit rule names someone else who may say yes: an administrator names an approver in the approval rules (Admin › Approvals, automation & AI), or the customer pays, or the limit is raised.', [{ path: 'credit', message: 'Nobody to ask.' }])
    const asked = await askOverride(tools, hold.id, requester, plan, note)
    if (!asked.asked) throw new DomainError('conflict', 'No credit rule is switched on any more: check it again instead.', [{ path: 'credit', message: 'No rule.' }])
    tools.audit({ action: 'credit.askOverride', recordType: hold.recordType, recordId: hold.recordId, companyId: hold.companyId, after: { creditCheckId: hold.id, taskId: asked.taskId, requestedById: requester } })
    return { taskId: asked.taskId }
  })
  return result
}

/** The subject's row is held while a credit hold of it is decided (a waiting order: its row). */
async function lockSubject(tools: CommandTools, hold: Pick<HoldRow, 'recordType' | 'recordId'>): Promise<void> {
  if (hold.recordType === 'SalesOrder') await tools.tx.$queryRaw`SELECT 1 FROM "SalesOrder" WHERE id = ${hold.recordId}::uuid FOR UPDATE`
}
