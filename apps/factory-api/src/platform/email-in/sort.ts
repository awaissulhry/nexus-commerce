import type { Prisma } from '@nexus/factory-db'
import { events as emailInEvents } from '@nexus/factory-domain/email-in/events'
import { sortMail, type InboundAttachment, type InboundStatus, type SortOutcome } from '@nexus/factory-domain/email-in/rules'
import { eventFor } from '@nexus/factory-domain/events/define'
import { uniqueIds } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { defineHandler, type EventHandler } from '../outbox/dispatch'
import { ensureThread, THREAD_OFFICE, writeMessage, type ThreadRow } from '../threads/threads'
import { recordFiles, type StoredPart } from './files'
import { MAIL_FACTS, PARTY_RECORD, sortFactsOf, type Suggestion } from './match'

/**
 * Sorting a read mail (plan A1 §3.7 "Matching"; COL-020, COL-022, COL-023, COL-025), the worker's handler of
 * email.inbound_fetched: ONE command `emailIn.sort` locks the FETCHED row, reads the facts (match.ts), lets
 * factory-domain's `sortMail` decide, and applies it in the same transaction:
 *   MATCHED    the thread (the record's, or the sender's party's, made when it has none) gets the mail as an INBOUND
 *              EMAIL message (sanitised HTML, the mail's Message-ID: unique in the tenant, so the same mail never
 *              becomes a second message), its attachments become files of the thread's record shared with the party;
 *   HELD       it waits for a person (a DMARC failure, spam, an unknown sender, a closed thread), with the thread it
 *              named; its attachments are files of the mail, office only;
 *   TRIAGE     "mail to sort", with the party it suggests; its attachments are files of the mail, office only;
 *   REJECTED   the same Message-ID is a thread message already (DUPLICATE): nothing is written.
 * and the event email.inbound_sorted (the "mail to sort" screen; a joined mail also has thread.message_posted). Safe to
 * repeat: only a FETCHED row is sorted.
 */

const sorted = emailInEvents[2]

export const MAIL_SORT = {
  ...MAIL_FACTS,
  receivedAt: true,
  fromName: true,
  subject: true,
  bodyText: true,
  bodyHtml: true,
  attachments: true,
  threadId: true,
  senderPartyId: true,
  senderContactId: true,
} as const satisfies Prisma.InboundEmailSelect
export type MailRow = Prisma.InboundEmailGetPayload<{ select: typeof MAIL_SORT }>

/** The attachments as stored on the row. */
export const attachmentsOf = (row: { readonly attachments: Prisma.JsonValue }): InboundAttachment[] => (Array.isArray(row.attachments) ? (row.attachments as unknown as InboundAttachment[]) : [])
/** The kept ones, with their objects in the store. */
export const keptOf = (attachments: readonly InboundAttachment[]): StoredPart[] => attachments.filter((part): part is StoredPart => part.kept)

/** The kept parts with the files that now hold them (in order). */
export function withFiles(attachments: readonly InboundAttachment[], fileIds: readonly string[]): InboundAttachment[] {
  let index = 0
  return attachments.map((part) => (part.kept ? { ...part, fileId: fileIds[index++] ?? null } : part))
}

/**
 * The mail as an INBOUND message of the thread (the email-in side of the threads seam), inside the caller's command:
 * its stored parts become files of the thread's record shared with the thread's party, then the message (author: the
 * party's contact when known, else the sender's name or address; text, sanitised HTML, Message-ID, received time).
 * Answers the message and the file of each part.
 */
export async function joinThread(tools: CommandTools, thread: ThreadRow, mail: MailRow, parts: readonly StoredPart[], contactId: string | null): Promise<{ messageId: string; fileIds: string[] }> {
  const fileIds = await recordFiles(tools, { recordType: thread.recordType, recordId: thread.recordId, companyId: thread.companyId, partyId: thread.partyId }, parts)
  const message = await writeMessage(tools, thread, {
    direction: 'INBOUND',
    channel: 'EMAIL',
    author: { kind: 'PARTY', id: contactId, name: mail.fromName ?? mail.fromAddress },
    bodyText: mail.bodyText && mail.bodyText !== '' ? mail.bodyText : (mail.subject ?? '—'),
    bodyHtml: mail.bodyHtml,
    attachments: uniqueIds(fileIds),
    emailMessageId: mail.emailMessageId,
    at: mail.receivedAt,
  })
  return { messageId: message.id, fileIds }
}

/** The files of a mail that waits (TRIAGE, HELD): office only, on the mail itself. */
export const keepOnMail = (tools: CommandTools, mail: Pick<MailRow, 'id' | 'companyId'>, parts: readonly StoredPart[]): Promise<string[]> =>
  recordFiles(tools, { recordType: 'InboundEmail', recordId: mail.id, companyId: mail.companyId, partyId: null }, parts)

/** The sorting event of a mail. */
export function emitSorted(tools: Pick<CommandTools, 'emit'>, mail: Pick<MailRow, 'id' | 'companyId'>, status: InboundStatus, threadId: string | null, messageId: string | null): void {
  tools.emit(eventFor(sorted, { subject: mail.id, companyId: mail.companyId, payload: { inboundEmailId: mail.id, status, threadId, messageId } }))
}

