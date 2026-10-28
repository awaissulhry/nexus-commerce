import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { EMAIL_TRIAGE, FILES_READ, THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { inboundMachine, TO_SORT, type InboundStatus } from '@nexus/factory-domain/email-in/rules'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { encodeCursor } from '@nexus/factory-domain/threads/timeline'
import { excerptOf } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf, type OfficeContext, type RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { GatewayCallFailed, GatewayRefusal } from '../gateway/gateway'
import type { AttachmentView } from '../threads/contract'
import { afterCursor, contextOf, cursorOf, ensureThread, officeRecord, scopeOfThread, THREAD_OFFICE, type RecordRef, type ThreadRow } from '../threads/threads'
import type { InboundDetailView, InboundSummaryView } from './contract'
import { putPart, type StoredPart } from './files'
import type { EmailInRuntime } from './service'
import { attachmentsOf, emitSorted, joinThread, keptOf, MAIL_SORT, type MailRow } from './sort'

/**
 * "Mail to sort" (A2 SCR-019; plan A1 §3.7; features COL-022, COL-023, COL-025): the office's side of email in. Every
 * route needs email.triage over the mail's company (the SES account's; a tenant-wide account's mail: any company), and
 * writing into a record's thread also threads.post over the record. Each change is ONE command with its audit row and
 * email.inbound_sorted, guarded by the mail's version (the worker moves it too):
 *
 *   list     GET /email/inbound: the mail to sort (TRIAGE, HELD, FAILED; or one status), newest first, in the person's
 *            companies
 *   view     GET /email/inbound/:id: the sanitised text and HTML, SES's verdicts, the attachments (kept: the file that
 *            holds them; skipped: why), the thread it names, what it suggests
 *   assign   POST …/assign (TRIAGE or HELD → MATCHED, MANUAL): the record's thread gets the mail as an INBOUND message;
 *            the record must have a customer or supplier (the message is shared with it)
 *   release  POST …/release (HELD): a person says the mail is genuine. It joins the thread it named (MATCHED, MANUAL),
 *            also a closed one; a mail that named none goes to the triage list (TRIAGE)
 *   reject   POST …/reject (TRIAGE, HELD or FAILED → REJECTED): spam (MARKED_SPAM) or thrown away (DISCARDED)
 *
 * The attachments of a waiting mail are files of the mail itself; assigning or releasing it copies them onto the record
 * (each read and put again through the file store, before the command: a file's record never changes), shared with the
 * record's party. The mail keeps its own copies.
 */

const companyScope = { company: { field: 'companyId', nullable: true as const } }

const SUMMARY = {
  id: true,
  companyId: true,
  status: true,
  receivedAt: true,
  fromAddress: true,
  fromName: true,
  subject: true,
  bodyText: true,
  spfVerdict: true,
  dkimVerdict: true,
  dmarcVerdict: true,
  dmarcPolicy: true,
  spamVerdict: true,
  virusVerdict: true,
  heldReason: true,
  rejectReason: true,
  matchedBy: true,
  threadId: true,
  senderPartyId: true,
  senderContactId: true,
  attachments: true,
  version: true,
} as const satisfies Prisma.InboundEmailSelect
type SummaryRow = Prisma.InboundEmailGetPayload<{ select: typeof SUMMARY }>

const DETAIL = {
  ...SUMMARY,
  to: true,
  cc: true,
  bodyHtml: true,
  messageId: true,
  attempts: true,
  lastError: true,
  fetchedAt: true,
  sortedAt: true,
  sortedById: true,
} as const satisfies Prisma.InboundEmailSelect
type DetailRow = Prisma.InboundEmailGetPayload<{ select: typeof DETAIL }>

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

function summaryOf(row: SummaryRow): InboundSummaryView {
  return {
    id: row.id,
    companyId: row.companyId,
    status: row.status,
    receivedAt: toUtcIso(row.receivedAt),
    from: { address: row.fromAddress, name: row.fromName },
    subject: row.subject,
    excerpt: excerptOf(row.bodyText ?? ''),
    verdicts: { spf: row.spfVerdict, dkim: row.dkimVerdict, dmarc: row.dmarcVerdict, dmarcPolicy: row.dmarcPolicy, spam: row.spamVerdict, virus: row.virusVerdict },
    heldReason: row.heldReason,
    rejectReason: row.rejectReason,
    matchedBy: row.matchedBy,
    threadId: row.threadId,
    suggestion: { partyId: row.senderPartyId, contactId: row.senderContactId },
    attachmentCount: attachmentsOf(row).length,
    version: row.version,
  }
}

/** The detail, read with the caller's client (a route) or inside its command (an answer kept in the receipt). */
async function detailOf(client: FactoryClient | CommandTx, context: RequestContext, row: DetailRow): Promise<InboundDetailView> {
  const actor = actorOf(context)
  const attachments = attachmentsOf(row)
  const fileIds = attachments.flatMap((part) => (part.kept && part.fileId ? [part.fileId] : []))
  const files = fileIds.length === 0 ? [] : await client.storedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, companyId: true, kind: true, originalName: true, contentType: true, sizeBytes: true, status: true } })
  const seen = new Map<string, AttachmentView>()
  for (const file of files) {
    if (can(actor, FILES_READ, { companyId: file.companyId })) seen.set(file.id, { id: file.id, kind: file.kind, originalName: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, status: file.status })
  }
  const thread = row.threadId ? await client.thread.findUnique({ where: { id: row.threadId }, select: { id: true, recordType: true, recordId: true, status: true } }) : null
  return {
    ...summaryOf(row),
    to: row.to,
    cc: row.cc,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    attachments: attachments.map((part) => ({
      name: part.name,
      contentType: part.contentType,
      sizeBytes: part.sizeBytes,
      kept: part.kept,
      skipReason: part.kept ? null : part.reason,
      file: part.kept && part.fileId ? (seen.get(part.fileId) ?? null) : null,
    })),
    thread,
    messageId: row.messageId,
    attempts: row.attempts,
    lastError: row.lastError,
    fetchedAt: iso(row.fetchedAt),
    sortedAt: iso(row.sortedAt),
    sortedById: row.sortedById,
  }
}

