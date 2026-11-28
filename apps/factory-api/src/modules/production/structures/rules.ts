import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { EVERY_PARTY_WORDS, holds, reachesEveryParty } from '@nexus/factory-domain/core/permissions'
import { PRODUCTION_STRUCTURES_MANAGE, PRODUCTION_STRUCTURES_RULES } from '@nexus/factory-domain/production/structures/permissions'
import { openRules, ruleNumber, rulePlace, sameOrdersRule, STRUCTURE_REFUSALS, tryOrder, type StructureCategory } from '@nexus/factory-domain/production/structures/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { refuse } from '../../people/employees/access'
import { officeContextOf } from '../../sales/orders/access'
import { companyOf, namesFor, neverUsedOf, partyNames, readsAt, ruleRows, rulesOfCompany, structuresByIds, writesRulesAt, type RuleRecord } from './facts'

/**
 * The rules that pick an order line's structure (owb-ss6 step 6.2; build/briefs/owb-ss6.md § Shape; design § 5zj C ruleModal,
 * ruleMove, rulePlace, ruleAbove, the "Try an order" box): ONE list per company, read from the top, the first rule that fits wins;
 * the last line "Everything else → the normal way" is the web's. Kept by the owner and sales (production.structures.rules); read
 * by holders of .rules or .manage. Closed and opened again, never deleted. The open rules are numbered 1..n after every change
 * (a closed rule keeps its last place). One audit row per change (recordType OrderStructureRule; a move of the others:
 * production.moveStructureRule).
 *
 *   GET   /production/structure-rules                the screen's company's list: dead ("Never used"), the structure's closed,
 *                                                    fitsNow; neverUsed; may.write
 *   POST  /production/structure-rules                a new rule, placed above the first rule that would take all its orders
 *                                                    (rulePlace) unless the body names its place
 *   PATCH /production/structure-rules/:ruleId        its customer, category, structure, on/off, note (an open rule; it keeps its place)
 *   PUT   /production/structure-rules/order          { ids } every open rule once, in its new order (renumbered 1..n)
 *   POST  /production/structure-rules/:ruleId/close | reopen (opened again: placed by rulePlace)
 *   POST  /production/structure-rules/try            a customer and a category: the winner and why each other rule does not win
 *   GET   /production/customers/:partyId/structure-rules   the rules naming this customer and the rules for any customer, with what
 *                                                    they do now for this customer's orders
 *
 * A rule naming a customer the caller does not reach is never shown (nor named in words); the whole list's order is changed only
 * by someone who reaches every customer. Refusals are 409s with `refusal/<CODE>` (STRUCTURE_REFUSALS): SAME_ORDERS (also checked
 * by the partial uniques OrderStructureRule_open_same_orders(_any_kind)), STRUCTURE_NOT_OPEN, CUSTOMER_NOT_OURS, RULE_CLOSED,
 * RULE_ALREADY_CLOSED, RULE_ALREADY_OPEN, ORDER_NOT_WHOLE.
 */

const RECORD = 'OrderStructureRule'
const NOT_FOUND = 'Structure rule not found.'
const NOT_WRITER = 'You may read the rules but not change them: the owner and sales keep them.'

const noteOf = (note: string | null | undefined): string | null => (note === undefined || note === null || note.trim() === '' ? null : note.trim())

