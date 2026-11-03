import { createHash } from 'node:crypto'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import {
  addDays,
  CAPA_RECORD,
  escalationDue,
  escalationTask,
  REMIND_LOOK_AHEAD_DAYS,
  reminderDue,
  reminderTask,
  taskLanguageOf,
  type ActionStatus,
} from '@nexus/factory-domain/quality/capa/rules'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings, type CommandTools, type CommandTx } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { liveAssignment } from '../../../platform/auth/roles/access'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { followInCommand } from '../../../platform/threads/followers'
import { asDay, dayOf, lockCapa, personActor, readCapa, remindable, scopeOf, seesCapa, ACTION_COLUMNS, type ActionRow, type CapaRow, type Reader } from './store'

/**
 * Reminders and escalation of CAPA actions (B-W2b-108; QHS-096 "CAPA actions with reminders, using tasks (COL-037)";
 * design quality.capa capa-actions "overdue rows escalate by rule (quality.settings)", live capa.action_due /
 * capa.action_overdue). Both are tasks on the CAPA (platform/tasks' Task rows, written here in the same command): the
 * notification centre tells the assignee (task.assigned → ASSIGNMENT, "The system assigned you …"), My tasks lists them,
 * and the CAPA's own tasks panel shows them. Nothing is mailed by this step (a person's digest carries their notifications;
 * off by default) and nothing reaches a customer.
 *
 *   reminder    an open action, at each moment of factory-domain rules reminderDue (3 days before its due day and on the
 *               day, from 07:00 Rome): a task for its owner (else, when the owner may not be given tasks on the CAPA, its
 *               CAPA's owner; else nobody's, on the record), due on the action's day, in the assignee's language; the
 *               earlier reminder's task, still open, is closed (one open reminder per action); remindersSent + 1 and
 *               lastRemindedAt (always later than the last); capa.action_due. Also by hand (POST …/remind, ./actions.ts).
 *   escalation  once, when the action is overdue plus the waiting time of the company's CAPA_ACTION_OVERDUE rule
 *               (QualityAlertRule: the company's rows when it has any, else the tenant's; withinMinutes; enabled): to the
 *               action's escalation path (escalateToId) when set, else the rule's audience (OWNER = the CAPA's owner, ROLE =
 *               the people who hold the rule's role over the company, OWNER_AND_ROLE both); only ACTIVE office people who see
 *               the CAPA; a task each (those who may be given one); escalatedAt; capa.action_overdue. With no path and no
 *               rule switched on, nothing escalates.
 *   ending      an action done or cancelled (and a CAPA cancelled) closes its open reminder and escalation tasks.
 *
 * Task ids are derived from the action (reminder n, escalation to a person): the same reminder never makes two tasks, and
 * the tasks of an action are found again without a column of their own.
 *
 * The clustered cron `quality.capaReminders` (every 15 minutes; scheduler only): per tenant, as its system, every open
 * action of an open CAPA whose reminder or escalation is due, each in ONE system command keyed
 * `capa-remind:<action>:<moment>` / `capa-escalate:<action>` (a second tick answers from its receipt): the CAPA's row FOR
 * UPDATE first (the module's lock order), the action read again and the step decided again inside.
 */

const [taskCreated, taskAssigned, taskCompleted, taskChanged] = taskEvents

