import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { PORTAL_COMMENT } from '@nexus/factory-domain/auth/partners/permissions'
import { FILES_READ, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as threadEvents } from '@nexus/factory-domain/threads/events'
import { cleanBody, excerptOf, uniqueIds, type ThreadStatus } from '@nexus/factory-domain/threads/rules'
import { composerOf, partnerThreadWords, PARTNER_THREADS_SCAN, postProblems, sideOf } from '@nexus/factory-domain/threads/partner/rules'
import { encodeCursor } from '@nexus/factory-domain/threads/timeline'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { systemCallerOf } from '../../files/files'
import { audienceSees, type FileAudience } from '../../files/rules'
import { kindsOfSession, partnerCallerOf, type PartnerCaller } from '../../search/partner/session'
import type { PartnerRecord } from '../../search/partner/view'
import { partnerViewOf, viewFits } from '../../search/partner/views'
import type { AttachmentView } from '../contract'
import { afterCursor, cursorOf, ensureThread, type RecordRef } from '../threads'
import type { PartnerMessageView } from './contract'

/**
 * A record's thread in a portal session (B-W2b-168; COL-059, COL-060; design portal.frame › thread "Ask a question /
 * Messages", portal.customer.home › recent-messages). Everything is read in the PARTNER scope (factory_partner_runtime:
 * the party's row-level security; a thread of another party, an internal note, who in the office wrote a message and the
 * thread's last activity are not there to read), and a record is one the partner may open (its partner view,
 * search/partner/views: the party's own record of a kind the person's portal shows, in the state the partner knows it in,
 * threads.read over its company — the session's — and the party).
 *
 *   read   GET /portal/threads/<type>/<id>: the record as the partner knows it (their reference first), the shared
 *          messages newest first with the files the partner may see, and the composer: whether the person may write
 *          (portal.comment, an open thread, not a preview), why not in their language, and "You can also answer our
 *          e-mails" when our mail on this thread carries its reply address (COL-060).
 *   list   GET /portal/threads: the party's conversations by their newest shared message (from=company: ours), for the
 *          Messages list and Home's "recent messages from us".
 *   post   POST /portal/threads/<type>/<id>/messages: a portal post (COL-060: one thread whichever way the partner answers).
 *          The record's thread is made first when it has none, in the tenant's system scope (the partner role cannot
 *          insert a Thread; ensureThread takes the record's company, site and party from its resolver, and a thread of
 *          another party refuses). Then ONE command in the partner's own scope writes the Message — INBOUND, PARTNER,
 *          PORTAL, author PARTY by the person's name, never an author id, mention or floor flag (no column grant; the
 *          portal-frame guard holds the same shape) — with its audit row (the actor is the person) and
 *          `thread.message_posted` (the office's followers are told "a reply arrived"). Attachments: files of the
 *          record shared with the party, available. A CLOSED thread refuses in words (the email step holds a mail to a
 *          closed thread for a person; the portal says so at once). Right after, the thread's last activity moves to the
 *          post in the system scope (the partner role cannot update a Thread): bookkeeping, as the session's idle slide.
 * A link session is not served here (its own record's shared messages stay on GET /threads/<type>/<id>).
 */

const [messagePosted] = threadEvents

/** What the partner role reads of a message (never the author id, the mentions or the floor flag). */
const MESSAGE_PARTNER = {
  id: true,
  threadId: true,
  direction: true,
  channel: true,
  authorKind: true,
  authorName: true,
  bodyText: true,
  bodyHtml: true,
  attachmentFileIds: true,
  at: true,
} as const satisfies Prisma.MessageSelect
type MessageRow = Prisma.MessageGetPayload<{ select: typeof MESSAGE_PARTNER }>

/** What the partner role reads of a thread (never the reply token, the last activity or who opened it). */
const THREAD_PARTNER = { id: true, companyId: true, siteId: true, partyId: true, recordType: true, recordId: true, status: true } as const satisfies Prisma.ThreadSelect
type ThreadRow = Prisma.ThreadGetPayload<{ select: typeof THREAD_PARTNER }>

