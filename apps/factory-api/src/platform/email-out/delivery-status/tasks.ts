import { createHash } from 'node:crypto'
import { businessDate } from '@nexus/factory-domain/core/time'
import { events as emailEvents } from '@nexus/factory-domain/email/events'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as mailDepthEvents } from '@nexus/factory-domain/mail-depth/events'
import { bounceTaskWords, type BounceKind } from '@nexus/factory-domain/mail-depth/rules'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import { command, type CommandCaller } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../outbox/dispatch'
import { mayBeAssigned } from '../../tasks/tasks'
import { followInCommand } from '../../threads/followers'
import { recordLabelOf } from '../../threads/labels'
import { resolveRecord } from '../../threads/records'

/**
 * A bounce makes a task (B-W2b-394; COL-031): the worker's handler `email.bounceTask` of email.status_changed (BOUNCED: a hard
 * bounce) and email.bounce_noted (a soft one). The person who sent the mail from a record's thread gets a task on that record,
 * due today, in their language: fix the address and send again (hard), or send again later or reach them another way (soft).
 * ONE command as the tenant's system; at most one task per mail and kind (its id is derived from them: a repeated event makes
 * none), audited, with task.created / task.assigned (their bell) and the assignee following the record. Mail without a thread
 * (sign-in mail, the digest) makes no task: the delivery log and the blocked list show it. A sender who may no longer be given
 * tasks on the record leaves the task unassigned on it.
 */

export const BOUNCE_TASK_HANDLER = 'email.bounceTask'
const statusChanged = emailEvents[1]
const [taskCreated, taskAssigned] = taskEvents
const bounceNotedPayload = mailDepthEvents[3].payload

/** A UUID (version 8, RFC 9562) derived from a text: one task per mail and kind. */
function derivedId(text: string): string {
  const hex = createHash('sha256').update(text).digest('hex')
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export const bounceTaskIdOf = (outboundId: string, hard: boolean): string => derivedId(`email-bounce|${hard ? 'hard' : 'soft'}|${outboundId}`)

/** The task of one bounced mail, made once. Answers its id, or null when none is made. */
export async function bounceTask(caller: CommandCaller, tenantId: string, outboundId: string, kind: BounceKind, options: { readonly causationId?: string } = {}): Promise<string | null> {
  const hard = kind === 'PERMANENT'
  const taskId = bounceTaskIdOf(outboundId, hard)
  const { result } = await command(caller, { name: 'email.bounceTask', input: { outboundId, kind }, ...(options.causationId ? { causationId: options.causationId } : {}) }, async (tools) => {
    const { tx, now } = tools
    const mail = await tx.emailOutbound.findUnique({ where: { id: outboundId }, select: { id: true, companyId: true, threadId: true, recordType: true, recordId: true, subject: true, createdById: true } })
    const skip = (why: string): null => {
      tools.audit({ action: 'email.bounceTaskSkipped', recordType: 'EmailOutbound', recordId: outboundId, companyId: mail?.companyId ?? null, after: { why, taskId } })
      return null
    }
    if (!mail?.threadId || !mail.recordType || !mail.recordId) return skip('NO_THREAD')
    if (await tx.task.findUnique({ where: { id: taskId }, select: { id: true } })) return skip('MADE')
    const scope = await resolveRecord(tx, mail.recordType, mail.recordId)
    const label = scope ? await recordLabelOf(tx, mail.recordType, mail.recordId) : null
    if (!scope || label === null) return skip('NO_RECORD')
    const assigneeId = mail.createdById && (await mayBeAssigned(tx, tenantId, mail.createdById, scope, true, now, mail.recordType)) ? mail.createdById : null
    const locale = assigneeId ? (await tx.user.findUnique({ where: { id: assigneeId }, select: { locale: true } }))?.locale : null
    const words = bounceTaskWords(locale, { kind, subject: mail.subject, record: label })
    const where = { companyId: scope.companyId ?? null, siteId: scope.siteId ?? null }
    await tx.task.create({
      data: {
        id: taskId,
        ...where,
        partyId: scope.partyId ?? null,
        title: words.title,
        description: words.description,
        recordType: mail.recordType,
        recordId: mail.recordId,
        recordLabel: label,
        assigneeId,
        // Assignee, assigner and time come together (the table's rule); the system names nobody else, so the row names the
        // assignee as giving it (the event says the system did: their bell rings).
        assignedById: assigneeId,
        assignedAt: assigneeId ? now : null,
        dueDate: new Date(`${businessDate(now)}T00:00:00.000Z`),
        checklist: [],
        createdAt: now,
        updatedAt: now,
        createdById: null,
      },
      select: { id: true },
    })
    tools.audit({ action: 'tasks.create', recordType: 'Task', recordId: taskId, ...where, after: { title: words.title, assigneeId, status: 'OPEN', recordType: mail.recordType, recordId: mail.recordId, by: 'bounce', outboundId, bounceKind: kind } })
    const about = { taskId, recordType: mail.recordType, recordId: mail.recordId }
    tools.emit(eventFor(taskCreated, { subject: taskId, ...where, payload: { ...about, assigneeId } }))
    if (assigneeId) {
      tools.emit(eventFor(taskAssigned, { subject: taskId, ...where, payload: { ...about, assigneeId, assignedById: null } }))
      await followInCommand(tools, { type: mail.recordType, id: mail.recordId, ...where }, assigneeId, 'ASSIGNEE', null)
    }
    return taskId
  })
  return result
}

/** The worker's handler (background.ts W2B_394_HANDLERS). A failure throws: BullMQ retries it. */
export function bounceTaskHandler(): EventHandler {
  return defineHandler({
    name: BOUNCE_TASK_HANDLER,
    events: ['email.status_changed', 'email.bounce_noted'],
    attempts: 5,
    async handle(event, tools) {
      if (event.type === 'email.status_changed') {
        const { outboundId, status } = statusChanged.payload.parse(event.payload)
        if (status === 'BOUNCED') await bounceTask(tools.caller, event.tenantId, outboundId, 'PERMANENT', { causationId: event.eventId })
        return
      }
      const { outboundId, bounceKind } = bounceNotedPayload.parse(event.payload)
      await bounceTask(tools.caller, event.tenantId, outboundId, bounceKind, { causationId: event.eventId })
    },
  })
}
