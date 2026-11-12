import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_SETTINGS_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { POLICY_CHANNELS, policyDraftProblems, type PolicyChannel, type PolicyDraft } from '@nexus/factory-domain/sales/returns-depth/rules'
import { SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import type { FreightPayer } from '@nexus/factory-domain/sales/returns/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { officeOf } from '../returns/access'
import { asDay } from '../returns/store'
import { livePolicyOf, POLICY_COLUMNS, POLICY_RECORD, policyUse, policyView, readPolicies, type PolicyRow, type PolicyView } from './store'

/**
 * The return policies per company and channel (B-W2b-341; SAL-338; design sales.settings ssettings.returns "Return window
 * from delivery, condition rules, freight"): business customers (B2B) and consumers who bought at a distance
 * (CONSUMER_DISTANCE: the right of withdrawal, Codice del Consumo art. 52). One live policy per company and channel; a new
 * one retires the live one in the same command; one an RMA names keeps its terms (its name may still change). Kept with
 * the sales settings' permission over the company, as W2a's return policy (modules/sales/returns/policy.ts), which stays
 * the default where no policy is set.
 *
 *   GET  /sales/returns/policies?companyId&channel&live  (sales.returns.view) the policies, live first; who may change them
 *   POST /sales/returns/policies                         (sales.settings.manage) a new one, today or from an earlier day,
 *                                                        retiring the live one of its company and channel
 *   PATCH /sales/returns/policies/:policyId              (sales.settings.manage) its name; its terms while no RMA names it
 *   POST /sales/returns/policies/:policyId/retire        (sales.settings.manage) retired (no policy for the channel: the
 *                                                        sales settings' return policy applies again)
 */

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

function refuse(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: problem.path.startsWith('body') ? problem.path : `body/${problem.path}` })))
}

async function companyOf(caller: CommandCaller, companyId: string): Promise<{ id: string; code: string }> {
  const company = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true, code: true } })) : null
  if (!company) throw new NotFoundError('Company not found.')
  return company
}

/** GET /sales/returns/policies */
export async function listPolicies(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly channel?: PolicyChannel | undefined; readonly live?: boolean | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if (query.companyId !== undefined) {
    await companyOf(caller, query.companyId)
    if (!can(actor, SALES_RETURNS_VIEW, { companyId: query.companyId })) throw new NotFoundError('Company not found.')
  }
  return caller.withClient(async (client) => {
    const scope = scopeWhere(actor, SALES_RETURNS_VIEW, { company: 'companyId' })
    const rows = await readPolicies(client, { AND: [scope, query.companyId ? { companyId: query.companyId } : {}, query.channel ? { channel: query.channel } : {}, query.live === true ? { retiredAt: null } : query.live === false ? { retiredAt: { not: null } } : {}] })
    const used = await policyUse(client, rows.map((row) => row.id))
    const ordered = [...rows].sort((a, b) => Number(a.retiredAt !== null) - Number(b.retiredAt !== null))
    return {
      policies: ordered.map((row) => ({ ...policyView(row, used.get(row.id) ?? 0), canManage: mayWrite(actor, SALES_SETTINGS_MANAGE, row.companyId) })),
      canManage: query.companyId ? mayWrite(actor, SALES_SETTINGS_MANAGE, query.companyId) : false,
    }
  })
}

export interface NewPolicyBody {
  readonly companyId: string
  readonly channel: PolicyChannel
  readonly name: string
  readonly windowDays: number
  readonly goodsDueDays: number | null
  readonly freightPaidBy: FreightPayer
  readonly conditions?: string | null | undefined
  readonly withdrawalWords?: string | null | undefined
  /** From which day it applies (today or earlier; left out: today). */
  readonly effectiveFrom?: BusinessDate | undefined
}

const draftOf = (body: Omit<NewPolicyBody, 'companyId'>, today: BusinessDate): PolicyDraft => ({
  channel: body.channel,
  name: (body.name ?? '').trim(),
  windowDays: body.windowDays,
  goodsDueDays: body.goodsDueDays,
  freightPaidBy: body.freightPaidBy,
  conditions: blank(body.conditions),
  withdrawalWords: blank(body.withdrawalWords),
  effectiveFrom: body.effectiveFrom ?? today,
})

const audited = (draft: PolicyDraft) => ({ channel: draft.channel, name: draft.name, windowDays: draft.windowDays, goodsDueDays: draft.goodsDueDays, freightPaidBy: draft.freightPaidBy, conditions: draft.conditions, withdrawalWords: draft.withdrawalWords, effectiveFrom: draft.effectiveFrom })

async function policyFor(tools: Pick<CommandTools, 'tx'>, policyId: string): Promise<PolicyRow> {
  const [locked] = await tools.tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ReturnPolicy" WHERE "id" = ${policyId}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Return policy not found.')
  return (await tools.tx.returnPolicy.findUnique({ where: { id: policyId }, select: POLICY_COLUMNS }))!
}

