import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { EMAIL_SEND, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { outsideAddressWords, RECIPIENT_REFUSALS, recipientRule, type OutsideAddress } from '@nexus/factory-domain/email/recipient-party' // B-TH-004
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { compose } from '@nexus/factory-domain/email/compose'
import { events as emailEvents } from '@nexus/factory-domain/email/events'
import { privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor, replyAddress, replySubject, threadingOf } from '@nexus/factory-domain/email/headers'
import { buildMime, type MimeAttachment } from '@nexus/factory-domain/email/mime'
import {
  allRecipients,
  attachmentSizeProblems,
  cleanSubject,
  failureText,
  identityReady,
  localeOf,
  MAX_ATTACHMENT_BYTES,
  MAX_SEND_ATTEMPTS,
  normalizeRecipients,
  recipientProblems,
  SEND_CLAIM_MS,
  subjectProblems,
  suppressionProblems,
  type OutboundStatus,
  type Recipients,
} from '@nexus/factory-domain/email/rules'
import { eventFor } from '@nexus/factory-domain/events/define'
import { addressOwnership } from './mis-send/check' // B-TH-004
import { cleanBody, MAX_BODY_LENGTH } from '@nexus/factory-domain/threads/rules'
import { encodeCursor } from '@nexus/factory-domain/threads/timeline'
import { COMMAND_SETTINGS, command, runCommand, type CommandCaller, type CommandSpec, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { companyLegalOf } from '../documents/documents'
import type { Clock } from '../../core/time'
import { brandedIdentity } from '../branding/sender'
import { GatewayCallFailed, GatewayRefusal } from '../gateway/gateway'
import { defineHandler, type EventHandler } from '../outbox/dispatch'
import {
  afterCursor,
  attachmentProblems,
  contextOf,
  cursorOf,
  ensureThread,
  officeRecord,
  scopeOfThread,
  threadViewOf,
  writeMessage,
  type RecordRef,
  type ThreadRow,
} from '../threads/threads'
// B-TH-050: a mail names the shared message it answers, or the mail of ours it corrects.
import { messageLinkProblems } from '../threads/threads'
import type { EmailView } from './contract'
import { processEmail, type EmailRuntime } from './service'
// B-W2b-371: a record type's thread gate (a rider's profile: sales.measurements.view).
import { mayOnThread } from '../threads/records'
// B-TH-048: undo send (a thread mail waits 10 s and may be taken back meanwhile).
import { isDue, sendAfterOf, UNDO_REFUSALS, undoRefusal, undoUntilOf, waitMsOf, type UndoRefusal } from '@nexus/factory-domain/email/undo-send'
// B-TH-092: the sender's draft of the record goes with the mail sent from its thread.
import { clearDraftInCommand } from '../threads/draft-keys'

/**
 * Mail out on record threads (plan A1 §3.3 `email-out`, §3.7; features PLT-139, PLT-149, COL-024):
 *
 *   send      `sendEmail(tools, …)` inside a command (the route's `email.send`, or a module's own command that sends):
 *             the record's thread (ensureThread), the attachments checked as shared with the thread's party
 *             (attachmentProblems PARTNER) and together at most MAX_ATTACHMENT_BYTES (10 MB), the recipients checked
 *             against the suppression list, the OUTBOUND EMAIL
 *             message on the thread (writeMessage: its text is the mail's), the EmailOutbound row QUEUED (From line,
 *             recipients, subject, Message-ID, In-Reply-To and References from the thread's earlier mail) and the
 *             event email.queued: all in ONE transaction.
 *   deliver   the worker's handler of email.queued (`deliverOutbound`): a claim (QUEUED → SENDING, one try counted,
 *             suppression and identity checked again) → the MIME built from the message (headers, the reply address
 *             read from the thread here and nowhere else, the footer with the legal block and the privacy notice, the
 *             attached files' bytes read through the file store: one `files.read` gateway call each) →
 *             ONE gateway call (`mail.send`, one IntegrationCall row) → SENT with SES's message id; a failure goes back
 *             to QUEUED for the job's next try, or FAILED after MAX_SEND_ATTEMPTS or when it cannot succeed. A mail
 *             already SENT (a repeated event) is left alone: it is sent once.
 *   list      GET /threads/<type>/<id>/emails: the thread's mail and where each one is (threads.read).
 *   undo      B-TH-048 (threads plan TH-3, thread-G08, Owner decision 6): a mail sent from the thread's composer (the route's
 *             send) waits 10 seconds (sendAfter; its message is held: no customer reads it meanwhile) and its sender may take
 *             it back in that time: POST /threads/<type>/<id>/emails/<emailId>/undo, QUEUED → WITHDRAWN, never claimed. The
 *             worker's job waits until sendAfter (the dispatcher's delay) and claims only after it; the claim (or a failure)
 *             releases the message (the database). A module's document mail and the system's mail leave at once.
 *
 * Sign-in mail uses the same `deliverOutbound` with a body made in memory (auth-mail.ts).
 */

const [queued, statusChanged] = emailEvents

const OUTBOUND_VIEW = {
  id: true,
  companyId: true,
  identityId: true,
  threadId: true,
  messageId: true,
  templateKey: true,
  locale: true,
  fromAddress: true,
  fromName: true,
  to: true,
  cc: true,
  bcc: true,
  subject: true,
  status: true,
  attempts: true,
  lastError: true,
  queuedAt: true,
  sentAt: true,
  deliveredAt: true,
  bouncedAt: true,
  complainedAt: true,
  failedAt: true,
  // B-TH-048: the undo window, who sent it, the take-back.
  sendAfter: true,
  createdById: true,
  withdrawnAt: true,
  withdrawnById: true,
} as const satisfies Prisma.EmailOutboundSelect
type OutboundViewRow = Prisma.EmailOutboundGetPayload<{ select: typeof OUTBOUND_VIEW }>

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

export function emailViewOf(row: OutboundViewRow, now: Date = new Date()): EmailView {
  return {
    id: row.id,
    companyId: row.companyId,
    identityId: row.identityId,
    threadId: row.threadId,
    messageId: row.messageId,
    templateKey: row.templateKey,
    locale: row.locale,
    from: { name: row.fromName, address: row.fromAddress },
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    queuedAt: toUtcIso(row.queuedAt),
    sentAt: iso(row.sentAt),
    deliveredAt: iso(row.deliveredAt),
    bouncedAt: iso(row.bouncedAt),
    complainedAt: iso(row.complainedAt),
    failedAt: iso(row.failedAt),
    // B-TH-048: "Sending… · Undo" until undoUntil; a mail taken back says when and by whom.
    sendAfter: iso(row.sendAfter),
    undoUntil: iso(undoUntilOf(row, now)),
    sentById: row.createdById,
    withdrawnAt: iso(row.withdrawnAt),
    withdrawnById: row.withdrawnById,
  }
}

const IDENTITY_SEND = {
  id: true,
  companyId: true,
  kind: true,
  domain: true,
  fromAddress: true,
  displayName: true,
  displayNamePolicy: true,
  replyDomain: true,
  accountId: true,
  status: true,
  verificationStatus: true,
  dkimStatus: true,
} as const satisfies Prisma.EmailIdentitySelect
export type SendingIdentity = Prisma.EmailIdentityGetPayload<{ select: typeof IDENTITY_SEND }>

/**
 * The identity a mail goes out from: the one named (it must be the company's), else the company's default of the kind;
 * it must be ready (active, domain and DKIM verified).
 */
export async function sendingIdentity(tx: CommandTx, companyId: string | null, identityId: string | null | undefined, kind: 'CONVERSATION' | 'NOTIFICATION'): Promise<SendingIdentity> {
  const identity = identityId
    ? await tx.emailIdentity.findFirst({ where: { id: identityId, ...(companyId ? { companyId } : {}) }, select: IDENTITY_SEND })
    : companyId
      ? await tx.emailIdentity.findFirst({ where: { companyId, kind, isDefault: true, status: 'ACTIVE' }, select: IDENTITY_SEND, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      : null
  if (!identity) {
    throw new ValidationError('No sending address for this company.', [
      { path: 'body/identityId', message: identityId ? 'Not a sending identity of the record\'s company.' : 'The company has no default sending identity; name one.' },
    ])
  }
  if (!identityReady(identity)) throw new InvalidStateError('This sending address is not verified in SES yet (domain and DKIM), or it is disabled.')
  // B-W2b-161: the company's branding names the mail it sends to partners (platform/branding sender.ts).
  return brandedIdentity(tx, identity)
}

/** The suppressed addresses among these (PLT-149). */
export async function suppressedAmong(tx: CommandTx, addresses: readonly string[]): Promise<Set<string>> {
  if (addresses.length === 0) return new Set()
  // B-W2b-24: only a block in force (a lifted one keeps its address: mail may go to it again).
  const rows = await tx.suppression.findMany({ where: { address: { in: [...addresses] }, liftedAt: null }, select: { address: true } })
  return new Set(rows.map((row) => row.address))
}

// ---- B-TH-004 (threads plan TH-0, WALL-G03/G04/G05; T20 T21 T24): one recipient rule for every mail on a party's record ---------

/** The names the office reads for parties (trade name, else the registered one). */
async function partyNamesOf(client: CommandTx | FactoryClient, ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return new Map()
  const rows = await client.party.findMany({ where: { id: { in: wanted } }, select: { id: true, legalName: true, tradeName: true } })
  return new Map(rows.map((row) => [row.id, row.tradeName?.trim() || row.legalName]))
}

/**
 * The recipient rule (factory-domain email/recipient-party) on a record of a party: a To or Cc address of ANOTHER party
 * (its contact or portal person, and not one of this party's) is refused unless the person ticked "Send outside this
 * customer"; a Bcc goes only to our own people or the party's own, tick or not. Refused in words: 409 `refusal/OTHER_PARTY`
 * or `refusal/HIDDEN_OUTSIDE`, each address at its field saying whose it is (the office reads every customer). Returns the
 * addresses the tick let through, for the send's audit row. A record without a party: nothing to check.
 */
export async function checkRecipientRule(
  client: CommandTx | FactoryClient,
  input: { readonly recordParty: string | null; readonly to: readonly string[]; readonly cc?: readonly string[] | undefined; readonly bcc?: readonly string[] | undefined; readonly sendOutside?: boolean | undefined; readonly at?: string | undefined; readonly pathOf?: ((address: OutsideAddress) => string) | undefined },
): Promise<readonly OutsideAddress[]> {
  if (input.recordParty === null) return []
  const ownership = await addressOwnership(client, [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])])
  const { outside, hiddenOutside } = recipientRule({ recordParty: input.recordParty, to: input.to, cc: input.cc, bcc: input.bcc, ownership })
  if (outside.length === 0 && hiddenOutside.length === 0) return []
  const names = await partyNamesOf(client, [...outside, ...hiddenOutside].flatMap((address) => address.parties))
  const nameOf = (partyId: string) => names.get(partyId) ?? ''
  const at = input.at ?? 'body'
  const issuesOf = (list: readonly OutsideAddress[]) => list.map((address) => ({ path: input.pathOf?.(address) ?? `${at}/${address.field}/${address.index}`, message: outsideAddressWords(address, nameOf) }))
  if (hiddenOutside.length > 0) {
    const words = RECIPIENT_REFUSALS.HIDDEN_OUTSIDE.en
    throw new DomainError('conflict', words, [{ path: 'refusal/HIDDEN_OUTSIDE', message: words }, ...issuesOf(hiddenOutside)])
  }
  if (input.sendOutside !== true) {
    const words = RECIPIENT_REFUSALS.OTHER_PARTY.en
    throw new DomainError('conflict', words, [{ path: 'refusal/OTHER_PARTY', message: words }, ...issuesOf(outside)])
  }
  return outside
}
// ---- end B-TH-004

export interface ThreadMailInput {
  readonly record: RecordRef
  /** The office user who sends: their name (and address, for PERSON_ADDRESS) make the From line. */
  readonly sender: { readonly userId: string; readonly name: string; readonly email: string | null }
  readonly to: readonly string[]
  readonly cc?: readonly string[] | undefined
  readonly bcc?: readonly string[] | undefined
  /** Null or missing: "Re: " and the subject of the thread's latest mail. */
  readonly subject?: string | null | undefined
  readonly body: string
  /** Files of the record, shared with its party. */
  readonly attachments?: readonly string[] | undefined
  /** Default: the company's default CONVERSATION identity. */
  readonly identityId?: string | null | undefined
  /** The language of the mail's fixed text. Default: the company's. */
  readonly locale?: string | null | undefined
  /**
   * B-TH-004: the person ticked "Send outside this customer": To and Cc may hold an address of another party of the record's
   * (recorded in the send's audit row). Without it such an address is refused (checkRecipientRule).
   */
  readonly sendOutside?: boolean | undefined
  /**
   * B-TH-048: the mail waits UNDO_SEND_MS (10 s) before it leaves and its sender may take it back meanwhile; its message is
   * held until then. Only the thread composer's Send (sendFromThread); a module's document mail leaves at once.
   */
  readonly undoWindow?: boolean | undefined
  // ---- B-TH-050: the shared message it answers ("Reply"), or the mail of ours it corrects ("Correct"), one at most.
  readonly replyToMessageId?: string | null | undefined
  readonly correctsMessageId?: string | null | undefined
}

export interface ThreadMailResult {
  readonly thread: ThreadRow
  readonly messageId: string
  readonly outbound: OutboundViewRow
}

type SendTools = Pick<CommandTools, 'tx' | 'context' | 'now' | 'audit' | 'emit'>

/**
 * Queues a mail on a record's thread, inside the caller's command (see the module comment). No permission check here:
 * the caller (the route, a module's command) has done its own. Throws a ValidationError with the problems' paths.
 */
export async function sendEmail(tools: SendTools, input: ThreadMailInput): Promise<ThreadMailResult> {
  const { tx, now, context } = tools
  const { thread } = await ensureThread(tools, input.record, input.sender.userId)
  if (thread.status !== 'OPEN') throw new InvalidStateError('This thread is closed; reopen it to send mail.')
  const identity = await sendingIdentity(tx, thread.companyId, input.identityId, 'CONVERSATION')

  const recipients: Recipients = normalizeRecipients(input)
  const bodyText = cleanBody(input.body)
  const attachments = [...new Set(input.attachments ?? [])]
  let subject = input.subject === null || input.subject === undefined ? null : cleanSubject(input.subject)
  if (subject === null) {
    const latest = await tx.emailOutbound.findFirst({ where: { threadId: thread.id }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], select: { subject: true } })
    subject = latest ? replySubject(latest.subject) : ''
  }
  const problems: Issue[] = [...recipientProblems(recipients), ...subjectProblems(subject)]
  if (bodyText.length === 0) problems.push({ path: 'body/body', message: 'Write the message.' })
  if (bodyText.length > MAX_BODY_LENGTH) problems.push({ path: 'body/body', message: `A message holds at most ${MAX_BODY_LENGTH} characters.` })
  const attachmentIssues = await attachmentProblems(tx, context, thread, attachments, 'PARTNER')
  problems.push(...attachmentIssues)
  if (attachments.length > 0 && attachmentIssues.length === 0) {
    const sizes = await tx.storedFile.findMany({ where: { id: { in: attachments } }, select: { sizeBytes: true } })
    problems.push(...attachmentSizeProblems(sizes.map((file) => file.sizeBytes)))
  }
  problems.push(...suppressionProblems(recipients, await suppressedAmong(tx, allRecipients(recipients))))
  // B-TH-050: what it answers or corrects (a message of this conversation shared with the party; a mail corrects a mail).
  const links = { replyToMessageId: input.replyToMessageId ?? null, correctsMessageId: input.correctsMessageId ?? null }
  problems.push(...(await messageLinkProblems(tx, thread, links, { direction: 'OUTBOUND', channel: 'EMAIL' })))
  if (problems.length > 0) throw new ValidationError('The mail is not valid.', problems)
  // B-TH-004: one recipient rule for every mail on a party's record (the thread's party is the record's).
  const sentOutside = await checkRecipientRule(tx, { recordParty: thread.partyId, to: recipients.to, cc: recipients.cc, bcc: recipients.bcc, sendOutside: input.sendOutside })

  const earlier = await tx.message.findMany({
    where: { threadId: thread.id, emailMessageId: { not: null } },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
    select: { emailMessageId: true },
  })
  const threading = threadingOf(earlier.map((row) => row.emailMessageId as string))
  const company = await tx.company.findUniqueOrThrow({ where: { id: identity.companyId }, select: { locale: true } })
  const outboundId = newId()
  const emailMessageId = messageIdFor(outboundId, identity.domain)
  const from = fromLine(identity, { name: input.sender.name, email: input.sender.email })
  // B-TH-048: the mail and its message wait together (the database requires both or neither).
  const sendAfter = input.undoWindow === true ? sendAfterOf(now) : null

  const message = await writeMessage(tools, thread, {
    direction: 'OUTBOUND',
    channel: 'EMAIL',
    author: { kind: 'USER', id: input.sender.userId, name: input.sender.name },
    bodyText,
    attachments,
    emailMessageId,
    ...(sendAfter ? { held: true } : {}), // B-TH-048
    ...links, // B-TH-050
  })
  const outbound = await tx.emailOutbound.create({
    data: {
      id: outboundId,
      companyId: identity.companyId,
      identityId: identity.id,
      threadId: thread.id,
      messageId: message.id,
      recordType: thread.recordType,
      recordId: thread.recordId,
      templateKey: 'thread.message',
      locale: localeOf(input.locale ?? company.locale),
      fromAddress: from.address,
      fromName: from.name,
      to: [...recipients.to],
      cc: [...recipients.cc],
      bcc: [...recipients.bcc],
      subject,
      emailMessageId,
      inReplyTo: threading.inReplyTo,
      referenceIds: threading.references,
      status: 'QUEUED',
      queuedAt: now,
      ...(sendAfter ? { sendAfter } : {}), // B-TH-048
      createdAt: now,
      updatedAt: now,
      createdById: input.sender.userId,
    },
    select: OUTBOUND_VIEW,
  })
  tools.audit({
    recordType: 'EmailOutbound',
    recordId: outboundId,
    companyId: identity.companyId,
    siteId: thread.siteId,
    after: {
      threadId: thread.id,
      messageId: message.id,
      identityId: identity.id,
      templateKey: 'thread.message',
      recipients: allRecipients(recipients).length,
      attachments: attachments.length,
      status: 'QUEUED',
      ...(sendAfter ? { sendAfter: toUtcIso(sendAfter) } : {}), // B-TH-048
      // B-TH-004: what the person's "Send outside this customer" let through, and whose each address is.
      ...(sentOutside.length > 0 ? { sentOutside: sentOutside.map((address) => ({ address: address.address, parties: address.parties })) } : {}),
    },
  })
  tools.emit(eventFor(queued, { subject: outboundId, companyId: identity.companyId, siteId: thread.siteId, payload: { outboundId, threadId: thread.id, messageId: message.id, ...(sendAfter ? { sendAfter: toUtcIso(sendAfter) } : {}) } }))
  return { thread, messageId: message.id, outbound }
}

export interface SendRouteBody {
  readonly to: readonly string[]
  readonly cc?: readonly string[] | undefined
  readonly bcc?: readonly string[] | undefined
  readonly subject?: string | undefined
  readonly body: string
  readonly attachments?: readonly string[] | undefined
  readonly identityId?: string | undefined
  readonly locale?: string | undefined
  /** B-TH-004: the person ticked "Send outside this customer". */
  readonly sendOutside?: boolean | undefined
  // ---- B-TH-050
  readonly replyToMessageId?: string | undefined
  readonly correctsMessageId?: string | undefined
}

/** POST /threads/<type>/<id>/emails (email.send): the signed-in person sends a mail from the record's thread. */
export async function sendFromThread(caller: CommandCaller, record: RecordRef, body: SendRouteBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const { scope } = await caller.withClient((client) => officeRecord(client, record))
  if (!mayOnThread(actor, THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
  if (!can(actor, EMAIL_SEND, scope)) throw new ForbiddenError()

  const { result } = await command(caller, { name: 'email.send', idempotencyKey, input: { recordType: record.type, recordId: record.id, ...body } }, async (tools) => {
    const user = await tools.tx.user.findUniqueOrThrow({ where: { id: context.actorId }, select: { displayName: true, email: true } })
    // B-TH-048: the composer's Send waits 10 s, so its sender can take it back (POST …/emails/:emailId/undo).
    const sent = await sendEmail(tools, { ...body, record, sender: { userId: context.actorId, name: user.displayName, email: user.email }, undoWindow: true })
    await clearDraftInCommand(tools, context.actorId, record) // B-TH-092
    // The thread as it is now (made by this command or a racing one): its scope decides.
    if (!can(actor, EMAIL_SEND, scopeOfThread(sent.thread))) throw new ForbiddenError()
    return { thread: threadViewOf(sent.thread), messageId: sent.messageId, email: emailViewOf(sent.outbound, tools.now) }
  })
  return result
}

/** GET /threads/<type>/<id>/emails (threads.read): the thread's mail, newest first, with where each one is. */
export async function listThreadEmails(caller: CommandCaller, record: RecordRef, page: { readonly cursor?: string | undefined; readonly limit: number }) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const cursor = cursorOf(page.cursor)
  return caller.withClient(async (client) => {
    const { thread, scope } = await officeRecord(client, record)
    if (!mayOnThread(actorOf(context), THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
    if (!thread) return { emails: [], nextCursor: null }
    const rows = await client.emailOutbound.findMany({
      where: { AND: [{ threadId: thread.id }, afterCursor(cursor, 'queuedAt') as Prisma.EmailOutboundWhereInput] },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      select: OUTBOUND_VIEW,
    })
    const shown = rows.slice(0, page.limit)
    const last = shown.at(-1)
    const now = new Date()
    return { emails: shown.map((row) => emailViewOf(row, now)), nextCursor: rows.length > page.limit && last ? encodeCursor({ at: last.queuedAt, id: last.id }) : null }
  })
}

// ---- B-TH-048 (threads plan TH-3, thread-G08, feature T7-F06; Owner decision 6): take a mail back in its 10 seconds ---------

function undoRefused(code: UndoRefusal): DomainError {
  const words = UNDO_REFUSALS[code].en
  return new DomainError('conflict', words, [{ path: `refusal/${code}`, message: words }])
}

/**
 * POST /threads/<type>/<id>/emails/<emailId>/undo (email.send over the record): the person who sent a mail from the thread
 * takes it back before it leaves — QUEUED → WITHDRAWN with when and by whom, only while it was never claimed and before its
 * sendAfter (the commands' clock); the worker then has nothing to claim, and its message stays held for good (the customer
 * never reads it; the office reads it as taken back). Refused in words (409 refusal/<code>: NO_WINDOW, LEFT, NOT_SENT,
 * NOT_YOURS). A mail already taken back by them is answered again without a change. The answer gives the mail's text back
 * (to, cc, bcc, subject, body, attachments) for the composer: "taken back = the text back in the box".
 */
export async function takeBackEmail(caller: CommandCaller, record: RecordRef, emailId: string, idempotencyKey?: string) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const { thread, scope } = await caller.withClient((client) => officeRecord(client, record))
  if (!mayOnThread(actor, THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
  if (!can(actor, EMAIL_SEND, scope)) throw new ForbiddenError()
  if (!thread) throw new NotFoundError('Mail not found.')

  const { result } = await command(caller, { name: 'email.takeBack', idempotencyKey, input: { recordType: record.type, recordId: record.id, emailId } }, async (tools) => {
    // One take-back or claim at a time: the worker's claim reads the same row.
    await tools.tx.$queryRaw`SELECT id FROM "EmailOutbound" WHERE id = ${emailId}::uuid FOR UPDATE`
    const row = await tools.tx.emailOutbound.findFirst({ where: { id: emailId, threadId: thread.id }, select: { ...OUTBOUND_VIEW, messageId: true } })
    if (!row || !row.messageId) throw new NotFoundError('Mail not found.')
    const refusal = undoRefusal(row, context.actorId, tools.now)
    if (refusal) throw undoRefused(refusal)
    let current = row
    if (row.status !== 'WITHDRAWN') {
      const { count } = await tools.tx.emailOutbound.updateMany({
        where: { id: row.id, status: 'QUEUED', attempts: 0 },
        data: { status: 'WITHDRAWN', withdrawnAt: tools.now, withdrawnById: context.actorId, version: { increment: 1 } },
      })
      if (count !== 1) throw undoRefused('LEFT')
      current = await tools.tx.emailOutbound.findUniqueOrThrow({ where: { id: row.id }, select: { ...OUTBOUND_VIEW, messageId: true } })
      emitStatus(tools, { id: row.id, companyId: row.companyId, threadId: thread.id, recordType: thread.recordType, recordId: thread.recordId }, 'WITHDRAWN')
    }
    tools.audit({
      action: 'email.takeBack',
      recordType: 'EmailOutbound',
      recordId: row.id,
      companyId: row.companyId,
      siteId: thread.siteId,
      before: { status: row.status },
      after: { status: 'WITHDRAWN', messageId: row.messageId, ...(row.status === 'WITHDRAWN' ? { unchanged: true } : {}) },
    })
    const message = await tools.tx.message.findUniqueOrThrow({ where: { id: row.messageId }, select: { bodyText: true, attachmentFileIds: true } })
    return {
      email: emailViewOf(current, tools.now),
      text: { to: current.to, cc: current.cc, bcc: current.bcc, subject: current.subject, body: message.bodyText, attachments: message.attachmentFileIds },
    }
  })
  return result
}
// ---- end B-TH-048

// ---------------------------------------------------------------------------------------------------------------------
// Delivery

const OUTBOUND_SEND = {
  ...OUTBOUND_VIEW,
  recordType: true,
  recordId: true,
  emailMessageId: true,
  inReplyTo: true,
  referenceIds: true,
  claimedUntil: true,
  identity: { select: IDENTITY_SEND },
} as const satisfies Prisma.EmailOutboundSelect
export type ClaimedOutbound = Prisma.EmailOutboundGetPayload<{ select: typeof OUTBOUND_SEND }>

/** How a delivery ended: sent, failed for good, to be retried by the job, or nothing to do (sent, claimed elsewhere, taken back). */
export type DeliveryOutcome = 'sent' | 'failed' | 'retry' | 'settled'

export interface DeliverOptions {
  /** May a failed try go back to QUEUED for another (the worker's job), or is every failure final (sign-in mail)? */
  readonly retry: boolean
  /** The whole MIME message of the claimed mail. */
  readonly build: (row: ClaimedOutbound) => Promise<string>
  /** The commands' clock. Default the server's. */
  readonly clock?: Clock
  /** The event that asked for it (the commands' causationId). */
  readonly causationId?: string
}

/** The mail's state changed: its live message for the record's thread panel. */
function emitStatus(tools: Pick<CommandTools, 'emit'>, row: { readonly id: string; readonly companyId: string; readonly threadId: string | null; readonly recordType: string | null; readonly recordId: string | null }, status: OutboundStatus): void {
  tools.emit(
    eventFor(statusChanged, {
      subject: row.id,
      companyId: row.companyId,
      payload: { outboundId: row.id, threadId: row.threadId, recordType: row.recordType, recordId: row.recordId, status },
    }),
  )
}

/** The mail did not leave and cannot: FAILED, with why. Inside a command. */
async function fail(tools: CommandTools, row: ClaimedOutbound, reason: string): Promise<void> {
  const lastError = failureText(reason)
  await tools.tx.emailOutbound.update({ where: { id: row.id }, data: { status: 'FAILED', failedAt: tools.now, claimedUntil: null, lastError }, select: { id: true } })
  tools.audit({ action: 'email.failed', recordType: 'EmailOutbound', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'FAILED', lastError } })
  emitStatus(tools, row, 'FAILED')
}

/**
 * Sends one EmailOutbound row (see the module comment). Safe to repeat: only a QUEUED row (or a SENDING one whose claim
 * lapsed) is claimed, so a mail is sent once however often its event comes. B-TH-048: a thread mail still in its undo window
 * is not claimed — 'retry' (the modules' own mails, which never wait, never meet it; the worker's handler reads it apart with
 * deliverWhenDue).
 */
export async function deliverOutbound(runtime: EmailRuntime, caller: CommandCaller, outboundId: string, options: DeliverOptions): Promise<DeliveryOutcome> {
  const outcome = await deliverWhenDue(runtime, caller, outboundId, options)
  return outcome === 'waiting' ? 'retry' : outcome
}

/** B-TH-048: deliverOutbound, saying 'waiting' for a mail still in its undo window (not claimed: come back at its sendAfter). */
export async function deliverWhenDue(runtime: EmailRuntime, caller: CommandCaller, outboundId: string, options: DeliverOptions): Promise<DeliveryOutcome | 'waiting'> {
  const settings = { ...COMMAND_SETTINGS, ...(options.clock ? { clock: options.clock } : {}) }
  const run = <Result>(spec: CommandSpec, work: (tools: CommandTools) => Promise<Result>) =>
    runCommand(caller, { ...spec, ...(options.causationId ? { causationId: options.causationId } : {}) }, work, settings)

  // Nothing to claim (sent already, or claimed by another worker): no command, no audit row.
  const before = await caller.withClient((client) => client.emailOutbound.findUnique({ where: { id: outboundId }, select: { status: true, claimedUntil: true, sendAfter: true } }))
  const open = before?.status === 'QUEUED' || (before?.status === 'SENDING' && (before.claimedUntil === null || before.claimedUntil.getTime() <= settings.clock.now().getTime()))
  if (!open) return 'settled'
  // B-TH-048: a thread mail is not claimed before its sendAfter (its sender may still take it back).
  if (before.status === 'QUEUED' && !isDue(before, settings.clock.now())) return 'waiting'

  const { result: claim } = await run({ name: 'email.claim', input: { outboundId } }, async (tools): Promise<'claimed' | 'failed' | 'settled' | 'waiting'> => {
    // B-TH-048: the row locked, so a take-back (email.takeBack locks it too) and this claim never cross.
    await tools.tx.$queryRaw`SELECT id FROM "EmailOutbound" WHERE id = ${outboundId}::uuid FOR UPDATE`
    const row = await tools.tx.emailOutbound.findUnique({ where: { id: outboundId }, select: OUTBOUND_SEND })
    const lapsed = row?.status === 'SENDING' && (row.claimedUntil === null || row.claimedUntil.getTime() <= tools.now.getTime())
    if (!row || (row.status !== 'QUEUED' && !lapsed)) {
      tools.audit({ action: 'email.claimSkipped', recordType: 'EmailOutbound', recordId: outboundId, after: { status: row?.status ?? null } })
      return 'settled'
    }
    // B-TH-048: still in its undo window (read again under the lock): not claimed yet.
    if (row.status === 'QUEUED' && !isDue(row, tools.now)) {
      tools.audit({ action: 'email.claimSkipped', recordType: 'EmailOutbound', recordId: outboundId, after: { status: row.status, waitingUntil: toUtcIso(row.sendAfter!) } })
      return 'waiting'
    }
    const suppressed = await suppressedAmong(tools.tx, [...row.to, ...row.cc, ...row.bcc])
    if (suppressed.size > 0) {
      await fail(tools, row, `suppressed: ${suppressed.size} recipient(s) bounced or complained before`)
      return 'failed'
    }
    if (!identityReady(row.identity)) {
      await fail(tools, row, 'the sending identity is disabled or not verified in SES')
      return 'failed'
    }
    const { count } = await tools.tx.emailOutbound.updateMany({
      where: { id: outboundId, status: row.status, attempts: row.attempts },
      data: { status: 'SENDING', attempts: { increment: 1 }, claimedUntil: new Date(tools.now.getTime() + SEND_CLAIM_MS) },
    })
    if (count !== 1) {
      tools.audit({ action: 'email.claimSkipped', recordType: 'EmailOutbound', recordId: outboundId, after: { status: row.status } })
      return 'settled'
    }
    tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: row.companyId, before: { status: row.status }, after: { status: 'SENDING', attempt: row.attempts + 1 } })
    return 'claimed'
  })
  if (claim !== 'claimed') return claim
  // Claimed by this call (SENDING until the claim lapses): read as it is now, outside the claim's transaction.
  const row = await caller.withClient(async (client) => {
    const found = await client.emailOutbound.findUniqueOrThrow({ where: { id: outboundId }, select: OUTBOUND_SEND })
    // B-W2b-161: the company's name under the signature is its branding's sender name (platform/branding sender.ts).
    return { ...found, identity: await brandedIdentity(client, found.identity) }
  })

  let failure: { readonly message: string; readonly retryable: boolean }
  try {
    const raw = await options.build(row)
    const sent = await runtime.mail.send(caller, row.identity.accountId, {
      outboundId: row.id,
      templateKey: row.templateKey,
      from: row.fromAddress,
      to: row.to,
      cc: row.cc,
      bcc: row.bcc,
      raw,
    })
    await run({ name: 'email.recordSent', input: { outboundId } }, async (tools) => {
      const { count } = await tools.tx.emailOutbound.updateMany({
        where: { id: outboundId, status: 'SENDING' },
        data: { status: 'SENT', sesMessageId: sent.sesMessageId, sentAt: tools.now, claimedUntil: null, lastError: null },
      })
      tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: row.companyId, before: { status: 'SENDING' }, after: { status: count === 1 ? 'SENT' : 'unchanged' } })
      if (count === 1) emitStatus(tools, row, 'SENT')
      return null
    })
    return 'sent'
  } catch (error) {
    const retryable = error instanceof GatewayRefusal || (error instanceof GatewayCallFailed && error.retryable)
    failure = { message: error instanceof Error ? `${error.name}: ${error.message}` : String(error), retryable }
  }

  const again = options.retry && failure.retryable && row.attempts < MAX_SEND_ATTEMPTS
  await run({ name: 'email.recordFailure', input: { outboundId } }, async (tools) => {
    const current = await tools.tx.emailOutbound.findUnique({ where: { id: outboundId }, select: { status: true } })
    if (current?.status !== 'SENDING') {
      tools.audit({ action: 'email.claimSkipped', recordType: 'EmailOutbound', recordId: outboundId, after: { status: current?.status ?? null } })
      return null
    }
    if (!again) {
      await fail(tools, { ...row, status: 'SENDING' }, failure.message)
      return null
    }
    const lastError = failureText(failure.message)
    await tools.tx.emailOutbound.update({ where: { id: outboundId }, data: { status: 'QUEUED', claimedUntil: null, lastError }, select: { id: true } })
    tools.audit({ action: 'email.retry', recordType: 'EmailOutbound', recordId: outboundId, companyId: row.companyId, before: { status: 'SENDING' }, after: { status: 'QUEUED', lastError, attempts: row.attempts } })
    return null
  })
  return again ? 'retry' : 'failed'
}

