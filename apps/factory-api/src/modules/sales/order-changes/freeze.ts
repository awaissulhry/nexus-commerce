import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { kindFits } from '@nexus/factory-domain/auth/partners/kinds'
import { PARTNERS_VIEW } from '@nexus/factory-domain/auth/partners/permissions'
import { PARTNERS_PRODUCTION_MANAGE } from '@nexus/factory-domain/production-brand/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { AmendmentDiff } from '@nexus/factory-domain/sales/amendments/amendments'
import {
  FIELD_SCOPE,
  FIELD_WORDS,
  freezeRuleProblems,
  freezeVerdict,
  frozenProblems,
  furthestStage,
  looseningProblem,
  NOT_STARTED_WORDS,
  ORDER_FREEZE_FIELDS,
  rulesForParty,
  STAGE_WORDS,
  type FreezeRuleFacts,
  type FrozenChange,
  type OrderFreezeAction,
  type OrderFreezeField,
  type OrderFreezeStage,
  type StageReached,
} from '@nexus/factory-domain/sales/order-changes/freeze'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { SALES_SETTINGS_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeContextOf } from '../orders/access'
import { officeOrder } from '../orders/moves'
import { readLines, type OrderRow, type Reader } from '../orders/store'
import { readStages, stageOfLine, stageOfSize } from './stages'

/**
 * What freezes on an order at each production stage (B-W2b-309; SAL-218; design order.changes.freeze "What is frozen",
 * order.lines.cards "Sizes already cut are locked with the reason 'Cutting started — size frozen'"). The rules are the
 * company's (OrderFreezeRule, B-W2b-281; the database keeps one active rule per company, field and stage and never lets a
 * later stage loosen an earlier BLOCKED); their reading is factory-domain sales/order-changes/freeze; the stages are read
 * from production by ./stages.ts.
 *
 *   GET  /sales/order-freeze-rules?companyId=   the company's rules (switched off ones too), in words: orders.view or
 *                                               sales.settings.manage over the company
 *   POST /sales/order-freeze-rules              sales.settings.manage: a rule (field, stage, action, words); a second active
 *                                               rule of the field at that stage, or one that loosens an earlier block: 409
 *   PATCH /sales/order-freeze-rules/:ruleId     {version, active?, action?, note?}: field, stage and company never change
 *   GET  /sales/orders/:orderId/freeze          orders.view: the order's stage, every field's verdict for the order, and per
 *                                               line and size the stage reached and what is locked, with the reason in words
 *
 * `frozenChangesOf` reads an amendment's diff against the verdicts (W2a's amend command refuses what they hold).
 *
 * B-PR-14 (production plan §3; 08-backend §2 "Freeze per brand"; B-PR-12's OrderFreezeRule.partyId): a customer may have rules
 * of its own. Per field, its active rules replace the company's for that customer (factory-domain rulesForParty); the company's
 * set (partyId null) decides every other field and every customer without rules of its own; another customer's rules never
 * decide. Every reading of an order's verdicts reads the company's set with `partyId: null` and the order's customer's own.
 *   GET   ?companyId=&partyId=   that customer's own rules beside the company's (and which set decides each field), for a
 *                                person who reaches that customer (orders.view, sales.settings.manage, partners.view or
 *                                partners.production.manage over the company and it; else 404); without partyId the company's
 *   POST  {…, partyId}           a customer's own rule: sales.settings.manage or partners.production.manage over the company
 *                                and that customer (the route is signed-in; the handler checks); one active rule per set,
 *                                field and stage; no loosening inside one set
 *   PATCH                        a customer's rule with the same rights; its customer never changes
 */

