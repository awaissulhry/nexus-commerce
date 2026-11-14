import type { Issue } from '../core/errors'
import { isTemplateLanguage } from './language'
import { COMPANY_PLACEHOLDERS } from './mail'
import { placeholderProblems } from './placeholders'

/**
 * Saved replies (B-W2b-422; COL-016 "Message templates per language"; design shell.preview send panel "Message (template per
 * language)"): a message a person writes again and again — a delay notice, a sample request, a certificate sent — per
 * language, with placeholders the record fills (the order's number and promised day, the contact's name). A person's own,
 * or shared with the office (the database's MessageTemplate: ownerId null). Picking one fills the message box; the person
 * reads it, changes it and sends: nothing is sent by a saved reply. Pure.
 */

/** The records a saved reply may be for (null: any record), and the placeholders each fills. */
export const REPLY_RECORD_TYPES = ['SalesOrder', 'Quote', 'PurchaseOrder', 'ServiceCase', 'Shipment', 'Party'] as const
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
})

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
  if (!isTemplateLanguage(words.language)) problems.push({ path: 'body/language', message: 'Saved replies are written in Italian or English.' })
  if (words.recordType !== null && !isReplyRecordType(words.recordType)) problems.push({ path: 'body/recordType', message: 'Saved replies are for an order, a quote, a purchase order, a service case, a shipment, a customer or supplier, or any record.' })
  const body = words.body.trim()
  if (body === '' || body.length > REPLY_LIMITS.body) problems.push({ path: 'body/body', message: `1 to ${REPLY_LIMITS.body} characters.` })
  else problems.push(...placeholderProblems(body, 'body/body', replyPlaceholdersOf(words.recordType)))
  return problems
}
