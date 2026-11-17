import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { RECORD_TYPE } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { mayOnThread, mayShare } from './records'
import { contextOf, scopeOfThread, type RecordRef } from './threads'

/**
 * B-TH-027 (threads plan TH-2, G10; design T1-F04 "2 new", T4-F04 "New since your last visit", PL3-F08, the lists' "New
 * messages"; wall W08 / T08): each person's own read mark on a thread (factory-db ThreadRead, the TH-2 schema wave: one per
 * thread and person, the newest message they read).
 *
 *   reading    a thread's answer carries the reader's own mark: the message they read last, how many came after it that are
 *              new to them, and the first of those ("New since your last visit": the line above it). New = after the mark in
 *              the feed's order (at, id), and for the office not written by the reader; for a portal person only messages
 *              shared with their party (the partner scope: an internal note is never there to count) — their own posts move
 *              their mark (the portal post does), so their own words never count either.
 *   mark       POST /threads/<type>/<id>/read (office) and POST /portal/threads/<type>/<id>/read (portal): read up to a message
 *              (default the newest the person may read); the mark only moves forward. POST /threads/<type>/<id>/unread (office):
 *              new again from a message on ("Mark unread": the mark moves back before it, or goes).
 *   unread     POST /threads/unread: the new-message counts of a page of records (Incoming, Orders, Quotes, the portal's lists),
 *              at most UNREAD_MAX, in ONE grouped read on the messages' (threadId, at) index; a record the person may not read
 *              counts 0, as one with no thread (never "it exists").
 *
 * Who: office people and the party's portal people, each ONLY their own mark — every write and read here takes the person from
 * the session, never from the body (the database lets a portal party write its own party's marks: keeping each person to their
 * own is this file's). Never the floor (no route: Statuto dei Lavoratori art. 4) and no "seen by" list: nobody reads another
 * person's mark. A preview of a customer's portal by the office writes no mark. The audit row of a mark names the mark only,
 * never the thread's words.
 */

/** The most records one unread read counts (a page of a list). */
export const UNREAD_MAX = 200

export interface Reading {
  /** The message the person read last on this thread; null: none yet. */
  readonly lastReadMessageId: string | null
  /** Messages after it that are new to the person (see the module's head). */
  readonly newCount: number
  /** The first of them ("New since your last visit" sits above it); null: nothing new. */
  readonly firstNewMessageId: string | null
}

type Reader = FactoryClient | CommandTx
type Who = { readonly userId: string; readonly office: boolean }

const keyOf = (threadId: string, userId: string): string => `read:${threadId}:${userId}`

/** The person whose marks these are: the session's office person or portal person; nobody else (a link, the floor, the system). */
export function whoOf(context: RequestContext): Who | null {
  if (context.audience === 'office') return { userId: context.actorId, office: true }
  if (context.audience === 'partner') return { userId: context.actorId, office: false }
  return null
}

/** The person's mark on a thread, read in the caller's own scope (a portal session reads only its party's marks). */
async function markOf(client: Reader, threadId: string, userId: string): Promise<{ id: string; lastReadMessageId: string; lastReadMessage: { at: Date } | null } | null> {
  const mark = await client.threadRead.findFirst({ where: { threadId, userId }, select: { id: true, lastReadMessageId: true } })
  if (!mark) return null
  // The message read last, by its own read (no relation select: the partner role reads only the message columns it holds).
  const message = await client.message.findFirst({ where: { id: mark.lastReadMessageId }, select: { at: true } })
  return { ...mark, lastReadMessage: message }
}

/** What is new to the person after a message (at, id), in the feed's order; the office leaves out its own. */
function newWhere(threadId: string, who: Who, after: { at: Date; id: string } | null): Prisma.MessageWhereInput {
  return {
    AND: [
      { threadId },
      who.office ? { OR: [{ authorId: null }, { authorId: { not: who.userId } }] } : { audience: 'PARTNER' },
      after ? { OR: [{ at: { gt: after.at } }, { at: after.at, id: { gt: after.id } }] } : {},
    ],
  }
}

/** The reader's reading of one thread (see the module's head). */
export async function readingOf(client: Reader, threadId: string, who: Who): Promise<Reading> {
  const mark = await markOf(client, threadId, who.userId)
  const after = mark?.lastReadMessage ? { at: mark.lastReadMessage.at, id: mark.lastReadMessageId } : null
  const where = newWhere(threadId, who, after)
  const [newCount, first] = await Promise.all([client.message.count({ where }), client.message.findFirst({ where, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { id: true } })])
  return { lastReadMessageId: mark?.lastReadMessageId ?? null, newCount, firstNewMessageId: first?.id ?? null }
}

/**
 * The person's mark moved to `message` in the caller's command (its scope writes: a portal person's mark names their party,
 * the thread's). `forward`: only when it is later than the mark (read); otherwise set as given (unread). Returns whether it moved.
 */
