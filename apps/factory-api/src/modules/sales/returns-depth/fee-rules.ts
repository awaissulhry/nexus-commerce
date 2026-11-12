import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { SALES_SETTINGS_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { feeRuleProblems, type FeeKind, type FeeRuleDraft, type PolicyChannel } from '@nexus/factory-domain/sales/returns-depth/rules'
import { SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import { RETURN_REASON_LIST } from '@nexus/factory-domain/sales/returns/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { reasonWords } from '../../../platform/reasons/service'
import { mayWrite } from '../../product/materials/store'
import { officeOf } from '../returns/access'
import { decimalText, FEE_RULE_COLUMNS, FEE_RULE_RECORD, feeRuleUse, feeRuleView, readFeeRules, type FeeRuleRow, type FeeRuleView } from './store'

/**
 * Restocking and handling fee rules (B-W2b-341; SAL-343; design sales.settings ssettings.returns "Handling fee rules
 * (dropped when the cause is ours)"): per company, for a group of the RETURN reason codes (none: every reason) and a
 * channel (none: both), a percent of the credit or a fixed amount per line (the price grain). The first active rule that
 * matches a decided line gives its fee (./fees.ts, read by the decision). A rule a line names keeps its terms: switch it
 * off and make another. Kept with the sales settings' permission over the company.
 *
 *   GET   /sales/returns/fee-rules?companyId   (sales.returns.view) the rules in their order; a fixed amount only with
 *                                              the price grain
 *   POST  /sales/returns/fee-rules             (sales.settings.manage; an amount needs the price grain) a new rule
 *   PATCH /sales/returns/fee-rules/:ruleId     (sales.settings.manage) its name, order and switch; its terms while no
 *                                              line names it
 */

function refuse(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: problem.path.startsWith('body') ? problem.path : `body/${problem.path}` })))
}

/** GET /sales/returns/fee-rules */
export async function listFeeRules(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if (query.companyId !== undefined) {
    const company = isUuid(query.companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: query.companyId! }, select: { id: true } })) : null
    if (!company || !can(actor, SALES_RETURNS_VIEW, { companyId: company.id })) throw new NotFoundError('Company not found.')
  }
  return caller.withClient(async (client) => {
    const rows = await readFeeRules(client, { AND: [scopeWhere(actor, SALES_RETURNS_VIEW, { company: 'companyId' }), query.companyId ? { companyId: query.companyId } : {}] })
    const used = await feeRuleUse(client, rows.map((row) => row.id))
    const reasons = await reasonWords(client, RETURN_REASON_LIST)
    return {
      rules: rows.map((row) => ({ ...feeRuleView(row, used.get(row.id) ?? 0, reasons), canManage: mayWrite(actor, SALES_SETTINGS_MANAGE, row.companyId) })),
      canManage: query.companyId ? mayWrite(actor, SALES_SETTINGS_MANAGE, query.companyId) : false,
    }
  })
}

export interface FeeRuleBody {
  readonly companyId: string
  readonly channel?: PolicyChannel | null | undefined
  readonly name: string
  readonly reasonCodes?: readonly string[] | undefined
  readonly kind: FeeKind
  readonly percent?: string | null | undefined
  /** AMOUNT: minor units (price grain). */
  readonly amount?: number | null | undefined
  readonly currency?: string | null | undefined
  readonly sequence?: number | undefined
  readonly active?: boolean | undefined
}

/** The rule's reason codes are codes of the RETURN list (an inactive one stays named: it is history). */
async function reasonProblems(tools: Pick<CommandTools, 'tx'>, codes: readonly string[], before: readonly string[] = []): Promise<Issue[]> {
  const words = await reasonWords(tools.tx, RETURN_REASON_LIST)
  return codes.flatMap((code, index) => {
    const known = words.get(code)
    if (!known) return [{ path: `reasonCodes/${index}`, message: `${code} is not a reason of the return list.` }]
    if (!known.active && !before.includes(code)) return [{ path: `reasonCodes/${index}`, message: `${known.labelEn} is switched off in the return reasons.` }]
    return []
  })
}

const draftOf = (row: Pick<FeeRuleRow, 'channel' | 'name' | 'reasonCodes' | 'kind' | 'percent' | 'amount' | 'currency' | 'sequence'>): FeeRuleDraft => ({
  channel: row.channel as PolicyChannel | null,
  name: row.name,
  reasonCodes: [...row.reasonCodes],
  kind: row.kind as FeeKind,
  percent: decimalText(row.percent),
  amount: row.amount,
  currency: row.currency,
  sequence: row.sequence,
})

const audited = (draft: FeeRuleDraft, active: boolean) => ({ ...draft, reasonCodes: [...draft.reasonCodes], amount: markMoney('price', draft.amount), active })

const viewOf = async (tools: Pick<CommandTools, 'tx'>, ruleId: string): Promise<FeeRuleView> => {
  const row = (await tools.tx.returnFeeRule.findUnique({ where: { id: ruleId }, select: FEE_RULE_COLUMNS }))!
  return feeRuleView(row, (await feeRuleUse(tools.tx, [row.id])).get(row.id) ?? 0, await reasonWords(tools.tx, RETURN_REASON_LIST))
}

