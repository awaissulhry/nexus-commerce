import { THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { REPLY_REFUSAL_WORDS, type ReplyRefusalCode } from '@nexus/factory-domain/threads/replies'
import { cleanBody, noteProblems, uniqueIds } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { partyReaders } from '../portal/tasks/people'
import type { MessageView, ThreadView } from './contract'
import { mayOnThread, mayShare, notShareableRefusal, wallScopeOf } from './records'
import { attachmentProblems, contextOf, ensureThread, messageViewOf, officeRecord, scopeOfThread, THREAD_OFFICE, threadViewOf, visibleAttachments, writeMessage, type RecordRef, type ThreadRow } from './threads'
// B-TH-050: a reply names the shared message it answers, or corrects a portal reply of ours.
import { messageLinkProblems, messageLinksOf } from './threads'

/**
 * B-TH-044 (threads plan TH-3, G15; T5-F07 "Reply in the portal only"; wall W08): POST /threads/<type>/<id>/replies — a reply to
 * the record's party that it reads in its portal, with no mail: ONE command writes an OUTBOUND message on the PORTAL channel of
 * the record's own thread, by the office person (threads.post over the record; no email.send: nothing is sent). The portal's news
 * tells the party (platform/portal/notifications/rules/records.ts portalNews.messagePosted: the record's party only, its own
 * number for a request, quote or order) and their mail setting decides when they hear of it. B-TH-045: one action that replies on
 * several records sends the same `batchId` with each, so each reader's bell folds them into one item.
 *
 * Refused in words at `refusal/<CODE>` (factory-domain threads/replies.ts), never naming another party: a record with no party yet
 * (a prospect's request: make the customer first) NO_PARTY, a record that is never shared NOT_SHAREABLE (B-PR-08a), a closed
 * conversation CLOSED, and a party of which nobody may read the record in the portal now NO_PORTAL (reply by e-mail). The files
 * attached are the record's, already shared with its party (`attachmentProblems`, PARTNER).
 */

export interface ReplyInput {
  readonly body: string
  readonly attachments?: readonly string[] | undefined
  readonly batchId?: string | undefined
  // ---- B-TH-050
  readonly replyToMessageId?: string | undefined
  readonly correctsMessageId?: string | undefined
}

/** The 409 of a refused reply: the words at `refusal/<code>`. */
export function replyRefusal(code: ReplyRefusalCode): DomainError {
  const words = REPLY_REFUSAL_WORDS[code].en
  return new DomainError('conflict', words, [{ path: `refusal/${code}`, message: words }])
}

/** The most companies of a tenant a company-less thread's portal readers are looked for in (a tenant has a handful). */
const MAX_COMPANIES = 50

/**
 * Whether someone of the thread's party may read it in the portal now: a person who could use the portal (active, the portal on,
 * the company's terms in force: platform/portal/tasks/people.ts) and whose roles reach the thread (threads.read). A thread with no
 * company (a tenant-wide party's account conversation) is read in each company's portal.
 */
async function portalReaderExists(tx: CommandTx, tenantId: string, thread: ThreadRow, now: Date): Promise<boolean> {
  const partyId = thread.partyId
  if (partyId === null) return false
  const scope: ScopedRecord = scopeOfThread(thread)
  const companies = thread.companyId ? [thread.companyId] : (await tx.company.findMany({ orderBy: { id: 'asc' }, take: MAX_COMPANIES, select: { id: true } })).map((row) => row.id)
  for (const companyId of companies) {
    const readers = await partyReaders(tx, tenantId, partyId, companyId, now)
    if (readers.some((reader) => can(reader.actor, THREADS_READ, scope))) return true
  }
  return false
}

/** POST /threads/<type>/<id>/replies (threads.postReply): the reply, the thread made with it when the record has none yet. */
export async function postPortalReply(caller: CommandCaller, record: RecordRef, input: ReplyInput, idempotencyKey?: string): Promise<{ thread: ThreadView; message: MessageView }> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const draft = { bodyText: cleanBody(input.body), mentions: [] as string[], attachments: uniqueIds(input.attachments), forFloor: false }
  const problems = noteProblems(draft)
  if (problems.length > 0) throw new ValidationError('The reply is not valid.', problems)
  const { thread: existing, scope } = await caller.withClient((client) => officeRecord(client, record))
  if (!mayOnThread(actor, THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
  if (!mayOnThread(actor, THREADS_POST, record.type, scope)) throw new ForbiddenError()
  if (!mayShare(record.type)) throw notShareableRefusal()
  if (scope.partyId === null) throw replyRefusal('NO_PARTY')
  if (existing && existing.status !== 'OPEN') throw replyRefusal('CLOSED')

  const { result } = await command(
    caller,
    { name: 'threads.postReply', idempotencyKey, input: { recordType: record.type, recordId: record.id, bodyText: draft.bodyText, attachments: draft.attachments, batchId: input.batchId ?? null, replyToMessageId: input.replyToMessageId ?? null, correctsMessageId: input.correctsMessageId ?? null } },
    async (tools) => {
      const { thread } = await ensureThread(tools, record, context.actorId)
      // The thread as it is now (made by this command or a racing one): its scope decides — with its wall party, as the note route
      // checks it since B-PR-08a part 2 (a record never shared is refused before this; the rule stays the one rule).
      const wall = await wallScopeOf(tools.tx, thread)
      if (!mayOnThread(actor, THREADS_READ, record.type, wall)) throw new NotFoundError('Record not found.')
      if (!mayOnThread(actor, THREADS_POST, record.type, wall)) throw new ForbiddenError()
      if (thread.partyId === null) throw replyRefusal('NO_PARTY')
      if (thread.status !== 'OPEN') throw replyRefusal('CLOSED')
      if (!(await portalReaderExists(tools.tx, context.tenantId, thread, tools.now))) throw replyRefusal('NO_PORTAL')
      const links = { replyToMessageId: input.replyToMessageId ?? null, correctsMessageId: input.correctsMessageId ?? null } // B-TH-050
      const issues = [...(await attachmentProblems(tools.tx, context, thread, draft.attachments, 'PARTNER')), ...(await messageLinkProblems(tools.tx, thread, links, { direction: 'OUTBOUND', channel: 'PORTAL' }))]
      if (issues.length > 0) throw new ValidationError('The reply is not valid.', issues)
      const author = await tools.tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } })
      const message = await writeMessage(tools, thread, {
        direction: 'OUTBOUND',
        channel: 'PORTAL',
        author: { kind: 'USER', id: context.actorId, name: author?.displayName ?? null },
        bodyText: draft.bodyText,
        attachments: draft.attachments,
        ...(input.batchId ? { batchId: input.batchId } : {}),
        ...links, // B-TH-050
      })
      const current = await tools.tx.thread.findUniqueOrThrow({ where: { id: thread.id }, select: THREAD_OFFICE })
      const attachments = await visibleAttachments(tools.tx, context, message.attachmentFileIds)
      return { thread: threadViewOf(current), message: messageViewOf(message, attachments, true, await messageLinksOf(tools.tx, thread.id, [message], { sharedOnly: false, workerShown: true })) }
    },
  )
  return result
}
