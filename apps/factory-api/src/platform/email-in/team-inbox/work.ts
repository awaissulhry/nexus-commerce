import { EMAIL_TRIAGE } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { untilProblem, workRefusal, workStateOf, type WorkChange } from '@nexus/factory-domain/mail-depth/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import type { QueueMailView } from './contract'
import { INBOX_COLUMNS, maySortMail, mayWork, type InboxRow } from './inboxes'
import { QUEUE_COLUMNS, queueViewsOf } from './queue'
import { badBody, emitWorked, mailRefusal, officeOf, WORK_COLUMNS, type WorkRow } from './store'

/**
 * Working a team inbox's mail (B-W2b-394; COL-027; design home.mail "Team inbox (W2b): assign to a person, close, snooze,
 * follow-up that cancels itself when the partner replies"). Each is ONE command on the mail at the version the person read
 * (the worker moves it too, and the database clears a follow-up when the partner answers: read it again on a 409), with its
 * audit row and email.inbound_worked (the queue refreshes; an assignment tells the assignee):
 *
 *   POST /email/inbound/:id/assignee   {assigneeId | null}: a member takes it (yourself) or is given it; it leaves the queue for
 *                                      the others (UNASSIGNED); null puts it back
 *   POST /email/inbound/:id/close      done ("archive from my view" too): off every open view; a follow-up asked stays
 *   POST /email/inbound/:id/reopen     back in the queue
 *   POST /email/inbound/:id/snooze     {until | null}: off the queue until then (back by itself), or back now
 *   POST /email/inbound/:id/follow-up  {until | null}: comes back then, open, unless a later mail joins its thread first (the
 *                                      database clears it, B-W2b-366); needs a thread (a record to answer on)
 *   POST /email/inbound/:id/team-inbox {teamInboxId}: put in an inbox, or moved to another of the mail's company
 *
 * Who: email.triage over the mail's company and a member of its inbox (of both inboxes for a move), or a holder of
 * email.inboxes.manage. The assignee: a member who sorts the company's mail now (live roles). A REJECTED mail changes no more.
 */

type Body = { readonly version: number }

async function readMail(caller: CommandCaller, context: OfficeContext, inboundEmailId: string): Promise<{ mail: WorkRow; inbox: InboxRow | null }> {
  const found = await caller.withClient(async (db) => {
    const mail = isUuid(inboundEmailId) ? await db.inboundEmail.findUnique({ where: { id: inboundEmailId }, select: WORK_COLUMNS }) : null
    const inbox = mail?.teamInboxId ? await db.teamInbox.findUnique({ where: { id: mail.teamInboxId }, select: INBOX_COLUMNS }) : null
    return { mail, inbox }
  })
  if (!found.mail || !can(actorOf(context), EMAIL_TRIAGE, { companyId: found.mail.companyId })) throw new NotFoundError('Mail not found.')
  return { mail: found.mail, inbox: found.inbox }
}

/** The mail of an inbox the person works, else not found (or refused in words). */
async function workableMail(caller: CommandCaller, context: OfficeContext, inboundEmailId: string): Promise<{ mail: WorkRow; inbox: InboxRow }> {
  const { mail, inbox } = await readMail(caller, context, inboundEmailId)
  const refusal = workRefusal(mail)
  if (refusal) throw new ConflictError(refusal)
  if (!inbox || !mayWork(context, inbox)) throw new NotFoundError('Mail not found.')
  return { mail, inbox }
}

async function answerOf(tools: CommandTools, context: OfficeContext, inboundEmailId: string): Promise<{ mail: QueueMailView }> {
  const row = await tools.tx.inboundEmail.findUniqueOrThrow({ where: { id: inboundEmailId }, select: QUEUE_COLUMNS })
  return { mail: (await queueViewsOf(tools.tx, context, [row], tools.now))[0]! }
}

