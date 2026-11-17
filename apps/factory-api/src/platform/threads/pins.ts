import type { FactoryClient } from '@nexus/factory-db'
import { THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_INQUIRIES_MANAGE } from '@nexus/factory-domain/sales/inquiries/permissions'
import { cleanBody, excerptOf, MAX_BODY_LENGTH } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { erasedAmong, erasedForOutside } from './feed-depth'
import { mayOnThread, mayShare, wallScopeOf } from './records'
import { contextOf, ensureThread, officeRecord, scopeOfThread, writeMessage, type RecordRef } from './threads'

/**
 * B-TH-091 (threads plan TH-9, N4, L2-G11; T2-F07 "2 pinned", T3-F12 "Pin for everyone", PROJ.thread-F06, O-SAL-INQ-LIST.pane-facts-F06;
 * wall W08 / T08): pins — a message (and so the files it carries) pinned on its conversation for everyone on the record, never a
 * personal bookmark and never a copy of the text: the line points at the message.
 *
 *   GET    /threads/<type>/<id>/pins                 the conversation's pins, oldest pin first: the office every pin (who pinned it,
 *                                                    when); a portal reader only the pins of messages shared with its own customer
 *                                                    (the database's partner policy: a pin carries its message's party, an office note's
 *                                                    pin none) — never who pinned it, never a pin of an office note
 *   PUT    /threads/<type>/<id>/pins/<messageId>     pin (threads.post over the record): a message of this conversation, not a mail
 *                                                    in its undo window or taken back; pinning one already pinned changes nothing
 *   DELETE /threads/<type>/<id>/pins/<messageId>     unpin (the same right); the history keeps who did it
 *   POST   /threads/Inquiry/<id>/pins/note           a request's own office note (Inquiry.note) moved into the conversation as an office
 *                                                    note, pinned first — one place for office notes (threads.post and sales.inquiries.
 *                                                    manage over the request); the field is emptied in the same command
 *
 * A pinned message erased after a privacy request stays pinned as a "removed" line (its words are gone, the pin is not).
 */

/** The most pins one conversation keeps (the popover scrolls; more is no longer a pin). */
export const PINS_MAX = 50

export const PIN_WORDS = Object.freeze({
  HELD: {
    it: 'Una mail ancora nel tempo per annullare l’invio, o ripresa, non si fissa.',
    en: 'A mail still in its undo window, or taken back, is not pinned.',
  },
  FULL: {
    it: `Questa conversazione ha già ${PINS_MAX} messaggi fissati: togline uno prima.`,
    en: `This conversation already has ${PINS_MAX} pinned messages: unpin one first.`,
  },
  NO_NOTE: {
    it: 'Questa richiesta non ha una nota da spostare nella conversazione.',
    en: 'This request has no note to move into the conversation.',
  },
  NOTE_ONLY_REQUEST: {
    it: 'Solo la nota di una richiesta si sposta nella conversazione come nota fissata.',
    en: 'Only a request’s note moves into the conversation as a pinned note.',
  },
})

const refusal = (code: keyof typeof PIN_WORDS): DomainError => new DomainError('conflict', PIN_WORDS[code].en, [{ path: `refusal/${code}`, message: PIN_WORDS[code].en }])

const keyOf = (threadId: string, messageId: string): string => `pin:${threadId}:${messageId}`

export interface PinView {
  readonly messageId: string
  readonly pinnedAt: string
  /** Office only: who pinned it. */
  readonly pinnedBy?: { readonly id: string; readonly name: string | null }
  readonly message: {
    readonly authorName: string | null
    /** One line of its words (empty when it carries files only). */
    readonly excerpt: string
    readonly at: string
    /** Office only: OFFICE (a note) or PARTNER (shared with the customer or supplier). */
    readonly audience?: 'OFFICE' | 'PARTNER'
    readonly attachmentCount: number
    /** Erased after a privacy request: the line says "removed". */
    readonly removed: boolean
  }
}

type Reader = FactoryClient | CommandTx

