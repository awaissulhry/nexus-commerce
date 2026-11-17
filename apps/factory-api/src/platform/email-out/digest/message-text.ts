import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import type { FactoryClient } from '@nexus/factory-db'
import type { CommandTx } from '../../../core/command'
import { mayOnThread } from '../../threads/records'
import { wallScopesOf } from '../../threads/records' // B-PR-08a part 2: a work order's, hold's or NCR's message is quoted through its customer

/**
 * B-TH-080 (threads plan TH-6, thread-G11; feature T8-F09 "Safe notification text"): a notification mail carries the message
 * it is about — the office digest and the office's instant mail quote the note or mail a mention or a follow points at, and a
 * customer's portal mail (as it happens or in its summary) quotes the message we sent them. The text is cut per reader, at the
 * moment the mail is made, never once for all:
 *
 *   - an office person: the message of their notification (params.messageId), while they may still read its thread now
 *     (threads.read over the thread's company, site and customer, and its record type's gate); a note is the office's own;
 *   - a customer's portal person: only a message SHARED with their own customer (audience PARTNER, its party theirs, never an
 *     internal note) of a notification that points at it (anchor `message:<id>`), whatever made the notification.
 *
 * Anything else — no message, a message gone, a thread they may no longer read, another customer's message, a note — quotes
 * nothing: the mail says what it said before. The quote is the message's plain text, its spaces folded, at most
 * QUOTE_MAX_CHARACTERS (then "…"); never its HTML, its attachments or its amounts' grains (a plain text the writer typed).
 */

type Reader = FactoryClient | CommandTx

export const QUOTE_MAX_CHARACTERS = 300

/** A message's text as a mail quotes it (null: nothing to quote). */
export function quoteOf(text: string | null | undefined): string | null {
  const folded = (text ?? '').replace(/\s+/g, ' ').trim()
  if (folded === '') return null
  return folded.length <= QUOTE_MAX_CHARACTERS ? folded : `${folded.slice(0, QUOTE_MAX_CHARACTERS - 1).trimEnd()}…`
}

const messageIdOf = (params: unknown): string | null => {
  const value = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>).messageId : null
  return typeof value === 'string' ? value : null
}
const anchoredMessageOf = (anchor: string | null): string | null => (anchor && anchor.startsWith('message:') ? anchor.slice('message:'.length) : null)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An office person's quotes, per notification id: the messages their notifications name that they may read now. */
export async function officeQuotes(db: Reader, actor: Actor, notifications: readonly { readonly id: string; readonly params: unknown }[]): Promise<Map<string, string>> {
  const wanted = notifications.flatMap((row) => {
    const messageId = messageIdOf(row.params)
    return messageId && UUID.test(messageId) ? [{ id: row.id, messageId }] : []
  })
  if (wanted.length === 0) return new Map()
  const messages = await db.message.findMany({
    where: { id: { in: [...new Set(wanted.map((entry) => entry.messageId))] } },
    select: { id: true, bodyText: true, thread: { select: { recordType: true, /* B-PR-08a */ recordId: true, companyId: true, siteId: true, partyId: true } } },
  })
  const byId = new Map(messages.map((message) => [message.id, message]))
  const scopeOf = await wallScopesOf(db, messages.map((message) => message.thread)) // B-PR-08a part 2
  const quotes = new Map<string, string>()
  for (const entry of wanted) {
    const message = byId.get(entry.messageId)
    if (!message || !mayOnThread(actor, THREADS_READ, message.thread.recordType, scopeOf(message.thread))) continue
    const quote = quoteOf(message.bodyText)
    if (quote) quotes.set(entry.id, quote)
  }
  return quotes
}

/** A customer's quotes, per notification id: only messages shared with that customer (never a note, never another's). */
export async function partnerQuotes(db: Reader, partyId: string, notifications: readonly { readonly id: string; readonly anchor: string | null }[]): Promise<Map<string, string>> {
  const quotes = new Map<string, string>()
  for (const [id, message] of await partnerMessages(db, partyId, notifications)) if (message.quote) quotes.set(id, message.quote)
  return quotes
}

// ---- th-backend-g step 2 (B-TH-279: the portal's new-message mail reads its template, which names who wrote) ---------------------
/**
 * A customer's messages, per notification id, under the same rule as its quotes (only a message shared with THAT customer, never a
 * note, never another's): the quote, and who wrote it as its portal names the writer (`authorName`; null: the company, said by the
 * caller — the portal thread shows the company's name then). A notification whose message is not theirs is absent.
 */
export async function partnerMessages(db: Reader, partyId: string, notifications: readonly { readonly id: string; readonly anchor: string | null }[]): Promise<Map<string, { readonly quote: string | null; readonly authorName: string | null }>> {
  const wanted = notifications.flatMap((row) => {
    const messageId = anchoredMessageOf(row.anchor)
    return messageId && UUID.test(messageId) ? [{ id: row.id, messageId }] : []
  })
  if (wanted.length === 0) return new Map()
  const messages = await db.message.findMany({
    where: { id: { in: [...new Set(wanted.map((entry) => entry.messageId))] }, audience: 'PARTNER', partyId, direction: { not: 'INTERNAL_NOTE' } },
    select: { id: true, bodyText: true, authorName: true, partyId: true, audience: true },
  })
  const byId = new Map(messages.filter((message) => message.audience === 'PARTNER' && message.partyId === partyId).map((message) => [message.id, message]))
  const found = new Map<string, { readonly quote: string | null; readonly authorName: string | null }>()
  for (const entry of wanted) {
    const message = byId.get(entry.messageId)
    if (message) found.set(entry.id, { quote: quoteOf(message.bodyText), authorName: message.authorName?.trim() || null })
  }
  return found
}
// ---- end th-backend-g step 2