/** One change of a company's list at a time (the list is read, then renumbered). */
const lockList = (tx: CommandTx, companyId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factory.structure-rules|${companyId}`}::text, 0))`

/** "Rule 2 is for exactly these orders. …" */
const sameOrdersWords = (number: number): string => `Rule ${number} is for exactly these orders. Change that rule: two rules for the same orders are never both used.`

/** The open rules renumbered 1..n in this order: each that moves is written (its version up by one) and audited. */
async function renumber(tools: CommandTools, companyId: string, list: readonly Pick<RuleRecord, 'id' | 'sortOrder'>[], exceptId: string | null = null): Promise<number> {
  let moved = 0
  for (const [index, rule] of list.entries()) {
    const place = index + 1
    if (rule.id === exceptId || rule.sortOrder === place) continue
    await tools.tx.orderStructureRule.update({ where: { id: rule.id }, data: { sortOrder: place, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'production.moveStructureRule', recordType: RECORD, recordId: rule.id, companyId, before: { sortOrder: rule.sortOrder }, after: { sortOrder: place } })
    moved += 1
  }
  return moved
}

/** The customer a rule names: one of the tenant of no other company than the rule's. */
async function checkCustomer(tx: CommandTx, companyId: string, partyId: string | null): Promise<void> {
  if (partyId === null) return
  const party = await tx.party.findUnique({ where: { id: partyId }, select: { companyId: true } })
  if (!party || (party.companyId !== null && party.companyId !== companyId)) refuse('CUSTOMER_NOT_OURS', STRUCTURE_REFUSALS.CUSTOMER_NOT_OURS, 'partyId')
}

/** The structure a rule gives: one of the company, open. */
async function checkStructure(tx: CommandTx, companyId: string, structureId: string): Promise<void> {
  const structure = (await structuresByIds(tx, [structureId])).get(structureId)
  if (!structure || structure.companyId !== companyId || structure.closed) refuse('STRUCTURE_NOT_OPEN', STRUCTURE_REFUSALS.STRUCTURE_NOT_OPEN, 'structureId')
}

/** One rule's row, read in the transaction. */
async function rowOf(tx: CommandTx, context: OfficeContext, companyId: string, ruleId: string) {
  return (await ruleRows(tx, context, companyId, await rulesOfCompany(tx, companyId), { only: (rule) => rule.id === ruleId }))[0]!
}

/** One rule the caller reads (else 404) and may change (else 403), with its company. */
async function writableRule(caller: CommandCaller, context: OfficeContext, ruleId: string): Promise<{ readonly companyId: string; readonly partyId: string | null }> {
  const rule = await caller.withClient((client) => client.orderStructureRule.findUnique({ where: { id: ruleId }, select: { companyId: true, partyId: true } }))
  if (!rule || !readsAt(context, rule)) throw new NotFoundError(NOT_FOUND)
  if (!writesRulesAt(context, rule)) throw new ForbiddenError(NOT_WRITER)
  return rule
}

/** The holder of neither right is refused (the manifest says signed-in). */
function assertReader(context: OfficeContext): void {
  const actor = actorOf(context)
  if (!holds(actor, PRODUCTION_STRUCTURES_MANAGE) && !holds(actor, PRODUCTION_STRUCTURES_RULES)) throw new ForbiddenError()
}

/** GET /production/structure-rules. */
export async function listRules(caller: CommandCaller) {
  const context = officeContextOf(caller)
  assertReader(context)
  return caller.withClient(async (client) => {
    const companyId = await companyOf(client, context, [PRODUCTION_STRUCTURES_RULES, PRODUCTION_STRUCTURES_MANAGE], null)
    if (!readsAt(context, { companyId })) throw new ForbiddenError()
    const rules = await rulesOfCompany(client, companyId)
    const rows = await ruleRows(client, context, companyId, rules)
    return { rules: rows, neverUsed: neverUsedOf(rows), may: { write: writesRulesAt(context, { companyId }) } }
  })
}

/** GET /production/customers/:partyId/structure-rules. */
export async function customerRules(caller: CommandCaller, partyId: string) {
  const context = officeContextOf(caller)
  assertReader(context)
  return caller.withClient(async (client) => {
    const party = await client.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true } })
    if (!party) throw new NotFoundError('Customer not found.')
    const companyId = await companyOf(client, context, [PRODUCTION_STRUCTURES_RULES, PRODUCTION_STRUCTURES_MANAGE], party.companyId)
    if ((party.companyId !== null && party.companyId !== companyId) || !readsAt(context, { companyId, partyId })) throw new NotFoundError('Customer not found.')
    const rules = await rulesOfCompany(client, companyId)
    const rows = await ruleRows(client, context, companyId, rules, { only: (rule) => rule.partyId === partyId || (rule.partyId === null && !rule.closed), partyId })
    return { rules: rows, may: { write: writesRulesAt(context, { companyId, partyId }) } }
  })
}