const viewOf = async (tools: Pick<CommandTools, 'tx'>, policyId: string): Promise<PolicyView> => {
  const row = (await tools.tx.returnPolicy.findUnique({ where: { id: policyId }, select: POLICY_COLUMNS }))!
  return policyView(row, (await policyUse(tools.tx, [row.id])).get(row.id) ?? 0)
}

/** POST /sales/returns/policies */
export async function createPolicy(caller: CommandCaller, body: NewPolicyBody, idempotencyKey?: string): Promise<{ policy: PolicyView; retired: { id: string; name: string } | null }> {
  const context = officeOf(caller)
  const company = await companyOf(caller, body.companyId)
  if (!mayWrite(actorOf(context), SALES_SETTINGS_MANAGE, company.id)) throw new ForbiddenError()
  const { result } = await command(caller, { name: 'returnsDepth.createPolicy', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const today = businessDate(now)
    const draft = draftOf(body, today)
    const problems = policyDraftProblems(draft)
    if (draft.effectiveFrom > today) problems.push({ path: 'effectiveFrom', message: 'A new policy applies at once: today or an earlier day (it replaces the live one now).' })
    if (problems.length > 0) refuse(problems, 'The return policy is not valid.')
    // The live policy of the company and channel, locked, then retired before the new one is written (one live policy).
    const [live] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ReturnPolicy" WHERE "companyId" = ${company.id}::uuid AND "channel"::text = ${draft.channel} AND "retiredAt" IS NULL FOR UPDATE`
    const replaced = live ? (await tx.returnPolicy.findUnique({ where: { id: live.id }, select: POLICY_COLUMNS }))! : null
    const id = newId()
    if (replaced) {
      await tx.returnPolicy.update({ where: { id: replaced.id }, data: { retiredAt: now, retiredById: context.actorId, updatedById: context.actorId, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'returnsDepth.retirePolicy', recordType: POLICY_RECORD, recordId: replaced.id, companyId: company.id, before: { retiredAt: null }, after: { retiredAt: now.toISOString(), replacedBy: id }, reason: `Replaced by the new policy "${draft.name}".` })
      tools.emit({ type: 'return_policy.saved', subject: replaced.id, companyId: company.id, payload: { policyId: replaced.id, companyId: company.id, channel: draft.channel, change: 'RETIRED', replacedId: null, fields: ['retiredAt'] } })
    }
    await tx.returnPolicy.create({
      data: { id, companyId: company.id, channel: draft.channel, name: draft.name, windowDays: draft.windowDays, goodsDueDays: draft.goodsDueDays, freightPaidBy: draft.freightPaidBy, conditions: draft.conditions, withdrawalWords: draft.withdrawalWords, effectiveFrom: asDay(draft.effectiveFrom), createdAt: now, updatedAt: now, createdById: context.actorId, updatedById: context.actorId },
      select: { id: true },
    })
    tools.audit({ recordType: POLICY_RECORD, recordId: id, companyId: company.id, after: { ...audited(draft), replacedId: replaced?.id ?? null } })
    tools.emit({ type: 'return_policy.saved', subject: id, companyId: company.id, payload: { policyId: id, companyId: company.id, channel: draft.channel, change: 'CREATED', replacedId: replaced?.id ?? null, fields: [] } })
    return { policy: await viewOf(tools, id), retired: replaced ? { id: replaced.id, name: replaced.name } : null }
  })
  return result
}

export interface PolicyChange extends Partial<Omit<NewPolicyBody, 'companyId' | 'channel'>> {
  readonly version: number
}

const TERMS = ['windowDays', 'goodsDueDays', 'freightPaidBy', 'conditions', 'withdrawalWords', 'effectiveFrom'] as const

/** PATCH /sales/returns/policies/:policyId */
export async function changePolicy(caller: CommandCaller, policyId: string, body: PolicyChange, idempotencyKey?: string): Promise<{ policy: PolicyView }> {
  const context = officeOf(caller)
  const seen = isUuid(policyId) ? await caller.withClient((client) => client.returnPolicy.findUnique({ where: { id: policyId }, select: { id: true, companyId: true } })) : null
  if (!seen || !can(actorOf(context), SALES_RETURNS_VIEW, { companyId: seen.companyId })) throw new NotFoundError('Return policy not found.')
  if (!mayWrite(actorOf(context), SALES_SETTINGS_MANAGE, seen.companyId)) throw new ForbiddenError()
  const { result } = await command(caller, { name: 'returnsDepth.changePolicy', idempotencyKey, input: { policyId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await policyFor(tools, seen.id)
    if (row.version !== body.version) throw new StaleVersionError('ReturnPolicy', row.id, row.version, body.version)
    if (row.retiredAt !== null) throw new InvalidStateError(`Return policy "${row.name}" was retired: make a new one.`)
    const before = draftOf({ channel: row.channel as PolicyChannel, name: row.name, windowDays: row.windowDays, goodsDueDays: row.goodsDueDays, freightPaidBy: row.freightPaidBy as FreightPayer, conditions: row.conditions, withdrawalWords: row.withdrawalWords, effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10) }, businessDate(now))
    const after: PolicyDraft = {
      ...before,
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.windowDays !== undefined ? { windowDays: body.windowDays } : {}),
      ...(body.goodsDueDays !== undefined ? { goodsDueDays: body.goodsDueDays } : {}),
      ...(body.freightPaidBy !== undefined ? { freightPaidBy: body.freightPaidBy } : {}),
      ...(body.conditions !== undefined ? { conditions: blank(body.conditions) } : {}),
      ...(body.withdrawalWords !== undefined ? { withdrawalWords: blank(body.withdrawalWords) } : {}),
      ...(body.effectiveFrom !== undefined ? { effectiveFrom: body.effectiveFrom } : {}),
    }
    const problems = policyDraftProblems(after)
    if (after.effectiveFrom > businessDate(now)) problems.push({ path: 'effectiveFrom', message: 'Today or an earlier day.' })
    if (problems.length > 0) refuse(problems, 'The return policy is not valid.')
    const fields = (['name', ...TERMS] as const).filter((field) => before[field] !== after[field])
    const terms = fields.filter((field) => (TERMS as readonly string[]).includes(field))
    if (terms.length > 0 && ((await policyUse(tx, [row.id])).get(row.id) ?? 0) > 0) {
      throw new DomainError('conflict', `Return policy "${row.name}" is named by returns already: its terms stay as they were agreed. Make a new policy for this channel (it replaces this one).`, terms.map((field) => ({ path: `body/${field}`, message: 'Named by returns: make a new policy.' })))
    }
    if (fields.length > 0) {
      await tx.returnPolicy.update({
        where: { id: row.id },
        data: { name: after.name, windowDays: after.windowDays, goodsDueDays: after.goodsDueDays, freightPaidBy: after.freightPaidBy, conditions: after.conditions, withdrawalWords: after.withdrawalWords, effectiveFrom: asDay(after.effectiveFrom), updatedById: context.actorId, updatedAt: now, version: { increment: 1 } },
        select: { id: true },
      })
      const pick = (draft: PolicyDraft) => Object.fromEntries(fields.map((field) => [field, draft[field]]))
      tools.audit({ recordType: POLICY_RECORD, recordId: row.id, companyId: row.companyId, before: pick(before), after: pick(after) })
      tools.emit({ type: 'return_policy.saved', subject: row.id, companyId: row.companyId, payload: { policyId: row.id, companyId: row.companyId, channel: row.channel as PolicyChannel, change: 'CHANGED', replacedId: null, fields: [...fields] } })
    }
    return { policy: await viewOf(tools, row.id) }
  })
  return result
}