function officeOf(caller: CommandCaller): OfficeContext {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The mail as a person who sorts it sees it: any other (another tenant's, out of their companies) is not found. */
async function readMail(caller: CommandCaller, inboundEmailId: string): Promise<DetailRow & MailRow> {
  const context = officeOf(caller)
  if (!isUuid(inboundEmailId)) throw new NotFoundError('Mail not found.')
  const row = await caller.withClient((client) => client.inboundEmail.findUnique({ where: { id: inboundEmailId }, select: { ...DETAIL, ...MAIL_SORT } }))
  if (!row || !can(actorOf(context), EMAIL_TRIAGE, { companyId: row.companyId })) throw new NotFoundError('Mail not found.')
  return row
}

/** GET /email/inbound: one page of the mail to sort (or of one status), newest first. */
export async function listInbound(caller: CommandCaller, query: { readonly status?: InboundStatus | undefined; readonly companyId?: string | undefined; readonly cursor?: string | undefined; readonly limit: number }) {
  const context = officeOf(caller)
  const cursor = cursorOf(query.cursor)
  const scope = scopeWhere(actorOf(context), EMAIL_TRIAGE, companyScope) as Prisma.InboundEmailWhereInput
  const rows = await caller.withClient((client) =>
    client.inboundEmail.findMany({
      where: {
        AND: [
          scope,
          { status: query.status ? query.status : { in: [...TO_SORT] } },
          query.companyId ? { companyId: query.companyId } : {},
          afterCursor(cursor, 'receivedAt') as Prisma.InboundEmailWhereInput,
        ],
      },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: SUMMARY,
    }),
  )
  const shown = rows.slice(0, query.limit)
  const last = shown.at(-1)
  return { mails: shown.map(summaryOf), nextCursor: rows.length > query.limit && last ? encodeCursor({ at: last.receivedAt, id: last.id }) : null }
}

/** GET /email/inbound/:id. */
export async function getInbound(caller: CommandCaller, inboundEmailId: string): Promise<{ mail: InboundDetailView }> {
  const row = await readMail(caller, inboundEmailId)
  return { mail: await caller.withClient((client) => detailOf(client, officeOf(caller), row)) }
}

/** A store call's failure for the person: the file store is not reachable now (503). */
async function storeCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof GatewayRefusal || error instanceof GatewayCallFailed) {
      throw new ApiError('not_ready', 'The file store is not available right now; nothing was changed. Try again shortly.')
    }
    throw error
  }
}

/**
 * The waiting mail's files, copied for a record (before the command): each AVAILABLE file of the mail is read and put
 * again under a new key of the record's company, in the mail's order.
 */
