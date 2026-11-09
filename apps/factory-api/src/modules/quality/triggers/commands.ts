import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { TriggerChange } from '@nexus/factory-domain/quality-triggers/events'
import type { Chip, Frequency } from '@nexus/factory-domain/quality/plans/rules'
import { EVENT_RULES, inOrder, orderProblems, ruleProblems, TRIGGER_LIMITS, type TriggerEvent } from '@nexus/factory-domain/quality/triggers/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { chipsOf } from '../plans/store'
import { companyRules } from './read'
import {
  assertManage,
  chipRefsProblems,
  lockCompanyRules,
  officeOf,
  plansOf,
  readRule,
  recordsOpenedBy,
  TRIGGER_COLUMNS,
  TRIGGER_RECORD,
  TriggerRefusedError,
  type Db,
  type PlanFacts,
  type TriggerRow,
} from './store'

/**
 * The writes of "When inspections are created" (B-W2b-101; QHS-010, QHS-011): one command() each with an Idempotency-Key,
 * an audit row per rule it changes and one `inspection_trigger.changed`.
 *
 *   POST   /quality/inspection-triggers                    a rule: when, for what, which plan, how often; at the end of the
 *                                                          list or at `position` (the rules after it move down)
 *   PATCH  /quality/inspection-triggers/:triggerId         its event, chips, plan, frequency; switched off or on
 *   DELETE /quality/inspection-triggers/:triggerId?version a rule that opened nothing (B-W2b-213: one that opened records
 *                                                          names them as the rule that opened them: it is switched off
 *                                                          instead, 409 refusal/OPENED_RECORDS in words)
 *   POST   /quality/inspection-triggers/order              the company's rules in a new order (the whole list)
 *
 * A rule names a plan of its company with an APPROVED version (the version records open on) and of a stage its event
 * opens; the plan step refuses retiring that version while an active rule names the plan (B-W2b-92). Places are 10, 20,
 * 30 … rewritten under the company's list lock (advisory `factory.inspection-triggers|tenant|company`) by every write
 * that moves a rule; a place change does not bump a rule's version (the version guards what the rule says).
 */

type Tools = CommandTools