/** One work command: guarded by the mail's version, the change written, audited and told. */
async function work(
  caller: CommandCaller,
  context: OfficeContext,
  inboundEmailId: string,
  body: Body,
  name: `${string}.${string}`,
  idempotencyKey: string | undefined,
  apply: (tools: CommandTools, mail: WorkRow) => Promise<{ change: WorkChange; data: Record<string, unknown> }>,
) {
  const { result } = await command(caller, { name, idempotencyKey, input: { inboundEmailId, ...body }, record: { type: 'InboundEmail', id: inboundEmailId, expectedVersion: body.version } }, async (tools) => {
    const mail = await tools.tx.inboundEmail.findUniqueOrThrow({ where: { id: inboundEmailId }, select: WORK_COLUMNS })
    // The worker may have thrown it away meanwhile (the guard would refuse too).
    if (mail.status === 'REJECTED') throw new ConflictError('This mail was thrown away; it changes no more.')
    const outcome = await apply(tools, mail)
    await tools.tx.inboundEmail.update({ where: { id: inboundEmailId }, data: outcome.data, select: { id: true } })
    const after = await tools.tx.inboundEmail.findUniqueOrThrow({ where: { id: inboundEmailId }, select: WORK_COLUMNS })
    const shown = (row: WorkRow) => ({ teamInboxId: row.teamInboxId, assigneeId: row.assigneeId, closedAt: row.closedAt ? toUtcIso(row.closedAt) : null, snoozedUntil: row.snoozedUntil ? toUtcIso(row.snoozedUntil) : null, followUpUntil: row.followUpUntil ? toUtcIso(row.followUpUntil) : null })
    tools.audit({ recordType: 'InboundEmail', recordId: inboundEmailId, companyId: mail.companyId, before: shown(mail), after: { ...shown(after), change: outcome.change } })
    emitWorked(tools, mail, after.teamInboxId, outcome.change, after.assigneeId, context.actorId)
    return answerOf(tools, context, inboundEmailId)
  }).catch(mailRefusal)
  return result
}

