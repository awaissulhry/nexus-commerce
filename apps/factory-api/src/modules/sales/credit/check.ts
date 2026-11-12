import { chooseRules } from '@nexus/factory-domain/approvals/rules'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { markMoney } from '@nexus/factory-domain/money/marked'
import {
  checkWords,
  creditFacts,
  CREDIT_OVERRIDE_FIELDS,
  creditResult,
  exposureOf,
  findingsOf,
  heldWords,
  HOLDING_STEPS,
  OVERRIDE_CHANGES,
  type CreditFinding,
  type CreditReading,
  type CreditResult,
  type CreditStep,
} from '@nexus/factory-domain/sales/credit/credit'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { askApproval, withdrawPending } from '../../../platform/approvals/engine'
import { readCredit, type Reader } from './reading'

/**
 * The credit check of a step (B-W2b-304; SAL-148, SAL-237, SAL-241, SAL-244), inside the step's own command: ONE
 * CreditCheck row with what it saw (factory-db, append-only), its result and words, the audit row and
 * credit_check.recorded. No limit set: no check, no row (as before).
 *
 *   planCredit(db, …)                 the reading and the result; HOLD only at a step that may hold and only when a
 *                                     CREDIT_OVERRIDE approval rule of the company (switched on, in force) holds on the
 *                                     check's facts — the company's "hold or warn" (factory-domain sales/credit)
 *   writeCheck(tools, plan, record)   the row (an override names the HOLD and the approved request)
 *   askOverride(tools, checkId, …)    the CREDIT_OVERRIDE request for a yes about a HOLD check (platform/approvals)
 *
 *   quoteCreditInCommand              the quote being sent: PASS or WARN (a quote never holds)
 *   planOrderCredit / recordOrderCredit
 *                                     an order being made (typed, from an accepted quote, a portal request, the API): the
 *                                     plan BEFORE the order row (a HOLD makes it PENDING_APPROVAL: nothing moves into that
 *                                     state later), the row and the request after it
 *   creditGateInCommand               a work order's release, a shipment leaving: PASS/WARN written and the step goes
 *                                     on; a HOLD stops the step with 409 in words (CreditHeldError) and is written after
 *                                     the rollback by withCreditHolds (with its request), as compliance gates write
 *                                     their refusals; a HOLD already waiting for a yes stops it without a new row; an
 *                                     override of the last HOLD lets it through
 */

export interface CreditPlan {
  readonly step: CreditStep
  readonly partyId: string
  readonly companyId: string
  readonly customerCode: string
  readonly reading: CreditReading
  readonly findings: readonly CreditFinding[]
  readonly result: CreditResult
  readonly words: string
  /** The rule that would decide a yes (null: none matched, or every matching one names the person asking). */
  readonly approver: { readonly ruleId: string; readonly roleId: string | null; readonly userId: string | null } | null
}

export interface PlanInput {
  readonly step: CreditStep
  readonly partyId: string
  readonly companyId: string
  /** The amount checked when it is not counted yet, in its currency (counted only in the limit's currency). */
  readonly subject?: { readonly amount: number; readonly currency: string } | null
  readonly exclude?: readonly string[]
  readonly now: Date
  /** The people asking (the person acting): a rule naming one of them never decides. */
  readonly askers: readonly string[]
}

/** The credit rules of the company (kind CREDIT_OVERRIDE) that are switched on: the ones a check may hold by. */
async function overrideRules(db: Reader, companyId: string) {
  return db.approvalRule.findMany({
    where: { kind: 'CREDIT_OVERRIDE', active: true, OR: [{ companyId: null }, { companyId }] },
    select: { id: true, companyId: true, sequence: true, createdAt: true, active: true, effectiveFrom: true, condition: true, approverRoleId: true, approverUserId: true },
  })
}