const refuse = (problems: readonly Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

const changed = (tools: Tools, rule: Pick<TriggerRow, 'id' | 'companyId' | 'event'> | null, companyId: string, change: TriggerChange) =>
  tools.emit({ type: 'inspection_trigger.changed', subject: rule?.id ?? companyId, companyId, siteId: null, payload: { companyId, triggerId: rule?.id ?? null, change, event: (rule?.event as TriggerEvent | undefined) ?? null } })

const audited = (row: Pick<TriggerRow, 'event' | 'appliesTo' | 'planId' | 'frequency' | 'frequencyValue' | 'dueHours' | 'active' | 'sortOrder'>, plan?: Pick<PlanFacts, 'code'>) => ({
  event: row.event,
  appliesTo: row.appliesTo,
  planId: row.planId,
  ...(plan ? { planCode: plan.code } : {}),
  frequency: row.frequency,
  frequencyValue: row.frequencyValue,
  dueHours: row.dueHours,
  active: row.active,
  sortOrder: row.sortOrder,
})

/** The plan a rule names: the company's, of a stage its event opens; with an approved version when the rule is active. */
async function planFor(db: Db, companyId: string, planId: string): Promise<PlanFacts> {
  const plan = (await plansOf(db, [planId])).get(planId)
  if (!plan || plan.companyId !== companyId) refuse([{ path: 'planId', message: 'Not an inspection plan of this company.' }], 'Not an inspection plan of this company.')
  return plan!
}

function assertApproved(plan: PlanFacts): void {
  if (!plan.approved) throw new TriggerRefusedError('NO_APPROVED_VERSION', `Plan ${plan.code} has no approved version: a rule opens inspections on the approved version. Approve one first, or save the rule switched off.`)
}

/**
 * Inside the command: the plan row FOR SHARE (B-W2b-92's retire takes it FOR UPDATE and refuses while an active rule names
 * the plan), then the approved version again, so a rule is never switched on as its plan's version is retired.
 */
async function holdPlan(tx: Tools['tx'], plan: PlanFacts, active: boolean): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "InspectionPlan" WHERE "id" = ${plan.id}::uuid FOR SHARE`
  if (active && !(await tx.inspectionPlanVersion.findFirst({ where: { planId: plan.id, status: 'APPROVED' }, select: { id: true } }))) assertApproved({ ...plan, approved: null })
}

/** The company's rules at 10, 20, 30 … in this order (only the places that change are written). */
async function renumber(tx: Tools['tx'], ordered: readonly Pick<TriggerRow, 'id' | 'sortOrder'>[], now: Date): Promise<Map<string, { before: number; after: number }>> {
  const moved = new Map<string, { before: number; after: number }>()
  for (const [index, row] of ordered.entries()) {
    const sortOrder = (index + 1) * 10
    if (row.sortOrder === sortOrder) continue
    await tx.inspectionTrigger.update({ where: { id: row.id }, data: { sortOrder, updatedAt: now }, select: { id: true } })
    moved.set(row.id, { before: row.sortOrder, after: sortOrder })
  }
  return moved
}

// ---- a new rule --------------------------------------------------------------------------------------------------------

export interface CreateBody {
  readonly companyId: string
  readonly event: TriggerEvent
  readonly planId: string
  readonly appliesTo?: readonly Chip[] | undefined
  readonly frequency?: Frequency | undefined
  readonly frequencyValue?: number | null | undefined
  readonly dueHours?: number | null | undefined
  readonly active?: boolean | undefined
  readonly position?: number | undefined
}

/** The frequency left out: the plan's approved version's, when the event takes it; else every lot. */
function frequencyFor(body: Pick<CreateBody, 'event' | 'frequency' | 'frequencyValue'>, plan: PlanFacts): { frequency: Frequency; frequencyValue: number | null } {
  if (body.frequency) return { frequency: body.frequency, frequencyValue: body.frequencyValue ?? null }
  const own = plan.approved?.frequency ?? null
  if (own && EVENT_RULES[body.event].frequencies.includes(own)) return { frequency: own, frequencyValue: plan.approved?.frequencyValue ?? null }
  return { frequency: 'EVERY_LOT', frequencyValue: null }
}

/** POST /quality/inspection-triggers. */
export async function createRule(caller: CommandCaller, body: CreateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertManage(context, body.companyId)
  const appliesTo = body.appliesTo ?? []
  const active = body.active ?? true
  const { plan, frequency } = await caller.withClient(async (client) => {
    const db = client as unknown as Db
    const plan = await planFor(db, body.companyId, body.planId)
    const frequency = frequencyFor(body, plan)
    const problems = [...ruleProblems({ event: body.event, stage: plan.stage, appliesTo, ...frequency, dueHours: body.dueHours ?? null }), ...(await chipRefsProblems(db, body.companyId, appliesTo))]
    if (problems.length > 0) refuse(problems, 'The rule is not valid.')
    return { plan, frequency }
  })
  if (active) assertApproved(plan)
  const { result } = await command(caller, { name: 'quality.createInspectionTrigger', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockCompanyRules(tx, body.companyId)
    await holdPlan(tx, plan, active)
    const existing = inOrder(await tx.inspectionTrigger.findMany({ where: { companyId: body.companyId }, select: TRIGGER_COLUMNS }))
    if (existing.length >= TRIGGER_LIMITS.rulesPerCompany) throw new TriggerRefusedError('TOO_MANY', `A company keeps at most ${TRIGGER_LIMITS.rulesPerCompany} rules: delete the ones nobody needs.`)
    const id = newId()
    const at = Math.min(body.position ?? existing.length + 1, existing.length + 1) - 1
    const row = await tx.inspectionTrigger.create({
      data: { id, companyId: body.companyId, sortOrder: (existing.length + 1) * 10, event: body.event, appliesTo: appliesTo.map((chip) => ({ kind: chip.kind, value: chip.value })), planId: plan.id, ...frequency, dueHours: body.dueHours ?? null, active, createdAt: now, updatedAt: now, createdById: context.actorId },
      select: TRIGGER_COLUMNS,
    })
    const ordered = [...existing]
    ordered.splice(at, 0, row)
    const moved = await renumber(tx, ordered, now)
    tools.audit({ recordType: TRIGGER_RECORD, recordId: id, companyId: body.companyId, after: { ...audited({ ...row, sortOrder: moved.get(id)?.after ?? row.sortOrder }, plan), position: at + 1 } })
    for (const [movedId, place] of moved) if (movedId !== id) tools.audit({ action: 'quality.moveInspectionTrigger', recordType: TRIGGER_RECORD, recordId: movedId, companyId: body.companyId, before: { sortOrder: place.before }, after: { sortOrder: place.after } })
    changed(tools, row, body.companyId, 'CREATED')
    return { id }
  })
  return caller.withClient(async (client) => {
    const rules = await companyRules(client as unknown as Db, body.companyId, new Date())
    return { rule: rules.find((rule) => rule.id === result.id)!, rules }
  })
}

// ---- a change ----------------------------------------------------------------------------------------------------------

export interface EditBody {
  readonly version: number
  readonly event?: TriggerEvent | undefined
  readonly planId?: string | undefined
  readonly appliesTo?: readonly Chip[] | undefined
  readonly frequency?: Frequency | undefined
  readonly frequencyValue?: number | null | undefined
  readonly dueHours?: number | null | undefined
  readonly active?: boolean | undefined
}

/** PATCH /quality/inspection-triggers/:triggerId. */
export async function editRule(caller: CommandCaller, triggerId: string, body: EditBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const before = await caller.withClient((client) => readRule(client as unknown as Db, context, triggerId))
  assertManage(context, before.companyId)
  const next = {
    event: body.event ?? (before.event as TriggerEvent),
    planId: body.planId ?? before.planId,
    appliesTo: body.appliesTo ?? chipsOf(before.appliesTo),
    frequency: body.frequency ?? (before.frequency as Frequency),
    // A new frequency takes the number sent with it (none: none); the same frequency keeps its number unless one is sent.
    frequencyValue: body.frequencyValue !== undefined ? body.frequencyValue : body.frequency && body.frequency !== before.frequency ? null : before.frequencyValue,
    dueHours: body.dueHours !== undefined ? body.dueHours : before.dueHours,
    active: body.active ?? before.active,
  }
  const plan = await caller.withClient(async (client) => {
    const db = client as unknown as Db
    const plan = await planFor(db, before.companyId, next.planId)
    const problems = [...ruleProblems({ event: next.event, stage: plan.stage, appliesTo: next.appliesTo, frequency: next.frequency, frequencyValue: next.frequencyValue, dueHours: next.dueHours }), ...(body.appliesTo ? await chipRefsProblems(db, before.companyId, body.appliesTo) : [])]
    if (problems.length > 0) refuse(problems, 'The change is not valid.')
    return plan
  })
  if (next.active) assertApproved(plan)
  await command(caller, { name: 'quality.editInspectionTrigger', idempotencyKey, input: { triggerId, ...body }, record: { type: 'InspectionTrigger', id: before.id, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    await holdPlan(tx, plan, next.active)
    const current = (await tx.inspectionTrigger.findUnique({ where: { id: before.id }, select: TRIGGER_COLUMNS }))!
    const data: Prisma.InspectionTriggerUncheckedUpdateInput = {
      event: next.event,
      planId: plan.id,
      appliesTo: next.appliesTo.map((chip) => ({ kind: chip.kind, value: chip.value })),
      frequency: next.frequency,
      frequencyValue: next.frequencyValue ?? null,
      dueHours: next.dueHours ?? null,
      active: next.active,
      updatedAt: now,
    }
    const after = await tx.inspectionTrigger.update({ where: { id: current.id }, data, select: TRIGGER_COLUMNS })
    tools.audit({ recordType: TRIGGER_RECORD, recordId: after.id, companyId: after.companyId, before: audited(current), after: audited(after, plan) })
    const onlySwitch = body.active !== undefined && body.active !== current.active && Object.keys(body).every((key) => key === 'version' || key === 'active')
    changed(tools, after, after.companyId, onlySwitch ? (after.active ? 'SWITCHED_ON' : 'SWITCHED_OFF') : 'EDITED')
    return { id: after.id }
  })
  return caller.withClient(async (client) => {
    const rules = await companyRules(client as unknown as Db, before.companyId, new Date())
    return { rule: rules.find((rule) => rule.id === before.id)! }
  })
}

// ---- deleting ----------------------------------------------------------------------------------------------------------

/** DELETE /quality/inspection-triggers/:triggerId?version=. */
export async function deleteRule(caller: CommandCaller, triggerId: string, query: { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const before = await caller.withClient((client) => readRule(client as unknown as Db, context, triggerId))
  assertManage(context, before.companyId)
  const plan = await caller.withClient(async (client) => (await plansOf(client as unknown as Db, [before.planId])).get(before.planId))
  const { result } = await command(caller, { name: 'quality.deleteInspectionTrigger', idempotencyKey, input: { triggerId, ...query }, record: { type: 'InspectionTrigger', id: before.id, expectedVersion: query.version } }, async (tools) => {
    const { tx, now } = tools
    await lockCompanyRules(tx, before.companyId)
    const current = await tx.inspectionTrigger.findUnique({ where: { id: before.id }, select: TRIGGER_COLUMNS })
    if (!current) throw new NotFoundError('Inspection rule not found.')
    // B-W2b-213: the records a rule opened name it (a foreign key with Restrict): it is switched off, never deleted then.
    const opened = await recordsOpenedBy(tx, current.id)
    if (opened > 0) {
      throw new TriggerRefusedError(
        'OPENED_RECORDS',
        `This rule opened ${opened} ${opened === 1 ? 'inspection' : 'inspections'}: each keeps it as the rule that opened it, so it is not deleted. Switch it off instead: it opens nothing more.`,
      )
    }
    await tx.inspectionTrigger.delete({ where: { id: current.id }, select: { id: true } })
    const rest = inOrder(await tx.inspectionTrigger.findMany({ where: { companyId: current.companyId }, select: { id: true, sortOrder: true } }))
    const moved = await renumber(tx, rest, now)
    tools.audit({ recordType: TRIGGER_RECORD, recordId: current.id, companyId: current.companyId, before: audited(current, plan), after: { deleted: true } })
    for (const [movedId, place] of moved) tools.audit({ action: 'quality.moveInspectionTrigger', recordType: TRIGGER_RECORD, recordId: movedId, companyId: current.companyId, before: { sortOrder: place.before }, after: { sortOrder: place.after } })
    changed(tools, current, current.companyId, 'DELETED')
    return { deleted: { id: current.id, event: current.event as TriggerEvent, planCode: plan?.code ?? '?' } }
  })
  return { deleted: result.deleted, rules: await caller.withClient((client) => companyRules(client as unknown as Db, before.companyId, new Date())) }
}

// ---- the order ---------------------------------------------------------------------------------------------------------

/** POST /quality/inspection-triggers/order: the whole list, in its new order. */
export async function orderRules(caller: CommandCaller, body: { readonly companyId: string; readonly order: readonly string[] }, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertManage(context, body.companyId)
  await command(caller, { name: 'quality.orderInspectionTriggers', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockCompanyRules(tx, body.companyId)
    const existing = await tx.inspectionTrigger.findMany({ where: { companyId: body.companyId }, select: { id: true, sortOrder: true } })
    const problems = orderProblems(body.order, existing.map((row) => row.id))
    if (problems.length > 0) refuse(problems, 'The new order is not valid.')
    const byId = new Map(existing.map((row) => [row.id, row] as const))
    const moved = await renumber(tx, body.order.map((id) => byId.get(id)!), now)
    for (const [movedId, place] of moved) tools.audit({ action: 'quality.moveInspectionTrigger', recordType: TRIGGER_RECORD, recordId: movedId, companyId: body.companyId, before: { sortOrder: place.before }, after: { sortOrder: place.after } })
    if (moved.size === 0) tools.audit({ recordType: 'Company', recordId: body.companyId, companyId: body.companyId, after: { inspectionTriggers: 'order unchanged' } })
    changed(tools, null, body.companyId, 'REORDERED')
    return { moved: moved.size }
  })
  return { rules: await caller.withClient((client) => companyRules(client as unknown as Db, body.companyId, new Date())) }
}