async function copyFiles(runtime: EmailInRuntime, caller: CommandCaller, mail: MailRow, companyId: string | null): Promise<StoredPart[]> {
  const context = officeOf(caller)
  const kept = keptOf(attachmentsOf(mail)).filter((part) => part.fileId !== null)
  if (kept.length === 0) return []
  const rows = await caller.withClient((client) =>
    client.storedFile.findMany({
      where: { id: { in: kept.map((part) => part.fileId!) }, recordType: 'InboundEmail', recordId: mail.id, status: 'AVAILABLE' },
      select: { id: true, originalName: true, contentType: true, sizeBytes: true, sha256: true, storeAccountId: true, storageKey: true },
    }),
  )
  const files = runtime.files()
  const copies: StoredPart[] = []
  for (const part of kept) {
    const row = rows.find((file) => file.id === part.fileId)
    if (!row) continue
    const body = await storeCall(() => files.storage.read(caller, row.storeAccountId, row.storageKey, row.sizeBytes))
    if (!body) throw new ConflictError(`The attachment ${row.originalName} of this mail is missing from the file store.`)
    copies.push(
      await storeCall(() =>
        putPart(files, caller, { tenantId: context.tenantId, companyId, storeAccountId: row.storeAccountId }, { name: row.originalName, contentType: row.contentType, body, sha256: row.sha256 }),
      ),
    )
  }
  return copies
}

const guarded = (inboundEmailId: string, version: number) => ({ type: 'InboundEmail' as const, id: inboundEmailId, expectedVersion: version })

/**
 * Joins a waiting mail to a thread inside the command (assign and release): the version guard has locked the row; the
 * move is checked against the machine; the copies become files of the record; the mail becomes MATCHED (MANUAL).
 */
async function joinManually(tools: CommandTools, context: OfficeContext, inboundEmailId: string, thread: ThreadRow, copies: readonly StoredPart[], reason?: string): Promise<InboundDetailView> {
  const { tx, now } = tools
  const mail = await tx.inboundEmail.findUniqueOrThrow({ where: { id: inboundEmailId }, select: { ...MAIL_SORT, status: true, heldReason: true } })
  assertTransition(inboundMachine, mail.status, 'MATCHED')
  if (thread.partyId === null) throw new ConflictError('This record has no customer or supplier to share the mail with.')
  if (mail.emailMessageId && (await tx.message.findFirst({ where: { emailMessageId: mail.emailMessageId }, select: { id: true } }))) {
    throw new ConflictError('This mail is a message of a thread already.')
  }
  const contactId = mail.senderPartyId === thread.partyId ? mail.senderContactId : null
  const { messageId } = await joinThread(tools, thread, mail, copies, contactId)
  await tx.inboundEmail.update({
    where: { id: inboundEmailId },
    data: { status: 'MATCHED', threadId: thread.id, messageId, matchedBy: 'MANUAL', heldReason: null, sortedAt: now, sortedById: context.actorId },
    select: { id: true },
  })
  tools.audit({
    recordType: 'InboundEmail',
    recordId: inboundEmailId,
    companyId: mail.companyId,
    before: { status: mail.status, heldReason: mail.heldReason },
    after: { status: 'MATCHED', matchedBy: 'MANUAL', threadId: thread.id, recordType: thread.recordType, recordId: thread.recordId, messageId, files: copies.length },
    ...(reason ? { reason } : {}),
  })
  emitSorted(tools, mail, 'MATCHED', thread.id, messageId)
  const row = await tx.inboundEmail.findUniqueOrThrow({ where: { id: inboundEmailId }, select: DETAIL })
  return detailOf(tx, context, row)
}

