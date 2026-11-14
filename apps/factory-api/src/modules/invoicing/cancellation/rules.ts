import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { DEPOSIT_CANCELLATION_RULE, ruleProblems, type CancellationDepositKind, type CancellationDocument, type CancelledBy, type RefundRule, type RuleFacts } from '@nexus/factory-domain/invoicing/cancellation/cancellation'
import { INVOICES_DEPOSIT_RULES_MANAGE } from '@nexus/factory-domain/invoicing/cancellation/permissions'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf, type Reader } from '../store'
import { assertCompany, refusingInWords } from '../tax-codes/store'

/**
 * The company's rules for the deposit when an order is cancelled (B-W2b-396; FIN-080; design finance.settings "Deposits":
 * refund on cancellation): the list (invoices.view), a new rule, a change of what it keeps, pays back or documents, and
 * archive (invoices.depositRules.manage over the company). Each write is ONE command on the rule (its version guards it),
 * audited, with deposit_cancellation_rule.changed. A rule's company, deposit kind, side and order type never change
 * (archive it and make another); one ACTIVE rule per company, kind, side and order type (the database's partial unique,
 * answered 409 in words). No rule is made by itself: without one, everything is paid back (GATE-ACCOUNTANT).
 */

export const RULE_COLUMNS = { id: true, companyId: true, depositKind: true, cancelledBy: true, madeToMeasure: true, keepPct: true, refundRule: true, documentKind: true, note: true, status: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.DepositCancellationRuleSelect
type RuleRow = Prisma.DepositCancellationRuleGetPayload<{ select: typeof RULE_COLUMNS }>

export const ruleFactsOf = (row: RuleRow): RuleFacts => ({
  id: row.id,
  depositKind: row.depositKind as CancellationDepositKind,
  cancelledBy: row.cancelledBy as CancelledBy,
  madeToMeasure: row.madeToMeasure,
  refundRule: row.refundRule as RefundRule,
  keepPct: row.keepPct.toFixed(4),
  documentKind: row.documentKind as CancellationDocument,
  note: row.note,
})

const viewOf = (row: RuleRow) => ({
  id: row.id,
  version: row.version,
  companyId: row.companyId,
  depositKind: row.depositKind as CancellationDepositKind,
  cancelledBy: row.cancelledBy as CancelledBy,
  madeToMeasure: row.madeToMeasure,
  refundRule: row.refundRule as RefundRule,
  keepPct: new Dec(row.keepPct.toString()).toString(),
  documentKind: row.documentKind as CancellationDocument,
  note: row.note,
  status: row.status as 'ACTIVE' | 'ARCHIVED',
  createdAt: toUtcIso(row.createdAt),
  updatedAt: toUtcIso(row.updatedAt),
})

/** The company's ACTIVE rules, as the outcome reads them. */
export async function activeRules(db: Reader, companyId: string): Promise<RuleFacts[]> {
  return (await db.depositCancellationRule.findMany({ where: { companyId, status: 'ACTIVE' }, select: RULE_COLUMNS })).map(ruleFactsOf)
}

const isOneActive = (error: unknown): boolean => {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  return (cause?.originalCode === '23505' && /DepositCancellationRule_one_active/.test(String(cause.originalMessage ?? ''))) || (error as { code?: unknown } | null)?.code === 'P2002'
}
const oneActive = () => new ConflictError('The company has an active rule for this deposit, side and kind of order already: change that one, or archive it first.')

/** GET /invoicing/deposit-rules (invoices.view over the company). */
export async function listRules(caller: CommandCaller, query: { companyId: string; status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | undefined }) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_VIEW, INVOICES_VIEW, { companyId: query.companyId }, 'Company')
  const rows = await caller.withClient((client) =>
    client.depositCancellationRule.findMany({ where: { companyId: query.companyId, ...(query.status === 'ALL' ? {} : { status: query.status ?? 'ACTIVE' }) }, select: RULE_COLUMNS, orderBy: [{ depositKind: 'asc' }, { cancelledBy: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] }),
  )
  return {
    companyId: query.companyId,
    rules: rows.map(viewOf),
    rule: { status: DEPOSIT_CANCELLATION_RULE.status, words: DEPOSIT_CANCELLATION_RULE.words },
    mayManage: can(actorOf(context), INVOICES_DEPOSIT_RULES_MANAGE, { companyId: query.companyId }),
  }
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

function checked(input: Parameters<typeof ruleProblems>[0]) {
  const issues = ruleProblems(input)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  return { ...input, keepPct: new Dec(input.keepPct).toFixed(4) }
}

/** POST /invoicing/deposit-rules (invoices.depositRules.manage over the company). */
export async function createRule(
  caller: CommandCaller,
  body: { companyId: string; depositKind: CancellationDepositKind; cancelledBy: CancelledBy; madeToMeasure: boolean | null; refundRule: RefundRule; keepPct?: string | undefined; documentKind: CancellationDocument; note?: string | null | undefined },
  idempotencyKey?: string,
) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_VIEW, INVOICES_DEPOSIT_RULES_MANAGE, { companyId: body.companyId }, 'Company')
  const fields = checked({ depositKind: body.depositKind, cancelledBy: body.cancelledBy, madeToMeasure: body.madeToMeasure, refundRule: body.refundRule, keepPct: body.keepPct ?? '0', documentKind: body.documentKind, note: blankToNull(body.note) })
  const id = newId()
  const { result } = await refusingInWords(() =>
    command(caller, { name: 'invoices.createDepositRule', idempotencyKey, input: body }, async (tools) => {
      if (!(await tools.tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
      const clash = await tools.tx.depositCancellationRule.findFirst({ where: { companyId: body.companyId, depositKind: fields.depositKind, cancelledBy: fields.cancelledBy, madeToMeasure: fields.madeToMeasure, status: 'ACTIVE' }, select: { id: true } })
      if (clash) throw oneActive()
      const row = await tools.tx.depositCancellationRule.create({ data: { id, companyId: body.companyId, ...fields, createdById: context.actorId }, select: RULE_COLUMNS })
      tools.audit({ action: 'invoices.createDepositRule', recordType: 'DepositCancellationRule', recordId: id, companyId: body.companyId, after: { ...fields } })
      tools.emit({ type: 'deposit_cancellation_rule.changed', subject: id, companyId: body.companyId, payload: { ruleId: id, companyId: body.companyId, action: 'CREATED' } })
      return { rule: viewOf(row) }
    }).catch((error: unknown) => {
      if (isOneActive(error)) throw oneActive()
      throw error
    }),
  )
  return result
}

async function officeRule(caller: CommandCaller, ruleId: string): Promise<RuleRow> {
  const context = officeContextOf(caller)
  const row = isUuid(ruleId) ? await caller.withClient((client) => client.depositCancellationRule.findUnique({ where: { id: ruleId }, select: RULE_COLUMNS })) : null
  assertCompany(context, INVOICES_VIEW, INVOICES_DEPOSIT_RULES_MANAGE, row ? { companyId: row.companyId } : null, 'Deposit rule')
  return row!
}

/** PATCH /invoicing/deposit-rules/:ruleId (invoices.depositRules.manage): what it keeps, pays back, documents, its note. */
export async function updateRule(caller: CommandCaller, ruleId: string, body: { version: number; refundRule?: RefundRule | undefined; keepPct?: string | undefined; documentKind?: CancellationDocument | undefined; note?: string | null | undefined }, idempotencyKey?: string) {
  const seen = await officeRule(caller, ruleId)
  const { result } = await refusingInWords(() =>
    command(caller, { name: 'invoices.updateDepositRule', idempotencyKey, input: { ruleId, ...body }, record: { type: 'DepositCancellationRule', id: ruleId, expectedVersion: body.version } }, async (tools) => {
      const row = (await tools.tx.depositCancellationRule.findUnique({ where: { id: ruleId }, select: RULE_COLUMNS }))!
      if (row.status !== 'ACTIVE') throw new InvalidStateError('This rule is archived: make a new one instead.')
      const before = ruleFactsOf(row)
      const next = checked({
        ...before,
        refundRule: body.refundRule ?? before.refundRule,
        keepPct: body.keepPct ?? (body.refundRule && body.refundRule !== 'KEEP_PERCENT' ? '0' : before.keepPct),
        documentKind: body.documentKind ?? before.documentKind,
        note: body.note === undefined ? before.note : blankToNull(body.note),
      })
      const updated = await tools.tx.depositCancellationRule.update({ where: { id: ruleId }, data: { refundRule: next.refundRule, keepPct: next.keepPct, documentKind: next.documentKind, note: next.note, updatedAt: tools.now }, select: RULE_COLUMNS })
      tools.audit({ action: 'invoices.updateDepositRule', recordType: 'DepositCancellationRule', recordId: ruleId, companyId: seen.companyId, before: { refundRule: before.refundRule, keepPct: before.keepPct, documentKind: before.documentKind, note: before.note }, after: { refundRule: next.refundRule, keepPct: next.keepPct, documentKind: next.documentKind, note: next.note } })
      tools.emit({ type: 'deposit_cancellation_rule.changed', subject: ruleId, companyId: seen.companyId, payload: { ruleId, companyId: seen.companyId, action: 'EDITED' } })
      return { rule: viewOf(updated) }
    }),
  )
  return result
}

/** POST /invoicing/deposit-rules/:ruleId/archive (invoices.depositRules.manage). */
export async function archiveRule(caller: CommandCaller, ruleId: string, body: { version: number }, idempotencyKey?: string) {
  const seen = await officeRule(caller, ruleId)
  const { result } = await refusingInWords(() =>
    command(caller, { name: 'invoices.archiveDepositRule', idempotencyKey, input: { ruleId, ...body }, record: { type: 'DepositCancellationRule', id: ruleId, expectedVersion: body.version } }, async (tools) => {
      const row = (await tools.tx.depositCancellationRule.findUnique({ where: { id: ruleId }, select: RULE_COLUMNS }))!
      if (row.status !== 'ACTIVE') throw new InvalidStateError('This rule is archived already.')
      const updated = await tools.tx.depositCancellationRule.update({ where: { id: ruleId }, data: { status: 'ARCHIVED', updatedAt: tools.now }, select: RULE_COLUMNS })
      tools.audit({ action: 'invoices.archiveDepositRule', recordType: 'DepositCancellationRule', recordId: ruleId, companyId: seen.companyId, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } })
      tools.emit({ type: 'deposit_cancellation_rule.changed', subject: ruleId, companyId: seen.companyId, payload: { ruleId, companyId: seen.companyId, action: 'ARCHIVED' } })
      return { rule: viewOf(updated) }
    }),
  )
  return result
}
