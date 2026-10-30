import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { FILES_READ, THREADS_MANAGE, THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as threadEvents } from '@nexus/factory-domain/threads/events'
import {
  audienceOf,
  cleanBody,
  newReplyToken,
  noteProblems,
  threadMachine,
  uniqueIds,
  type AuthorKind,
  type MessageChannel,
  type MessageDirection,
  type ThreadStatus,
} from '@nexus/factory-domain/threads/rules'
import { decodeCursor, encodeCursor, type TimelineCursor } from '@nexus/factory-domain/threads/timeline'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { heldRoles } from '../auth/roles/access'
import { audienceSees, type FileAudience, type Viewer } from '../files/rules'
import type { AttachmentView, MessageView, ThreadView } from './contract'
import { followInCommand } from './followers'
import { resolveRecord, type RecordScope } from './records'

/**
 * Record threads (plan A1 §2.3, §3.7; features COL-001, COL-003, COL-020):
 *
 *   read       GET /threads/<type>/<id>: the record's thread and a page of its messages, newest first. The office sees
 *              every message (within can(threads.read) over the record's company, site and party); a portal session
 *              only the messages shared with its party (row-level security first: an internal note never carries a
 *              party), a link only those of its own record. Each attachment is shown only when the reader's file rules
 *              let it see the file.
 *   note       POST …/notes (threads.postNote): an internal note. The record's thread is made with the first message
 *              (one per record, also when two first notes race), from the record's own company, site and party.
 *              Mentions name people who can read the thread (an event each); attachments are AVAILABLE files of the
 *              same record that the writer may read.
 *   status     PUT …/status (threads.setStatus): close a thread to new notes, or reopen it.
 *
 * The email steps write through the same seam inside their own commands: `ensureThread` and `writeMessage` with
 * direction OUTBOUND (the mail sent; its delivery state is the email step's own table) or INBOUND (the reply that
 * arrived, found by the thread's reply token). Every write goes through command() with its audit rows and events.
 */

const [messagePosted, userMentioned] = threadEvents

export interface RecordRef {
  readonly type: string
  readonly id: string
}

const THREAD_COMMON = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  recordType: true,
  recordId: true,
  status: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.ThreadSelect
/** What the office reads of a thread (the reply token stays in the API: the email steps use it). */
export const THREAD_OFFICE = { ...THREAD_COMMON, lastMessageAt: true } as const satisfies Prisma.ThreadSelect
export type ThreadRow = Prisma.ThreadGetPayload<{ select: typeof THREAD_OFFICE }>
type SeenThread = Prisma.ThreadGetPayload<{ select: typeof THREAD_COMMON }> & { lastMessageAt?: Date | null }

const MESSAGE_COMMON = {
  id: true,
  threadId: true,
  direction: true,
  audience: true,
  channel: true,
  authorKind: true,
  authorName: true,
  bodyText: true,
  bodyHtml: true,
  attachmentFileIds: true,
  at: true,
} as const satisfies Prisma.MessageSelect
const MESSAGE_OFFICE = { ...MESSAGE_COMMON, authorId: true, mentionedUserIds: true } as const satisfies Prisma.MessageSelect
type MessageRow = Prisma.MessageGetPayload<{ select: typeof MESSAGE_COMMON }> & { authorId?: string | null; mentionedUserIds?: string[] }

const FILE_COMMON = {
  id: true,
  companyId: true,
  recordType: true,
  recordId: true,
  kind: true,
  originalName: true,
  contentType: true,
  sizeBytes: true,
  status: true,
  visibility: true,
  partyId: true,
} as const satisfies Prisma.StoredFileSelect
/** The partner role cannot read a file's floor site; the office reads it for the audience check. */
const FILE_OFFICE = { ...FILE_COMMON, floorSiteId: true } as const satisfies Prisma.StoredFileSelect

export function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}

const isOffice = (context: RequestContext): boolean => context.audience === 'office'
const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))
const recordWhere = (record: RecordRef) => ({ recordType: record.type, recordId: record.id })
export const scopeOfThread = (thread: Pick<SeenThread, 'companyId' | 'siteId' | 'partyId'>): ScopedRecord => ({
  companyId: thread.companyId,
  siteId: thread.siteId,
  partyId: thread.partyId,
})