/** The check a step would write now, or null when the customer has no limit with the company (no check). */
export async function planCredit(db: Reader, input: PlanInput): Promise<CreditPlan | null> {
  const probe = await readCredit(db, { partyId: input.partyId, companyId: input.companyId, exclude: input.exclude ?? [], now: input.now })
  if (!probe) return null
  const subject = input.subject && input.subject.currency === probe.currency ? input.subject.amount : 0
  const reading: CreditReading = { currency: probe.currency, openOrders: probe.openOrders, openInvoices: probe.openInvoices, overdue: probe.overdue, subject, limit: probe.limit, onHold: probe.onHold }
  const party = await db.party.findUnique({ where: { id: input.partyId }, select: { code: true } })
  const customerCode = party?.code ?? ''
  const findings = findingsOf(reading)
  let rulesHold = false
  let approver: CreditPlan['approver'] = null
  if (findings.length > 0 && HOLDING_STEPS.includes(input.step)) {
    const choice = chooseRules(await overrideRules(db, input.companyId), { companyId: input.companyId, facts: creditFacts(reading, input.step, customerCode), askers: input.askers }, CREDIT_OVERRIDE_FIELDS, input.now)
    rulesHold = choice.matched.length > 0
    approver = choice.deciding ? { ruleId: choice.deciding.id, roleId: choice.deciding.approverRoleId, userId: choice.deciding.approverUserId } : null
  }
  const result = creditResult(reading, input.step, rulesHold)
  return { step: input.step, partyId: input.partyId, companyId: input.companyId, customerCode, reading, findings, result, words: checkWords(findings, result), approver }
}

export interface CheckRecord {
  readonly recordType: string
  readonly recordId: string
}

const writerOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/**
 * When the check happened: the command's time, unless that clock runs more than a minute ahead of the database's (a
 * command on an app clock a test moves on: the …_guards refuse a check "in the future"), then the database's. An override
 * keeps the command's time: it must not be before the yes its command wrote.
 */