/**
 * The files a record mail attaches, with their bytes: each still AVAILABLE, of the thread's record and shared with its
 * party (checked again: a file may have changed since the mail was queued), together at most MAX_ATTACHMENT_BYTES, read
 * through the file store (one `files.read` gateway call each, never inside a command). A file that no longer qualifies
 * fails the mail (a plain Error: final); a store that does not answer fails the try (the gateway's error: retried).
 */
async function attachmentsOf(runtime: EmailRuntime, caller: CommandCaller, thread: { readonly recordType: string; readonly recordId: string; readonly partyId: string | null }, fileIds: readonly string[]): Promise<MimeAttachment[]> {
  if (fileIds.length === 0) return []
  const rows = await caller.withClient((client) =>
    client.storedFile.findMany({
      where: { id: { in: [...fileIds] } },
      select: { id: true, originalName: true, contentType: true, sizeBytes: true, status: true, recordType: true, recordId: true, partyId: true, storeAccountId: true, storageKey: true },
    }),
  )
  const files = fileIds.map((id) => {
    const file = rows.find((row) => row.id === id)
    if (!file || file.status !== 'AVAILABLE' || file.recordType !== thread.recordType || file.recordId !== thread.recordId || file.partyId === null || file.partyId !== thread.partyId) {
      throw new Error(`attachment ${id} is no longer an available file shared with the record's party`)
    }
    return file
  })
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  if (total > MAX_ATTACHMENT_BYTES) throw new Error(`the attachments hold ${total} bytes; a mail carries at most ${MAX_ATTACHMENT_BYTES}`)
  const attached: MimeAttachment[] = []
  for (const file of files) {
    const content = await runtime.files().read(caller, file.storeAccountId, file.storageKey, file.sizeBytes)
    if (!content) throw new Error(`attachment ${file.id} is missing from the file store`)
    attached.push({ filename: file.originalName, contentType: file.contentType, content })
  }
  return attached
}

