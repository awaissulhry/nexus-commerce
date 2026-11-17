import { createHash } from 'node:crypto'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { productionIssueRaised } from '@nexus/factory-domain/production-brand/events'
import { ISSUE_DUE_TIME, ISSUE_WORDS, issueTaskWords } from '@nexus/factory-domain/production-brand/issues'
import { escalationClock } from '@nexus/factory-domain/production-brand/supervisor'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import { excerptOf } from '@nexus/factory-domain/threads/rules'
import type { CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { WORKING_DAY_HORIZON_DAYS, workingCalendarFor } from '../../../platform/calendars/service'
import { mayBeAssigned } from '../../../platform/tasks/tasks'
import { followInCommand } from '../../../platform/threads/followers'
import type { SeenRecord } from '../notes/check'

/**
 * B-PR-43b — "Needs an answer" on a note (production plan §1 "'Needs an answer' makes it a task; no answer in 1 working day → the
 * backup; 2 → you and Admin", §3 "Issues"; lead pick L24; review fixes R-42, R-43, R-44, R-48, R-54; the Owner's point N4). Written
 * in B-PR-43a's command, beside the notes, for each record a note was written on:
 *
 *   ProductionIssue   one per record (source OFFICE), of the record's own company, site and customer, naming its sales order (a
 *                     work order's single order; none for one of several orders), the note it was raised with, its due day and
 *                     its task; a work order of several customers or of none raises none (the database's rule too: said in words)
 *   batch             one per customer and company of the action (R-43: a batch never spans two customers): every issue of it
 *                     carries it, so answering closes them together
 *   Task              ONE per batch and supervisor (R-43): for the records' production supervisor (./supervisor/resolver), on a
 *                     SALES ORDER — the record itself, or the work order's order — which carries the customer and so the wall
 *                     (task rows on work orders carry none yet: B-PR-08a part 2); given only to a person who may be given a task
 *                     there and reads it (platform/tasks mayBeAssigned: PW-17), else to nobody yet; due at raise + 1 working day,
 *                     08:00 company time, on the company's calendar (factory-domain escalationClock, R-44); written as
 *                     platform/tasks writes one (audit, task.created, task.assigned → the assignee's ASSIGNMENT bell, the
 *                     assignee follows the task's record), by the writer of the note
 *   events            one production_issue.raised per issue (each names ONE customer; office live rule, no partner entry:
 *                     R-48, PW-15) and one audit row per batch (`production.issuesRaised`)
 *
 * The customer never reads any of it (R-41: the partner role has no grant on ProductionIssue or Task). Escalation is B-PR-45's
 * (its cron scan also takes these): its tasks take ids from `issueEscalationTaskId`, so answering finds and closes them.
 */

const [taskCreated, taskAssigned] = taskEvents

/** A UUID (version 8, RFC 9562) derived from a text: the same text, the same id (capa/reminders' way). */
function derivedId(text: string): string {
  const hex = createHash('sha256').update(text).digest('hex')
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** B-PR-45's escalation task of an issue's batch task, for one person at one step: found again (and closed) by answering. */
export const issueEscalationTaskId = (taskId: string, step: 1 | 2, userId: string): string => derivedId(`production-issue-escalation|${taskId}|${step}|${userId}`)

/** A record a note was written on, as the raise needs it. */
export interface NotedRecord {
  readonly record: SeenRecord
  readonly messageId: string
}

/** What "Needs an answer" did: the issue of each record, the tasks, and the records that raise none (with why). */
export interface Raised {
  readonly issues: ReadonlyMap<string, string>
  readonly tasks: readonly { readonly taskId: string; readonly type: string; readonly id: string; readonly label: string; readonly assigned: boolean; readonly records: number }[]
  readonly notRaised: readonly { readonly type: string; readonly id: string; readonly label: string; readonly why: string }[]
}

const asDay = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

/** The due day of an issue raised now at a company: raise + 1 working day (R-44); a calendar that never opens: the next day. */
export async function issueDueOn(tools: Pick<CommandTools, 'tx' | 'now'>, companyId: string): Promise<BusinessDate> {
  const raisedOn = businessDate(tools.now)
  for (const span of [31, WORKING_DAY_HORIZON_DAYS]) {
    const loaded = await workingCalendarFor(tools.tx, { scope: 'COMPANY', id: companyId }, { from: plusDays(raisedOn, -1), to: plusDays(raisedOn, span) })
    const clock = escalationClock(loaded.calendar, tools.now)
    if ('dueOn' in clock) return clock.dueOn
  }
  return plusDays(raisedOn, 1)
}

/** One batch: one customer at one company, its noted records. */
function batchesOf(noted: readonly NotedRecord[]): { companyId: string; partyId: string; records: NotedRecord[] }[] {
  const out = new Map<string, { companyId: string; partyId: string; records: NotedRecord[] }>()
  for (const entry of noted) {
    const key = `${entry.record.companyId}|${entry.record.partyId}`
    const batch = out.get(key) ?? { companyId: entry.record.companyId, partyId: entry.record.partyId!, records: [] }
    batch.records.push(entry)
    out.set(key, batch)
  }
  return [...out.values()]
}

/** Inside B-PR-43a's command: an issue for each noted record of one customer, one task per batch and supervisor (see the head). */
export async function raiseIssuesInCommand(tools: CommandTools, context: OfficeContext, noted: readonly NotedRecord[], bodyText: string): Promise<Raised> {
  const { tx, now } = tools
  const notRaised = noted.filter((entry) => entry.record.partyId === null).map((entry) => ({ type: entry.record.type, id: entry.record.id, label: entry.record.label, why: ISSUE_WORDS.NO_CUSTOMER.en }))
  const withCustomer = noted.filter((entry) => entry.record.partyId !== null)
  // Each work order's sales orders (its cells'): its single order is its issue's; its first names the task's record.
  const workOrderIds = withCustomer.filter((entry) => entry.record.type === 'WorkOrder').map((entry) => entry.record.id)
  const cells = workOrderIds.length === 0 ? [] : await tx.workOrderSize.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { workOrderId: true, salesOrderLine: { select: { orderId: true } } }, orderBy: { id: 'asc' } })
  const ordersOf = (workOrderId: string): string[] => [...new Set(cells.filter((cell) => cell.workOrderId === workOrderId && cell.salesOrderLine).map((cell) => cell.salesOrderLine!.orderId))]
  const issueOrderOf = (record: SeenRecord): string | null => (record.type === 'SalesOrder' ? record.id : ordersOf(record.id).length === 1 ? ordersOf(record.id)[0]! : null)
  const issues = new Map<string, string>()
  const tasks: Raised['tasks'][number][] = []
  for (const batch of batchesOf(withCustomer)) {
    const batchId = newId()
    const dueOn = await issueDueOn(tools, batch.companyId)
    const party = await tx.party.findUnique({ where: { id: batch.partyId }, select: { legalName: true, tradeName: true } })
    const customer = party?.tradeName ?? party?.legalName ?? ''
    // One task per supervisor of the batch (records with none share one task for nobody yet).
    const bySupervisor = new Map<string, NotedRecord[]>()
    for (const entry of batch.records) bySupervisor.set(entry.record.supervisorId ?? '', [...(bySupervisor.get(entry.record.supervisorId ?? '') ?? []), entry])
    const raisedHere: { id: string; record: SeenRecord }[] = []
    const taskIds: string[] = []
    for (const [supervisor, entries] of bySupervisor) {
      // The task's record: a SALES ORDER of the customer (it carries the wall) — the first record that has one: its own, or its
      // work order's first; a work order alone with no order line only when none has (its task still carries the customer).
      const first = entries[0]!.record
      const orderId = entries.map((entry) => (entry.record.type === 'SalesOrder' ? entry.record.id : (ordersOf(entry.record.id)[0] ?? null))).find((candidate) => candidate !== null) ?? null
      const found = orderId ? await tx.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, number: true, companyId: true, partyId: true } }) : null
      // Never another customer's order (a batch is one customer's: the wall of the task is the batch's own).
      const order = found && found.partyId === batch.partyId ? found : null
      const onRecord = order ? { type: 'SalesOrder', id: order.id, label: order.number, companyId: order.companyId, siteId: null as string | null, partyId: order.partyId } : { type: first.type, id: first.id, label: first.label, companyId: first.companyId, siteId: first.siteId, partyId: batch.partyId }
      const scope = { companyId: onRecord.companyId, siteId: onRecord.siteId, partyId: onRecord.partyId }
      // PW-17: only to a person who may be given a task there and reads it; else nobody's yet (the escalation still finds it).
      const assigneeId = supervisor !== '' && (await mayBeAssigned(tx, context.tenantId, supervisor, scope, true, now, onRecord.type)) ? supervisor : null
      const locale = assigneeId ? ((await tx.user.findUnique({ where: { id: assigneeId }, select: { locale: true } }))?.locale ?? null) : null
      const words = issueTaskWords({ locale, labels: entries.map((entry) => entry.record.label), customer, excerpt: excerptOf(bodyText) })
      // The note on the task's own record, when this batch wrote one there (the task links back to it).
      const messageId = entries.find((entry) => entry.record.type === onRecord.type && entry.record.id === onRecord.id)?.messageId ?? null
      const taskId = newId()
      await tx.task.create({
        data: {
          id: taskId,
          companyId: onRecord.companyId,
          siteId: onRecord.siteId,
          partyId: onRecord.partyId,
          title: words.title,
          description: words.description,
          recordType: onRecord.type,
          recordId: onRecord.id,
          recordLabel: onRecord.label,
          assigneeId,
          assignedById: assigneeId ? context.actorId : null,
          assignedAt: assigneeId ? now : null,
          dueDate: asDay(dueOn),
          dueTime: ISSUE_DUE_TIME,
          checklist: [],
          createdAt: now,
          updatedAt: now,
          createdById: context.actorId,
          ...(messageId ? { messageId } : {}),
        },
        select: { id: true },
      })
      const where = { subject: taskId, companyId: onRecord.companyId, siteId: onRecord.siteId }
      tools.audit({ action: 'tasks.create', recordType: 'Task', recordId: taskId, companyId: onRecord.companyId, siteId: onRecord.siteId, after: { title: words.title, dueDate: dueOn, dueTime: ISSUE_DUE_TIME, assigneeId, status: 'OPEN', recordType: onRecord.type, recordId: onRecord.id, by: 'production.issue', batchId } })
      tools.audit({ action: 'tasks.create', recordType: onRecord.type, recordId: onRecord.id, companyId: onRecord.companyId, siteId: onRecord.siteId, after: { taskId, title: words.title } })
      const about = { taskId, recordType: onRecord.type, recordId: onRecord.id }
      tools.emit(eventFor(taskCreated, { ...where, payload: { ...about, assigneeId } }))
      if (assigneeId) {
        tools.emit(eventFor(taskAssigned, { ...where, payload: { ...about, assigneeId, assignedById: context.actorId } }))
        await followInCommand(tools, { type: onRecord.type, id: onRecord.id, companyId: onRecord.companyId, siteId: onRecord.siteId }, assigneeId, 'ASSIGNEE', context.actorId)
      }
      taskIds.push(taskId)
      tasks.push({ taskId, type: onRecord.type, id: onRecord.id, label: onRecord.label, assigned: assigneeId !== null, records: entries.length })
      for (const entry of entries) {
        const issueId = newId()
        await tx.productionIssue.create({
          data: {
            id: issueId,
            companyId: entry.record.companyId,
            siteId: entry.record.type === 'WorkOrder' ? entry.record.siteId : null,
            partyId: batch.partyId,
            recordType: entry.record.type,
            recordId: entry.record.id,
            salesOrderId: issueOrderOf(entry.record),
            taskId,
            messageId: entry.messageId,
            source: 'OFFICE',
            batchId,
            raisedAt: now,
            dueDate: asDay(dueOn),
            createdAt: now,
            updatedAt: now,
            createdById: context.actorId,
          },
          select: { id: true },
        })
        issues.set(`${entry.record.type}:${entry.record.id}`, issueId)
        raisedHere.push({ id: issueId, record: entry.record })
        tools.emit(eventFor(productionIssueRaised, { subject: issueId, companyId: entry.record.companyId, siteId: entry.record.type === 'WorkOrder' ? entry.record.siteId : null, payload: { issueId, partyId: batch.partyId, recordType: entry.record.type, recordId: entry.record.id, source: 'OFFICE', batchId } }))
      }
    }
    // R-48: one audit row per batch (one customer at one company), naming only its own records.
    tools.audit({
      action: 'production.issuesRaised',
      recordType: 'Party',
      recordId: batch.partyId,
      companyId: batch.companyId,
      after: { batchId, source: 'OFFICE', dueOn, issues: raisedHere.map((entry) => ({ issueId: entry.id, recordType: entry.record.type, recordId: entry.record.id })), taskIds },
    })
  }
  return { issues, tasks, notRaised }
}