async function apply(tools: CommandTools, mail: MailRow, outcome: SortOutcome, suggestion: Suggestion, senderPartyId: string | null, record: { readonly type: string; readonly id: string } | null = null): Promise<{ threadId: string | null; messageId: string | null }> {
  const { tx, now } = tools
  const attachments = attachmentsOf(mail)
  const parts = keptOf(attachments)
  const common = { senderPartyId: suggestion.senderPartyId, senderContactId: suggestion.senderContactId, sortedAt: now, version: { increment: 1 } }
  if (outcome.status === 'REJECTED') {
    await tx.inboundEmail.update({ where: { id: mail.id }, data: { ...common, status: 'REJECTED', rejectReason: outcome.reason }, select: { id: true } })
    return { threadId: null, messageId: null }
  }
  if (outcome.status === 'MATCHED') {
    const thread =
      outcome.threadId !== null
        ? await tx.thread.findUniqueOrThrow({ where: { id: outcome.threadId }, select: THREAD_OFFICE })
        : (await ensureThread(tools, record ?? { type: PARTY_RECORD, id: senderPartyId! }, null)).thread
    const { messageId, fileIds } = await joinThread(tools, thread, mail, parts, suggestion.senderPartyId === thread.partyId ? suggestion.senderContactId : null)
    await tx.inboundEmail.update({
      where: { id: mail.id },
      data: { ...common, status: 'MATCHED', threadId: thread.id, messageId, matchedBy: outcome.by, attachments: withFiles(attachments, fileIds) as unknown as Prisma.InputJsonValue },
      select: { id: true },
    })
    return { threadId: thread.id, messageId }
  }
  const fileIds = await keepOnMail(tools, mail, parts)
  await tx.inboundEmail.update({
    where: { id: mail.id },
    data: {
      ...common,
      status: outcome.status,
      threadId: outcome.threadId,
      ...(outcome.status === 'HELD' ? { heldReason: outcome.reason } : {}),
      attachments: withFiles(attachments, fileIds) as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  })
  return { threadId: outcome.threadId, messageId: null }
}

/** Sorts one read mail (see the module comment). */
export async function sortInbound(caller: CommandCaller, inboundEmailId: string, options: { readonly causationId?: string } = {}): Promise<InboundStatus | 'settled'> {
  const before = await caller.withClient((client) => client.inboundEmail.findUnique({ where: { id: inboundEmailId }, select: { status: true } }))
  if (before?.status !== 'FETCHED') return 'settled'
  const { result } = await command(caller, { name: 'emailIn.sort', input: { inboundEmailId }, ...(options.causationId ? { causationId: options.causationId } : {}) }, async (tools) => {
    const { tx } = tools
    // The lock: the row stays FETCHED (and locked) for the rest of the transaction; a sorted row matches nothing.
    const { count } = await tx.inboundEmail.updateMany({ where: { id: inboundEmailId, status: 'FETCHED' }, data: { lastError: null } })
    const mail = count === 1 ? await tx.inboundEmail.findUniqueOrThrow({ where: { id: inboundEmailId }, select: MAIL_SORT }) : null
    if (!mail) {
      tools.audit({ action: 'emailIn.sortSkipped', recordType: 'InboundEmail', recordId: inboundEmailId })
      return 'settled' as const
    }
    const { facts, suggestion, record } = await sortFactsOf(tx, mail)
    const outcome = sortMail(facts)
    // B-W2b-17: a known sender's mail joins the record the match named (a complaint) when not the party's own thread.
    const { threadId, messageId } = await apply(tools, mail, outcome, suggestion, facts.senderParty?.partyId ?? null, record)
    tools.audit({
      recordType: 'InboundEmail',
      recordId: mail.id,
      companyId: mail.companyId,
      before: { status: 'FETCHED' },
      after: {
        status: outcome.status,
        ...(outcome.status === 'MATCHED' ? { matchedBy: outcome.by } : {}),
        ...(outcome.status === 'HELD' || outcome.status === 'REJECTED' ? { reason: outcome.reason } : {}),
        threadId,
        messageId,
        senderPartyId: suggestion.senderPartyId,
      },
    })
    emitSorted(tools, mail, outcome.status, threadId, messageId)
    return outcome.status
  })
  return result
}

export const EMAIL_SORT_HANDLER = 'emailIn.sort'
const fetchedPayload = emailInEvents[1].payload

/** The worker's handler of email.inbound_fetched (background.ts HANDLERS). A failure throws: BullMQ retries it. */
export function emailSortHandler(): EventHandler {
  return defineHandler({
    name: EMAIL_SORT_HANDLER,
    events: ['email.inbound_fetched'],
    attempts: 5,
    async handle(event, tools) {
      const { inboundEmailId } = fetchedPayload.parse(event.payload)
      await sortInbound(tools.caller, inboundEmailId, { causationId: event.eventId })
    },
  })
}