export const RULE_COLUMNS = { id: true, companyId: true, partyId: true, field: true, frozenFrom: true, action: true, active: true, note: true, updatedById: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.OrderFreezeRuleSelect
type RuleRow = Prisma.OrderFreezeRuleGetPayload<{ select: typeof RULE_COLUMNS }>

const factsOf = (row: RuleRow): FreezeRuleFacts => ({ id: row.id, field: row.field as OrderFreezeField, frozenFrom: row.frozenFrom as OrderFreezeStage, action: row.action as OrderFreezeAction, active: row.active, note: row.note })

const RULE_ORDER: Prisma.OrderFreezeRuleOrderByWithRelationInput[] = [{ field: 'asc' }, { frozenFrom: 'asc' }, { id: 'asc' }]

/**
 * The active rules that decide for an order of `partyId` (the amend command's and the order's reading): the company's set
 * (partyId null) and the customer's own, the customer's replacing the company's per field (B-PR-14). `partyId` null: the
 * company's set alone.
 */
export async function activeRules(db: Reader, companyId: string, partyId: string | null = null): Promise<FreezeRuleFacts[]> {
  const rows = await db.orderFreezeRule.findMany({ where: { companyId, active: true, OR: [{ partyId: null }, ...(partyId ? [{ partyId }] : [])] }, select: RULE_COLUMNS, orderBy: RULE_ORDER })
  return rulesForParty(rows, partyId).map(factsOf)
}

/** B-PR-14: the active rules of ONE set (the company's: partyId null; or one customer's own): what a new rule is checked against. */
async function activeSet(db: Reader, companyId: string, partyId: string | null): Promise<FreezeRuleFacts[]> {
  const rows = await db.orderFreezeRule.findMany({ where: { companyId, active: true, partyId }, select: RULE_COLUMNS, orderBy: RULE_ORDER })
  return rows.map(factsOf)
}

const mayRead = (context: OfficeContext, companyId: string): boolean => can(actorOf(context), ORDERS_VIEW, { companyId }) || can(actorOf(context), SALES_SETTINGS_MANAGE, { companyId })
const assertManage = (context: OfficeContext, companyId: string): void => {
  if (!can(actorOf(context), SALES_SETTINGS_MANAGE, { companyId })) throw new ForbiddenError()
}

// ── B-PR-14: a customer's own rules ──
const CUSTOMER_READS: readonly Permission[] = [ORDERS_VIEW, SALES_SETTINGS_MANAGE, PARTNERS_VIEW, PARTNERS_PRODUCTION_MANAGE]
const CUSTOMER_KEEPS: readonly Permission[] = [SALES_SETTINGS_MANAGE, PARTNERS_PRODUCTION_MANAGE]
const mayOnCustomer = (context: OfficeContext, permissions: readonly Permission[], companyId: string, partyId: string): boolean => permissions.some((permission) => can(actorOf(context), permission, { companyId, partyId }))
const CUSTOMER_NOT_FOUND = 'Customer not found.'
const ONLY_CUSTOMERS = "A customer's own freeze rules are for a customer or a brand."

/**
 * The customer a set of rules is for, as the caller reaches it: a party of this company (or of every company) that the caller
 * reads (else 404, the same for an unknown one: a person limited to another customer learns nothing), a customer or a brand
 * (else 409), and kept by the caller when `keep` (else 403).
 */
async function reachCustomer(caller: CommandCaller, context: OfficeContext, companyId: string, partyId: string, keep: boolean): Promise<void> {
  const party = await caller.withClient((db) => db.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true, roles: true } }))
  if (!party || (party.companyId !== null && party.companyId !== companyId) || !mayOnCustomer(context, CUSTOMER_READS, companyId, partyId)) throw new NotFoundError(CUSTOMER_NOT_FOUND)
  if (!kindFits('CUSTOMER', party.roles)) throw new DomainError('conflict', ONLY_CUSTOMERS, [{ path: 'body/partyId', message: ONLY_CUSTOMERS }])
  if (keep && !mayOnCustomer(context, CUSTOMER_KEEPS, companyId, partyId)) throw new ForbiddenError()
}
// ── end B-PR-14 ──

async function namesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

function ruleView(row: RuleRow, names: Map<string, string>) {
  const facts = factsOf(row)
  const verdict = freezeVerdict([{ ...facts, active: true }], facts.field, facts.frozenFrom)
  return {
    id: row.id,
    companyId: row.companyId,
    /** B-PR-14: the customer whose own rule it is (null: the company's). */
    partyId: row.partyId,
    field: facts.field,
    fieldWords: FIELD_WORDS[facts.field],
    frozenFrom: facts.frozenFrom,
    stageWords: STAGE_WORDS[facts.frozenFrom],
    action: facts.action,
    active: row.active,
    note: row.note,
    /** What the order shows beside the field once the stage is reached. */
    words: verdict.words,
    updatedBy: row.updatedById ? (names.get(row.updatedById) ?? null) : null,
    updatedAt: toUtcIso(row.updatedAt),
    version: row.version,
  }
}