const FILE_PARTNER = { id: true, companyId: true, recordType: true, recordId: true, kind: true, originalName: true, contentType: true, sizeBytes: true, status: true, visibility: true, partyId: true } as const satisfies Prisma.StoredFileSelect

/** The audit action of a portal post: its actor is the person who wrote it (`mine`). */
export const POST_ACTION = 'portal.postMessage'

interface OpenRecord {
  readonly record: PartnerRecord
  readonly scope: ScopedRecord
}

/** The record if the partner may open it (its view, the person's kinds, threads.read over it), else 404 in words. */
async function openRecord(client: FactoryClient, caller: PartnerCaller, ref: RecordRef): Promise<OpenRecord> {
  const view = partnerViewOf(ref.type)
  const kinds = await kindsOfSession(client, caller)
  if (!view || !viewFits(view, kinds)) throw new NotFoundError('Record not found.')
  const [record] = await view.read(client, [ref.id])
  const scope = { companyId: record?.companyId ?? null, partyId: caller.context.partyId }
  if (!record || !can(caller.actor, THREADS_READ, scope)) throw new NotFoundError('Record not found.')
  return { record, scope }
}

const recordViewOf = (type: string, record: PartnerRecord) => ({ type, id: record.id, theirRef: record.theirRef, ourRef: record.ourRef, subtitle: record.subtitle, status: record.status })

/** The attached files the partner may see: shared with its party's portal, available, and files.read over them. */
async function visibleAttachments(client: FactoryClient | CommandTx, caller: PartnerCaller, fileIds: readonly string[]): Promise<Map<string, AttachmentView>> {
  const seen = new Map<string, AttachmentView>()
  const ids = [...new Set(fileIds)]
  if (ids.length === 0) return seen
  const viewer = { audience: 'partner' as const, partyId: caller.context.partyId }
  for (const row of await client.storedFile.findMany({ where: { id: { in: ids } }, select: FILE_PARTNER })) {
    if (row.status !== 'AVAILABLE' || !audienceSees(viewer, { ...row, visibility: row.visibility as FileAudience[] })) continue
    if (!can(caller.actor, FILES_READ, { companyId: row.companyId, partyId: row.partyId })) continue
    seen.set(row.id, { id: row.id, kind: row.kind, originalName: row.originalName, contentType: row.contentType, sizeBytes: row.sizeBytes, status: row.status })
  }
  return seen
}

/** The messages of these ids the reader wrote in the portal (their posts' audit rows name them), read as the system. */
async function minePosts(request: FastifyRequest, caller: PartnerCaller, rows: readonly MessageRow[]): Promise<Set<string>> {
  const ids = rows.filter((row) => row.authorKind === 'PARTY' && row.channel === 'PORTAL').map((row) => row.id)
  if (ids.length === 0) return new Set()
  const audits = await systemCallerOf(request)(caller.context.tenantId).withClient((client) =>
    client.auditLog.findMany({ where: { recordType: 'Message', recordId: { in: ids }, action: POST_ACTION, actorId: caller.context.actorId }, select: { recordId: true } }),
  )
  return new Set(audits.map((row) => row.recordId))
}

function messageViewOf(caller: PartnerCaller, row: MessageRow, attachments: ReadonlyMap<string, AttachmentView>, mine: ReadonlySet<string>): PartnerMessageView {
  const side = sideOf(row.direction)
  return {
    id: row.id,
    side,
    channel: row.channel,
    author: { name: row.authorName ?? (side === 'COMPANY' ? caller.session.company.name : null), mine: mine.has(row.id) },
    body: row.bodyText,
    bodyHtml: row.bodyHtml,
    attachments: row.attachmentFileIds.flatMap((fileId) => {
      const seen = attachments.get(fileId)
      return seen ? [seen] : []
    }),
    at: toUtcIso(row.at),
  }
}

const threadOf = (client: FactoryClient | CommandTx, ref: RecordRef): Promise<ThreadRow | null> =>
  client.thread.findFirst({ where: { recordType: ref.type, recordId: ref.id }, select: THREAD_PARTNER })