function viewerOf(context: RequestContext): Viewer {
  switch (context.audience) {
    case 'office':
    case 'system':
      return { audience: context.audience }
    case 'partner':
      return { audience: 'partner', partyId: context.partyId }
    case 'link':
      return { audience: 'link', partyId: context.partyId, record: context.record }
    default:
      return { audience: 'platform' }
  }
}

/** A page cursor the screen sent back, or a 400. */
export function cursorOf(value: string | undefined): TimelineCursor | null {
  if (value === undefined || value === '') return null
  const cursor = decodeCursor(value)
  if (!cursor) throw new ValidationError('The cursor is not valid.', [{ path: 'querystring/cursor', message: 'Send back nextCursor as it came.' }])
  return cursor
}

/** Rows after the cursor in a newest-first feed ordered by (field, id). */
export function afterCursor(cursor: TimelineCursor | null, field: string): Record<string, unknown> {
  if (!cursor) return {}
  return { OR: [{ [field]: { lt: cursor.at } }, { [field]: cursor.at, id: { lt: cursor.id } }] }
}

/**
 * The record as the office sees it: its thread (if it has one) and its scope, the thread's own when it exists, else the
 * record's from its resolver. A record type without a thread, or a record that does not exist, is not found.
 */
export async function officeRecord(client: FactoryClient | CommandTx, record: RecordRef): Promise<{ thread: ThreadRow | null; scope: ScopedRecord }> {
  const thread = await client.thread.findFirst({ where: recordWhere(record), select: THREAD_OFFICE })
  if (thread) return { thread, scope: scopeOfThread(thread) }
  const scope = await resolveRecord(client, record.type, record.id)
  if (!scope) throw new NotFoundError('Record not found.')
  return { thread: null, scope }
}

export function threadViewOf(row: SeenThread): ThreadView {
  return {
    id: row.id,
    recordType: row.recordType,
    recordId: row.recordId,
    companyId: row.companyId,
    siteId: row.siteId,
    partyId: row.partyId,
    status: row.status,
    ...('lastMessageAt' in row ? { lastMessageAt: iso(row.lastMessageAt ?? null) } : {}),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
  }
}

function messageViewOf(row: MessageRow, attachments: ReadonlyMap<string, AttachmentView>): MessageView {
  return {
    id: row.id,
    threadId: row.threadId,
    direction: row.direction,
    audience: row.audience,
    channel: row.channel,
    author: { kind: row.authorKind, ...('authorId' in row ? { id: row.authorId ?? null } : {}), name: row.authorName },
    body: row.bodyText,
    bodyHtml: row.bodyHtml,
    ...('mentionedUserIds' in row ? { mentions: row.mentionedUserIds ?? [] } : {}),
    attachments: row.attachmentFileIds.flatMap((fileId) => {
      const seen = attachments.get(fileId)
      return seen ? [seen] : []
    }),
    at: toUtcIso(row.at),
  }
}

/**
 * The attached files this reader may see (COL-050, through the files' own rules): row-level security first (a portal
 * or link reads only files shared with its party), then the audience (portal: PARTNER, link: LINK and its record),
 * AVAILABLE for anyone outside the office, and can(files.read) over the file. Anything else is left out, unannounced.
 */
async function visibleAttachments(client: FactoryClient | CommandTx, context: RequestContext, fileIds: readonly string[]): Promise<Map<string, AttachmentView>> {
  const seen = new Map<string, AttachmentView>()
  const ids = [...new Set(fileIds)]
  if (ids.length === 0) return seen
  const rows = await client.storedFile.findMany({ where: { id: { in: ids } }, select: isOffice(context) ? FILE_OFFICE : FILE_COMMON })
  const actor = actorOf(context)
  const viewer = viewerOf(context)
  for (const row of rows) {
    const scope = isOffice(context) ? { companyId: row.companyId } : { companyId: row.companyId, partyId: row.partyId }
    if (!audienceSees(viewer, { ...row, visibility: row.visibility as FileAudience[] })) continue
    if (!isOffice(context) && row.status !== 'AVAILABLE') continue
    if (!can(actor, FILES_READ, scope)) continue
    seen.set(row.id, { id: row.id, kind: row.kind, originalName: row.originalName, contentType: row.contentType, sizeBytes: row.sizeBytes, status: row.status })
  }
  return seen
}