/** A UUID (version 8, RFC 9562) derived from a text: the same text, the same id. */
function derivedId(text: string): string {
  const hex = createHash('sha256').update(text).digest('hex')
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export const reminderTaskId = (actionId: string, reminder: number): string => derivedId(`capa-reminder|${actionId}|${reminder}`)
export const escalationTaskId = (actionId: string, userId: string): string => derivedId(`capa-escalation|${actionId}|${userId}`)

type Tools = Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit'>

/** A task on the CAPA, written as platform/tasks writes one, by the system (no maker). */
async function writeTask(tools: Tools, capa: CapaRow, task: { readonly id: string; readonly assigneeId: string | null; readonly title: string; readonly description: string; readonly dueDate: BusinessDate }): Promise<void> {
  const { tx, now } = tools
  const scope = { companyId: capa.companyId, siteId: null }
  await tx.task.create({
    data: {
      id: task.id,
      companyId: capa.companyId,
      siteId: null,
      partyId: capa.customerId,
      title: task.title,
      description: task.description,
      recordType: CAPA_RECORD,
      recordId: capa.id,
      recordLabel: capa.number,
      assigneeId: task.assigneeId,
      // The row names who assigns (the CAPA's owner, on whose behalf its reminders go); the event says the system did.
      assignedById: task.assigneeId ? capa.ownerId : null,
      assignedAt: task.assigneeId ? now : null,
      dueDate: asDay(task.dueDate),
      checklist: [],
      createdAt: now,
      updatedAt: now,
      createdById: null,
    },
    select: { id: true },
  })
  tools.audit({ action: 'tasks.create', recordType: 'Task', recordId: task.id, ...scope, after: { title: task.title, dueDate: task.dueDate, assigneeId: task.assigneeId, status: 'OPEN', recordType: CAPA_RECORD, recordId: capa.id, by: 'capa' } })
  const about = { taskId: task.id, recordType: CAPA_RECORD, recordId: capa.id }
  tools.emit(eventFor(taskCreated, { subject: task.id, ...scope, payload: { ...about, assigneeId: task.assigneeId } }))
  if (task.assigneeId) {
    tools.emit(eventFor(taskAssigned, { subject: task.id, ...scope, payload: { ...about, assigneeId: task.assigneeId, assignedById: null } }))
    if (await tx.user.findUnique({ where: { id: task.assigneeId }, select: { id: true } })) await followInCommand(tools, { type: CAPA_RECORD, id: capa.id, companyId: capa.companyId, siteId: null }, task.assigneeId, 'ASSIGNEE', null)
  }
}

/** Closes an open task (DONE or CANCELLED), as platform/tasks does; false when it is not there or not open. */
async function closeTask(tools: Tools, taskId: string, status: 'DONE' | 'CANCELLED', by: string | null): Promise<boolean> {
  const { tx, now } = tools
  const row = await tx.task.findUnique({ where: { id: taskId }, select: { id: true, status: true, companyId: true, siteId: true, recordType: true, recordId: true } })
  if (!row || row.status !== 'OPEN') return false
  const { count } = await tx.task.updateMany({ where: { id: taskId, status: 'OPEN' }, data: { status, closedAt: now, closedById: by, snoozedUntil: null, version: { increment: 1 }, updatedAt: now } })
  if (count === 0) return false
  const scope = { companyId: row.companyId, siteId: row.siteId }
  tools.audit({ action: 'tasks.status', recordType: 'Task', recordId: taskId, ...scope, before: { status: 'OPEN' }, after: { status, by: 'capa' } })
  const about = { taskId, recordType: row.recordType, recordId: row.recordId }
  if (status === 'DONE') tools.emit(eventFor(taskCompleted, { subject: taskId, ...scope, payload: about }))
  else tools.emit(eventFor(taskChanged, { subject: taskId, ...scope, payload: { ...about, status, fields: ['status'] } }))
  return true
}

/** Closes the open reminder and escalation tasks of an action (it ended, or its CAPA was cancelled). Answers how many. */
export async function closeReminderTasks(tools: Tools, capa: Pick<CapaRow, 'id'>, action: Pick<ActionRow, 'id' | 'remindersSent'>, status: 'DONE' | 'CANCELLED', by: string | null = null): Promise<number> {
  const open = await tools.tx.task.findMany({ where: { recordType: CAPA_RECORD, recordId: capa.id, status: 'OPEN', createdById: null }, select: { id: true, assigneeId: true } })
  const reminders = new Set(Array.from({ length: action.remindersSent }, (_, index) => reminderTaskId(action.id, index + 1)))
  let closed = 0
  for (const task of open) {
    const mine = reminders.has(task.id) || (task.assigneeId !== null && task.id === escalationTaskId(action.id, task.assigneeId))
    if (mine && (await closeTask(tools, task.id, status, by))) closed++
  }
  return closed
}

/** A person's language for the words of their task (their profile's; Italian by default). */
async function languageOf(db: Reader, userId: string | null) {
  if (!userId) return taskLanguageOf(null)
  return taskLanguageOf((await db.user.findUnique({ where: { id: userId }, select: { locale: true } }))?.locale)
}

/** Whether the person may be given a task on the CAPA now: ACTIVE, and platform/tasks' rule over the CAPA's scope. */
async function mayTake(db: Reader, tenantId: string, userId: string, capa: CapaRow, now: Date): Promise<boolean> {
  const user = await db.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true } })
  return user !== null && remindable(await personActor(db, tenantId, userId, now), scopeOf(capa))
}

