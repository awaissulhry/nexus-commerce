import { type BusinessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { ISSUE_DUE_TIME } from '@nexus/factory-domain/production-brand/issues'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import type { CommandTools } from '../../../core/command'
import { liveAssignment } from '../../../platform/auth/roles/access'
import { mayBeAssigned } from '../../../platform/tasks/tasks'
import { followInCommand, personReads } from '../../../platform/threads/followers'
import type { WallScope } from '../../../platform/threads/records'
import type { Reader } from '../supervisor/resolver'

/**
 * B-PR-45 — the tasks of an issue that the SYSTEM makes (production plan §3 "Issues"; R-42, R-43, R-44; PW-17): the batch task
 * of a customer's "Report a problem" (../brand-portal/problems.ts) and the escalation tasks of a batch (./escalate.ts). Written
 * as platform/tasks writes one (and as capa/reminders writes its system tasks): the row (no maker: `createdById` null, which is
 * how ./answered.ts finds an escalation task again), its audit rows, task.created, task.assigned (the assignee's ASSIGNMENT bell:
 * "The system assigned you …") and the assignee's ASSIGNEE follow of the task's record. Who may be given one is decided here
 * too: an ACTIVE office person who reads the record's thread (threads' `personReads`) AND may hold a task there (platform/tasks
 * `mayBeAssigned`), each checked on the record itself — a person limited to another customer is never given one (PW-17).
 */

const [taskCreated, taskAssigned] = taskEvents

const asDay = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

/** The record a task sits on, with the customer that walls it (a work order's thread is reached through its WALL party). */
export interface TaskRecord {
  readonly type: string
  readonly id: string
  readonly label: string
  readonly companyId: string
  readonly siteId: string | null
  readonly partyId: string
}

/** The scope threads and tasks check a person on (the customer as the wall party: a work order's thread is not shared). */
export const wallOf = (record: Pick<TaskRecord, 'companyId' | 'siteId' | 'partyId'>): WallScope => ({ companyId: record.companyId, siteId: record.siteId, partyId: record.partyId, wallPartyId: record.partyId })

/** Whether this person may be given an issue's task on the record now: reads its thread and may hold a task there (PW-17). */
export async function takesIssueTask(db: Reader, tenantId: string, userId: string, record: TaskRecord, now: Date): Promise<boolean> {
  const scope = wallOf(record)
  if (!(await personReads(db, tenantId, userId, scope, now, record.type))) return false
  return mayBeAssigned(db, tenantId, userId, scope, true, now, record.type)
}

/** The ACTIVE office people who hold one of these roles now (by key: `production_manager`, `owner`, `admin`), by name. */
export async function roleHolders(db: Reader, roleKeys: readonly string[], now: Date): Promise<string[]> {
  if (roleKeys.length === 0) return []
  const rows = await db.roleAssignment.findMany({
    where: { role: { key: { in: [...roleKeys] }, audience: 'OFFICE' }, ...liveAssignment(now), user: { status: 'ACTIVE', audience: 'OFFICE' } },
    orderBy: [{ userId: 'asc' }, { id: 'asc' }],
    take: 500,
    select: { userId: true, user: { select: { displayName: true } } },
  })
  const byId = new Map(rows.map((row) => [row.userId, row.user.displayName]))
  return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], 'it') || (a[0] < b[0] ? -1 : 1)).map(([userId]) => userId)
}

/** A person's language for the words of their task (their profile's; Italian by default). */
export async function localeOf(db: Reader, userId: string | null): Promise<string | null> {
  if (!userId) return null
  return (await db.user.findUnique({ where: { id: userId }, select: { locale: true } }))?.locale ?? null
}

export interface SystemTask {
  readonly id: string
  readonly record: TaskRecord
  readonly title: string
  readonly description: string
  readonly assigneeId: string | null
  /** Who the row names as assigning (the database wants someone beside an assignee): the person the issue came from. */
  readonly assignedById: string | null
  readonly dueOn: BusinessDate
  /** The message the task links back to (a message of the record's own thread), or none. */
  readonly messageId: string | null
  /** What the audit row says made it, and the batch. */
  readonly by: string
  readonly batchId: string | null
}

/** Writes a task the system makes (see the head), inside the caller's command. */
export async function writeSystemTask(tools: Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit'>, task: SystemTask): Promise<void> {
  const { tx, now } = tools
  const { record } = task
  const assignedById = task.assigneeId ? (task.assignedById ?? task.assigneeId) : null
  await tx.task.create({
    data: {
      id: task.id,
      companyId: record.companyId,
      siteId: record.siteId,
      partyId: record.partyId,
      title: task.title,
      description: task.description,
      recordType: record.type,
      recordId: record.id,
      recordLabel: record.label,
      assigneeId: task.assigneeId,
      assignedById,
      assignedAt: task.assigneeId ? now : null,
      dueDate: asDay(task.dueOn),
      dueTime: ISSUE_DUE_TIME,
      checklist: [],
      createdAt: now,
      updatedAt: now,
      createdById: null,
      ...(task.messageId ? { messageId: task.messageId } : {}),
    },
    select: { id: true },
  })
  const scope = { companyId: record.companyId, siteId: record.siteId }
  tools.audit({ action: 'tasks.create', recordType: 'Task', recordId: task.id, ...scope, after: { title: task.title, dueDate: task.dueOn, dueTime: ISSUE_DUE_TIME, assigneeId: task.assigneeId, status: 'OPEN', recordType: record.type, recordId: record.id, by: task.by, batchId: task.batchId } })
  tools.audit({ action: 'tasks.create', recordType: record.type, recordId: record.id, ...scope, after: { taskId: task.id, title: task.title } })
  const where = { subject: task.id, ...scope }
  const about = { taskId: task.id, recordType: record.type, recordId: record.id }
  tools.emit(eventFor(taskCreated, { ...where, payload: { ...about, assigneeId: task.assigneeId } }))
  if (task.assigneeId) {
    // The system assigned it ("The system assigned you …"): the event names nobody as assigning.
    tools.emit(eventFor(taskAssigned, { ...where, payload: { ...about, assigneeId: task.assigneeId, assignedById: null } }))
    await followInCommand(tools, { type: record.type, id: record.id, companyId: record.companyId, siteId: record.siteId }, task.assigneeId, 'ASSIGNEE', null)
  }
}