export interface ThreadPage {
  readonly thread: ThreadView | null
  readonly messages: MessageView[]
  readonly nextCursor: string | null
}

const EMPTY: ThreadPage = Object.freeze({ thread: null, messages: [], nextCursor: null })

/** GET /threads/<type>/<id>: the thread and one page of its messages the caller may see, newest first. */
export async function readThread(caller: CommandCaller, record: RecordRef, page: { readonly cursor?: string | undefined; readonly limit: number }): Promise<ThreadPage> {
  const context = contextOf(caller)
  const actor = actorOf(context)
  const cursor = cursorOf(page.cursor)
  const office = isOffice(context)
  if (!office && context.audience !== 'partner' && context.audience !== 'link') throw new ForbiddenError()
  // A link opens one record: any other is not found.
  if (context.audience === 'link' && (context.record.type !== record.type || context.record.id !== record.id)) throw new NotFoundError('Record not found.')

  return caller.withClient(async (client) => {
    let thread: SeenThread | null
    if (office) {
      const found = await officeRecord(client, record)
      if (!can(actor, THREADS_READ, found.scope)) throw new NotFoundError('Record not found.')
      thread = found.thread
    } else {
      // Row-level security shows a partner only its own party's threads; "none" and "not yours" look the same.
      thread = await client.thread.findFirst({ where: recordWhere(record), select: THREAD_COMMON })
      if (thread && !can(actor, THREADS_READ, scopeOfThread(thread))) thread = null
    }
    if (!thread) return EMPTY
    const rows = (await client.message.findMany({
      where: { AND: [{ threadId: thread.id }, office ? {} : { audience: 'PARTNER' }, afterCursor(cursor, 'at') as Prisma.MessageWhereInput] },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      select: office ? MESSAGE_OFFICE : MESSAGE_COMMON,
    })) as MessageRow[]
    const shown = rows.slice(0, page.limit)
    const attachments = await visibleAttachments(client, context, shown.flatMap((row) => row.attachmentFileIds))
    const last = shown.at(-1)
    return {
      thread: threadViewOf(thread),
      messages: shown.map((row) => messageViewOf(row, attachments)),
      nextCursor: rows.length > page.limit && last ? encodeCursor(last) : null,
    }
  })
}

/** The parts of command()'s tools the seam needs. */
export type ThreadTools = Pick<CommandTools, 'tx' | 'context' | 'now' | 'audit' | 'emit'>

/**
 * The record's thread inside a command, made when it has none (COL-001: one per record). Two first messages that race
 * both insert with ON CONFLICT DO NOTHING on (tenant, record): one row wins, and both go on with it. The thread takes
 * the record's company, site and party from its resolver; a thread made before its record had a party takes the
 * party once it has one. No permission check here: the caller (a route, an email job) has done its own.
 */
export async function ensureThread(tools: ThreadTools, record: RecordRef, createdById: string | null): Promise<{ thread: ThreadRow; created: boolean }> {
  const { tx, now } = tools
  const scope: RecordScope | null = await resolveRecord(tx, record.type, record.id)
  let thread = await tx.thread.findFirst({ where: recordWhere(record), select: THREAD_OFFICE })
  if (!thread) {
    if (!scope) throw new NotFoundError('Record not found.')
    const id = newId()
    await tx.thread.createMany({
      data: [
        {
          id,
          companyId: scope.companyId,
          siteId: scope.siteId,
          partyId: scope.partyId,
          recordType: record.type,
          recordId: record.id,
          replyToken: newReplyToken(),
          createdAt: now,
          updatedAt: now,
          createdById,
        },
      ],
      skipDuplicates: true,
    })
    thread = await tx.thread.findFirst({ where: recordWhere(record), select: THREAD_OFFICE })
    if (!thread) throw new ApiError('internal_error', 'The record\'s thread was neither made nor found.')
    if (thread.id === id) {
      tools.audit({
        action: 'threads.open',
        recordType: 'Thread',
        recordId: id,
        companyId: thread.companyId,
        siteId: thread.siteId,
        after: { recordType: record.type, recordId: record.id, partyId: thread.partyId, status: thread.status },
      })
      return { thread, created: true }
    }
  }
  if (thread.partyId === null && scope?.partyId) {
    const partyId = scope.partyId
    thread = await tx.thread.update({ where: { id: thread.id }, data: { partyId }, select: THREAD_OFFICE })
    tools.audit({ action: 'threads.setParty', recordType: 'Thread', recordId: thread.id, companyId: thread.companyId, siteId: thread.siteId, before: { partyId: null }, after: { partyId } })
  }
  return { thread, created: false }
}