/** The MIME of a record mail, from its thread message and its attached files (read in the caller's system scope). */
export function threadMailBuilder(runtime: EmailRuntime, caller: CommandCaller, clock?: Clock): (row: ClaimedOutbound) => Promise<string> {
  return async (row) => {
    if (!row.threadId || !row.messageId) throw new Error('A record mail names its thread and message.')
    const { threadId, messageId, identity } = row
    const { thread, message } = await caller.withClient(async (client) => ({
      thread: await client.thread.findUniqueOrThrow({ where: { id: threadId }, select: { replyToken: true, recordType: true, recordId: true, partyId: true } }),
      message: await client.message.findUniqueOrThrow({ where: { id: messageId }, select: { bodyText: true, authorName: true, attachmentFileIds: true } }),
    }))
    const company = await companyLegalOf(caller, row.companyId)
    const attachments = await attachmentsOf(runtime, caller, thread, message.attachmentFileIds)
    const mail = compose(
      { template: 'thread.message', body: message.bodyText, senderName: message.authorName, companyName: identity.displayName, attachmentNames: attachments.map((file) => file.filename) },
      { locale: localeOf(row.locale), company, privacyUrl: privacyNoticeUrl(runtime.webOrigin, row.companyId) },
    )
    return buildMime({
      id: row.id,
      from: { name: row.fromName, address: row.fromAddress },
      to: row.to,
      cc: row.cc,
      replyTo: replyAddress(thread.replyToken, identity.replyDomain),
      subject: row.subject,
      messageId: row.emailMessageId,
      inReplyTo: row.inReplyTo,
      references: row.referenceIds,
      date: (clock ?? COMMAND_SETTINGS.clock).now(),
      text: mail.text,
      html: mail.html,
      automatic: false,
      attachments,
    })
  }
}

