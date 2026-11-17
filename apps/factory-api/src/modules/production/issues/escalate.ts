import type { FactoryDatabase } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { productionIssueEscalated } from '@nexus/factory-domain/production-brand/events'
import {
  ESCALATION_ROLE_KEYS,
  escalationAudienceOf,
  escalationCommandKey,
  escalationTaskWords,
  escalationUnitsOf,
  type EscalatingIssue,
  type EscalationAudience,
  type EscalationUnit,
  type IssueSource,
  type IssueStatus,
} from '@nexus/factory-domain/production-brand/issues'
import { escalationClock, escalationStepAt, escalationStepsDue, type EscalationClock } from '@nexus/factory-domain/production-brand/supervisor'
import { excerptOf } from '@nexus/factory-domain/threads/rules'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings, type CommandTools, type CommandTx } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { WORKING_DAY_HORIZON_DAYS, workingCalendarFor } from '../../../platform/calendars/service'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { customerDefaultsOf, type Reader } from '../supervisor/resolver'
import { openTasksOfIssues } from './answered'
import { issueEscalationTaskId } from './raise'
import { localeOf, roleHolders, takesIssueTask, writeSystemTask, type TaskRecord } from './tasks'

/**
 * B-PR-45 — an issue nobody answered goes up (production plan §1 "no answer in 1 working day → the backup; 2 → you and Admin",
 * §3 "Issues", §7.12; lead pick L24; review fixes R-43 "one escalation per batch and step", R-44 "due = raise + 1 working day →
 * backup (else production managers); raise + 2 → Owner and Admin; step time 08:00 company time"; the CAPA escalation pattern,
 * quality/capa/reminders.ts). Both sources: a customer's "Report a problem" and the office's "Needs an answer".
 *
 * The clustered cron `production.issueEscalation` (every 15 minutes; scheduler only): per tenant, as its system, the OPEN issues
 * not yet at step 2 whose due day has come (the index (tenantId, status, dueDate)) — a scan, not timers, so the issues raised
 * before this step (B-PR-43b, slice 2) escalate too. They are grouped into escalations (factory-domain escalationUnitsOf: one
 * per batch and its task; a lone issue alone), each on the company's calendar from its earliest raise (escalationClock; a
 * company without calendar rows of its own reads the calendar defaults; a clock past the horizon never escalates), and every
 * step it has reached and not taken runs, in order, in ONE system command keyed `issue-escalate:<batch.task or issue>:<step>` (a
 * second tick answers from its receipt):
 *
 *   inside   the issues FOR UPDATE and read again: the open ones still below the step (none: nothing is written); the clock
 *            read again (the step must still be due)
 *   who      step 1 the customer's backup, else the production managers; step 2 the Owner and Admin (role holders, ACTIVE office
 *            people) — each checked on the batch task's record itself: reads its thread and may hold a task there (PW-17: a
 *            person limited to another customer is never told); someone who holds an open task of the issue already is not
 *            given a second one
 *   writes   per person a task on the batch task's record (id `issueEscalationTaskId(batch task, step, person)`, made by the
 *            system: ./answered.ts closes it with the issue), due on the day of the step at 08:00, in the person's language;
 *            `escalationStep` and `escalatedAt` on each issue (compare-and-set: never below what it took); one
 *            production_issue.escalated per issue (office live rule, no partner entry: R-48, PW-15) and one audit row
 *            `production.issuesEscalated` per escalation (one customer). A step nobody may take is still taken (the audit row
 *            says nobody was told), so the next step comes on its own clock.
 *
 * The customer never reads any of it (R-41): it keeps "Waiting on us since …" until a real reply in the thread.
 */

export const ISSUE_ESCALATION_CRON = 'production.issueEscalation'

export interface EscalationOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

const asDay = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

const ISSUE_COLUMNS = { id: true, companyId: true, siteId: true, partyId: true, recordType: true, recordId: true, taskId: true, batchId: true, source: true, status: true, raisedAt: true, escalationStep: true, createdById: true, messageId: true } as const
interface IssueRow extends EscalatingIssue {
  readonly siteId: string | null
  readonly recordType: string
  readonly recordId: string
  readonly createdById: string | null
  readonly messageId: string
}
const asRow = (row: { source: string; status: string } & Omit<IssueRow, 'source' | 'status'>): IssueRow => ({ ...row, source: row.source as IssueSource, status: row.status as IssueStatus })

/** The issues the scan looks at: open, below step 2, due by tomorrow (each company's calendar then decides). */
async function candidates(db: Reader, now: Date): Promise<IssueRow[]> {
  const rows = await db.productionIssue.findMany({
    where: { status: 'OPEN', escalationStep: { lt: 2 }, dueDate: { lte: asDay(plusDays(businessDate(now), 1)) } },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    take: 2000,
    select: ISSUE_COLUMNS,
  })
  return rows.map(asRow)
}