export async function moveMark(tools: Pick<CommandTools, 'tx' | 'now' | 'audit'>, thread: { readonly id: string; readonly companyId: string | null; readonly siteId: string | null; readonly partyId: string | null }, who: Who, message: { readonly id: string; readonly at: Date }, forward: boolean): Promise<boolean> {
  const mark = await markOf(tools.tx, thread.id, who.userId)
  if (mark) {
    if (mark.lastReadMessageId === message.id) return false
    const current = mark.lastReadMessage
    if (forward && current && (current.at > message.at || (current.at.getTime() === message.at.getTime() && mark.lastReadMessageId > message.id))) return false
    await tools.tx.threadRead.update({ where: { id: mark.id }, data: { lastReadMessageId: message.id, readAt: tools.now, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'threads.markRead', recordType: 'ThreadRead', recordId: mark.id, companyId: thread.companyId, siteId: thread.siteId, after: { moved: forward ? 'READ' : 'UNREAD' } })
    return true
  }
  const id = newId()
  await tools.tx.threadRead.create({ data: { id, threadId: thread.id, userId: who.userId, key: keyOf(thread.id, who.userId), partyId: who.office ? null : thread.partyId, lastReadMessageId: message.id, readAt: tools.now, createdAt: tools.now, updatedAt: tools.now }, select: { id: true } })
  tools.audit({ action: 'threads.markRead', recordType: 'ThreadRead', recordId: id, companyId: thread.companyId, siteId: thread.siteId, after: { moved: 'READ' } })
  return true
}

const THREAD_SCOPE = { id: true, companyId: true, siteId: true, partyId: true, recordType: true, recordId: true } as const satisfies Prisma.ThreadSelect

/** The record's thread if the person may read it (office: threads.read and its gate; portal: its party's, shareable), else 404 / none. */
async function readableThread(client: Reader, context: RequestContext, record: RecordRef) {
  if (context.audience !== 'office' && !mayShare(record.type)) return null
  const thread = await client.thread.findFirst({ where: { recordType: record.type, recordId: record.id }, select: THREAD_SCOPE })
  if (!thread || !mayOnThread(actorOf(context), THREADS_READ, record.type, scopeOfThread(thread))) return null
  return thread
}

/** The message a mark moves to: the one named (of this thread, readable by the person), else the newest the person may read. */
async function targetOf(client: Reader, threadId: string, who: Who, messageId: string | undefined): Promise<{ id: string; at: Date } | null> {
  const where: Prisma.MessageWhereInput = { AND: [{ threadId }, who.office ? {} : { audience: 'PARTNER' }, messageId ? { id: messageId } : {}] }
  return client.message.findFirst({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { id: true, at: true } })
}

/**
 * POST /threads/<type>/<id>/read and /portal/threads/<type>/<id>/read: the person read the thread up to a message (default the
 * newest they may read). Their reading after it. A thread they may not read is not found; a portal preview writes nothing.
 */
export async function markThreadRead(caller: CommandCaller, record: RecordRef, body: { readonly messageId?: string | undefined }, idempotencyKey?: string, options: { readonly preview?: boolean } = {}): Promise<{ reading: Reading }> {
  const context = contextOf(caller)
  const who = whoOf(context)
  if (!who) throw new ForbiddenError()
  const found = await caller.withClient(async (client) => {
    const thread = await readableThread(client, context, record)
    if (!thread) throw new NotFoundError('Record not found.')
    const target = await targetOf(client, thread.id, who, body.messageId)
    if (body.messageId && !target) throw new ValidationError('Not a message of this conversation.', [{ path: 'body/messageId', message: 'Not a message of this conversation.' }])
    return { thread, target }
  })
  if (found.target && !options.preview) {
    const target = found.target
    const mark = await caller.withClient((client) => markOf(client, found.thread.id, who.userId))
    const ahead = !mark?.lastReadMessage || mark.lastReadMessage.at < target.at || (mark.lastReadMessage.at.getTime() === target.at.getTime() && mark.lastReadMessageId < target.id)
    if (ahead) await command(caller, { name: 'threads.markRead', idempotencyKey, input: { recordType: record.type, recordId: record.id, messageId: target.id } }, async (tools) => ({ moved: await moveMark(tools, found.thread, who, target, true) }))
  }
  return { reading: await caller.withClient((client) => readingOf(client, found.thread.id, who)) }
}

/** POST /threads/<type>/<id>/unread (office): new again from `messageId` on — the mark moves to the message before it, or goes. */
export async function markThreadUnread(caller: CommandCaller, record: RecordRef, body: { readonly messageId: string }, idempotencyKey?: string): Promise<{ reading: Reading }> {
  const context = contextOf(caller)
  const who = whoOf(context)
  if (!who || !who.office) throw new ForbiddenError()
  const thread = await caller.withClient(async (client) => {
    const found = await readableThread(client, context, record)
    if (!found) throw new NotFoundError('Record not found.')
    return found
  })
  await command(caller, { name: 'threads.markUnread', idempotencyKey, input: { recordType: record.type, recordId: record.id, messageId: body.messageId } }, async (tools) => {
    const from = await tools.tx.message.findFirst({ where: { id: body.messageId, threadId: thread.id }, select: { id: true, at: true } })
    if (!from) throw new ValidationError('Not a message of this conversation.', [{ path: 'body/messageId', message: 'Not a message of this conversation.' }])
    const before = await tools.tx.message.findFirst({ where: { threadId: thread.id, OR: [{ at: { lt: from.at } }, { at: from.at, id: { lt: from.id } }] }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { id: true, at: true } })
    if (before) {
      if (!(await moveMark(tools, thread, who, before, false))) tools.audit({ action: 'threads.markUnread', recordType: 'Thread', recordId: thread.id, companyId: thread.companyId, siteId: thread.siteId, after: { moved: 'NONE' } })
      return { moved: true }
    }
    const mark = await markOf(tools.tx, thread.id, who.userId)
    if (mark) await tools.tx.threadRead.delete({ where: { id: mark.id }, select: { id: true } })
    tools.audit({ action: 'threads.markUnread', recordType: 'ThreadRead', recordId: mark?.id ?? thread.id, companyId: thread.companyId, siteId: thread.siteId, after: { moved: 'UNREAD' } })
    return { moved: mark !== null }
  })
  return { reading: await caller.withClient((client) => readingOf(client, thread.id, who)) }
}

export interface UnreadCount {
  readonly recordType: string
  readonly recordId: string
  readonly newCount: number
  /** When the newest new message came (null: nothing new). */
  readonly lastAt: string | null
}

/**
 * POST /threads/unread: each record's new-message count for the person (office or portal), in the order asked. One read of the
 * threads (each checked as the thread page checks it), then ONE grouped count of the messages after each mark.
 */
export async function unreadCounts(caller: CommandCaller, records: readonly RecordRef[]): Promise<{ counts: UnreadCount[] }> {
  const context = contextOf(caller)
  const who = whoOf(context)
  if (!who) throw new ForbiddenError()
  if (records.length > UNREAD_MAX) throw new ValidationError(`At most ${UNREAD_MAX} records at once.`, [{ path: 'body/records', message: `At most ${UNREAD_MAX} records at once.` }])
  const asked = records.filter((record) => RECORD_TYPE.test(record.type) && isUuid(record.id))
  const counted = await caller.withClient(async (client) => {
    const threads = asked.length === 0 ? [] : await client.thread.findMany({ where: { OR: asked.map((record) => ({ recordType: record.type, recordId: record.id })) }, select: THREAD_SCOPE })
    const readable = threads.filter((thread) => (who.office || mayShare(thread.recordType)) && mayOnThread(actorOf(context), THREADS_READ, thread.recordType, scopeOfThread(thread)))
    if (readable.length === 0) return new Map<string, { newCount: number; lastAt: Date | null }>()
    const ids = readable.map((thread) => thread.id)
    // Two statements, never one with both: the partner role holds no grant on a message's author (a column privilege is checked
    // whether or not the branch runs), and its row-level security keeps it to its party's shared messages.
    const rows = who.office
      ? await client.$queryRaw<{ threadId: string; newCount: number; lastAt: Date | null }[]>`
          SELECT m."threadId"::text AS "threadId", count(*)::int AS "newCount", max(m."at") AS "lastAt"
            FROM "Message" m
            LEFT JOIN "ThreadRead" r ON r."threadId" = m."threadId" AND r."userId" = ${who.userId}::uuid
            LEFT JOIN "Message" seen ON seen."id" = r."lastReadMessageId"
           WHERE m."threadId" = ANY(${ids}::uuid[])
             AND (seen."id" IS NULL OR (m."at", m."id") > (seen."at", seen."id"))
             AND m."authorId" IS DISTINCT FROM ${who.userId}::uuid
           GROUP BY m."threadId"`
      : await client.$queryRaw<{ threadId: string; newCount: number; lastAt: Date | null }[]>`
          SELECT m."threadId"::text AS "threadId", count(*)::int AS "newCount", max(m."at") AS "lastAt"
            FROM "Message" m
            LEFT JOIN "ThreadRead" r ON r."threadId" = m."threadId" AND r."userId" = ${who.userId}::uuid
            LEFT JOIN "Message" seen ON seen."id" = r."lastReadMessageId"
           WHERE m."threadId" = ANY(${ids}::uuid[])
             AND (seen."id" IS NULL OR (m."at", m."id") > (seen."at", seen."id"))
             AND m."audience" = 'PARTNER'
           GROUP BY m."threadId"`
    const byThread = new Map(rows.map((row) => [row.threadId, row]))
    return new Map(readable.map((thread) => [`${thread.recordType}:${thread.recordId}`, { newCount: byThread.get(thread.id)?.newCount ?? 0, lastAt: byThread.get(thread.id)?.lastAt ?? null }]))
  })
  return {
    counts: records.map((record) => {
      const seen = counted.get(`${record.type}:${record.id}`)
      return { recordType: record.type, recordId: record.id, newCount: seen?.newCount ?? 0, lastAt: seen?.lastAt ? toUtcIso(seen.lastAt) : null }
    }),
  }
}