/** The composer's state for the person on this record. */
async function composerFor(client: FactoryClient, caller: PartnerCaller, scope: ScopedRecord, thread: ThreadRow | null) {
  const state = composerOf({ threadStatus: thread?.status ?? null, mayComment: can(caller.actor, PORTAL_COMMENT, scope), preview: caller.session.preview })
  const replyByEmail = thread !== null && (await client.message.findFirst({ where: { threadId: thread.id, direction: 'OUTBOUND', channel: 'EMAIL' }, select: { id: true } })) !== null
  const locale = caller.session.person.locale
  const company = caller.session.company.name
  return {
    canPost: state.canPost,
    reason: state.reason,
    words: state.reason ? partnerThreadWords(state.reason, locale, company) : null,
    replyByEmail,
    hint: replyByEmail ? partnerThreadWords('REPLY_BY_EMAIL', locale, company) : null,
  }
}

/** GET /portal/threads/<type>/<id>: the record's thread as the partner sees it, one page of messages newest first. */
export async function readPartnerThread(request: FastifyRequest, ref: RecordRef, page: { readonly cursor?: string | undefined; readonly limit: number }) {
  const caller = partnerCallerOf(request)
  const cursor = cursorOf(page.cursor)
  const read = await request.withClient(async (client) => {
    const { record, scope } = await openRecord(client, caller, ref)
    const thread = await threadOf(client, ref)
    const rows = thread
      ? await client.message.findMany({
          where: { AND: [{ threadId: thread.id, audience: 'PARTNER' }, afterCursor(cursor, 'at') as Prisma.MessageWhereInput] },
          orderBy: [{ at: 'desc' }, { id: 'desc' }],
          take: page.limit + 1,
          select: MESSAGE_PARTNER,
        })
      : []
    const shown = rows.slice(0, page.limit)
    return {
      record,
      thread,
      rows,
      shown,
      attachments: await visibleAttachments(client, caller, shown.flatMap((row) => row.attachmentFileIds)),
      composer: await composerFor(client, caller, scope, thread),
    }
  })
  const mine = await minePosts(request, caller, read.shown)
  const last = read.shown.at(-1)
  return {
    record: recordViewOf(ref.type, read.record),
    thread: read.thread ? { id: read.thread.id, status: read.thread.status } : null,
    messages: read.shown.map((row) => messageViewOf(caller, row, read.attachments, mine)),
    nextCursor: read.rows.length > page.limit && last ? encodeCursor(last) : null,
    composer: read.composer,
  }
}

/** GET /portal/threads: the party's conversations by their newest shared message (ours only with from=company). */
export async function listPartnerThreads(request: FastifyRequest, query: { readonly from: 'any' | 'company'; readonly limit: number }) {
  const caller = partnerCallerOf(request)
  return request.withClient(async (client) => {
    const kinds = await kindsOfSession(client, caller)
    // The party's newest shared messages (ids and times only), the newest of each thread, then those messages whole.
    const newest = await client.message.findMany({
      where: { audience: 'PARTNER', ...(query.from === 'company' ? { direction: 'OUTBOUND' as const } : {}) },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: PARTNER_THREADS_SCAN,
      select: { id: true, threadId: true },
    })
    const newestIds = new Map<string, string>()
    for (const row of newest) if (!newestIds.has(row.threadId)) newestIds.set(row.threadId, row.id)
    const lastOf = new Map((await client.message.findMany({ where: { id: { in: [...newestIds.values()] } }, select: MESSAGE_PARTNER })).map((row) => [row.threadId, row]))
    const threads = await client.thread.findMany({ where: { id: { in: [...lastOf.keys()] } }, select: THREAD_PARTNER })
    // Each thread's record through its partner view: a record the person may not open is left out, unannounced.
    const records = new Map<string, PartnerRecord>()
    for (const type of new Set(threads.map((thread) => thread.recordType))) {
      const view = partnerViewOf(type)
      if (!view || !viewFits(view, kinds)) continue
      for (const record of await view.read(client, threads.filter((thread) => thread.recordType === type).map((thread) => thread.recordId))) {
        if (can(caller.actor, THREADS_READ, { companyId: record.companyId, partyId: caller.context.partyId })) records.set(`${type}:${record.id}`, record)
      }
    }
    const conversations = threads
      .flatMap((thread) => {
        const record = records.get(`${thread.recordType}:${thread.recordId}`)
        const last = lastOf.get(thread.id)
        return record && last ? [{ thread, record, last }] : []
      })
      .sort((a, b) => b.last.at.getTime() - a.last.at.getTime() || b.last.id.localeCompare(a.last.id))
      .slice(0, query.limit)
    return {
      conversations: conversations.map(({ thread, record, last }) => {
        const side = sideOf(last.direction)
        return {
          record: recordViewOf(thread.recordType, record),
          thread: { id: thread.id, status: thread.status },
          last: {
            id: last.id,
            side,
            channel: last.channel,
            authorName: last.authorName ?? (side === 'COMPANY' ? caller.session.company.name : null),
            excerpt: excerptOf(last.bodyText),
            attachmentCount: last.attachmentFileIds.length,
            at: toUtcIso(last.at),
          },
        }
      }),
    }
  })
}