const later = (last: Date | null, now: Date): Date => (last && last.getTime() >= now.getTime() ? new Date(last.getTime() + 1) : now)

/**
 * Sends the next reminder of an open action inside the caller's command (the CAPA's row is locked by it): the task, the
 * count and time, the earlier reminder's task closed, the audit row on the CAPA and capa.action_due.
 */
export async function remindInCommand(tools: Tools, tenantId: string, capa: CapaRow, action: ActionRow, options: { readonly byHand: boolean; readonly moment: Date | null; readonly by: string | null }): Promise<{ reminder: number; taskId: string | null; assigneeId: string | null }> {
  const { tx, now } = tools
  const reminder = action.remindersSent + 1
  const ownerTakes = await mayTake(tx, tenantId, action.ownerId, capa, now)
  const assigneeId = ownerTakes ? action.ownerId : (await mayTake(tx, tenantId, capa.ownerId, capa, now)) ? capa.ownerId : null
  const words = reminderTask(await languageOf(tx, assigneeId), { number: capa.number, seq: action.seq, description: action.description, dueOn: dayOf(action.dueOn), ownerName: null })
  if (action.remindersSent > 0) await closeTask(tools, reminderTaskId(action.id, action.remindersSent), 'CANCELLED', options.by)
  const taskId = reminderTaskId(action.id, reminder)
  await writeTask(tools, capa, { id: taskId, assigneeId, title: words.title, description: words.description, dueDate: dayOf(action.dueOn) })
  const at = later(action.lastRemindedAt, now)
  await tx.capaAction.update({ where: { id: action.id }, data: { remindersSent: reminder, lastRemindedAt: at, updatedAt: now }, select: { id: true } })
  tools.audit({
    action: 'quality.remindCapaAction',
    recordType: CAPA_RECORD,
    recordId: capa.id,
    companyId: capa.companyId,
    before: { actionId: action.id, remindersSent: action.remindersSent },
    after: { actionId: action.id, seq: action.seq, remindersSent: reminder, lastRemindedAt: at.toISOString(), taskId, assigneeId, ownerTakesTasks: ownerTakes, byHand: options.byHand, moment: options.moment?.toISOString() ?? null },
  })
  tools.emit({ type: 'capa.action_due', subject: capa.id, companyId: capa.companyId, payload: { capaId: capa.id, number: capa.number, actionId: action.id, seq: action.seq, dueOn: dayOf(action.dueOn), reminder, taskId, byHand: options.byHand } })
  return { reminder, taskId, assigneeId }
}

// ---- escalation ----------------------------------------------------------------------------------------------------------

export interface EscalationRule {
  readonly ids: readonly string[]
  /** The shortest wait of the rules switched on, in minutes; null: no rule is on. */
  readonly withinMinutes: number | null
  readonly owner: boolean
  readonly roleIds: readonly string[]
}