async function checkedAtOf(tools: CommandTools, override: boolean): Promise<Date> {
  if (override) return tools.now
  const [row] = await tools.tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`
  return row && tools.now.getTime() > row.now.getTime() + 60_000 ? row.now : tools.now
}

/** Writes one CreditCheck (the step's, or an override's), its audit row and credit_check.recorded; the row's id. */
export async function writeCheck(tools: CommandTools, plan: CreditPlan, record: CheckRecord, override: { readonly checkId: string; readonly taskId: string } | null = null): Promise<string> {
  const id = newId()
  const { reading } = plan
  const exposure = exposureOf(reading)
  const words = override ? checkWords(plan.findings, plan.result, 'en', true) : plan.words
  const checkedAt = await checkedAtOf(tools, override !== null)
  await tools.tx.creditCheck.create({
    data: {
      id,
      companyId: plan.companyId,
      partyId: plan.partyId,
      step: plan.step,
      recordType: record.recordType,
      recordId: record.recordId,
      currency: reading.currency,
      openOrdersAmount: reading.openOrders,
      openInvoicesAmount: reading.openInvoices,
      overdueAmount: reading.overdue,
      subjectAmount: reading.subject,
      exposureAmount: exposure,
      limitAmount: reading.limit,
      onHold: reading.onHold,
      result: plan.result,
      words,
      overridesCheckId: override?.checkId ?? null,
      overrideTaskId: override?.taskId ?? null,
      checkedAt,
      requestId: tools.context.requestId,
      createdAt: tools.now,
      createdById: writerOf(tools),
    },
    select: { id: true },
  })
  tools.audit({
    action: override ? 'credit.override' : 'credit.check',
    recordType: record.recordType,
    recordId: record.recordId,
    companyId: plan.companyId,
    after: {
      creditCheckId: id,
      partyId: plan.partyId,
      step: plan.step,
      result: plan.result,
      findings: [...plan.findings],
      currency: reading.currency,
      openOrders: markMoney('price', reading.openOrders),
      openInvoices: markMoney('price', reading.openInvoices),
      overdue: markMoney('price', reading.overdue),
      subject: markMoney('price', reading.subject),
      exposure: markMoney('price', exposure),
      limit: markMoney('price', reading.limit),
      onHold: reading.onHold,
      overridesCheckId: override?.checkId ?? null,
      overrideTaskId: override?.taskId ?? null,
    },
  })
  tools.emit({
    type: 'credit_check.recorded',
    subject: id,
    companyId: plan.companyId,
    payload: { checkId: id, partyId: plan.partyId, step: plan.step, recordType: record.recordType, recordId: record.recordId, result: plan.result, overridesCheckId: override?.checkId ?? null },
  })
  return id
}

export type AskOutcome = { readonly asked: true; readonly taskId: string } | { readonly asked: false; readonly why: 'NO_RULE' | 'NO_APPROVER' | 'NO_REQUESTER' }

/**
 * The CREDIT_OVERRIDE request for a yes about a HOLD check, asked by `requesterId` (the person whose step was held) and
 * written by the person acting. No rule switched on any more, or every matching rule names a person asking: nothing asked
 * (the hold stays; another person may ask).
 */
export async function askOverride(tools: CommandTools, checkId: string, requesterId: string | null, plan: Pick<CreditPlan, 'approver'>, note: string | null = null): Promise<AskOutcome> {
  if (requesterId === null) return { asked: false, why: 'NO_REQUESTER' }
  if (plan.approver === null) return { asked: false, why: 'NO_APPROVER' }
  const outcome = await askApproval(tools, { kind: 'CREDIT_OVERRIDE', recordId: checkId, requester: { userId: requesterId }, note, changes: OVERRIDE_CHANGES })
  return outcome.asked ? { asked: true, taskId: outcome.taskId } : { asked: false, why: 'NO_RULE' }
}

const actorOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

// ---- the quote ------------------------------------------------------------------------------------------------------------

/** The quote being sent (SAL-148): one check of its version (PASS or WARN: a quote never holds); null without a limit. */
export async function quoteCreditInCommand(tools: CommandTools, versionId: string): Promise<string | null> {
  const version = await tools.tx.quoteVersion.findUnique({ where: { id: versionId }, select: { id: true, partyId: true, grossAmount: true, currency: true, quote: { select: { companyId: true } } } })
  if (!version) return null
  const plan = await planCredit(tools.tx, { step: 'QUOTE', partyId: version.partyId, companyId: version.quote.companyId, subject: { amount: version.grossAmount, currency: version.currency }, now: tools.now, askers: [] })
  return plan ? writeCheck(tools, plan, { recordType: 'QuoteVersion', recordId: version.id }) : null
}

// ---- an order being made --------------------------------------------------------------------------------------------------

export type OrderStep = Extract<CreditStep, 'ORDER' | 'PORTAL' | 'API'>

/** The check of an order being made, BEFORE its row: `status` is what the order is made with. */
export async function planOrderCredit(tools: CommandTools, input: { readonly step: OrderStep; readonly partyId: string; readonly companyId: string; readonly grossAmount: number; readonly currency: string }): Promise<{ plan: CreditPlan | null; status: 'CONFIRMED' | 'PENDING_APPROVAL' }> {
  const actor = actorOf(tools)
  const plan = await planCredit(tools.tx, { step: input.step, partyId: input.partyId, companyId: input.companyId, subject: { amount: input.grossAmount, currency: input.currency }, now: tools.now, askers: actor ? [actor] : [] })
  return { plan, status: plan?.result === 'HOLD' ? 'PENDING_APPROVAL' : 'CONFIRMED' }
}

/** After the order row: the check (and on a HOLD the request for a yes, asked by the person making it). */
export async function recordOrderCredit(tools: CommandTools, plan: CreditPlan | null, orderId: string, requesterId: string | null = actorOf(tools)): Promise<{ checkId: string; result: CreditResult; ask: AskOutcome | null } | null> {
  if (!plan) return null
  const checkId = await writeCheck(tools, plan, { recordType: 'SalesOrder', recordId: orderId })
  const ask = plan.result === 'HOLD' ? await askOverride(tools, checkId, requesterId, plan) : null
  return { checkId, result: plan.result, ask }
}

// ---- a release, a shipment: the gate ---------------------------------------------------------------------------------------

/** A HOLD found in a step's command, written (with its request) after the step rolled back. */
export interface PendingHold {
  readonly plan: CreditPlan
  readonly record: CheckRecord
}

/** The step held for credit: 409 in words; `creditHolds` are written after the rollback (withCreditHolds). */
export class CreditHeldError extends DomainError {
  override name = 'CreditHeldError'
  constructor(
    message: string,
    readonly creditHolds: readonly PendingHold[],
  ) {
    super('conflict', message, [{ path: 'credit', message }])
  }
}

/** The newest check of a record at a step for a customer, and whether a yes is asked on it. */
export async function newestCheck(db: Reader, input: { readonly step: CreditStep; readonly recordType: string; readonly recordId: string; readonly partyId?: string }) {
  const check = await db.creditCheck.findFirst({
    where: { step: input.step, recordType: input.recordType, recordId: input.recordId, ...(input.partyId ? { partyId: input.partyId } : {}) },
    orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, partyId: true, companyId: true, result: true, overridesCheckId: true, checkedAt: true, words: true },
  })
  if (!check) return null
  const pending = check.result === 'HOLD' && check.overridesCheckId === null ? await db.approvalTask.findFirst({ where: { kind: 'CREDIT_OVERRIDE', recordType: 'CreditCheck', recordId: check.id, status: 'PENDING' }, select: { id: true } }) : null
  return { ...check, held: check.result === 'HOLD' && check.overridesCheckId === null, pendingTaskId: pending?.id ?? null }
}

export interface GateInput {
  readonly step: Extract<CreditStep, 'RELEASE' | 'SHIPMENT'>
  readonly recordType: 'WorkOrder' | 'Shipment'
  readonly recordId: string
  /** The record in words ("Work order WO-0012", "Shipment SH-0004"). */
  readonly label: string
  readonly companyId: string
  /** The customers whose orders the record makes or ships. */
  readonly partyIds: readonly string[]
}

/** The gate of a release or a shipment, inside its command (see the file's head). */
export async function creditGateInCommand(tools: CommandTools, input: GateInput): Promise<void> {
  const actor = actorOf(tools)
  const pending: PendingHold[] = []
  const waiting: string[] = []
  for (const partyId of [...new Set(input.partyIds)].sort()) {
    const plan = await planCredit(tools.tx, { step: input.step, partyId, companyId: input.companyId, now: tools.now, askers: actor ? [actor] : [] })
    // No limit (any more): no check, as before.
    if (!plan) continue
    const last = await newestCheck(tools.tx, { step: input.step, recordType: input.recordType, recordId: input.recordId, partyId })
    // A yes given on the last HOLD of this record lets it through.
    if (last?.overridesCheckId) continue
    if (plan.result !== 'HOLD') {
      await writeCheck(tools, plan, { recordType: input.recordType, recordId: input.recordId })
      // The customer paid, or the limit was raised: the yes asked on the last HOLD is no longer needed.
      if (last?.held && last.pendingTaskId) await withdrawPending(tools, { kind: 'CREDIT_OVERRIDE', recordId: last.id, byId: actor, words: 'Checked again: within what the company lets through.' })
      continue
    }
    // A HOLD already waiting for a yes stops it again, without a new row.
    if (last?.held && last.pendingTaskId) {
      waiting.push(heldWords(input.label, plan.findings, 'ASKED'))
      continue
    }
    pending.push({ plan, record: { recordType: input.recordType, recordId: input.recordId } })
  }
  if (pending.length === 0 && waiting.length === 0) return
  const words = [...pending.map((hold) => heldWords(input.label, hold.plan.findings, hold.plan.approver && actor ? 'ASKED' : 'TO_ASK')), ...waiting]
  throw new CreditHeldError([...new Set(words)].join(' '), pending)
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

/**
 * Runs a step that may be held for credit: the HOLDs its CreditHeldError carries are written after it rolled back, in
 * one command as the person (each with its request for a yes), then the error goes on unchanged. A resent step (its
 * Idempotency-Key) writes them once. A HOLD that is already written and waiting meanwhile is not written twice.
 */
export async function withCreditHolds<T>(caller: CommandCaller, idempotencyKey: string | null | undefined, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const holds = error instanceof CreditHeldError ? error.creditHolds : []
    if (holds.length > 0) await recordHolds(caller, holds, idempotencyKey)
    throw error
  }
}

/** Writes the HOLDs of a held step (each with its request), one command as the person; never throws (a failure is logged). */
async function recordHolds(caller: CommandCaller, holds: readonly PendingHold[], idempotencyKey: string | null | undefined): Promise<void> {
  const derived = idempotencyKey ? `credit:${idempotencyKey}`.slice(0, 128) : null
  try {
    await command(caller, { name: 'credit.recordHold', idempotencyKey: derived && KEY.test(derived) ? derived : null, input: holds.map((hold) => ({ step: hold.plan.step, partyId: hold.plan.partyId, ...hold.record })) }, async (tools) => {
      let written = 0
      for (const hold of holds) {
        const last = await newestCheck(tools.tx, { step: hold.plan.step, recordType: hold.record.recordType, recordId: hold.record.recordId, partyId: hold.plan.partyId })
        if (last?.held && last.pendingTaskId) continue
        const checkId = await writeCheck(tools, hold.plan, hold.record)
        await askOverride(tools, checkId, actorOf(tools), hold.plan)
        written++
      }
      if (written === 0) tools.audit({ action: 'credit.check', recordType: holds[0]!.record.recordType, recordId: holds[0]!.record.recordId, companyId: holds[0]!.plan.companyId, after: { skipped: true, reason: 'a HOLD of this record waits for a yes already' } })
      return { written }
    })
  } catch (error) {
    ;(caller as { log?: { warn?: (object: unknown, message: string) => void } }).log?.warn?.({ err: error }, 'credit: a hold could not be recorded')
  }
}