/** The escalation clock of an issue raised at `raisedAt` at a company (null: no working day inside the horizon). */
export async function issueClockOf(db: Reader, companyId: string, raisedAt: Date): Promise<EscalationClock | null> {
  const raisedOn = businessDate(raisedAt)
  for (const span of [31, WORKING_DAY_HORIZON_DAYS]) {
    const loaded = await workingCalendarFor(db, { scope: 'COMPANY', id: companyId }, { from: plusDays(raisedOn, -1), to: plusDays(raisedOn, span) })
    const clock = escalationClock(loaded.calendar, raisedAt)
    if ('dueOn' in clock) return clock
  }
  return null
}

/** The business day a step falls due (the task's due day). */
const stepDayOf = (clock: EscalationClock, step: 1 | 2): BusinessDate => (step === 1 ? clock.dueOn : businessDate(clock.ownerAt))

/** Nothing is due any more (seen inside the command): nothing written. */
class NothingDue extends Error {}

/** The labels of the issues' records (sales order and work order numbers), in the issues' order. */
async function labelsOf(tx: CommandTx, issues: readonly IssueRow[]): Promise<string[]> {
  const orderIds = issues.filter((issue) => issue.recordType === 'SalesOrder').map((issue) => issue.recordId)
  const workIds = issues.filter((issue) => issue.recordType === 'WorkOrder').map((issue) => issue.recordId)
  const orders = orderIds.length ? await tx.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } }) : []
  const works = workIds.length ? await tx.workOrder.findMany({ where: { id: { in: workIds } }, select: { id: true, number: true } }) : []
  const label = new Map([...orders, ...works].map((row) => [row.id, row.number]))
  return issues.map((issue) => label.get(issue.recordId) ?? '')
}

export interface StepDone {
  readonly audience: EscalationAudience
  readonly told: readonly string[]
  readonly tasks: readonly string[]
  readonly issues: number
}

/** One step of one escalation, inside its command (see the head): the people, their tasks, the issues moved, the events. */
export async function escalateInCommand(tools: CommandTools, tenantId: string, unit: EscalationUnit, step: 1 | 2): Promise<StepDone> {
  const { tx, now } = tools
  const sorted = [...unit.issueIds].sort()
  await tx.$queryRaw`SELECT id FROM "ProductionIssue" WHERE id = ANY(${sorted}::uuid[]) ORDER BY id FOR UPDATE`
  const issues = (await tx.productionIssue.findMany({ where: { id: { in: sorted } }, select: ISSUE_COLUMNS, orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }] })).map(asRow).filter((issue) => issue.status === 'OPEN' && issue.escalationStep < step)
  if (issues.length === 0) throw new NothingDue()
  const clock = await issueClockOf(tx, unit.companyId, issues.reduce((least, issue) => (issue.raisedAt.getTime() < least.getTime() ? issue.raisedAt : least), issues[0]!.raisedAt))
  if (!clock || escalationStepAt(clock, now) < step) throw new NothingDue()

  // The batch task's record (the customer's sales order, else the record itself): the escalation tasks sit beside it.
  const batchTask = await tx.task.findUnique({ where: { id: unit.taskId }, select: { recordType: true, recordId: true, recordLabel: true, companyId: true, siteId: true, messageId: true } })
  const first = issues[0]!
  const record: TaskRecord =
    batchTask?.recordType && batchTask.recordId && batchTask.recordLabel
      ? { type: batchTask.recordType, id: batchTask.recordId, label: batchTask.recordLabel, companyId: batchTask.companyId ?? unit.companyId, siteId: batchTask.siteId, partyId: unit.partyId }
      : { type: first.recordType, id: first.recordId, label: (await labelsOf(tx, [first]))[0] ?? first.recordId, companyId: first.companyId, siteId: first.siteId, partyId: unit.partyId }

  // Who: step 1 the backup when they may take it, else the production managers; step 2 the Owner and Admin.
  let backupTakes = false
  let wanted: string[] = []
  if (step === 1) {
    const backupId = (await customerDefaultsOf(tx, [unit.partyId])).get(unit.partyId)?.backupId ?? null
    if (backupId && (await takesIssueTask(tx, tenantId, backupId, record, now))) {
      backupTakes = true
      wanted = [backupId]
    }
  }
  const audience = escalationAudienceOf(step, backupTakes)
  if (!backupTakes) wanted = await roleHolders(tx, ESCALATION_ROLE_KEYS[step], now)
  // Whoever holds an open task of the issue already (its batch task, an earlier step's) is not given a second one.
  const open = await openTasksOfIssues(tx, issues)
  const holding = new Set((open.length ? await tx.task.findMany({ where: { id: { in: open } }, select: { assigneeId: true } }) : []).flatMap((task) => (task.assigneeId ? [task.assigneeId] : [])))
  const told: string[] = []
  const tasks: string[] = []
  const party = await tx.party.findUnique({ where: { id: unit.partyId }, select: { legalName: true, tradeName: true } })
  const customer = party?.tradeName ?? party?.legalName ?? ''
  const labels = await labelsOf(tx, issues)
  const message = await tx.message.findUnique({ where: { id: first.messageId }, select: { bodyText: true } })
  const dueOn = stepDayOf(clock, step)
  for (const userId of wanted) {
    if (!backupTakes && !(await takesIssueTask(tx, tenantId, userId, record, now))) continue
    told.push(userId)
    if (holding.has(userId)) continue
    const taskId = issueEscalationTaskId(unit.taskId, step, userId)
    if (await tx.task.findUnique({ where: { id: taskId }, select: { id: true } })) continue
    const words = escalationTaskWords({ locale: await localeOf(tx, userId), step, source: first.source, labels, customer, excerpt: excerptOf(message?.bodyText ?? '') })
    await writeSystemTask(tools, { id: taskId, record, title: words.title, description: words.description, assigneeId: userId, assignedById: first.createdById, dueOn, messageId: batchTask?.messageId ?? null, by: 'production.issueEscalation', batchId: unit.batchId })
    tasks.push(taskId)
  }

  let moved = 0
  for (const issue of issues) {
    const { count } = await tx.productionIssue.updateMany({ where: { id: issue.id, status: 'OPEN', escalationStep: { lt: step } }, data: { escalationStep: step, escalatedAt: now, version: { increment: 1 }, updatedAt: now } })
    if (count === 0) continue
    moved++
    tools.emit(eventFor(productionIssueEscalated, { subject: issue.id, companyId: issue.companyId, siteId: issue.siteId, payload: { issueId: issue.id, partyId: unit.partyId, batchId: unit.batchId, step } }))
  }
  // R-48: one audit row per escalation (one customer at one company), naming only its own issues.
  tools.audit({
    action: 'production.issuesEscalated',
    recordType: 'Party',
    recordId: unit.partyId,
    companyId: unit.companyId,
    before: { step: unit.taken },
    after: { step, audience, batchId: unit.batchId, taskId: unit.taskId, issues: issues.map((issue) => issue.id), told, tasks, due: dueOn },
  })
  return { audience, told, tasks, issues: moved }
}