/** POST /sales/returns/fee-rules */
export async function createFeeRule(caller: CommandCaller, body: FeeRuleBody, idempotencyKey?: string): Promise<{ rule: FeeRuleView }> {
  const context = officeOf(caller)
  const company = isUuid(body.companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: body.companyId }, select: { id: true } })) : null
  if (!company) throw new NotFoundError('Company not found.')
  if (!mayWrite(actorOf(context), SALES_SETTINGS_MANAGE, company.id)) throw new ForbiddenError()
  const { result } = await command(caller, { name: 'returnsDepth.createFeeRule', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const draft: FeeRuleDraft = {
      channel: body.channel ?? null,
      name: (body.name ?? '').trim(),
      reasonCodes: [...(body.reasonCodes ?? [])],
      kind: body.kind,
      percent: body.percent ?? null,
      amount: body.amount ?? null,
      currency: body.currency ?? null,
      sequence: body.sequence ?? 100,
    }
    const problems = [...feeRuleProblems(draft), ...(await reasonProblems(tools, draft.reasonCodes))]
    if (problems.length > 0) refuse(problems, 'The fee rule is not valid.')
    const id = newId()
    const active = body.active ?? true
    await tx.returnFeeRule.create({
      data: { id, companyId: company.id, channel: draft.channel, name: draft.name, reasonCodes: [...draft.reasonCodes], kind: draft.kind, percent: draft.percent, amount: draft.amount, currency: draft.currency, sequence: draft.sequence, active, createdAt: now, updatedAt: now, createdById: context.actorId, updatedById: context.actorId },
      select: { id: true },
    })
    tools.audit({ recordType: FEE_RULE_RECORD, recordId: id, companyId: company.id, after: audited(draft, active) })
    tools.emit({ type: 'return_fee_rule.changed', subject: id, companyId: company.id, payload: { ruleId: id, companyId: company.id, change: 'CREATED', active, fields: [] } })
    return { rule: await viewOf(tools, id) }
  })
  return result
}

export interface FeeRuleChange extends Partial<Omit<FeeRuleBody, 'companyId'>> {
  readonly version: number
}

const TERMS = ['channel', 'reasonCodes', 'kind', 'percent', 'amount', 'currency'] as const

/** PATCH /sales/returns/fee-rules/:ruleId */
export async function changeFeeRule(caller: CommandCaller, ruleId: string, body: FeeRuleChange, idempotencyKey?: string): Promise<{ rule: FeeRuleView }> {
  const context = officeOf(caller)
  const seen = isUuid(ruleId) ? await caller.withClient((client) => client.returnFeeRule.findUnique({ where: { id: ruleId }, select: { id: true, companyId: true } })) : null
  if (!seen || !can(actorOf(context), SALES_RETURNS_VIEW, { companyId: seen.companyId })) throw new NotFoundError('Fee rule not found.')
  if (!mayWrite(actorOf(context), SALES_SETTINGS_MANAGE, seen.companyId)) throw new ForbiddenError()
  const { result } = await command(caller, { name: 'returnsDepth.changeFeeRule', idempotencyKey, input: { ruleId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ReturnFeeRule" WHERE "id" = ${seen.id}::uuid FOR UPDATE`
    if (!locked) throw new NotFoundError('Fee rule not found.')
    const row = (await tx.returnFeeRule.findUnique({ where: { id: seen.id }, select: FEE_RULE_COLUMNS }))!
    if (row.version !== body.version) throw new StaleVersionError('ReturnFeeRule', row.id, row.version, body.version)
    const before = draftOf(row)
    const kind = body.kind ?? before.kind
    const kindChanged = kind !== before.kind
    const after: FeeRuleDraft = {
      channel: body.channel !== undefined ? body.channel : before.channel,
      name: body.name !== undefined ? body.name.trim() : before.name,
      reasonCodes: body.reasonCodes !== undefined ? [...body.reasonCodes] : before.reasonCodes,
      kind,
      // A change of kind drops the other kind's terms.
      percent: body.percent !== undefined ? body.percent : kindChanged ? null : before.percent,
      amount: body.amount !== undefined ? body.amount : kindChanged ? null : before.amount,
      currency: body.currency !== undefined ? body.currency : kindChanged ? null : before.currency,
      sequence: body.sequence ?? before.sequence,
    }
    const active = body.active ?? row.active
    const problems = [...feeRuleProblems(after), ...(await reasonProblems(tools, after.reasonCodes, before.reasonCodes))]
    if (problems.length > 0) refuse(problems, 'The fee rule is not valid.')
    const same = (field: keyof FeeRuleDraft) => JSON.stringify(before[field]) === JSON.stringify(after[field])
    const fields = (['name', 'sequence', ...TERMS] as const).filter((field) => !same(field))
    const terms = fields.filter((field) => (TERMS as readonly string[]).includes(field))
    if (terms.length > 0 && ((await feeRuleUse(tx, [row.id])).get(row.id) ?? 0) > 0) {
      throw new DomainError('conflict', `Fee rule "${row.name}" gave fees on return lines: its terms stay as they were. Switch it off and make another.`, terms.map((field) => ({ path: `body/${field}`, message: 'Used on return lines: make another rule.' })))
    }
    const switched = active !== row.active
    if (fields.length > 0 || switched) {
      await tx.returnFeeRule.update({
        where: { id: row.id },
        data: { channel: after.channel, name: after.name, reasonCodes: [...after.reasonCodes], kind: after.kind, percent: after.percent, amount: after.amount, currency: after.currency, sequence: after.sequence, active, updatedById: context.actorId, updatedAt: now, version: { increment: 1 } },
        select: { id: true },
      })
      tools.audit({ recordType: FEE_RULE_RECORD, recordId: row.id, companyId: row.companyId, before: audited(before, row.active), after: audited(after, active) })
      const change = fields.length > 0 ? 'CHANGED' : active ? 'SWITCHED_ON' : 'SWITCHED_OFF'
      tools.emit({ type: 'return_fee_rule.changed', subject: row.id, companyId: row.companyId, payload: { ruleId: row.id, companyId: row.companyId, change, active, fields: [...fields, ...(switched ? ['active'] : [])] } })
    }
    return { rule: await viewOf(tools, row.id) }
  })
  return result
}
