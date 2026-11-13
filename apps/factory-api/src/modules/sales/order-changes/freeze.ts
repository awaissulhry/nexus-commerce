import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
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
 */

export const RULE_COLUMNS = { id: true, companyId: true, field: true, frozenFrom: true, action: true, active: true, note: true, updatedById: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.OrderFreezeRuleSelect
type RuleRow = Prisma.OrderFreezeRuleGetPayload<{ select: typeof RULE_COLUMNS }>

const factsOf = (row: RuleRow): FreezeRuleFacts => ({ id: row.id, field: row.field as OrderFreezeField, frozenFrom: row.frozenFrom as OrderFreezeStage, action: row.action as OrderFreezeAction, active: row.active, note: row.note })

/** The company's active rules (the amend command's and the order's reading). */
export async function activeRules(db: Reader, companyId: string): Promise<FreezeRuleFacts[]> {
  const rows = await db.orderFreezeRule.findMany({ where: { companyId, active: true }, select: RULE_COLUMNS, orderBy: [{ field: 'asc' }, { frozenFrom: 'asc' }, { id: 'asc' }] })
  return rows.map(factsOf)
}

const mayRead = (context: OfficeContext, companyId: string): boolean => can(actorOf(context), ORDERS_VIEW, { companyId }) || can(actorOf(context), SALES_SETTINGS_MANAGE, { companyId })
const assertManage = (context: OfficeContext, companyId: string): void => {
  if (!can(actorOf(context), SALES_SETTINGS_MANAGE, { companyId })) throw new ForbiddenError()
}

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

/** GET /sales/order-freeze-rules?companyId= */
export async function listFreezeRules(caller: CommandCaller, query: { readonly companyId: string }) {
  const context = officeContextOf(caller)
  if (!mayRead(context, query.companyId)) throw new NotFoundError('Company not found.')
  return caller.withClient(async (db) => {
    const rows = await db.orderFreezeRule.findMany({ where: { companyId: query.companyId }, select: RULE_COLUMNS, orderBy: [{ field: 'asc' }, { frozenFrom: 'asc' }, { active: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] })
    const names = await namesOf(db, rows.map((row) => row.updatedById))
    return {
      companyId: query.companyId,
      rules: rows.map((row) => ruleView(row, names)),
      /** No rule of a field: it stays open at every stage. */
      fields: ORDER_FREEZE_FIELDS.map((field) => ({ field, words: FIELD_WORDS[field], scope: FIELD_SCOPE[field] })),
      mayManage: can(actorOf(context), SALES_SETTINGS_MANAGE, { companyId: query.companyId }),
    }
  })
}

const isCode = (error: unknown, code: string): boolean => (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null)?.meta?.driverAdapterError?.cause?.originalCode === code || (code === '23505' && (error as { code?: unknown } | null)?.code === 'P2002')
const twin = (field: OrderFreezeField, stage: OrderFreezeStage) => new DomainError('conflict', `The company has an active rule for the ${FIELD_WORDS[field].en} from "${STAGE_WORDS[stage].en.toLowerCase()}" already: switch it off or change it.`, [{ path: 'body/frozenFrom', message: 'One active rule per field and stage.' }])
const loosens = (message: string) => new DomainError('conflict', message, [{ path: 'body/action', message }])

/** The refusals the database speaks (one active per field and stage; no loosening after a block), in words. */
function mapped(error: unknown, field: OrderFreezeField, stage: OrderFreezeStage): unknown {
  if (isCode(error, '23505')) return twin(field, stage)
  if (isCode(error, '23514')) return loosens(`The ${FIELD_WORDS[field].en} cannot be opened again for a change request at a later stage than a block.`)
  return error
}

export interface FreezeRuleBody {
  readonly companyId: string
  readonly field: OrderFreezeField
  readonly frozenFrom: OrderFreezeStage
  readonly action: OrderFreezeAction
  readonly note?: string | null | undefined
}

const blank = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim())

/** POST /sales/order-freeze-rules */
export async function createFreezeRule(caller: CommandCaller, body: FreezeRuleBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  assertManage(context, body.companyId)
  const issues = freezeRuleProblems(body)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  let ruleId: string
  try {
    const { result } = await command(caller, { name: 'orders.freezeRules.create', idempotencyKey, input: body }, async (tools) => {
      await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.order_freeze', ${body.companyId}::text, ${body.field}::text), 0))`
      const active = await activeRules(tools.tx, body.companyId)
      if (active.some((rule) => rule.field === body.field && rule.frozenFrom === body.frozenFrom)) throw twin(body.field, body.frozenFrom)
      const problem = looseningProblem([...active, { field: body.field, frozenFrom: body.frozenFrom, action: body.action, active: true }], body.field)
      if (problem) throw loosens(problem)
      const id = newId()
      const note = blank(body.note)
      await tools.tx.orderFreezeRule.create({ data: { id, companyId: body.companyId, field: body.field, frozenFrom: body.frozenFrom, action: body.action, note, updatedById: context.actorId, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: { id: true } })
      tools.audit({ action: 'orders.freezeRules.create', recordType: 'OrderFreezeRule', recordId: id, companyId: body.companyId, after: { field: body.field, frozenFrom: body.frozenFrom, action: body.action, active: true, note } })
      tools.emit({ type: 'order_freeze_rule.changed', subject: id, companyId: body.companyId, payload: { ruleId: id, companyId: body.companyId, field: body.field, frozenFrom: body.frozenFrom, action: body.action, active: true, change: 'MADE' } })
      return { id }
    })
    ruleId = result.id
  } catch (error) {
    throw mapped(error, body.field, body.frozenFrom)
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
  if (!row || !mayRead(context, row.companyId)) throw new NotFoundError('Freeze rule not found.')
  assertManage(context, row.companyId)
  if (body.active === undefined && body.action === undefined && body.note === undefined) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one of active, action, note.' }])
  const issues = freezeRuleProblems(body)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const field = row.field as OrderFreezeField
  const stage = row.frozenFrom as OrderFreezeStage
  try {
    await command(caller, { name: 'orders.freezeRules.update', idempotencyKey, input: { ruleId, ...body }, record: { type: 'OrderFreezeRule', id: ruleId, expectedVersion: body.version } }, async (tools) => {
      await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.order_freeze', ${row.companyId}::text, ${field}::text), 0))`
      const fresh = await tools.tx.orderFreezeRule.findUniqueOrThrow({ where: { id: ruleId }, select: RULE_COLUMNS })
      const after = { active: body.active ?? fresh.active, action: (body.action ?? fresh.action) as OrderFreezeAction, note: body.note === undefined ? fresh.note : blank(body.note) }
      if (after.active) {
        const others = (await activeRules(tools.tx, row.companyId)).filter((rule) => rule.id !== ruleId)
        if (!fresh.active && others.some((rule) => rule.field === field && rule.frozenFrom === stage)) throw twin(field, stage)
        const problem = looseningProblem([...others, { field, frozenFrom: stage, action: after.action, active: true }], field)
        if (problem) throw loosens(problem)
      }
      await tools.tx.orderFreezeRule.update({ where: { id: ruleId }, data: { active: after.active, action: after.action, note: after.note, updatedById: context.actorId, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ action: 'orders.freezeRules.update', recordType: 'OrderFreezeRule', recordId: ruleId, companyId: row.companyId, before: { active: fresh.active, action: fresh.action, note: fresh.note }, after })
      tools.emit({ type: 'order_freeze_rule.changed', subject: ruleId, companyId: row.companyId, payload: { ruleId, companyId: row.companyId, field, frozenFrom: stage, action: after.action, active: after.active, change: 'CHANGED' } })
      return { ruleId }
    })
  } catch (error) {
    throw mapped(error, field, stage)
  }
  return { rule: await ruleAfter(caller, ruleId) }
}

// ---- the order's reading -----------------------------------------------------------------------------------------------------

const stageView = (reached: StageReached) => ({ stage: reached.stage, on: reached.on, words: reached.stage ? STAGE_WORDS[reached.stage] : NOT_STARTED_WORDS })

function verdictView(rules: readonly FreezeRuleFacts[], field: OrderFreezeField, stage: OrderFreezeStage | null) {
  const verdict = freezeVerdict(rules, field, stage)
  return { field, fieldWords: FIELD_WORDS[field], state: verdict.state, frozenFrom: verdict.frozenFrom, ruleId: verdict.ruleId, words: verdict.words }
}

/** The order's freeze reading: what the "What is frozen" panel and the locked size cells show. */
export async function freezeReadingOf(db: Reader, order: Pick<OrderRow, 'id' | 'companyId'>) {
  const rules = await activeRules(db, order.companyId)
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
export async function frozenChangesOf(db: Reader, order: Pick<OrderRow, 'id' | 'companyId'>, diff: AmendmentDiff): Promise<{ changes: FrozenChange[]; furthest: OrderFreezeStage | null }> {
  const rules = await activeRules(db, order.companyId)
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
export async function previewFrozenProblems(db: Reader, order: Pick<OrderRow, 'id' | 'companyId'>, diff: AmendmentDiff, priced: boolean) {
  const { changes } = await frozenChangesOf(db, order, diff)
  return frozenProblems(changes, priced)
}
