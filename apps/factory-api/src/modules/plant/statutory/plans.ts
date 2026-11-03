import type { CheckIntervalUnit as DbCheckIntervalUnit, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import { PLANT_CHECKS_MANAGE } from '@nexus/factory-domain/plant/statutory/permissions'
import {
  addDays,
  beforeFirstDue,
  CHECK_LIMITS,
  dateOf,
  dayOf,
  DUE_SOON_DAYS,
  intervalProblems,
  machineRetired,
  planEnded,
  planExists,
  reminderProblems,
  sameDate,
  typeOtherClass,
  typeRetired,
  type CheckIntervalUnit,
  type CheckPlanStatus,
  type DueState,
} from '@nexus/factory-domain/plant/statutory/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { assertMay, assertMayWrite, assertVersion, bodyIssue, may, officeOf, problemsError, scopeOf } from '../access'
import { lockMachine, readMachine } from '../store'
import { checkOutsideBody, checkOwner, lockPlan, PLAN_COLUMNS, planViews, readPlan, refuse, RESULT_COLUMNS, resultViews, todayOf, type PlanRow } from './store'

/**
 * The check plans of machines (B-W2b-124; QHS-205; design plant.preventive "Plans", pop-ups "New plan", "Plan", "Move a
 * check"): one check type on one machine with its interval, outside body, owner, first and next due date and reminder
 * lead time. One ACTIVE plan per machine and type (the database's partial unique index): a new plan in place of an
 * active one ends it in the same command, with the reason. Reads need plant.view; writes plant.checks.manage over the
 * machine's company and site. Every write is one command(): the machine row locked first, then the plan (the plant's lock
 * order), the version read, the rules, the change, its audit row and `machine_check_plan.changed`. Moving the next due
 * date (by hand or by a result) clears lastRemindedAt, so each due date is reminded once (./reminders.ts).
 *
 *   GET  /plant/checks/plans[?siteId&machineId&checkTypeId&status&due&cursor&limit]   the grid (soonest due first)
 *   GET  /plant/checks/plans/:planId              the plan with its results (newest first)
 *   POST /plant/checks/plans                      a plan (in place of the active one with `replaceReason`)
 *   PATCH /plant/checks/plans/:planId             interval, outside body, owner, reminder, note
 *   POST /plant/checks/plans/:planId/move         the next due date, with the reason (the audit row keeps it)
 *   POST /plant/checks/plans/:planId/end          ended, with the reason (its results stay)
 */

const SOONEST: Prisma.MachineCheckPlanOrderByWithRelationInput[] = [{ nextDueOn: 'asc' }, { id: 'asc' }]

export interface PlanListQuery {
  readonly siteId?: string | undefined
  readonly machineId?: string | undefined
  readonly checkTypeId?: string | undefined
  readonly status?: CheckPlanStatus | undefined
  readonly due?: Extract<DueState, 'OVERDUE' | 'DUE_SOON'> | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** A due filter as a where: overdue = before today, due soon = today to today + 30 days (ACTIVE plans only). */
export const dueWhere = (due: 'OVERDUE' | 'DUE_SOON', today: BusinessDate): Prisma.MachineCheckPlanWhereInput =>
  due === 'OVERDUE' ? { status: 'ACTIVE', nextDueOn: { lt: dateOf(today) } } : { status: 'ACTIVE', nextDueOn: { gte: dateOf(today), lte: dateOf(addDays(today, DUE_SOON_DAYS)) } }

/** GET /plant/checks/plans: ACTIVE ones by default, the soonest due first; a cursor of `<nextDueOn>|<id>`. */
export async function listPlans(caller: CommandCaller, query: PlanListQuery) {
  const context = officeOf(caller)
  const now = new Date()
  const today = todayOf(now)
  const filters: Prisma.MachineCheckPlanWhereInput[] = [scopeOf(context, PLANT_VIEW) as Prisma.MachineCheckPlanWhereInput]
  if (query.siteId) filters.push({ siteId: query.siteId })
  if (query.machineId) filters.push({ machineId: query.machineId })
  if (query.checkTypeId) filters.push({ checkTypeId: query.checkTypeId })
  filters.push({ status: query.status ?? 'ACTIVE' })
  if (query.due) filters.push(dueWhere(query.due, today))
  const cursor = cursorOf(query.cursor)
  if (cursor) filters.push({ OR: [{ nextDueOn: { gt: dateOf(cursor.day) } }, { nextDueOn: dateOf(cursor.day), id: { gt: cursor.id } }] })
  return caller.withClient(async (client) => {
    const rows = await client.machineCheckPlan.findMany({ where: { AND: filters }, orderBy: SOONEST, take: query.limit + 1, select: PLAN_COLUMNS })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return { plans: await planViews(client, page, now), nextCursor: rows.length > query.limit && last ? `${dayOf(last.nextDueOn)}|${last.id}` : null, today }
  })
}

/** `<YYYY-MM-DD>|<uuid>`, or null when absent or not that shape. */
export function cursorOf(value: string | undefined): { day: BusinessDate; id: string } | null {
  if (!value) return null
  const [day = '', id = ''] = value.split('|')
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && isUuid(id) ? { day, id } : null
}

/** A plan the caller may see, else 404. */
async function knownPlan(caller: CommandCaller, context: OfficeContext, planId: string): Promise<PlanRow> {
  const row = isUuid(planId) ? await caller.withClient((client) => readPlan(client, planId)) : null
  if (!row) throw new NotFoundError('Check plan not found.')
  assertMay(context, PLANT_VIEW, row, 'Check plan')
  return row
}

/** GET /plant/checks/plans/:planId: the plan, its results (newest first), what this person may do. */
export async function planRecord(caller: CommandCaller, planId: string) {
  const context = officeOf(caller)
  const known = await knownPlan(caller, context, planId)
  const now = new Date()
  return caller.withClient(async (client) => {
    const [plan] = await planViews(client, [known], now)
    const results = await client.machineCheckResult.findMany({ where: { planId: known.id }, orderBy: [{ performedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], take: CHECK_LIMITS.page, select: RESULT_COLUMNS })
    const manage = may(context, PLANT_CHECKS_MANAGE, known)
    return { plan: plan!, results: await resultViews(client, results), canManage: manage && known.status === 'ACTIVE', canRecord: manage && known.status === 'ACTIVE' && known.machine.status !== 'RETIRED' }
  })
}

async function planAnswer(tx: CommandTx, id: string, now: Date) {
  const [view] = await planViews(tx, [(await readPlan(tx, id))!], now)
  return view!
}

function planChanged(tools: Pick<CommandTools, 'emit'>, plan: Pick<PlanRow, 'id' | 'companyId' | 'siteId' | 'machineId' | 'checkTypeId'> & { readonly machine: { readonly assetNumber: string } }, after: { readonly nextDueOn: BusinessDate; readonly interval: number; readonly intervalUnit: CheckIntervalUnit }, change: 'CREATED' | 'CHANGED' | 'MOVED' | 'ENDED', fields: readonly string[], replacedPlanId: string | null = null): void {
  tools.emit({
    type: 'machine_check_plan.changed',
    subject: plan.id,
    companyId: plan.companyId,
    siteId: plan.siteId,
    payload: { planId: plan.id, machineId: plan.machineId, assetNumber: plan.machine.assetNumber, checkTypeId: plan.checkTypeId, change, nextDueOn: after.nextDueOn, interval: after.interval, intervalUnit: after.intervalUnit, replacedPlanId, fields: [...fields] },
  })
}

/** Ends an ACTIVE plan inside the caller's command (its row locked by the caller): when, why, its audit row and event. */
export async function endPlanInCommand(tools: CommandTools, plan: PlanRow, reason: string, cause: 'BY_HAND' | 'REPLACED' | 'MACHINE_RETIRED'): Promise<void> {
  const { tx, now } = tools
  await tx.machineCheckPlan.update({ where: { id: plan.id }, data: { status: 'ENDED', endedAt: now, endedReason: reason, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  tools.audit({ action: 'plant.endCheckPlan', recordType: 'MachineCheckPlan', recordId: plan.id, companyId: plan.companyId, siteId: plan.siteId, before: { status: plan.status }, after: { status: 'ENDED', endedReason: reason, cause }, reason })
  planChanged(tools, plan, { nextDueOn: dayOf(plan.nextDueOn), interval: plan.interval, intervalUnit: plan.intervalUnit as CheckIntervalUnit }, 'ENDED', ['status'])
}

/**
 * The hook for retiring a machine (B-W2b-136): ends every ACTIVE check plan of the machine inside the retiring command,
 * whose machine row is locked first. The database refuses a NEW plan on a retired machine, never an old one: this ends them.
 */
export async function endPlansOfMachineInCommand(tools: CommandTools, machineId: string, reason: string): Promise<number> {
  const active = await tools.tx.machineCheckPlan.findMany({ where: { machineId, status: 'ACTIVE' }, orderBy: { id: 'asc' }, select: { id: true } })
  for (const { id } of active) await endPlanInCommand(tools, (await lockPlan(tools.tx, id))!, reason, 'MACHINE_RETIRED')
  return active.length
}

export interface CreatePlanBody {
  readonly machineId: string
  readonly checkTypeId: string
  /** Default: the type's default interval and unit (both or neither). */
  readonly interval?: number | undefined
  readonly intervalUnit?: CheckIntervalUnit | undefined
  readonly outsideBodyPartyId?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly firstDueOn: BusinessDate
  readonly reminderDays?: number | undefined
  readonly note?: string | null | undefined
  /** The ACTIVE plan of this machine and type is ended in the same command, with this reason. */
  readonly replaceReason?: string | undefined
}

/** POST /plant/checks/plans. */
export async function createPlan(caller: CommandCaller, body: CreatePlanBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await caller.withClient((client) => readMachine(client, context, body.machineId))
  if (!known) throw bodyIssue('machineId', 'Not a machine of the group.')
  assertMay(context, PLANT_VIEW, known, 'Machine')
  assertMayWrite(context, PLANT_CHECKS_MANAGE, known, 'Check plans of this site are kept by a role that keeps the statutory checks (plant.checks.manage).')
  if ((body.interval === undefined) !== (body.intervalUnit === undefined)) throw bodyIssue('interval', 'Give the interval with its unit, or neither (the type\'s default).')
  const problems = [...(body.interval !== undefined ? intervalProblems(body.interval, body.intervalUnit) : []), ...reminderProblems(body.reminderDays)]
  if (problems.length > 0) throw problemsError(problems, 'The plan is not valid.')
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'plant.createCheckPlan', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, known.id))!
    if (machine.status === 'RETIRED') refuse(machineRetired(machine.assetNumber))
    const type = await tx.machineCheckType.findFirst({ where: { id: body.checkTypeId }, select: { id: true, code: true, classId: true, active: true, defaultInterval: true, defaultIntervalUnit: true } })
    if (!type) throw bodyIssue('checkTypeId', 'Not a check type of the group.')
    if (!type.active) refuse(typeRetired(type.code))
    if (type.classId !== null && type.classId !== machine.classId) refuse(typeOtherClass(type.code, machine.assetNumber))
    const outsideBodyPartyId = await checkOutsideBody(tx, body.outsideBodyPartyId, machine.companyId)
    const ownerId = await checkOwner(tx, context.tenantId, body.ownerId, machine, now)
    // One ACTIVE plan per machine and type: the one there now ends first, when the person said why.
    const current = await tx.machineCheckPlan.findFirst({ where: { machineId: machine.id, checkTypeId: type.id, status: 'ACTIVE' }, select: { id: true } })
    let replaced: string | null = null
    if (current) {
      const locked = (await lockPlan(tx, current.id))!
      if (!body.replaceReason?.trim()) refuse(planExists(type.code, machine.assetNumber, dayOf(locked.nextDueOn)))
      await endPlanInCommand(tools, locked, body.replaceReason!.trim(), 'REPLACED')
      replaced = locked.id
    }
    const interval = body.interval ?? type.defaultInterval
    const intervalUnit = (body.intervalUnit ?? type.defaultIntervalUnit) as CheckIntervalUnit
    await tx.machineCheckPlan.create({
      data: {
        id,
        companyId: machine.companyId,
        siteId: machine.siteId,
        machineId: machine.id,
        checkTypeId: type.id,
        interval,
        intervalUnit: intervalUnit as DbCheckIntervalUnit,
        outsideBodyPartyId,
        ownerId,
        firstDueOn: dateOf(body.firstDueOn),
        nextDueOn: dateOf(body.firstDueOn),
        reminderDays: body.reminderDays ?? 30,
        note: body.note?.trim() || null,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    const scope = { companyId: machine.companyId, siteId: machine.siteId }
    tools.audit({
      action: 'plant.createCheckPlan',
      recordType: 'MachineCheckPlan',
      recordId: id,
      ...scope,
      after: { machineId: machine.id, checkTypeId: type.id, interval, intervalUnit, outsideBodyPartyId, ownerId, firstDueOn: body.firstDueOn, reminderDays: body.reminderDays ?? 30, note: body.note?.trim() || null, replacedPlanId: replaced },
      ...(replaced ? { reason: body.replaceReason!.trim() } : {}),
    })
    planChanged(tools, { id, ...scope, machineId: machine.id, checkTypeId: type.id, machine }, { nextDueOn: body.firstDueOn, interval, intervalUnit }, 'CREATED', [], replaced)
    return { plan: await planAnswer(tx, id, now), replacedPlanId: replaced }
  })
  return { ...result, replayed }
}

/** The plan for a write: the machine row locked first, then the plan, its version, still ACTIVE. */
async function lockedPlan(tools: CommandTools, context: OfficeContext, known: PlanRow, version: number): Promise<PlanRow> {
  await lockMachine(tools.tx, context, known.machineId)
  const plan = (await lockPlan(tools.tx, known.id))!
  assertVersion('check plan', plan.version, version)
  if (plan.status !== 'ACTIVE') refuse(planEnded())
  return plan
}

export interface UpdatePlanBody {
  readonly version: number
  readonly interval?: number | undefined
  readonly intervalUnit?: CheckIntervalUnit | undefined
  readonly outsideBodyPartyId?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly reminderDays?: number | undefined
  readonly note?: string | null | undefined
}

/** PATCH /plant/checks/plans/:planId: what the next results go by (the next due date moves by a result or by "move"). */
export async function updatePlan(caller: CommandCaller, planId: string, body: UpdatePlanBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await knownPlan(caller, context, planId)
  assertMayWrite(context, PLANT_CHECKS_MANAGE, known, 'Check plans of this site are kept by a role that keeps the statutory checks (plant.checks.manage).')
  const { result, replayed } = await command(caller, { name: 'plant.updateCheckPlan', idempotencyKey, input: { planId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const plan = await lockedPlan(tools, context, known, body.version)
    const interval = body.interval ?? plan.interval
    const intervalUnit = body.intervalUnit ?? (plan.intervalUnit as CheckIntervalUnit)
    const problems = [...(body.interval !== undefined || body.intervalUnit !== undefined ? intervalProblems(interval, intervalUnit) : []), ...reminderProblems(body.reminderDays)]
    if (problems.length > 0) throw problemsError(problems, 'The change is not valid.')
    const data: Prisma.MachineCheckPlanUncheckedUpdateInput = { version: { increment: 1 }, updatedAt: now }
    const fields: string[] = []
    if (interval !== plan.interval) (data.interval = interval), fields.push('interval')
    if (intervalUnit !== plan.intervalUnit) (data.intervalUnit = intervalUnit as DbCheckIntervalUnit), fields.push('intervalUnit')
    if (body.outsideBodyPartyId !== undefined) {
      const next = await checkOutsideBody(tx, body.outsideBodyPartyId, plan.companyId)
      if (next !== plan.outsideBodyPartyId) (data.outsideBodyPartyId = next), fields.push('outsideBodyPartyId')
    }
    if (body.ownerId !== undefined) {
      const next = await checkOwner(tx, context.tenantId, body.ownerId, plan, now)
      if (next !== plan.ownerId) (data.ownerId = next), fields.push('ownerId')
    }
    // A new lead time moves the window of a reminder not sent yet; a due date already reminded is not reminded again.
    if (body.reminderDays !== undefined && body.reminderDays !== plan.reminderDays) (data.reminderDays = body.reminderDays), fields.push('reminderDays')
    if (body.note !== undefined && (body.note?.trim() || null) !== plan.note) (data.note = body.note?.trim() || null), fields.push('note')
    const scope = { companyId: plan.companyId, siteId: plan.siteId }
    if (fields.length === 0) {
      tools.audit({ action: 'plant.updateCheckPlan', recordType: 'MachineCheckPlan', recordId: plan.id, ...scope, after: { unchanged: true } })
      return { plan: await planAnswer(tx, plan.id, now) }
    }
    await tx.machineCheckPlan.update({ where: { id: plan.id }, data, select: { id: true } })
    tools.audit({
      action: 'plant.updateCheckPlan',
      recordType: 'MachineCheckPlan',
      recordId: plan.id,
      ...scope,
      before: { interval: plan.interval, intervalUnit: plan.intervalUnit, outsideBodyPartyId: plan.outsideBodyPartyId, ownerId: plan.ownerId, reminderDays: plan.reminderDays, note: plan.note },
      after: { interval, intervalUnit, outsideBodyPartyId: data.outsideBodyPartyId ?? plan.outsideBodyPartyId, ownerId: data.ownerId ?? plan.ownerId, reminderDays: body.reminderDays ?? plan.reminderDays, note: data.note === undefined ? plan.note : data.note },
    })
    planChanged(tools, plan, { nextDueOn: dayOf(plan.nextDueOn), interval, intervalUnit }, 'CHANGED', fields)
    return { plan: await planAnswer(tx, plan.id, now) }
  })
  return { ...result, replayed }
}

/** POST /plant/checks/plans/:planId/move: "Move a check" (design: drag a chip; reason recorded in the audit row). */
export async function movePlan(caller: CommandCaller, planId: string, body: { readonly version: number; readonly nextDueOn: BusinessDate; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await knownPlan(caller, context, planId)
  assertMayWrite(context, PLANT_CHECKS_MANAGE, known, 'Check plans of this site are kept by a role that keeps the statutory checks (plant.checks.manage).')
  const reason = body.reason.trim()
  if (!reason) throw bodyIssue('reason', 'Say why the check moves.')
  const { result, replayed } = await command(caller, { name: 'plant.moveCheckPlan', idempotencyKey, input: { planId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const plan = await lockedPlan(tools, context, known, body.version)
    const before = dayOf(plan.nextDueOn)
    if (body.nextDueOn === before) refuse(sameDate(before))
    if (body.nextDueOn < dayOf(plan.firstDueOn)) refuse(beforeFirstDue(dayOf(plan.firstDueOn)))
    await tx.machineCheckPlan.update({ where: { id: plan.id }, data: { nextDueOn: dateOf(body.nextDueOn), lastRemindedAt: null, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'plant.moveCheckPlan', recordType: 'MachineCheckPlan', recordId: plan.id, companyId: plan.companyId, siteId: plan.siteId, before: { nextDueOn: before }, after: { nextDueOn: body.nextDueOn }, reason })
    planChanged(tools, plan, { nextDueOn: body.nextDueOn, interval: plan.interval, intervalUnit: plan.intervalUnit as CheckIntervalUnit }, 'MOVED', ['nextDueOn'])
    return { plan: await planAnswer(tx, plan.id, now) }
  })
  return { ...result, replayed }
}

/** POST /plant/checks/plans/:planId/end. */
export async function endPlan(caller: CommandCaller, planId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await knownPlan(caller, context, planId)
  assertMayWrite(context, PLANT_CHECKS_MANAGE, known, 'Check plans of this site are kept by a role that keeps the statutory checks (plant.checks.manage).')
  const reason = body.reason.trim()
  if (!reason) throw bodyIssue('reason', 'Say why the plan ends.')
  const { result, replayed } = await command(caller, { name: 'plant.endCheckPlan', idempotencyKey, input: { planId, ...body } }, async (tools) => {
    const plan = await lockedPlan(tools, context, known, body.version)
    await endPlanInCommand(tools, plan, reason, 'BY_HAND')
    return { plan: await planAnswer(tools.tx, plan.id, tools.now) }
  })
  return { ...result, replayed }
}
