import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { RECORD_TYPE } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { mayOnThread, mayShare } from './records'
import { wallScopeOf, wallScopesOf } from './records' // B-PR-08a part 2
import { contextOf, type RecordRef } from './threads' // B-PR-08a part 2: scopeOfThread → wallScopeOf
// B-OP-061 (order page dock A2): whether the reader may read each record's thread — the thread page's own check.
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { THREAD_PLACES, threadPlaceOf } from './records'
import { officeRecord } from './threads'
// B-CP-071 residual (customer page lead addition 5): a portal person counts only the records its portal opens.
import type { FastifyRequest } from 'fastify'
import { partnerViewOf, viewFits } from '../search/partner/views'
// B-CP-071 residual, end-check fix: the kinds and the reader from the request's own partner context (no portal session needed).
import { isPartnerKind, partnerKindsOf, type PartnerKind } from '@nexus/factory-domain/auth/partners/kinds'
import { officeAuthOf } from '../auth/sessions/office-auth'
import type { PartnerReader } from '../search/partner/view'

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
 *              counts 0, as one with no thread (never "it exists"). B-OP-061 (order page dock A2): asked with `readable: true`,
 *              each row also says whether the person may read the record's thread — the check of GET /threads/<type>/<id>
 *              (the thread's wall scope when it exists, else the record's own through the threads' record registry; a record whose
 *              conversation is another's, that one's): an unknown record and another customer's both answer false, alike. A portal
 *              person: its party's threads that exist (it starts none). Not asked: no row carries it (a list pays no extra read).
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

// ---- B-TH-079: what is new to the person on a thread (after their own mark), for the timeline's "hidden by this view" count.
export async function newToReaderWhere(client: Reader, threadId: string, who: Who): Promise<Prisma.MessageWhereInput> {
  const mark = await markOf(client, threadId, who.userId)
  return newWhere(threadId, who, mark?.lastReadMessage ? { at: mark.lastReadMessage.at, id: mark.lastReadMessageId } : null)
}
// ---- end B-TH-079

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

// ---- pg-s1 S1.4 (the pt- lane's L-1): a portal person's own message is never new to them, on every portal write path ----------
/**
 * The portal person who wrote a shared message has read it: their own mark moves to it, in the write's own command, as the portal
 * post's does (B-TH-027). Every portal path that writes a person's words as a message calls this ONE helper — the portal post
 * (platform/threads/partner postPartnerMessage: the thread page, a request's first words and its files, a production problem), a
 * change asked on the order page (sales/change-requests portal.ts) and an approval answered in the portal (approvals-out settle.ts)
 * — so no list, bubble or record counts the person's own words as new to them. Only the writer's mark: the party's other people
 * still read it as new, and another customer's never moves (row-level security; the database also checks the mark is the person's
 * own party's, ThreadRead_guard). Nothing for a preview (no write), for a link (no person: an invited link keeps no mark) or for a
 * thread with no party. The partner scope writes its own party's marks; the tenant's system scope any of the tenant's.
 */
export async function readOwnMessage(
  tools: Pick<CommandTools, 'tx' | 'now' | 'audit'>,
  thread: { readonly id: string; readonly companyId: string | null; readonly siteId: string | null; readonly partyId: string | null },
  writer: { readonly userId: string | null; readonly preview?: boolean },
  message: { readonly id: string; readonly at: Date },
): Promise<boolean> {
  if (writer.userId === null || writer.preview === true || thread.partyId === null) return false
  return moveMark(tools, thread, { userId: writer.userId, office: false }, message, true)
}
// ---- end pg-s1 S1.4

const THREAD_SCOPE = { id: true, companyId: true, siteId: true, partyId: true, recordType: true, recordId: true } as const satisfies Prisma.ThreadSelect

// ---- B-CP-071 residual (customer page lead addition 5; PA1's known residual): a portal person's unread read counts only the records
// its portal opens — the record's partner view, the person's kinds, the view's own rule for the reader (a draft opens only to the
// party's people who keep drafts). Its party's row-level security lets every colleague read the thread row; without this a Viewer
// read a 0/N count for a draft it cannot open. Such a record is left out exactly like an unknown id: no count, no hint (and, asked,
// readable false). The partner callers of this read are portal requests (POST /threads/unread, GET /portal/threads).
//
// End-check fix (B-OP-061's contract, T08): the read asks nothing of the portal session (a partner context is enough: the person and
// their party, as every other step of this read). Its kinds are the session's own rule (search/partner/session kindsOfSession): the
// person's partner kind on their User row (read in the partner scope, their own party's row), else — an office preview of the
// portal — every kind the party's roles fit. The reader's tenant read is resolved only when a view uses it.
type ThreadScope = Prisma.ThreadGetPayload<{ select: typeof THREAD_SCOPE }>
async function partnerKindsOfContext(client: FactoryClient, context: { readonly actorId: string; readonly partyId: string }): Promise<PartnerKind[]> {
  const kind = (await client.user.findUnique({ where: { id: context.actorId }, select: { partnerKind: true } }))?.partnerKind
  if (isPartnerKind(kind)) return [kind]
  const party = await client.party.findUnique({ where: { id: context.partyId }, select: { roles: true } })
  return party ? partnerKindsOf(party.roles) : []
}
async function openedByPartner(caller: CommandCaller, client: FactoryClient, threads: readonly ThreadScope[]): Promise<ThreadScope[]> {
  if (threads.length === 0) return []
  const context = contextOf(caller)
  if (context.audience !== 'partner') return []
  const request = caller as unknown as FastifyRequest
  const kinds = await partnerKindsOfContext(client, context)
  const reader: PartnerReader = {
    userId: context.actorId,
    actor: actorOf(context),
    inTenant: (work) => officeAuthOf(request.server).inTenant(context.tenantId, context.actorId, work),
  }
  const opened = new Set<string>()
  for (const type of new Set(threads.map((thread) => thread.recordType))) {
    const view = partnerViewOf(type)
    if (!view || !viewFits(view, kinds)) continue
    for (const record of await view.read(client, threads.filter((thread) => thread.recordType === type).map((thread) => thread.recordId), reader)) opened.add(`${type}:${record.id}`)
  }
  return threads.filter((thread) => opened.has(`${thread.recordType}:${thread.recordId}`))
}
// ---- end B-CP-071 residual