/** One step of one escalation in its own system command; false when nothing was due inside it. */
async function runStep(caller: CommandCaller, tenantId: string, unit: EscalationUnit, step: 1 | 2, settings: CommandSettings): Promise<boolean> {
  try {
    await runCommand(caller, { name: 'production.escalateIssues', idempotencyKey: escalationCommandKey(unit, step), input: { key: unit.key, step, issueIds: [...unit.issueIds] } }, (tools: CommandTools) => escalateInCommand(tools, tenantId, unit, step), settings)
    return true
  } catch (error) {
    if (error instanceof NothingDue) return false
    throw error
  }
}

/** One pass over every tenant (the cron's body; tests call it with a moved clock). */
export async function runIssueEscalation(options: EscalationOptions): Promise<{ readonly tenants: number; readonly escalated: number; readonly failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `issue-escalation-${newId()}`
  let escalated = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const now = settings.clock.now()
    const rows = await caller.withClient((client) => candidates(client, now))
    const clocks = new Map<string, EscalationClock | null>()
    for (const unit of escalationUnitsOf(rows)) {
      try {
        const clockKey = `${unit.companyId}|${unit.raisedAt.toISOString()}`
        if (!clocks.has(clockKey)) clocks.set(clockKey, await caller.withClient((client) => issueClockOf(client, unit.companyId, unit.raisedAt)))
        const clock = clocks.get(clockKey)
        if (!clock) continue
        for (const step of escalationStepsDue(clock, unit.taken, now)) if (await runStep(caller, tenantId, unit, step, settings)) escalated++
      } catch (error) {
        failed++
        options.log.error({ err: error, tenantId, escalation: unit.key }, 'a production issue could not be escalated')
      }
    }
  }
  if (escalated + failed > 0) options.log.info({ tenants: tenants.length, escalated, failed }, 'production issues escalated')
  return { tenants: tenants.length, escalated, failed }
}

/** The clustered cron (scheduler only; one replica per tick): every 15 minutes. */
export function issueEscalationCron(options: EscalationOptions): CronJob {
  return defineCron({
    name: ISSUE_ESCALATION_CRON,
    schedule: '*/15 * * * *',
    async run() {
      await runIssueEscalation(options)
    },
  })
}