/** A message for the seam: what the note route writes now, and the email steps later. */
export interface MessageInput {
  readonly direction: MessageDirection
  readonly channel: MessageChannel
  readonly author: { readonly kind: AuthorKind; readonly id: string | null; readonly name: string | null }
  /** Already cleaned (`cleanBody`). */
  readonly bodyText: string
  /** The sanitised HTML of an inbound mail only. */
  readonly bodyHtml?: string | null
  /** Checked people (`mentionProblems`); internal notes only. */
  readonly mentions?: readonly string[]
  /** Checked files (`attachmentProblems`). */
  readonly attachments?: readonly string[]
  readonly emailMessageId?: string | null
  /** When it entered the thread. Default: the command's time. */
  readonly at?: Date
}

/**
 * Writes one message into a thread, in the command's transaction: the message (append-only), the thread's last
 * activity, the audit row, `thread.message_posted`, and `thread.user_mentioned` for each person mentioned (not the
 * author). A shared message (OUTBOUND, INBOUND) needs the thread's party and carries it.
 */
export async function writeMessage(tools: ThreadTools, thread: ThreadRow, input: MessageInput): Promise<Prisma.MessageGetPayload<{ select: typeof MESSAGE_OFFICE }>> {
  const audience = audienceOf(input.direction)
  if (audience === 'PARTNER' && thread.partyId === null) throw new ConflictError('This record has no customer or supplier to share a message with.')
  const mentions = uniqueIds(input.mentions)
  const attachments = uniqueIds(input.attachments)
  if (mentions.length > 0 && input.direction !== 'INTERNAL_NOTE') throw new ApiError('internal_error', 'Only an internal note mentions people.')
  const id = newId()
  const at = input.at ?? tools.now
  const row = await tools.tx.message.create({
    data: {
      id,
      threadId: thread.id,
      partyId: audience === 'PARTNER' ? thread.partyId : null,
      direction: input.direction,
      audience,
      channel: input.channel,
      authorKind: input.author.kind,
      authorId: input.author.id,
      authorName: input.author.name,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml ?? null,
      mentionedUserIds: mentions,
      attachmentFileIds: attachments,
      emailMessageId: input.emailMessageId ?? null,
      at,
      createdAt: tools.now,
    },
    select: MESSAGE_OFFICE,
  })
  await tools.tx.thread.updateMany({ where: { id: thread.id, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }] }, data: { lastMessageAt: at } })
  tools.audit({
    recordType: 'Message',
    recordId: id,
    companyId: thread.companyId,
    siteId: thread.siteId,
    after: { threadId: thread.id, recordType: thread.recordType, recordId: thread.recordId, direction: input.direction, audience, channel: input.channel, attachments, mentions },
  })
  const about = { threadId: thread.id, messageId: id, recordType: thread.recordType, recordId: thread.recordId }
  const where = { subject: thread.recordId, companyId: thread.companyId, siteId: thread.siteId }
  tools.emit(eventFor(messagePosted, { ...where, payload: { ...about, direction: input.direction, audience } }))
  // B-W2a-20 (COL-006, COL-011): each person the note mentions (not its author) gets a mention row with the note (where
  // was I mentioned), follows the record unless they have a follow row (muted stays muted), and is told (the event).
  const told = mentions.filter((userId) => userId !== input.author.id)
  if (told.length > 0) {
    const authorId = input.author.kind === 'USER' ? input.author.id : null
    await tools.tx.messageMention.createMany({
      data: told.map((userId) => ({ id: newId(), messageId: id, threadId: thread.id, recordType: thread.recordType, recordId: thread.recordId, userId, authorId, at, createdAt: tools.now })),
    })
    for (const userId of told) await followInCommand(tools, { type: thread.recordType, id: thread.recordId, companyId: thread.companyId, siteId: thread.siteId }, userId, 'MENTIONED', input.author.id)
  }
  for (const userId of told) tools.emit(eventFor(userMentioned, { ...where, payload: { ...about, userId, authorId: input.author.id } }))
  return row
}