/** POST /production/structure-rules. */
export async function createRule(
  caller: CommandCaller,
  body: { readonly partyId: string | null; readonly category: StructureCategory | null; readonly structureId: string; readonly note?: string | undefined; readonly place?: number | undefined },
  idempotencyKey?: string,
) {
  const context = officeContextOf(caller)
  const structure = (await caller.withClient((client) => structuresByIds(client, [body.structureId]))).get(body.structureId)
  if (!structure || !readsAt(context, structure)) throw new NotFoundError('Order structure not found.')
  const companyId = structure.companyId
  if (!writesRulesAt(context, { companyId, partyId: body.partyId })) throw new ForbiddenError(NOT_WRITER)
  return command(caller, { name: 'production.createStructureRule', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockList(tx, companyId)
    const rules = await rulesOfCompany(tx, companyId)
    await checkStructure(tx, companyId, body.structureId)
    await checkCustomer(tx, companyId, body.partyId)
    const same = sameOrdersRule(body, rules)
    if (same) refuse('SAME_ORDERS', sameOrdersWords(ruleNumber(same, rules)), 'category')
    const open = openRules(rules)
    const index = body.place === undefined ? rulePlace(body, rules) : Math.min(Math.max(body.place - 1, 0), open.length)
    const id = newId()
    const note = noteOf(body.note)
    await tx.orderStructureRule.create({ data: { id, companyId, sortOrder: index + 1, partyId: body.partyId, category: body.category, structureId: body.structureId, note, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
    tools.audit({ action: 'production.createStructureRule', recordType: RECORD, recordId: id, companyId, after: { sortOrder: index + 1, partyId: body.partyId, category: body.category, structureId: body.structureId, note, placedBy: body.place === undefined ? 'RULE_PLACE' : 'BODY' } })
    await renumber(tools, companyId, [...open.slice(0, index), { id, sortOrder: index + 1 }, ...open.slice(index)], id)
    return rowOf(tx, context, companyId, id)
  })
}

/** PATCH /production/structure-rules/:ruleId. */
export async function updateRule(
  caller: CommandCaller,
  ruleId: string,
  body: { readonly version: number; readonly partyId?: string | null | undefined; readonly category?: StructureCategory | null | undefined; readonly structureId?: string | undefined; readonly active?: boolean | undefined; readonly note?: string | null | undefined },
  idempotencyKey?: string,
) {
  const context = officeContextOf(caller)
  const seen = await writableRule(caller, context, ruleId)
  const companyId = seen.companyId
  if (body.partyId !== undefined && !writesRulesAt(context, { companyId, partyId: body.partyId })) throw new ForbiddenError(NOT_WRITER)
  const { result } = await command(caller, { name: 'production.updateStructureRule', idempotencyKey, input: { ruleId, ...body }, record: { type: 'OrderStructureRule', id: ruleId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    await lockList(tx, companyId)
    const rules = await rulesOfCompany(tx, companyId)
    const before = rules.find((rule) => rule.id === ruleId)!
    if (before.closed) refuse('RULE_CLOSED', STRUCTURE_REFUSALS.RULE_CLOSED)
    const next = {
      partyId: body.partyId === undefined ? before.partyId : body.partyId,
      category: body.category === undefined ? before.category : body.category,
      structureId: body.structureId ?? before.structureId,
      active: body.active ?? before.active,
      note: body.note === undefined ? before.note : noteOf(body.note),
    }
    if (next.structureId !== before.structureId) await checkStructure(tx, companyId, next.structureId)
    if (next.partyId !== before.partyId) await checkCustomer(tx, companyId, next.partyId)
    if (next.partyId !== before.partyId || next.category !== before.category) {
      const same = sameOrdersRule(next, rules, ruleId)
      if (same) refuse('SAME_ORDERS', sameOrdersWords(ruleNumber(same, rules)), 'category')
    }
    await tx.orderStructureRule.update({
      where: { id: ruleId },
      data: { partyId: next.partyId, category: next.category as StructureCategory | null, structureId: next.structureId, active: next.active, note: next.note, updatedAt: now },
      select: { id: true },
    })
    const fields = ({ partyId, category, structureId, active, note }: typeof next) => ({ partyId, category, structureId, active, note })
    tools.audit({ action: 'production.updateStructureRule', recordType: RECORD, recordId: ruleId, companyId, before: fields(before), after: fields(next) })
    return rowOf(tx, context, companyId, ruleId)
  })
  return result
}

/** PUT /production/structure-rules/order. */
export async function orderRules(caller: CommandCaller, body: { readonly ids: readonly string[] }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const seen = await writableRule(caller, context, body.ids[0]!)
  const companyId = seen.companyId
  // The whole list is moved: the caller reaches every customer of it.
  if (!reachesEveryParty(actorOf(context), PRODUCTION_STRUCTURES_RULES, { companyId })) throw new ForbiddenError(EVERY_PARTY_WORDS.en)
  const { result } = await command(caller, { name: 'production.orderStructureRules', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    await lockList(tx, companyId)
    const rules = await rulesOfCompany(tx, companyId)
    const open = openRules(rules)
    const byId = new Map(open.map((rule) => [rule.id, rule]))
    if (body.ids.length !== open.length || new Set(body.ids).size !== body.ids.length || body.ids.some((id) => !byId.has(id))) refuse('ORDER_NOT_WHOLE', STRUCTURE_REFUSALS.ORDER_NOT_WHOLE, 'ids')
    const moved = await renumber(tools, companyId, body.ids.map((id) => byId.get(id)!))
    if (moved === 0) tools.audit({ action: 'production.orderStructureRules', recordType: 'Company', recordId: companyId, companyId, after: { structureRules: 'order unchanged' } })
    return { rules: await ruleRows(tx, context, companyId, await rulesOfCompany(tx, companyId)) }
  })
  return result
}

/** POST /production/structure-rules/:ruleId/close and …/reopen (opened again above the first rule that would take all its orders). */
export async function closeRule(caller: CommandCaller, ruleId: string, open: boolean, body: { readonly version?: number | undefined } | undefined, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const seen = await writableRule(caller, context, ruleId)
  const companyId = seen.companyId
  const name = open ? 'production.reopenStructureRule' : 'production.closeStructureRule'
  const expected = body?.version
  const { result } = await command(caller, { name, idempotencyKey, input: { ruleId, open, version: expected ?? null }, record: { type: 'OrderStructureRule', id: ruleId, ...(expected !== undefined ? { expectedVersion: expected } : {}) } }, async (tools) => {
    const { tx, now } = tools
    await lockList(tx, companyId)
    const rules = await rulesOfCompany(tx, companyId)
    const before = rules.find((rule) => rule.id === ruleId)!
    if (!open) {
      if (before.closed) refuse('RULE_ALREADY_CLOSED', STRUCTURE_REFUSALS.RULE_ALREADY_CLOSED)
      await tx.orderStructureRule.update({ where: { id: ruleId }, data: { closedAt: now, closedById: context.actorId, updatedAt: now }, select: { id: true } })
      tools.audit({ action: name, recordType: RECORD, recordId: ruleId, companyId, before: { closed: false, sortOrder: before.sortOrder }, after: { closed: true } })
      await renumber(tools, companyId, openRules(rules).filter((rule) => rule.id !== ruleId))
      return rowOf(tx, context, companyId, ruleId)
    }
    if (!before.closed) refuse('RULE_ALREADY_OPEN', STRUCTURE_REFUSALS.RULE_ALREADY_OPEN)
    if (before.structureClosed) refuse('STRUCTURE_NOT_OPEN', STRUCTURE_REFUSALS.STRUCTURE_NOT_OPEN, 'structureId')
    const same = sameOrdersRule(before, rules, ruleId)
    if (same) refuse('SAME_ORDERS', sameOrdersWords(ruleNumber(same, rules)))
    const others = openRules(rules)
    const index = rulePlace(before, others)
    await tx.orderStructureRule.update({ where: { id: ruleId }, data: { closedAt: null, closedById: null, sortOrder: index + 1, updatedAt: now }, select: { id: true } })
    tools.audit({ action: name, recordType: RECORD, recordId: ruleId, companyId, before: { closed: true, sortOrder: before.sortOrder }, after: { closed: false, sortOrder: index + 1 } })
    await renumber(tools, companyId, [...others.slice(0, index), { id: ruleId, sortOrder: index + 1 }, ...others.slice(index)], ruleId)
    return rowOf(tx, context, companyId, ruleId)
  })
  return result
}

/** POST /production/structure-rules/try: nothing is saved. */
export async function tryRules(caller: CommandCaller, body: { readonly partyId: string | null; readonly category: StructureCategory | null }) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const party = body.partyId === null ? null : await client.party.findUnique({ where: { id: body.partyId }, select: { id: true, companyId: true } })
    if (body.partyId !== null && !party) throw new NotFoundError('Customer not found.')
    const companyId = await companyOf(client, context, [PRODUCTION_STRUCTURES_RULES], party?.companyId ?? null)
    if (party && ((party.companyId !== null && party.companyId !== companyId) || !writesRulesAt(context, { companyId, partyId: party.id }))) throw new NotFoundError('Customer not found.')
    if (!writesRulesAt(context, { companyId })) throw new ForbiddenError()
    const rules = await rulesOfCompany(client, companyId)
    const names = namesFor(context, companyId, await partyNames(client, rules.map((rule) => rule.partyId)), await structuresByIds(client, rules.map((rule) => rule.structureId)))
    const answer = tryOrder({ partyId: body.partyId, category: body.category }, rules, names)
    // A rule naming a customer the caller does not reach is never shown.
    const shown = new Set(rules.filter((rule) => rule.partyId === null || readsAt(context, { companyId, partyId: rule.partyId })).map((rule) => rule.id))
    return { winner: answer.winner, others: answer.others.filter((other) => shown.has(other.ruleId)) }
  })
}