/** The record's thread if the person may read it (office: threads.read and its gate; portal: its party's, shareable), else 404 / none. */
async function readableThread(client: Reader, context: RequestContext, record: RecordRef) {
  if (context.audience !== 'office' && !mayShare(record.type)) return null
  const thread = await client.thread.findFirst({ where: { recordType: record.type, recordId: record.id }, select: THREAD_SCOPE })
  // B-PR-08a part 2: a work order's, hold's or NCR's thread (office only: refused above for anyone else) through its wall party.
  if (!thread || !mayOnThread(actorOf(context), THREADS_READ, record.type, await wallScopeOf(client, thread))) return null
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
  /** B-OP-061: asked with `readable`, whether the person may read the record's thread (false alike: unknown or out of reach). */
  readonly readable?: boolean
}

// ── B-OP-061 (order page dock A2; 11-dock §8 A2, §9) ──
/**
 * May the office person read the record's thread (GET /threads/<type>/<id>'s own check, nothing more said): the record whose
 * conversation is another's reads that one (B-SA-048); its thread's wall scope when it has one, else the record's from its resolver
 * (a work order's, hold's or NCR's through its wall party). A record of no known type, an unknown id and a record of a customer the
 * person does not reach are all false — the answer never tells them apart.
 */
async function officeReadable(client: Reader, actor: Actor, record: RecordRef): Promise<boolean> {
  const place = (await threadPlaceOf(client, record)) ?? record
  try {
    const found = await officeRecord(client, place)
    return mayOnThread(actor, THREADS_READ, place.type, found.scope)
  } catch (error) {
    if (error instanceof NotFoundError) return false
    throw error
  }
}
// ── end B-OP-061 ──

/**
 * POST /threads/unread: each record's new-message count for the person (office or portal), in the order asked. One read of the
 * threads (each checked as the thread page checks it), then ONE grouped count of the messages after each mark.
 */
export async function unreadCounts(caller: CommandCaller, records: readonly RecordRef[], /* B-OP-061 */ options: { readonly readable?: boolean } = {}): Promise<{ counts: UnreadCount[] }> {
  const context = contextOf(caller)
  const who = whoOf(context)
  if (!who) throw new ForbiddenError()
  if (records.length > UNREAD_MAX) throw new ValidationError(`At most ${UNREAD_MAX} records at once.`, [{ path: 'body/records', message: `At most ${UNREAD_MAX} records at once.` }])
  const asked = records.filter((record) => RECORD_TYPE.test(record.type) && isUuid(record.id))
  const counted = await caller.withClient(async (client) => {
    const threads = asked.length === 0 ? [] : await client.thread.findMany({ where: { OR: asked.map((record) => ({ recordType: record.type, recordId: record.id })) }, select: THREAD_SCOPE })
    // ---- B-PR-08a part 2: the office's work order, hold and NCR threads through their wall party (no read for a portal caller: its
    // threads of these types are left out first).
    const seen = threads.filter((thread) => who.office || mayShare(thread.recordType))
    const scopeOf = await wallScopesOf(client, seen)
    const mayRead = seen.filter((thread) => mayOnThread(actorOf(context), THREADS_READ, thread.recordType, scopeOf(thread)))
    // ---- end B-PR-08a
    // B-CP-071 residual (lead addition 5): a portal person, only the records its portal opens (else as an unknown id).
    const readable = who.office ? mayRead : await openedByPartner(caller, client, mayRead)
    // ---- B-OP-061: asked, whether each record's thread is readable (a thread read above, else the office's own check of it).
    const readableOf = new Map<string, boolean>()
    if (options.readable) {
      const withThread = new Set(threads.map((thread) => `${thread.recordType}:${thread.recordId}`))
      const read = new Set(readable.map((thread) => `${thread.recordType}:${thread.recordId}`))
      for (const record of asked) {
        const key = `${record.type}:${record.id}`
        if (readableOf.has(key)) continue
        // A record whose conversation is another's (the thread page reads that one), or with no thread yet: the office asks the
        // record itself; a portal person reads only its party's threads that exist.
        const asOffice = who.office && (Object.hasOwn(THREAD_PLACES, record.type) || !withThread.has(key))
        readableOf.set(key, asOffice ? await officeReadable(client, actorOf(context), record) : read.has(key))
      }
    }
    // ---- end B-OP-061
    if (readable.length === 0) return { counts: new Map<string, { newCount: number; lastAt: Date | null }>(), readableOf }
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
    return { counts: new Map(readable.map((thread) => [`${thread.recordType}:${thread.recordId}`, { newCount: byThread.get(thread.id)?.newCount ?? 0, lastAt: byThread.get(thread.id)?.lastAt ?? null }])), readableOf }
  })
  return {
    counts: records.map((record) => {
      const key = `${record.type}:${record.id}`
      const seen = counted.counts.get(key)
      const row = { recordType: record.type, recordId: record.id, newCount: seen?.newCount ?? 0, lastAt: seen?.lastAt ? toUtcIso(seen.lastAt) : null }
      // B-OP-061: a record not asked (a type no thread has, an id that is none) is false like any other unknown one.
      return options.readable ? { ...row, readable: counted.readableOf.get(key) ?? false } : row
    }),
  }
}
