import type { Prisma } from '@nexus/factory-db'
import { EMAIL_SEND, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
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
import { cleanBody, MAX_BODY_LENGTH } from '@nexus/factory-domain/threads/rules'
import { encodeCursor } from '@nexus/factory-domain/threads/timeline'
import { COMMAND_SETTINGS, command, runCommand, type CommandCaller, type CommandSpec, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { companyLegalOf } from '../documents/documents'
import type { Clock } from '../../core/time'
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
import type { EmailView } from './contract'
import { processEmail, type EmailRuntime } from './service'

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
} as const satisfies Prisma.EmailOutboundSelect
type OutboundViewRow = Prisma.EmailOutboundGetPayload<{ select: typeof OUTBOUND_VIEW }>

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

export function emailViewOf(row: OutboundViewRow): EmailView {
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
  return identity
}

/** The suppressed addresses among these (PLT-149). */
export async function suppressedAmong(tx: CommandTx, addresses: readonly string[]): Promise<Set<string>> {
  if (addresses.length === 0) return new Set()
  const rows = await tx.suppression.findMany({ where: { address: { in: [...addresses] } }, select: { address: true } })
  return new Set(rows.map((row) => row.address))
}

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
  if (problems.length > 0) throw new ValidationError('The mail is not valid.', problems)

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

  const message = await writeMessage(tools, thread, {
    direction: 'OUTBOUND',
    channel: 'EMAIL',
    author: { kind: 'USER', id: input.sender.userId, name: input.sender.name },
    bodyText,
    attachments,
    emailMessageId,
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
    after: { threadId: thread.id, messageId: message.id, identityId: identity.id, templateKey: 'thread.message', recipients: allRecipients(recipients).length, attachments: attachments.length, status: 'QUEUED' },
  })
  tools.emit(eventFor(queued, { subject: outboundId, companyId: identity.companyId, siteId: thread.siteId, payload: { outboundId, threadId: thread.id, messageId: message.id } }))
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
}

/** POST /threads/<type>/<id>/emails (email.send): the signed-in person sends a mail from the record's thread. */
export async function sendFromThread(caller: CommandCaller, record: RecordRef, body: SendRouteBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const { scope } = await caller.withClient((client) => officeRecord(client, record))
  if (!can(actor, THREADS_READ, scope)) throw new NotFoundError('Record not found.')
  if (!can(actor, EMAIL_SEND, scope)) throw new ForbiddenError()

  const { result } = await command(caller, { name: 'email.send', idempotencyKey, input: { recordType: record.type, recordId: record.id, ...body } }, async (tools) => {
    const user = await tools.tx.user.findUniqueOrThrow({ where: { id: context.actorId }, select: { displayName: true, email: true } })
    const sent = await sendEmail(tools, { ...body, record, sender: { userId: context.actorId, name: user.displayName, email: user.email } })
    // The thread as it is now (made by this command or a racing one): its scope decides.
    if (!can(actor, EMAIL_SEND, scopeOfThread(sent.thread))) throw new ForbiddenError()
    return { thread: threadViewOf(sent.thread), messageId: sent.messageId, email: emailViewOf(sent.outbound) }
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
    if (!can(actorOf(context), THREADS_READ, scope)) throw new NotFoundError('Record not found.')
    if (!thread) return { emails: [], nextCursor: null }
    const rows = await client.emailOutbound.findMany({
      where: { AND: [{ threadId: thread.id }, afterCursor(cursor, 'queuedAt') as Prisma.EmailOutboundWhereInput] },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      select: OUTBOUND_VIEW,
    })
    const shown = rows.slice(0, page.limit)
    const last = shown.at(-1)
    return { emails: shown.map(emailViewOf), nextCursor: rows.length > page.limit && last ? encodeCursor({ at: last.queuedAt, id: last.id }) : null }
  })
}

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

/** How a delivery ended: sent, failed for good, to be retried by the job, or nothing to do (sent or claimed elsewhere). */
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
 * lapsed) is claimed, so a mail is sent once however often its event comes.
 */
export async function deliverOutbound(runtime: EmailRuntime, caller: CommandCaller, outboundId: string, options: DeliverOptions): Promise<DeliveryOutcome> {
  const settings = { ...COMMAND_SETTINGS, ...(options.clock ? { clock: options.clock } : {}) }
  const run = <Result>(spec: CommandSpec, work: (tools: CommandTools) => Promise<Result>) =>
    runCommand(caller, { ...spec, ...(options.causationId ? { causationId: options.causationId } : {}) }, work, settings)

  // Nothing to claim (sent already, or claimed by another worker): no command, no audit row.
  const before = await caller.withClient((client) => client.emailOutbound.findUnique({ where: { id: outboundId }, select: { status: true, claimedUntil: true } }))
  const open = before?.status === 'QUEUED' || (before?.status === 'SENDING' && (before.claimedUntil === null || before.claimedUntil.getTime() <= settings.clock.now().getTime()))
  if (!open) return 'settled'

  const { result: claim } = await run({ name: 'email.claim', input: { outboundId } }, async (tools): Promise<'claimed' | 'failed' | 'settled'> => {
    const row = await tools.tx.emailOutbound.findUnique({ where: { id: outboundId }, select: OUTBOUND_SEND })
    const lapsed = row?.status === 'SENDING' && (row.claimedUntil === null || row.claimedUntil.getTime() <= tools.now.getTime())
    if (!row || (row.status !== 'QUEUED' && !lapsed)) {
      tools.audit({ action: 'email.claimSkipped', recordType: 'EmailOutbound', recordId: outboundId, after: { status: row?.status ?? null } })
      return 'settled'
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
  const row = await caller.withClient((client) => client.emailOutbound.findUniqueOrThrow({ where: { id: outboundId }, select: OUTBOUND_SEND }))

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

/**
 * The worker's handler of email.queued (background.ts HANDLERS). A try that should be repeated throws, so BullMQ retries
 * it with backoff (as many tries as the mail has); a mail sent, failed for good or taken by another worker ends the job.
 */
export function emailSendHandler(runtime: () => EmailRuntime = processEmail): EventHandler {
  return defineHandler({
    name: EMAIL_SEND_HANDLER,
    events: ['email.queued'],
    attempts: MAX_SEND_ATTEMPTS,
    async handle(event, tools) {
      const { outboundId } = queuedPayload.parse(event.payload)
      const email = runtime()
      const outcome = await deliverOutbound(email, tools.caller, outboundId, { retry: true, build: threadMailBuilder(email, tools.caller), causationId: event.eventId })
      if (outcome === 'retry') throw new Error(`mail ${outboundId} was not sent this time; it will be tried again`)
    },
  })
}