/** The pins of a thread as the reader's client reads them (a portal client: its own customer's only), with their messages. */
async function pinsOf(client: Reader, threadId: string, office: boolean): Promise<{ pins: Omit<PinView, 'message'>[]; messages: Map<string, { id: string; authorName: string | null; bodyText: string; at: Date; audience: 'OFFICE' | 'PARTNER'; attachmentFileIds: string[] }> }> {
  const rows: { messageId: string; pinnedAt: Date; pinnedById: string | null }[] = office
    ? await client.threadPin.findMany({ where: { threadId }, orderBy: [{ pinnedAt: 'asc' }, { id: 'asc' }], take: PINS_MAX, select: { messageId: true, pinnedAt: true, pinnedById: true } })
    : (await client.threadPin.findMany({ where: { threadId, partyId: { not: null } }, orderBy: [{ pinnedAt: 'asc' }, { id: 'asc' }], take: PINS_MAX, select: { messageId: true, pinnedAt: true } })).map((row) => ({ ...row, pinnedById: null as string | null }))
  const messageRows = rows.length === 0 ? [] : await client.message.findMany({ where: { threadId, id: { in: rows.map((row) => row.messageId) }, ...(office ? {} : { audience: 'PARTNER' as const }) }, select: { id: true, authorName: true, bodyText: true, at: true, audience: true, attachmentFileIds: true } })
  const messages = new Map(messageRows.map((row) => [row.id, row]))
  const names = office ? new Map((await client.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => (row.pinnedById ? [row.pinnedById] : [])))] } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName])) : new Map<string, string>()
  return {
    pins: rows.filter((row) => messages.has(row.messageId)).map((row) => ({ messageId: row.messageId, pinnedAt: toUtcIso(row.pinnedAt), ...(office && row.pinnedById ? { pinnedBy: { id: row.pinnedById, name: names.get(row.pinnedById) ?? null } } : {}) })),
    messages,
  }
}

function viewsOf(read: Awaited<ReturnType<typeof pinsOf>>, removed: ReadonlySet<string>, office: boolean): PinView[] {
  return read.pins.map((pin) => {
    const message = read.messages.get(pin.messageId)!
    return {
      ...pin,
      message: { authorName: message.authorName, excerpt: excerptOf(message.bodyText), at: toUtcIso(message.at), ...(office ? { audience: message.audience } : {}), attachmentCount: message.attachmentFileIds.length, removed: removed.has(message.id) },
    }
  })
}

/** GET /threads/<type>/<id>/pins: the office's every pin; a portal reader's, only of messages shared with it. */
export async function listPins(caller: CommandCaller, record: RecordRef): Promise<{ pins: PinView[] }> {
  const context = contextOf(caller)
  const office = context.audience === 'office'
  if (!office && context.audience !== 'partner') throw new ForbiddenError()
  if (!office && !mayShare(record.type)) return { pins: [] }
  const actor = actorOf(context)
  const read = await caller.withClient(async (client) => {
    if (office) {
      const found = await officeRecord(client, record)
      if (!mayOnThread(actor, THREADS_READ, record.type, found.scope)) throw new NotFoundError('Record not found.')
      if (!found.thread) return null
      const pins = await pinsOf(client, found.thread.id, true)
      return { pins, removed: await erasedAmong(client, [...pins.messages.values()]) }
    }
    // Row-level security shows a partner only its own party's thread and pins; "none" and "not yours" look the same.
    const partyId = context.audience === 'partner' ? context.partyId : null
    const thread = await client.thread.findFirst({ where: { recordType: record.type, recordId: record.id }, select: { id: true, companyId: true, siteId: true, partyId: true } })
    if (!thread || partyId === null || thread.partyId !== partyId || !mayOnThread(actor, THREADS_READ, record.type, scopeOfThread(thread))) return null
    return { pins: await pinsOf(client, thread.id, false), removed: null }
  })
  if (!read) return { pins: [] }
  const removed = read.removed ?? (await erasedForOutside(caller, context.tenantId, [...read.pins.messages.values()]))
  return { pins: viewsOf(read.pins, removed, office) }
}

/** The office writer's thread of the record (threads.post over it), or the refusal. */
async function writableThread(caller: CommandCaller, record: RecordRef) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const found = await caller.withClient((client) => officeRecord(client, record))
  if (!mayOnThread(actor, THREADS_READ, record.type, found.scope)) throw new NotFoundError('Record not found.')
  if (!mayOnThread(actor, THREADS_POST, record.type, found.scope)) throw new ForbiddenError('Pinning needs the right to write on this conversation.')
  return { context, actor, thread: found.thread }
}