export const EMAIL_SEND_HANDLER = 'email.sendQueued'
const queuedPayload = queued.payload

export interface EmailSendHandlerOptions {
  /** B-TH-048: the clock the handler reads the undo window on (and the delivery's commands run on). Default the server's. */
  readonly clock?: Clock
  /** How the handler waits for a window's end (tests may pass one that returns at once). Default a timer. */
  readonly sleep?: (ms: number) => Promise<void>
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The worker's handler of email.queued (background.ts HANDLERS). A try that should be repeated throws, so BullMQ retries
 * it with backoff (as many tries as the mail has); a mail sent, failed for good or taken by another worker ends the job.
 * B-TH-048: a thread mail's job waits until its sendAfter (the dispatcher's `delay`, from the event); one that runs early
 * anyway (a retry, the golden flow's drain, another clock) waits the rest here — at most the window's cap — and tries again.
 */
export function emailSendHandler(runtime: () => EmailRuntime = processEmail, options: EmailSendHandlerOptions = {}): EventHandler {
  const clock = options.clock ?? COMMAND_SETTINGS.clock
  const sleep = options.sleep ?? sleepFor
  return defineHandler({
    name: EMAIL_SEND_HANDLER,
    events: ['email.queued'],
    attempts: MAX_SEND_ATTEMPTS,
    delayMs(event, now) {
      const sendAfter = (event.payload as { sendAfter?: unknown } | null)?.sendAfter
      return typeof sendAfter === 'string' ? waitMsOf({ sendAfter: new Date(sendAfter) }, now) : 0
    },
    async handle(event, tools) {
      const { outboundId } = queuedPayload.parse(event.payload)
      const email = runtime()
      const deliver = () => deliverWhenDue(email, tools.caller, outboundId, { retry: true, clock, build: threadMailBuilder(email, tools.caller, clock), causationId: event.eventId })
      let outcome = await deliver()
      if (outcome === 'waiting') {
        // B-TH-048: read the window again (the row is the truth, not the event) and wait its rest once.
        const row = await tools.caller.withClient((client) => client.emailOutbound.findUnique({ where: { id: outboundId }, select: { sendAfter: true } }))
        await sleep(waitMsOf({ sendAfter: row?.sendAfter ?? null }, clock.now()) + 50)
        outcome = await deliver()
      }
      if (outcome === 'retry' || outcome === 'waiting') throw new Error(`mail ${outboundId} was not sent this time; it will be tried again`)
    },
  })
}