/** POST /sales/returns/policies/:policyId/retire */
export async function retirePolicy(caller: CommandCaller, policyId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<{ policy: PolicyView }> {
  const context = officeOf(caller)
  const seen = isUuid(policyId) ? await caller.withClient((client) => client.returnPolicy.findUnique({ where: { id: policyId }, select: { id: true, companyId: true } })) : null
  if (!seen || !can(actorOf(context), SALES_RETURNS_VIEW, { companyId: seen.companyId })) throw new NotFoundError('Return policy not found.')
  if (!mayWrite(actorOf(context), SALES_SETTINGS_MANAGE, seen.companyId)) throw new ForbiddenError()
  const { result } = await command(caller, { name: 'returnsDepth.retirePolicy', idempotencyKey, input: { policyId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await policyFor(tools, seen.id)
    if (row.version !== body.version) throw new StaleVersionError('ReturnPolicy', row.id, row.version, body.version)
    if (row.retiredAt !== null) throw new InvalidStateError(`Return policy "${row.name}" is retired already.`)
    await tx.returnPolicy.update({ where: { id: row.id }, data: { retiredAt: now, retiredById: context.actorId, updatedById: context.actorId, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: POLICY_RECORD, recordId: row.id, companyId: row.companyId, before: { retiredAt: null }, after: { retiredAt: now.toISOString() } })
    tools.emit({ type: 'return_policy.saved', subject: row.id, companyId: row.companyId, payload: { policyId: row.id, companyId: row.companyId, channel: row.channel as PolicyChannel, change: 'RETIRED', replacedId: null, fields: ['retiredAt'] } })
    return { policy: await viewOf(tools, row.id) }
  })
  return result
}

export { livePolicyOf, POLICY_CHANNELS }