/** PUT /threads/<type>/<id>/pins/<messageId>: pin a message for everyone on the record. */
export async function pinMessage(caller: CommandCaller, record: RecordRef, messageId: string, idempotencyKey?: string): Promise<{ pins: PinView[] }> {
  const { context, thread } = await writableThread(caller, record)
  if (!thread || !isUuid(messageId)) throw new NotFoundError('Not a message of this conversation.')
  await command(caller, { name: 'threads.pin', idempotencyKey, input: { recordType: record.type, recordId: record.id, messageId } }, async (tools) => {
    const message = await tools.tx.message.findFirst({ where: { id: messageId, threadId: thread.id }, select: { id: true, held: true } })
    if (!message) throw new NotFoundError('Not a message of this conversation.')
    if (message.held) throw refusal('HELD')
    if (await tools.tx.threadPin.findFirst({ where: { threadId: thread.id, messageId }, select: { id: true } })) return null
    if ((await tools.tx.threadPin.count({ where: { threadId: thread.id } })) >= PINS_MAX) throw refusal('FULL')
    const id = newId()
    // The pin's party is the message's, copied by the database (the app never writes it).
    await tools.tx.threadPin.create({ data: { id, threadId: thread.id, messageId, key: keyOf(thread.id, messageId), pinnedById: context.actorId, pinnedAt: tools.now, createdAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'threads.pin', recordType: 'ThreadPin', recordId: id, companyId: thread.companyId, siteId: thread.siteId, after: { threadId: thread.id, messageId } })
    return null
  })
  return listPins(caller, record)
}

/** DELETE /threads/<type>/<id>/pins/<messageId>: unpin (a message not pinned: nothing changes). */
export async function unpinMessage(caller: CommandCaller, record: RecordRef, messageId: string, idempotencyKey?: string): Promise<{ pins: PinView[] }> {
  const { thread } = await writableThread(caller, record)
  if (!thread || !isUuid(messageId)) throw new NotFoundError('Not a message of this conversation.')
  await command(caller, { name: 'threads.unpin', idempotencyKey, input: { recordType: record.type, recordId: record.id, messageId } }, async (tools) => {
    const pin = await tools.tx.threadPin.findFirst({ where: { threadId: thread.id, messageId }, select: { id: true } })
    if (!pin) return null
    await tools.tx.threadPin.delete({ where: { id: pin.id } })
    tools.audit({ action: 'threads.unpin', recordType: 'ThreadPin', recordId: pin.id, companyId: thread.companyId, siteId: thread.siteId, before: { threadId: thread.id, messageId } })
    return null
  })
  return listPins(caller, record)
}

/**
 * POST /threads/Inquiry/<id>/pins/note (L2-G11): the request's own note moved into its conversation — an office note in the person's
 * name with the note's words, pinned, and the request's note emptied, in ONE command (the thread made when it has none).
 */
export async function pinRequestNote(caller: CommandCaller, record: RecordRef, idempotencyKey?: string): Promise<{ pins: PinView[]; messageId: string }> {
  if (record.type !== 'Inquiry') throw refusal('NOTE_ONLY_REQUEST')
  const { context, actor } = await writableThread(caller, record)
  const { result } = await command(caller, { name: 'threads.pinRequestNote', idempotencyKey, input: { recordType: record.type, recordId: record.id } }, async (tools) => {
    const request = await tools.tx.inquiry.findUnique({ where: { id: record.id }, select: { id: true, companyId: true, partyId: true, note: true, version: true } })
    if (!request) throw new NotFoundError('Record not found.')
    if (!can(actor, SALES_INQUIRIES_MANAGE, { companyId: request.companyId, partyId: request.partyId })) throw new ForbiddenError('Moving the request’s note needs the right to manage requests.')
    const words = cleanBody(request.note ?? '').slice(0, MAX_BODY_LENGTH)
    if (words === '') throw refusal('NO_NOTE')
    const { thread } = await ensureThread(tools, record, context.actorId)
    if (!mayOnThread(actor, THREADS_POST, record.type, await wallScopeOf(tools.tx, thread))) throw new ForbiddenError()
    if ((await tools.tx.threadPin.count({ where: { threadId: thread.id } })) >= PINS_MAX) throw refusal('FULL')
    const author = await tools.tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } })
    const message = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'USER', id: context.actorId, name: author?.displayName ?? null }, bodyText: words })
    const pinId = newId()
    await tools.tx.threadPin.create({ data: { id: pinId, threadId: thread.id, messageId: message.id, key: keyOf(thread.id, message.id), pinnedById: context.actorId, pinnedAt: tools.now, createdAt: tools.now }, select: { id: true } })
    await tools.tx.inquiry.update({ where: { id: request.id }, data: { note: null, version: request.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'threads.pinRequestNote', recordType: 'Inquiry', recordId: request.id, companyId: request.companyId, before: { note: 'SET' }, after: { note: null, messageId: message.id, pinId } })
    return { messageId: message.id }
  })
  return { ...(await listPins(caller, record)), messageId: result.messageId }
}