/**
 * What is wrong with the files a message attaches (empty: none). Each must be a file of the thread's record, AVAILABLE,
 * readable by an office writer (can(files.read) over its company; the system writes for itself), and for a shared
 * message also shared with the thread's party (by portal or link): a file the party may not see never goes to it.
 */
export async function attachmentProblems(tx: CommandTx, context: RequestContext, thread: ThreadRow, fileIds: readonly string[], audience: 'OFFICE' | 'PARTNER'): Promise<Issue[]> {
  if (fileIds.length === 0) return []
  const rows = await tx.storedFile.findMany({ where: { id: { in: [...fileIds] } }, select: { id: true, companyId: true, recordType: true, recordId: true, status: true, partyId: true } })
  const byId = new Map(rows.map((row) => [row.id, row]))
  const actor = actorOf(context)
  const problems: Issue[] = []
  fileIds.forEach((fileId, index) => {
    const path = `body/attachments/${index}`
    const row = byId.get(fileId)
    if (!row || (isOffice(context) && !can(actor, FILES_READ, { companyId: row.companyId }))) problems.push({ path, message: 'File not found.' })
    else if (row.recordType !== thread.recordType || row.recordId !== thread.recordId) problems.push({ path, message: 'Only a file of this record can be attached.' })
    else if (row.status !== 'AVAILABLE') problems.push({ path, message: `This file is ${row.status}; only an available file can be attached.` })
    else if (audience === 'PARTNER' && row.partyId !== thread.partyId) problems.push({ path, message: "Share the file with the record's party first." })
  })
  return problems
}

/** What is wrong with the people a note mentions (empty: none): each an ACTIVE person whose roles let them read the thread. */
export async function mentionProblems(tx: CommandTx, context: RequestContext, thread: ThreadRow, userIds: readonly string[], now: Date): Promise<Issue[]> {
  if (userIds.length === 0) return []
  if (context.audience === 'platform') throw new ApiError('internal_error', 'Mentions belong to a tenant.')
  const active = new Set((await tx.user.findMany({ where: { id: { in: [...userIds] }, status: 'ACTIVE' }, select: { id: true } })).map((user) => user.id))
  const problems: Issue[] = []
  for (const [index, userId] of userIds.entries()) {
    const path = `body/mentions/${index}`
    if (!active.has(userId)) {
      problems.push({ path, message: 'Not an active person of this tenant.' })
      continue
    }
    // Their grants as a signed-in session would hold them (two-factor taken as proved: they will prove it to open it).
    const reader: Actor = { audience: 'office', tenantId: context.tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(tx, userId, now), true) }
    if (!can(reader, THREADS_READ, scopeOfThread(thread))) problems.push({ path, message: "This person cannot read this record's thread." })
  }
  return problems
}

/** The most people the mention list reads (a tenant's office staff, by name). */
export const MAX_MENTIONABLE = 500

/**
 * GET /threads/<type>/<id>/people: who a note on the record may mention (COL-006) — the same rule `mentionProblems`
 * checks at write: ACTIVE people whose roles let them read the record's thread (two-factor taken as proved). Office
 * writers only (threads.post over the record); names only, never an address or a role.
 */
export async function mentionablePeople(caller: CommandCaller, record: RecordRef, now: Date): Promise<Array<{ id: string; name: string }>> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const { scope } = await officeRecord(client, record)
    if (!can(actor, THREADS_READ, scope)) throw new NotFoundError('Record not found.')
    if (!can(actor, THREADS_POST, scope)) throw new ForbiddenError()
    const users = await client.user.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: MAX_MENTIONABLE,
      select: { id: true, displayName: true },
    })
    const people: Array<{ id: string; name: string }> = []
    for (const user of users) {
      const reader: Actor = { audience: 'office', tenantId: context.tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(client, user.id, now), true) }
      if (can(reader, THREADS_READ, scope)) people.push({ id: user.id, name: user.displayName })
    }
    return people
  })
}