/** What is wrong with the files a portal post attaches: files of the record, shared with the party, available, readable. */
async function attachmentProblems(tx: CommandTx, caller: PartnerCaller, thread: ThreadRow, fileIds: readonly string[]): Promise<Issue[]> {
  if (fileIds.length === 0) return []
  const rows = new Map((await tx.storedFile.findMany({ where: { id: { in: [...fileIds] } }, select: FILE_PARTNER })).map((row) => [row.id, row]))
  const viewer = { audience: 'partner' as const, partyId: caller.context.partyId }
  const problems: Issue[] = []
  fileIds.forEach((fileId, index) => {
    const path = `body/attachments/${index}`
    const row = rows.get(fileId)
    if (!row || !audienceSees(viewer, { ...row, visibility: row.visibility as FileAudience[] }) || !can(caller.actor, FILES_READ, { companyId: row.companyId, partyId: row.partyId })) {
      problems.push({ path, message: 'File not found.' })
    } else if (row.recordType !== thread.recordType || row.recordId !== thread.recordId) problems.push({ path, message: 'Only a file of this record can be attached.' })
    else if (row.status !== 'AVAILABLE') problems.push({ path, message: `This file is ${row.status}; only an available file can be attached.` })
  })
  return problems
}

/** A CLOSED thread refuses a portal post, in the person's language. */
function closedRefusal(caller: PartnerCaller): DomainError {
  const words = partnerThreadWords('CLOSED', caller.session.person.locale, caller.session.company.name)
  return new DomainError('invalid_state', words, [{ path: 'thread/CLOSED', message: words }])
}

export interface PartnerPostInput {
  readonly body: string
  readonly attachments?: readonly string[] | undefined
}