/** POST /email/inbound/:inboundEmailId/assignee */
export async function setAssignee(caller: CommandCaller, inboundEmailId: string, body: Body & { readonly assigneeId: string | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { mail, inbox } = await workableMail(caller, context, inboundEmailId)
  const now = serverClock.now()
  if (body.assigneeId !== null) {
    const member = inbox.memberIds.includes(body.assigneeId)
    const sorts = member && (await caller.withClient((db) => maySortMail(db, context.tenantId, body.assigneeId!, inbox.companyId, now)))
    if (!sorts) badBody('assigneeId', body.assigneeId === context.actorId ? 'You are not a member of this team inbox: ask its administrator to add you.' : 'A member of this team inbox whose roles sort mail of its company.')
  }
  if (body.assigneeId === mail.assigneeId) throw new ConflictError(body.assigneeId === null ? 'Nobody has this mail.' : 'This mail is with that person already.')
  return work(caller, context, inboundEmailId, body, 'emailIn.setAssignee', idempotencyKey, async (tools) => ({
    change: body.assigneeId === null ? 'UNASSIGNED' : 'ASSIGNED',
    data: body.assigneeId === null ? { assigneeId: null, assignedAt: null } : { assigneeId: body.assigneeId, assignedAt: tools.now },
  }))
}

/** POST /email/inbound/:inboundEmailId/close */
export async function closeMail(caller: CommandCaller, inboundEmailId: string, body: Body, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { mail } = await workableMail(caller, context, inboundEmailId)
  if (mail.closedAt !== null) throw new ConflictError('This mail is closed already.')
  return work(caller, context, inboundEmailId, body, 'emailIn.closeMail', idempotencyKey, async (tools, current) => {
    if (current.closedAt !== null) throw new ConflictError('This mail is closed already.')
    return { change: 'CLOSED', data: { closedAt: tools.now, closedById: context.actorId, snoozedUntil: null } }
  })
}

/** POST /email/inbound/:inboundEmailId/reopen */
export async function reopenMail(caller: CommandCaller, inboundEmailId: string, body: Body, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { mail } = await workableMail(caller, context, inboundEmailId)
  if (mail.closedAt === null) throw new ConflictError('This mail is open.')
  return work(caller, context, inboundEmailId, body, 'emailIn.reopenMail', idempotencyKey, async (_tools, current) => {
    if (current.closedAt === null) throw new ConflictError('This mail is open.')
    return { change: 'REOPENED', data: { closedAt: null, closedById: null } }
  })
}

/** POST /email/inbound/:inboundEmailId/snooze */
export async function snoozeMail(caller: CommandCaller, inboundEmailId: string, body: Body & { readonly until: string | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { mail } = await workableMail(caller, context, inboundEmailId)
  const now = serverClock.now()
  const until = body.until === null ? null : new Date(body.until)
  if (until !== null) {
    const problem = untilProblem(until, now)
    if (problem) badBody('until', problem)
  }
  if (mail.closedAt !== null) throw new ConflictError('This mail is closed: reopen it first.')
  if (until === null && workStateOf(mail, now) !== 'SNOOZED') throw new ConflictError('This mail is not snoozed.')
  return work(caller, context, inboundEmailId, body, 'emailIn.snoozeMail', idempotencyKey, async (_tools, current) => {
    if (current.closedAt !== null) throw new ConflictError('This mail is closed: reopen it first.')
    return { change: until === null ? 'WOKEN' : 'SNOOZED', data: { snoozedUntil: until } }
  })
}

/** POST /email/inbound/:inboundEmailId/follow-up */
export async function setFollowUp(caller: CommandCaller, inboundEmailId: string, body: Body & { readonly until: string | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { mail } = await workableMail(caller, context, inboundEmailId)
  const now = serverClock.now()
  const until = body.until === null ? null : new Date(body.until)
  if (until !== null) {
    const problem = untilProblem(until, now)
    if (problem) badBody('until', problem)
    if (mail.threadId === null) throw new ConflictError('A follow-up waits for an answer in the record’s thread: attach this mail to a record first.')
  } else if (mail.followUpUntil === null) {
    throw new ConflictError('No follow-up is asked for this mail.')
  }
  return work(caller, context, inboundEmailId, body, 'emailIn.setFollowUp', idempotencyKey, async () => ({ change: until === null ? 'FOLLOW_UP_CLEARED' : 'FOLLOW_UP_SET', data: { followUpUntil: until } }))
}

/** POST /email/inbound/:inboundEmailId/team-inbox: put a mail in an inbox, or move it to another (its assignee stays only if a member there). */
export async function moveMail(caller: CommandCaller, inboundEmailId: string, body: Body & { readonly teamInboxId: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { mail, inbox } = await readMail(caller, context, inboundEmailId)
  if (mail.status === 'REJECTED') throw new ConflictError('This mail was thrown away; it changes no more.')
  if (inbox && !mayWork(context, inbox)) throw new NotFoundError('Mail not found.')
  if (mail.teamInboxId === body.teamInboxId) throw new ConflictError('This mail is in that team inbox already.')
  const target = await caller.withClient((db) => db.teamInbox.findUnique({ where: { id: body.teamInboxId }, select: INBOX_COLUMNS }))
  if (!target || !mayWork(context, target)) badBody('teamInboxId', 'A team inbox you work.')
  if (!target.active) badBody('teamInboxId', 'This team inbox is switched off.')
  if (mail.companyId !== null && target.companyId !== mail.companyId) badBody('teamInboxId', 'A team inbox of the company the mail came to.')
  return work(caller, context, inboundEmailId, body, 'emailIn.moveMail', idempotencyKey, async (_tools, current) => ({
    change: current.teamInboxId === null ? 'ROUTED' : 'MOVED',
    data: { teamInboxId: target.id, ...(current.assigneeId && !target.memberIds.includes(current.assigneeId) ? { assigneeId: null, assignedAt: null } : {}) },
  }))
}