export interface NoteInput {
  readonly body: string
  readonly mentions?: readonly string[] | undefined
  readonly attachments?: readonly string[] | undefined
}

/** POST /threads/<type>/<id>/notes (threads.postNote): an internal note, the thread made with the first one. */
export async function postNote(caller: CommandCaller, record: RecordRef, input: NoteInput, idempotencyKey?: string): Promise<{ thread: ThreadView; message: MessageView }> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const draft = { bodyText: cleanBody(input.body), mentions: uniqueIds(input.mentions), attachments: uniqueIds(input.attachments) }
  const problems = noteProblems(draft)
  if (problems.length > 0) throw new ValidationError('The note is not valid.', problems)
  const { scope } = await caller.withClient((client) => officeRecord(client, record))
  if (!can(actor, THREADS_READ, scope)) throw new NotFoundError('Record not found.')
  if (!can(actor, THREADS_POST, scope)) throw new ForbiddenError()

  const { result } = await command(
    caller,
    { name: 'threads.postNote', idempotencyKey, input: { recordType: record.type, recordId: record.id, ...draft } },
    async (tools) => {
      const { thread } = await ensureThread(tools, record, context.actorId)
      // The thread as it is now (made by this command or a racing one): its scope decides.
      if (!can(actor, THREADS_POST, scopeOfThread(thread))) throw new ForbiddenError()
      if (thread.status !== 'OPEN') throw new InvalidStateError('This thread is closed; reopen it to write a note.')
      const issues = [
        ...(await attachmentProblems(tools.tx, context, thread, draft.attachments, 'OFFICE')),
        ...(await mentionProblems(tools.tx, context, thread, draft.mentions, tools.now)),
      ]
      if (issues.length > 0) throw new ValidationError('The note is not valid.', issues)
      const author = await tools.tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } })
      const message = await writeMessage(tools, thread, {
        direction: 'INTERNAL_NOTE',
        channel: 'APP',
        author: { kind: 'USER', id: context.actorId, name: author?.displayName ?? null },
        bodyText: draft.bodyText,
        mentions: draft.mentions,
        attachments: draft.attachments,
      })
      const current = await tools.tx.thread.findUniqueOrThrow({ where: { id: thread.id }, select: THREAD_OFFICE })
      const attachments = await visibleAttachments(tools.tx, context, message.attachmentFileIds)
      return { thread: threadViewOf(current), message: messageViewOf(message, attachments) }
    },
  )
  return result
}

/** PUT /threads/<type>/<id>/status (threads.setStatus): close or reopen the record's thread. */
export async function setThreadStatus(
  caller: CommandCaller,
  record: RecordRef,
  input: { readonly status: ThreadStatus; readonly version: number; readonly reason?: string | undefined },
  idempotencyKey?: string,
): Promise<ThreadView> {
  const context = contextOf(caller)
  const actor = actorOf(context)
  const thread = await caller.withClient((client) => client.thread.findFirst({ where: recordWhere(record), select: THREAD_OFFICE }))
  if (!thread || !can(actor, THREADS_READ, scopeOfThread(thread))) throw new NotFoundError('This record has no thread.')
  if (!can(actor, THREADS_MANAGE, scopeOfThread(thread))) throw new ForbiddenError()
  const { result } = await command(
    caller,
    {
      name: 'threads.setStatus',
      idempotencyKey,
      input: { recordType: record.type, recordId: record.id, ...input },
      record: { type: 'Thread', id: thread.id, expectedVersion: input.version, transition: { machine: threadMachine, to: input.status } },
    },
    async ({ tx, audit, record: guarded }) => {
      const row = await tx.thread.findUniqueOrThrow({ where: { id: thread.id }, select: THREAD_OFFICE })
      audit({
        recordType: 'Thread',
        recordId: thread.id,
        companyId: row.companyId,
        siteId: row.siteId,
        before: { status: guarded?.from ?? null },
        after: { status: row.status },
        ...(input.reason ? { reason: input.reason } : {}),
      })
      return threadViewOf(row)
    },
  )
  return result
}
