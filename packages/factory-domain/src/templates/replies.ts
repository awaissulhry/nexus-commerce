import type { Issue } from '../core/errors'
import { COMPANY_PLACEHOLDERS } from './mail'
import { placeholderProblems } from './placeholders'
// ---- B-TH-098: saved replies in the five message languages (./message-languages.ts).
import { isMessageLanguage, MESSAGE_LANGUAGE_WORDS } from './message-languages'

/**
 * Saved replies (B-W2b-422; COL-016 "Message templates per language"; design shell.preview send panel "Message (template per
 * language)"): a message a person writes again and again — a delay notice, a sample request, a certificate sent — per
 * language, with placeholders the record fills (the order's number and promised day, the contact's name). A person's own,
 * or shared with the office (the database's MessageTemplate: ownerId null). Picking one fills the message box; the person
 * reads it, changes it and sends: nothing is sent by a saved reply. Pure.
 */

/** The records a saved reply may be for (null: any record), and the placeholders each fills. */
// B-TH-046 (threads plan TH-3, N5): Inquiry — the requests of Sales › Incoming (number, what it is about, the wanted date, the
// customer's contact who wrote it).
export const REPLY_RECORD_TYPES = ['SalesOrder', 'Quote', 'PurchaseOrder', 'ServiceCase', 'Shipment', 'Party', 'Inquiry'] as const
export type ReplyRecordType = (typeof REPLY_RECORD_TYPES)[number]

export const isReplyRecordType = (value: unknown): value is ReplyRecordType => typeof value === 'string' && (REPLY_RECORD_TYPES as readonly string[]).includes(value)

/** What any record fills: the contact written to, the party, the person who writes, today, the company. */
export const COMMON_REPLY_PLACEHOLDERS = ['contact.name', 'party.name', 'me.name', 'today', ...COMPANY_PLACEHOLDERS] as const

export const REPLY_PLACEHOLDERS: Readonly<Record<ReplyRecordType, readonly string[]>> = Object.freeze({
  SalesOrder: [...COMMON_REPLY_PLACEHOLDERS, 'order.number', 'order.customerRef', 'order.promiseDate'],
  Quote: [...COMMON_REPLY_PLACEHOLDERS, 'quote.number', 'quote.validUntil'],
  PurchaseOrder: [...COMMON_REPLY_PLACEHOLDERS, 'order.number', 'order.deliveryDate'],
  ServiceCase: [...COMMON_REPLY_PLACEHOLDERS, 'case.number'],
  Shipment: [...COMMON_REPLY_PLACEHOLDERS, 'shipment.number', 'order.number'],
  Party: COMMON_REPLY_PLACEHOLDERS,
  // B-TH-046: `inquiry.subject` is what the request is about (the subject of the mail it came by, else its first line).
  Inquiry: [...COMMON_REPLY_PLACEHOLDERS, 'inquiry.number', 'inquiry.subject', 'inquiry.wantedDate', /* B-TH-098: the customer's own number (§0.5) */ 'inquiry.yourNumber'],
})

// ---- th-backend-g step 1 (threads plan §0.5 "counts do not leak", lead's decision) -------------------------------------------
/**
 * Who reads the filled text: CUSTOMER — a mail or a portal message to the record's customer (the default: a text that may reach a
 * customer is filled for one); OFFICE — an office note, read by the office only. The record numbers a customer has a number of its
 * own for (NUMBER_PLACEHOLDERS) are the customer's own running number ("#7") in a text to a customer, never the office's shared
 * series (INQ-…, QT-…, SO-…: their count would tell how much the other customers ask and order); the office keeps its series in an
 * office note. A prospect (no customer yet) has no number of its own: its request keeps the office's number. A supplier's purchase
 * order, a service case and a delivery note keep their own numbers (no customer series; DDTs and invoices are the legal series).
 */
export const REPLY_AUDIENCES = ['CUSTOMER', 'OFFICE'] as const
export type ReplyAudience = (typeof REPLY_AUDIENCES)[number]

/** The placeholders of each record type whose value is a customer record's number (the office's series, or the customer's own). */
export const NUMBER_PLACEHOLDERS: Readonly<Partial<Record<ReplyRecordType, readonly string[]>>> = Object.freeze({
  SalesOrder: ['order.number'],
  Quote: ['quote.number'],
  Shipment: ['order.number'],
  Inquiry: ['inquiry.number'],
})

/** One number a filled text holds, as the office writes it and as its customer reads it (null: the customer has none of its own yet). */
export interface NumberPair {
  readonly placeholder: string
  readonly office: string
  readonly customer: string | null
}

/** The value of a number placeholder for the reader: the office's series in office text, else the customer's own (null: none yet). */
export const numberFor = (audience: ReplyAudience, pair: Pick<NumberPair, 'office' | 'customer'>): string | null => (audience === 'OFFICE' ? pair.office : pair.customer)
// ---- end th-backend-g step 1

/** The placeholders a saved reply for this record type (null: any record) may use. */
export const replyPlaceholdersOf = (recordType: string | null): readonly string[] => (isReplyRecordType(recordType) ? REPLY_PLACEHOLDERS[recordType] : COMMON_REPLY_PLACEHOLDERS)

export const REPLY_LIMITS = Object.freeze({ name: 120, body: 10000 })

export interface ReplyWords {
  readonly name: string
  readonly language: string
  readonly body: string
  readonly recordType: string | null
}

/** Every problem of a saved reply (empty when it can be saved). */
export function replyProblems(words: ReplyWords): Issue[] {
  const problems: Issue[] = []
  const name = words.name.trim()
  if (name === '' || name.length > REPLY_LIMITS.name || /[\r\n]/.test(name)) problems.push({ path: 'body/name', message: `One line of 1 to ${REPLY_LIMITS.name} characters.` })
  if (!isMessageLanguage(words.language)) problems.push({ path: 'body/language', message: MESSAGE_LANGUAGE_WORDS.en }) // B-TH-098
  if (words.recordType !== null && !isReplyRecordType(words.recordType)) problems.push({ path: 'body/recordType', message: 'Saved replies are for an order, a quote, a purchase order, a service case, a shipment, a customer or supplier, a request, or any record.' })
  const body = words.body.trim()
  if (body === '' || body.length > REPLY_LIMITS.body) problems.push({ path: 'body/body', message: `1 to ${REPLY_LIMITS.body} characters.` })
  else problems.push(...placeholderProblems(body, 'body/body', replyPlaceholdersOf(words.recordType)))
  return problems
}