/** GET /sales/order-freeze-rules?companyId=&partyId= (B-PR-14: with partyId, that customer's own rules beside the company's). */
export async function listFreezeRules(caller: CommandCaller, query: { readonly companyId: string; readonly partyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const partyId = query.partyId ?? null
  if (partyId === null && !mayRead(context, query.companyId)) throw new NotFoundError('Company not found.')
  if (partyId !== null) await reachCustomer(caller, context, query.companyId, partyId, false)
  return caller.withClient(async (db) => {
    const rows = await db.orderFreezeRule.findMany({
      where: { companyId: query.companyId, OR: [{ partyId: null }, ...(partyId ? [{ partyId }] : [])] },
      select: RULE_COLUMNS,
      orderBy: [{ field: 'asc' }, { frozenFrom: 'asc' }, { active: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    })
    const names = await namesOf(db, rows.map((row) => row.updatedById))
    const ownFields = new Set(rows.filter((row) => partyId !== null && row.partyId === partyId && row.active).map((row) => row.field))
    return {
      companyId: query.companyId,
      partyId,
      rules: rows.map((row) => ruleView(row, names)),
      /** No rule of a field: it stays open at every stage. B-PR-14 `set`: whose rules decide the field for that customer. */
      fields: ORDER_FREEZE_FIELDS.map((field) => ({ field, words: FIELD_WORDS[field], scope: FIELD_SCOPE[field], set: ownFields.has(field) ? ('CUSTOMER' as const) : ('COMPANY' as const) })),
      mayManage: partyId === null ? can(actorOf(context), SALES_SETTINGS_MANAGE, { companyId: query.companyId }) : mayOnCustomer(context, CUSTOMER_KEEPS, query.companyId, partyId),
    }
  })
}

const isCode = (error: unknown, code: string): boolean => (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null)?.meta?.driverAdapterError?.cause?.originalCode === code || (code === '23505' && (error as { code?: unknown } | null)?.code === 'P2002')
const twin = (field: OrderFreezeField, stage: OrderFreezeStage, customer = false) => new DomainError('conflict', `${customer ? 'This customer' : 'The company'} has an active rule for the ${FIELD_WORDS[field].en} from "${STAGE_WORDS[stage].en.toLowerCase()}" already: switch it off or change it.`, [{ path: 'body/frozenFrom', message: 'One active rule per field and stage.' }])
const loosens = (message: string) => new DomainError('conflict', message, [{ path: 'body/action', message }])

/** The refusals the database speaks (one active per field and stage; no loosening after a block), in words. */
function mapped(error: unknown, field: OrderFreezeField, stage: OrderFreezeStage, customer = false): unknown {
  if (isCode(error, '23505')) return twin(field, stage, customer)
  if (isCode(error, '23514')) return loosens(`The ${FIELD_WORDS[field].en} cannot be opened again for a change request at a later stage than a block.`)
  return error
}

export interface FreezeRuleBody {
  readonly companyId: string
  /** B-PR-14: a customer's own rule (null or left out: the company's). */
  readonly partyId?: string | null | undefined
  readonly field: OrderFreezeField
  readonly frozenFrom: OrderFreezeStage
  readonly action: OrderFreezeAction
  readonly note?: string | null | undefined
}

const blank = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim())

/** POST /sales/order-freeze-rules */
export async function createFreezeRule(caller: CommandCaller, body: FreezeRuleBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  // B-PR-14: a customer's own rule is kept by sales.settings.manage or partners.production.manage over it; the company's as before.
  const partyId = body.partyId ?? null
  if (partyId === null) assertManage(context, body.companyId)
  else await reachCustomer(caller, context, body.companyId, partyId, true)
  const issues = freezeRuleProblems(body)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  let ruleId: string
  try {
    const { result } = await command(caller, { name: 'orders.freezeRules.create', idempotencyKey, input: body }, async (tools) => {
      // One set at a time: the company's (the key of before: concat_ws skips the null customer) or one customer's.
      await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.order_freeze', ${body.companyId}::text, ${partyId}::text, ${body.field}::text), 0))`
      const active = await activeSet(tools.tx, body.companyId, partyId)
      if (active.some((rule) => rule.field === body.field && rule.frozenFrom === body.frozenFrom)) throw twin(body.field, body.frozenFrom, partyId !== null)
      const problem = looseningProblem([...active, { field: body.field, frozenFrom: body.frozenFrom, action: body.action, active: true }], body.field)
      if (problem) throw loosens(problem)
      const id = newId()
      const note = blank(body.note)
      await tools.tx.orderFreezeRule.create({ data: { id, companyId: body.companyId, partyId, field: body.field, frozenFrom: body.frozenFrom, action: body.action, note, updatedById: context.actorId, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: { id: true } })
      tools.audit({ action: 'orders.freezeRules.create', recordType: 'OrderFreezeRule', recordId: id, companyId: body.companyId, after: { partyId, field: body.field, frozenFrom: body.frozenFrom, action: body.action, active: true, note } })
      tools.emit({ type: 'order_freeze_rule.changed', subject: id, companyId: body.companyId, payload: { ruleId: id, companyId: body.companyId, partyId, field: body.field, frozenFrom: body.frozenFrom, action: body.action, active: true, change: 'MADE' } })
      return { id }
    })
    ruleId = result.id
  } catch (error) {
    throw mapped(error, body.field, body.frozenFrom, partyId !== null)
  }
  return { rule: await ruleAfter(caller, ruleId) }
}

export interface FreezeRulePatch {
  readonly version: number
  readonly active?: boolean | undefined
  readonly action?: OrderFreezeAction | undefined
  readonly note?: string | null | undefined
}

async function ruleAfter(caller: CommandCaller, ruleId: string) {
  return caller.withClient(async (db) => {
    const row = await db.orderFreezeRule.findUniqueOrThrow({ where: { id: ruleId }, select: RULE_COLUMNS })
    return ruleView(row, await namesOf(db, [row.updatedById]))
  })
}

/** PATCH /sales/order-freeze-rules/:ruleId */
export async function updateFreezeRule(caller: CommandCaller, ruleId: string, body: FreezeRulePatch, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const row = await caller.withClient((db) => db.orderFreezeRule.findUnique({ where: { id: ruleId }, select: RULE_COLUMNS }))
  // B-PR-14: a customer's rule is found only by a person who reaches that customer, kept with its rights.
  const partyId = row?.partyId ?? null
  if (!row || (partyId === null ? !mayRead(context, row.companyId) : !mayOnCustomer(context, CUSTOMER_READS, row.companyId, partyId))) throw new NotFoundError('Freeze rule not found.')
  if (partyId === null) assertManage(context, row.companyId)
  else if (!mayOnCustomer(context, CUSTOMER_KEEPS, row.companyId, partyId)) throw new ForbiddenError()
  if (body.active === undefined && body.action === undefined && body.note === undefined) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one of active, action, note.' }])
  const issues = freezeRuleProblems(body)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const field = row.field as OrderFreezeField
  const stage = row.frozenFrom as OrderFreezeStage
  try {
    await command(caller, { name: 'orders.freezeRules.update', idempotencyKey, input: { ruleId, ...body }, record: { type: 'OrderFreezeRule', id: ruleId, expectedVersion: body.version } }, async (tools) => {
      await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.order_freeze', ${row.companyId}::text, ${partyId}::text, ${field}::text), 0))`
      const fresh = await tools.tx.orderFreezeRule.findUniqueOrThrow({ where: { id: ruleId }, select: RULE_COLUMNS })
      const after = { active: body.active ?? fresh.active, action: (body.action ?? fresh.action) as OrderFreezeAction, note: body.note === undefined ? fresh.note : blank(body.note) }
      if (after.active) {
        const others = (await activeSet(tools.tx, row.companyId, partyId)).filter((rule) => rule.id !== ruleId)
        if (!fresh.active && others.some((rule) => rule.field === field && rule.frozenFrom === stage)) throw twin(field, stage, partyId !== null)
        const problem = looseningProblem([...others, { field, frozenFrom: stage, action: after.action, active: true }], field)
        if (problem) throw loosens(problem)
      }
      await tools.tx.orderFreezeRule.update({ where: { id: ruleId }, data: { active: after.active, action: after.action, note: after.note, updatedById: context.actorId, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ action: 'orders.freezeRules.update', recordType: 'OrderFreezeRule', recordId: ruleId, companyId: row.companyId, before: { active: fresh.active, action: fresh.action, note: fresh.note }, after })
      tools.emit({ type: 'order_freeze_rule.changed', subject: ruleId, companyId: row.companyId, payload: { ruleId, companyId: row.companyId, partyId, field, frozenFrom: stage, action: after.action, active: after.active, change: 'CHANGED' } })
      return { ruleId }
    })
  } catch (error) {
    throw mapped(error, field, stage, partyId !== null)
  }
  return { rule: await ruleAfter(caller, ruleId) }
}

// ---- the order's reading -----------------------------------------------------------------------------------------------------

const stageView = (reached: StageReached) => ({ stage: reached.stage, on: reached.on, words: reached.stage ? STAGE_WORDS[reached.stage] : NOT_STARTED_WORDS })

function verdictView(rules: readonly FreezeRuleFacts[], field: OrderFreezeField, stage: OrderFreezeStage | null) {
  const verdict = freezeVerdict(rules, field, stage)
  return { field, fieldWords: FIELD_WORDS[field], state: verdict.state, frozenFrom: verdict.frozenFrom, ruleId: verdict.ruleId, words: verdict.words }
}

/** The order's freeze reading: what the "What is frozen" panel and the locked size cells show (B-PR-14: its customer's rules too). */
export async function freezeReadingOf(db: Reader, order: Pick<OrderRow, 'id' | 'companyId' | 'partyId'>) {
  const rules = await activeRules(db, order.companyId, order.partyId)
  const lines = (await readLines(db, order.id)).filter((line) => line.kind !== 'FEE')
  const stages = await readStages(db, lines.map((line) => line.id))
  return {
    rules: rules.length,
    order: { ...stageView(stages.order), fields: ORDER_FREEZE_FIELDS.map((field) => verdictView(rules, field, stages.order.stage)) },
    lines: lines.map((line) => {
      const reached = stageOfLine(stages, line.id)
      return {
        lineId: line.id,
        seq: line.seq,
        ...stageView(reached),
        fields: (['COLOURWAY', 'OPTION', 'PRICE'] as const).map((field) => verdictView(rules, field, reached.stage)),
        sizes: line.sizes.map((size) => {
          const cell = stageOfSize(stages, line.id, size.size)
          const verdict = verdictView(rules, 'SIZE_QUANTITY', cell.stage)
          return { size: size.size, ...stageView(cell), locked: verdict.state !== 'OPEN', state: verdict.state, words: verdict.words }
        }),
      }
    }),
  }
}

/** GET /sales/orders/:orderId/freeze */
export async function orderFreeze(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  const reading = await caller.withClient((db) => freezeReadingOf(db, order))
  return { orderId: order.id, number: order.number, ...reading }
}

// ---- an amendment against the rules ---------------------------------------------------------------------------------------

/**
 * The frozen-able changes an amendment makes, each with its verdict: SIZE_QUANTITY per size cell whose pieces change (a
 * removed line: every size), PRICE per line whose unit price changed, DELIVERY_DATE for the order when its requested date
 * changed. A new line has no production: open. Returns them with the stages (the priced change's `stage` fact).
 */
export async function frozenChangesOf(db: Reader, order: Pick<OrderRow, 'id' | 'companyId' | 'partyId'>, diff: AmendmentDiff): Promise<{ changes: FrozenChange[]; furthest: OrderFreezeStage | null }> {
  const rules = await activeRules(db, order.companyId, order.partyId)
  const dateChanged = diff.header.some((entry) => entry.field === 'requestedDate')
  const changed = diff.lines.filter((line) => line.change !== 'ADDED').map((line) => line.lineId)
  // A date change is read against the whole order's stage: every line of it then.
  const lineIds = dateChanged ? (await db.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((row) => row.id) : changed
  const stages = await readStages(db, lineIds)
  const changes: FrozenChange[] = []
  const reached: (OrderFreezeStage | null)[] = []
  for (const line of diff.lines) {
    if (line.change === 'ADDED') continue
    const lineStage = stageOfLine(stages, line.lineId).stage
    reached.push(lineStage)
    for (const size of line.sizes) changes.push({ field: 'SIZE_QUANTITY', lineId: line.lineId, seq: line.seq, size: size.size, verdict: freezeVerdict(rules, 'SIZE_QUANTITY', stageOfSize(stages, line.lineId, size.size).stage) })
    if (line.unitPrice !== null) changes.push({ field: 'PRICE', lineId: line.lineId, seq: line.seq, size: null, verdict: freezeVerdict(rules, 'PRICE', lineStage) })
  }
  if (dateChanged) {
    reached.push(stages.order.stage)
    changes.push({ field: 'DELIVERY_DATE', lineId: null, seq: null, size: null, verdict: freezeVerdict(rules, 'DELIVERY_DATE', stages.order.stage) })
  }
  return { changes, furthest: furthestStage(reached) }
}

/** The problems the freeze rules give an amendment's diff (the review dialogs' `problems`; nothing written). */
export async function previewFrozenProblems(db: Reader, order: Pick<OrderRow, 'id' | 'companyId' | 'partyId'>, diff: AmendmentDiff, priced: boolean) {
  const { changes } = await frozenChangesOf(db, order, diff)
  return frozenProblems(changes, priced)
}
