import { THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { REPLY_REFUSAL_WORDS, type ReplyRefusalCode } from '@nexus/factory-domain/threads/replies'
import { cleanBody, noteProblems, uniqueIds } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { partyReaders } from '../portal/tasks/people'
import type { MessageView, ThreadView } from './contract'
import { mayOnThread, mayShare, notShareableRefusal, wallScopeOf } from './records'
import { attachmentProblems, contextOf, ensureThread, messageViewOf, officeRecord, scopeOfThread, THREAD_OFFICE, threadViewOf, visibleAttachments, writeMessage, type RecordRef, type ThreadRow } from './threads'
// B-TH-050: a reply names the shared message it answers, or corrects a portal reply of ours.
import { messageLinkProblems, messageLinksOf } from './threads'
// B-TH-092: the sender's draft of the record goes with the reply.
import { clearDraftInCommand } from './draft-keys'
// B-SA-073: Reply to N checked on the server (one customer, at most 50 records) and the mis-send text check on every reply.
import { REPLY_BATCH_MAX } from '@nexus/factory-domain/threads/replies'
import { otherCustomers } from '../email-out/mis-send/check'
// B-SA-061: what the reply is about (a part of its order; never a work order: office only).
import { aboutProblems, aboutShapeProblems, type About } from './about'

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
 *
 * B-SA-073 (sales page plan R7, rule 7 / T11; review BW-6): Reply to N is checked HERE, not only in the browser. The replies that
 * share a `batchId` are one action of one customer: a reply whose record's customer is not the batch's (BATCH_TWO_CUSTOMERS) or that
 * would be the batch's 51st record (BATCH_FULL) is refused in words — so no action ever writes one message to two customers. The
 * batch is kept as audit rows of its own (recordType `ReplyBatch`, the batch's id: one row per reply with its customer and record),
 * read and written under the batch's own lock. Every reply also runs the mis-send text check (email-out/mis-send/check.ts
 * otherCustomers: another customer of the record's company named in the text): held (NAMES_OTHER_CUSTOMER) until the text changes or
 * the writer ticks "This text names no other customer" (`namesNoOtherCustomer`, the production notes' R-47 rule).
 *
 * B-SA-061 ("Discuss"): the reply may say which part of its order it is about (`about`: a line, shipment, invoice, deposit request,
 * gate or change request of THIS order — about.ts); another record's id is refused in words ("Not a part of this record."), and a
 * work order stays in office notes (a reply to the customer is never about one).
 */

export interface ReplyInput {
  readonly body: string
  readonly attachments?: readonly string[] | undefined
  readonly batchId?: string | undefined
  // ---- B-TH-050
  readonly replyToMessageId?: string | undefined
  readonly correctsMessageId?: string | undefined
  // ---- B-SA-073: the writer's tick "This text names no other customer" (R-47).
  readonly namesNoOtherCustomer?: boolean | undefined
  // ---- B-SA-061: the part of its order the reply is about (a sales order's reply only; never a work order).
  readonly about?: About | undefined
}

// ---- B-SA-073 ----------------------------------------------------------------------------------------------------------------
/** The audit record type that keeps a Reply to N's batch: one row per reply, keyed by the batch's id. */
export const REPLY_BATCH_RECORD = 'ReplyBatch'

/**
 * Inside the reply's command: the batch takes this record of this customer, or the reply is refused in words — another customer than
 * the batch's (BATCH_TWO_CUSTOMERS), or a 51st record (BATCH_FULL). A record already in the batch is no new record. Serialised on
 * the batch's id, so two replies of one batch sent at once never both pass.
 */
async function joinReplyBatch(tools: CommandTools, batchId: string, thread: ThreadRow): Promise<void> {
  const { tx } = tools
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.reply-batch', ${batchId}::uuid::text), 0))`
  const rows = await tx.auditLog.findMany({ where: { recordType: REPLY_BATCH_RECORD, recordId: batchId }, select: { after: true } })
  const taken = rows.map((row) => (row.after ?? {}) as { partyId?: string | null; recordType?: string; recordId?: string })
  if (taken.some((entry) => entry.partyId !== thread.partyId)) throw replyRefusal('BATCH_TWO_CUSTOMERS')
  const records = new Set(taken.map((entry) => `${entry.recordType}:${entry.recordId}`))
  const key = `${thread.recordType}:${thread.recordId}`
  if (!records.has(key) && records.size >= REPLY_BATCH_MAX) throw replyRefusal('BATCH_FULL')
  tools.audit({ action: 'threads.replyBatch', recordType: REPLY_BATCH_RECORD, recordId: batchId, companyId: thread.companyId, siteId: thread.siteId, after: { partyId: thread.partyId, recordType: thread.recordType, recordId: thread.recordId } })
}
// ---- end B-SA-073 -------------------------------------------------------------------------------------------------------------

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
  // B-SA-061: an about only on a sales order's reply, and never a work order (office only): refused in words before anything is read.
  const problems = [...noteProblems(draft), ...aboutShapeProblems(record.type, input.about, 'PARTNER')]
  if (problems.length > 0) throw new ValidationError('The reply is not valid.', problems)
  const { thread: existing, scope } = await caller.withClient((client) => officeRecord(client, record))
  if (!mayOnThread(actor, THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
  if (!mayOnThread(actor, THREADS_POST, record.type, scope)) throw new ForbiddenError()
  if (!mayShare(record.type)) throw notShareableRefusal()
  if (scope.partyId === null) throw replyRefusal('NO_PARTY')
  if (existing && existing.status !== 'OPEN') throw replyRefusal('CLOSED')

  const { result } = await command(
    caller,
    { name: 'threads.postReply', idempotencyKey, input: { recordType: record.type, recordId: record.id, bodyText: draft.bodyText, attachments: draft.attachments, batchId: input.batchId ?? null, replyToMessageId: input.replyToMessageId ?? null, correctsMessageId: input.correctsMessageId ?? null, /* B-SA-073 */ namesNoOtherCustomer: input.namesNoOtherCustomer === true, /* B-SA-061 */ about: input.about ?? null } },
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
      // ---- B-SA-073: the mis-send text check (another customer of the company named), then the batch's one customer and 50 records.
      if (input.namesNoOtherCustomer !== true && (await otherCustomers(tools.tx, draft.bodyText, thread.partyId, thread.companyId)).length > 0) throw replyRefusal('NAMES_OTHER_CUSTOMER')
      if (input.batchId) await joinReplyBatch(tools, input.batchId, thread)
      // ---- end B-SA-073
      const links = { replyToMessageId: input.replyToMessageId ?? null, correctsMessageId: input.correctsMessageId ?? null } // B-TH-050
      const issues = [
        ...(await attachmentProblems(tools.tx, context, thread, draft.attachments, 'PARTNER')),
        ...(await messageLinkProblems(tools.tx, thread, links, { direction: 'OUTBOUND', channel: 'PORTAL' })),
        ...(await aboutProblems(tools.tx, actor, thread, input.about, 'PARTNER')), // B-SA-061
      ]
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
        ...(input.about ? { about: input.about } : {}), // B-SA-061
      })
      await clearDraftInCommand(tools, context.actorId, record) // B-TH-092
      const current = await tools.tx.thread.findUniqueOrThrow({ where: { id: thread.id }, select: THREAD_OFFICE })
      const attachments = await visibleAttachments(tools.tx, context, message.attachmentFileIds)
      return { thread: threadViewOf(current), message: messageViewOf(message, attachments, true, await messageLinksOf(tools.tx, thread.id, [message], { sharedOnly: false, workerShown: true })) }
    },
  )
  return result
}