/** The company's CAPA_ACTION_OVERDUE rules (its own rows when it has any, else the tenant's), the ones switched on. */
export async function escalationRuleOf(db: Reader, companyId: string): Promise<EscalationRule> {
  const rows = await db.qualityAlertRule.findMany({ where: { event: 'CAPA_ACTION_OVERDUE', OR: [{ companyId }, { companyId: null }] }, select: { id: true, companyId: true, audience: true, roleId: true, withinMinutes: true, enabled: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const own = rows.filter((row) => row.companyId === companyId)
  const on = (own.length > 0 ? own : rows.filter((row) => row.companyId === null)).filter((row) => row.enabled)
  return {
    ids: on.map((row) => row.id),
    withinMinutes: on.length === 0 ? null : Math.min(...on.map((row) => row.withinMinutes)),
    owner: on.some((row) => row.audience === 'OWNER' || row.audience === 'OWNER_AND_ROLE'),
    roleIds: [...new Set(on.flatMap((row) => (row.roleId && (row.audience === 'ROLE' || row.audience === 'OWNER_AND_ROLE') ? [row.roleId] : [])))],
  }
}

/** The wait before an action escalates: its rule's, or at once on an explicit path with no rule; null: it never escalates. */
export const escalationWait = (action: Pick<ActionRow, 'escalateToId'>, rule: EscalationRule): number | null => (action.escalateToId ? (rule.withinMinutes ?? 0) : rule.owner || rule.roleIds.length > 0 ? rule.withinMinutes : null)

/** Who an overdue action escalates to, now: its path, else the rule's audience; only ACTIVE office people who see the CAPA. */
async function escalationPeople(db: Reader, tenantId: string, capa: CapaRow, action: ActionRow, rule: EscalationRule, now: Date): Promise<string[]> {
  const wanted = new Set<string>()
  if (action.escalateToId) wanted.add(action.escalateToId)
  else {
    if (rule.owner) wanted.add(capa.ownerId)
    if (rule.roleIds.length > 0) {
      const held = await db.roleAssignment.findMany({ where: { roleId: { in: [...rule.roleIds] }, ...liveAssignment(now) }, select: { userId: true, allCompanies: true, companyIds: true }, orderBy: [{ userId: 'asc' }] })
      for (const assignment of held) if (assignment.allCompanies || assignment.companyIds.includes(capa.companyId)) wanted.add(assignment.userId)
    }
  }
  const people: string[] = []
  for (const userId of [...wanted].sort()) if (await seesCapa(db, tenantId, userId, scopeOf(capa), now)) people.push(userId)
  return people
}

/** Nothing is due any more (seen inside the command): nothing written. */
class NothingDue extends Error {}

/** Escalates an overdue action inside the caller's command (the CAPA's row locked by it): a task each, escalatedAt, the audit row, capa.action_overdue. */
export async function escalateInCommand(tools: Tools, tenantId: string, capa: CapaRow, action: ActionRow, rule: EscalationRule): Promise<{ told: string[]; tasks: string[] }> {
  const { tx, now } = tools
  const told = await escalationPeople(tx, tenantId, capa, action, rule, now)
  if (told.length === 0) throw new NothingDue()
  const owner = await tx.user.findUnique({ where: { id: action.ownerId }, select: { displayName: true } })
  const tasks: string[] = []
  for (const userId of told) {
    if (!(await mayTake(tx, tenantId, userId, capa, now))) continue
    const words = escalationTask(await languageOf(tx, userId), { number: capa.number, seq: action.seq, description: action.description, dueOn: dayOf(action.dueOn), ownerName: owner?.displayName ?? null })
    const taskId = escalationTaskId(action.id, userId)
    await writeTask(tools, capa, { id: taskId, assigneeId: userId, title: words.title, description: words.description, dueDate: businessDate(now) })
    tasks.push(taskId)
  }
  await tx.capaAction.update({ where: { id: action.id }, data: { escalatedAt: now, updatedAt: now }, select: { id: true } })
  tools.audit({ action: 'quality.escalateCapaAction', recordType: CAPA_RECORD, recordId: capa.id, companyId: capa.companyId, before: { actionId: action.id, escalatedAt: null }, after: { actionId: action.id, seq: action.seq, escalatedAt: now.toISOString(), told, tasks, path: action.escalateToId ? 'ACTION' : 'RULE', ruleIds: rule.ids } })
  tools.emit({ type: 'capa.action_overdue', subject: capa.id, companyId: capa.companyId, payload: { capaId: capa.id, number: capa.number, actionId: action.id, seq: action.seq, dueOn: dayOf(action.dueOn), told: told.length, tasks: tasks.length } })
  return { told, tasks }
}

// ---- the cron ------------------------------------------------------------------------------------------------------------

export interface RemindersOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

/** Open actions of open CAPAs near or past their due day (reminders up to the day; escalation after it, until done). */
async function candidates(db: CommandTx, now: Date) {
  const today = businessDate(now)
  return db.capaAction.findMany({
    where: {
      status: 'OPEN',
      capa: { status: { notIn: ['CLOSED', 'CANCELLED'] } },
      OR: [{ dueOn: { gte: asDay(addDays(today, -1)), lte: asDay(addDays(today, REMIND_LOOK_AHEAD_DAYS)) } }, { dueOn: { lt: asDay(today) }, escalatedAt: null }],
    },
    orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
    take: 1000,
    select: { ...ACTION_COLUMNS, capa: { select: { companyId: true } } },
  })
}

type Step = { readonly kind: 'remind'; readonly moment: Date } | { readonly kind: 'escalate' }

/** One step of one action in its own system command; false when nothing was due inside it. */
async function runStep(caller: CommandCaller, tenantId: string, action: Pick<ActionRow, 'id' | 'capaId'>, step: Step, rule: EscalationRule, settings: CommandSettings): Promise<boolean> {
  const key = step.kind === 'remind' ? `capa-remind:${action.id}:${step.moment.toISOString()}` : `capa-escalate:${action.id}`
  try {
    await runCommand(
      caller,
      { name: step.kind === 'remind' ? 'quality.remindCapaAction' : 'quality.escalateCapaAction', idempotencyKey: key, input: { actionId: action.id, ...(step.kind === 'remind' ? { moment: step.moment.toISOString() } : {}) } },
      async (tools: CommandTools) => {
        const { tx, now } = tools
        // The module's lock order: the CAPA's row first, then the action.
        const locked = await lockCapa(tx, action.capaId)
        if (!locked || locked.status === 'CLOSED' || locked.status === 'CANCELLED') throw new NothingDue()
        const capa = (await readCapa(tx, action.capaId))!
        await tx.$queryRaw`SELECT "id" FROM "CapaAction" WHERE "id" = ${action.id}::uuid FOR UPDATE`
        const row = await tx.capaAction.findUnique({ where: { id: action.id }, select: ACTION_COLUMNS })
        if (!row || row.status !== 'OPEN') throw new NothingDue()
        const facts = { status: row.status as ActionStatus, dueOn: dayOf(row.dueOn), remindersSent: row.remindersSent, lastRemindedAt: row.lastRemindedAt, escalatedAt: row.escalatedAt }
        if (step.kind === 'remind') {
          const due = reminderDue(facts, now)
          if (!due || due.getTime() !== step.moment.getTime()) throw new NothingDue()
          return remindInCommand(tools, tenantId, capa, row, { byHand: false, moment: due, by: null })
        }
        const wait = escalationWait(row, rule)
        if (wait === null || !escalationDue(facts, wait, now)) throw new NothingDue()
        return escalateInCommand(tools, tenantId, capa, row, rule)
      },
      settings,
    )
    return true
  } catch (error) {
    if (error instanceof NothingDue) return false
    throw error
  }
}

/** One pass over every tenant (the cron's body; tests call it with a moved clock). */
export async function runCapaReminders(options: RemindersOptions): Promise<{ readonly tenants: number; readonly reminded: number; readonly escalated: number; readonly failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `capa-reminders-${newId()}`
  let reminded = 0
  let escalated = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const now = settings.clock.now()
    const rows = await caller.withClient((client) => candidates(client as CommandTx, now))
    const rules = new Map<string, EscalationRule>()
    for (const row of rows) {
      const companyId = row.capa.companyId
      if (!rules.has(companyId)) rules.set(companyId, await caller.withClient((client) => escalationRuleOf(client, companyId)))
      const rule = rules.get(companyId)!
      const facts = { status: row.status as ActionStatus, dueOn: dayOf(row.dueOn), remindersSent: row.remindersSent, lastRemindedAt: row.lastRemindedAt, escalatedAt: row.escalatedAt }
      const steps: Step[] = []
      const moment = reminderDue(facts, now)
      if (moment) steps.push({ kind: 'remind', moment })
      const wait = escalationWait(row, rule)
      if (wait !== null && escalationDue(facts, wait, now)) steps.push({ kind: 'escalate' })
      for (const step of steps) {
        try {
          if (await runStep(caller, tenantId, row, step, rule, settings)) step.kind === 'remind' ? reminded++ : escalated++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, actionId: row.id, step: step.kind }, 'a CAPA action could not be reminded or escalated')
        }
      }
    }
  }
  if (reminded + escalated + failed > 0) options.log.info({ tenants: tenants.length, reminded, escalated, failed }, 'CAPA actions reminded and escalated')
  return { tenants: tenants.length, reminded, escalated, failed }
}

/** The clustered cron (scheduler only; one replica per tick): every 15 minutes. */
export function capaRemindersCron(options: RemindersOptions): CronJob {
  return defineCron({
    name: 'quality.capaReminders',
    schedule: '*/15 * * * *',
    async run() {
      await runCapaReminders(options)
    },
  })
}