/** POST /email/inbound/:id/assign: the record's thread gets the mail (TRIAGE or HELD → MATCHED, MANUAL). */
export async function assignInbound(runtime: EmailInRuntime, caller: CommandCaller, inboundEmailId: string, input: { readonly recordType: string; readonly recordId: string; readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const mail = await readMail(caller, inboundEmailId)
  if (mail.status !== 'TRIAGE' && mail.status !== 'HELD') throw new InvalidStateError(`This mail is ${mail.status}; only mail that waits (TRIAGE, HELD) is assigned.`)
  const record: RecordRef = { type: input.recordType, id: input.recordId }
  const { scope } = await caller.withClient((client) => officeRecord(client, record))
  if (!can(actor, THREADS_READ, scope)) throw new NotFoundError('Record not found.')
  if (!can(actor, THREADS_POST, scope)) throw new ForbiddenError()
  if (!scope.partyId) throw new ConflictError('This record has no customer or supplier to share the mail with.')
  const copies = await copyFiles(runtime, caller, mail, scope.companyId ?? null)
  const { result } = await command(
    caller,
    { name: 'emailIn.assign', idempotencyKey, input: { inboundEmailId, recordType: record.type, recordId: record.id }, record: guarded(inboundEmailId, input.version) },
    async (tools) => {
      const { thread } = await ensureThread(tools, record, context.actorId)
      if (!can(actor, THREADS_POST, scopeOfThread(thread))) throw new ForbiddenError()
      return { mail: await joinManually(tools, context, inboundEmailId, thread, copies) }
    },
  )
  return result
}

/** POST /email/inbound/:id/release: a HELD mail goes on, into the thread it named (MATCHED), else to the triage list. */
export async function releaseInbound(runtime: EmailInRuntime, caller: CommandCaller, inboundEmailId: string, input: { readonly version: number; readonly reason?: string | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const mail = await readMail(caller, inboundEmailId)
  if (mail.status !== 'HELD') throw new InvalidStateError(`This mail is ${mail.status}; only a HELD mail is released.`)
  const thread = mail.threadId ? await caller.withClient((client) => client.thread.findUnique({ where: { id: mail.threadId! }, select: THREAD_OFFICE })) : null
  let copies: StoredPart[] = []
  if (thread) {
    const scope: ScopedRecord = scopeOfThread(thread)
    if (!can(actor, THREADS_READ, scope) || !can(actor, THREADS_POST, scope)) throw new ForbiddenError()
    if (thread.partyId === null) throw new ConflictError('The thread this mail names has no customer or supplier to share it with; assign it to a record.')
    copies = await copyFiles(runtime, caller, mail, thread.companyId)
  }
  const { result } = await command(
    caller,
    { name: 'emailIn.release', idempotencyKey, input: { inboundEmailId, reason: input.reason ?? null }, record: guarded(inboundEmailId, input.version) },
    async (tools) => {
      if (thread) {
        const current = await tools.tx.thread.findUniqueOrThrow({ where: { id: thread.id }, select: THREAD_OFFICE })
        return { mail: await joinManually(tools, context, inboundEmailId, current, copies, input.reason) }
      }
      const { tx, now } = tools
      const before = await tx.inboundEmail.findUniqueOrThrow({ where: { id: inboundEmailId }, select: { id: true, companyId: true, status: true, heldReason: true } })
      assertTransition(inboundMachine, before.status, 'TRIAGE')
      await tx.inboundEmail.update({ where: { id: inboundEmailId }, data: { status: 'TRIAGE', heldReason: null, sortedAt: now, sortedById: context.actorId }, select: { id: true } })
      tools.audit({ recordType: 'InboundEmail', recordId: inboundEmailId, companyId: before.companyId, before: { status: 'HELD', heldReason: before.heldReason }, after: { status: 'TRIAGE' }, ...(input.reason ? { reason: input.reason } : {}) })
      emitSorted(tools, before, 'TRIAGE', null, null)
      return { mail: await detailOf(tx, context, await tx.inboundEmail.findUniqueOrThrow({ where: { id: inboundEmailId }, select: DETAIL })) }
    },
  )
  return result
}

/** POST /email/inbound/:id/reject: spam or thrown away (TRIAGE, HELD or FAILED → REJECTED). */
export async function rejectInbound(caller: CommandCaller, inboundEmailId: string, input: { readonly reason: 'MARKED_SPAM' | 'DISCARDED'; readonly version: number; readonly note?: string | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const mail = await readMail(caller, inboundEmailId)
  if (!(['TRIAGE', 'HELD', 'FAILED'] as InboundStatus[]).includes(mail.status)) throw new InvalidStateError(`This mail is ${mail.status}; only mail to sort is thrown away.`)
  const { result } = await command(
    caller,
    { name: 'emailIn.reject', idempotencyKey, input: { inboundEmailId, reason: input.reason }, record: guarded(inboundEmailId, input.version) },
    async (tools) => {
      const { tx, now } = tools
      const before = await tx.inboundEmail.findUniqueOrThrow({ where: { id: inboundEmailId }, select: { id: true, companyId: true, status: true, heldReason: true } })
      assertTransition(inboundMachine, before.status, 'REJECTED')
      await tx.inboundEmail.update({ where: { id: inboundEmailId }, data: { status: 'REJECTED', rejectReason: input.reason, heldReason: null, sortedAt: now, sortedById: context.actorId }, select: { id: true } })
      tools.audit({ recordType: 'InboundEmail', recordId: inboundEmailId, companyId: before.companyId, before: { status: before.status, heldReason: before.heldReason }, after: { status: 'REJECTED', rejectReason: input.reason }, ...(input.note ? { reason: input.note } : {}) })
      emitSorted(tools, before, 'REJECTED', null, null)
      return { mail: await detailOf(tx, context, await tx.inboundEmail.findUniqueOrThrow({ where: { id: inboundEmailId }, select: DETAIL })) }
    },
  )
  return result
}