/** POST /portal/threads/<type>/<id>/messages: the person's post into the record's thread (COL-060). */
export async function postPartnerMessage(request: FastifyRequest, ref: RecordRef, input: PartnerPostInput, idempotencyKey?: string) {
  const caller = partnerCallerOf(request)
  const draft = { bodyText: cleanBody(input.body), attachments: uniqueIds(input.attachments) }
  const problems = postProblems(draft)
  if (problems.length > 0) throw new ValidationError('The message is not valid.', problems)

  const opened = await request.withClient(async (client) => {
    const { scope } = await openRecord(client, caller, ref)
    if (caller.session.preview) throw new ForbiddenError(partnerThreadWords('PREVIEW', caller.session.person.locale, caller.session.company.name))
    if (!can(caller.actor, PORTAL_COMMENT, scope)) throw new ForbiddenError(partnerThreadWords('NO_COMMENT', caller.session.person.locale, caller.session.company.name))
    return threadOf(client, ref)
  })
  let thread = opened
  if (!thread) thread = await openThreadFor(request, caller, ref)
  if (thread.status === 'CLOSED') throw closedRefusal(caller)

  const known = thread
  const { result } = await command(
    request as CommandCaller,
    { name: POST_ACTION, idempotencyKey, input: { recordType: ref.type, recordId: ref.id, ...draft } },
    async (tools) => {
      // The thread as it is now, as the partner reads it (closed meanwhile? still the party's?).
      const current = await threadOf(tools.tx, ref)
      if (!current || current.id !== known.id || current.partyId !== caller.context.partyId) throw new NotFoundError('Record not found.')
      if (current.status === 'CLOSED') throw closedRefusal(caller)
      const issues = await attachmentProblems(tools.tx, caller, current, draft.attachments)
      if (issues.length > 0) throw new ValidationError('The message is not valid.', issues)
      const id = newId()
      const row = await tools.tx.message.create({
        data: {
          id,
          threadId: current.id,
          partyId: caller.context.partyId,
          direction: 'INBOUND',
          audience: 'PARTNER',
          channel: 'PORTAL',
          authorKind: 'PARTY',
          authorName: caller.session.person.displayName,
          bodyText: draft.bodyText,
          bodyHtml: null,
          attachmentFileIds: [...draft.attachments],
          emailMessageId: null,
          at: tools.now,
          createdAt: tools.now,
        },
        select: MESSAGE_PARTNER,
      })
      tools.audit({
        recordType: 'Message',
        recordId: id,
        companyId: current.companyId,
        siteId: current.siteId,
        after: { threadId: current.id, recordType: current.recordType, recordId: current.recordId, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', attachments: [...draft.attachments] },
      })
      tools.emit(
        eventFor(messagePosted, {
          subject: current.recordId,
          companyId: current.companyId,
          siteId: current.siteId,
          payload: { threadId: current.id, messageId: id, recordType: current.recordType, recordId: current.recordId, direction: 'INBOUND', audience: 'PARTNER' },
        }),
      )
      const attachments = await visibleAttachments(tools.tx, caller, row.attachmentFileIds)
      return { thread: { id: current.id, status: current.status as ThreadStatus }, message: messageViewOf(caller, row, attachments, new Set([id])) }
    },
  )
  await touchThread(request, caller, result.thread.id, new Date(result.message.at))
  return result
}

/** The record's thread made in the tenant's system scope (the partner role cannot insert one), for this party only. */
async function openThreadFor(request: FastifyRequest, caller: PartnerCaller, ref: RecordRef): Promise<ThreadRow> {
  const { result } = await command(
    systemCallerOf(request)(caller.context.tenantId),
    { name: 'portal.openThread', input: { recordType: ref.type, recordId: ref.id, partyId: caller.context.partyId, personId: caller.context.actorId } },
    async (tools) => {
      const { thread, created } = await ensureThread(tools, ref, caller.context.actorId)
      // A thread of another party (or of none) never takes this party's post.
      if (thread.partyId !== caller.context.partyId) throw new NotFoundError('Record not found.')
      if (!created) tools.audit({ recordType: 'Thread', recordId: thread.id, companyId: thread.companyId, siteId: thread.siteId, after: { recordType: ref.type, recordId: ref.id, openedFor: caller.context.actorId, created: false } })
      return { id: thread.id }
    },
  )
  const thread = await request.withClient((client) => client.thread.findUnique({ where: { id: result.id }, select: THREAD_PARTNER }))
  if (!thread) throw new NotFoundError('Record not found.')
  return thread
}

/**
 * The thread's last activity moves to the post (only later: the thread guard), in the tenant's system scope: the partner
 * role cannot update a Thread. Bookkeeping right after the post's command (its audit row is the post's), like the office's
 * writeMessage does inside its own.
 */
async function touchThread(request: FastifyRequest, caller: PartnerCaller, threadId: string, at: Date): Promise<void> {
  await systemCallerOf(request)(caller.context.tenantId).withClient((client) =>
    client.thread.updateMany({ where: { id: threadId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }] }, data: { lastMessageAt: at } }),
  )
}
