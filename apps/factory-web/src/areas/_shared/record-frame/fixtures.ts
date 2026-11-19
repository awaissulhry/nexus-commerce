import { createElement } from 'react'
import { recordDockedThread, type RecordDockedInput } from '../../../lib/record-thread/fixtures'
import type { HeadModel } from '../../../lib/record-thread/head/model'
import { ThreadCase } from '../../../lib/record-thread/ThreadCase'
import { useRecordFrame } from './RecordFrame'
import { useDockTop } from '../record-thread/ThreadPick' // F-OP-202: a design case's dock pick, drawn inside the card as on the page
// ---- F-OP-217: All of <customer> in a design case — the same card the page draws (AllOfCustomerDock), over a made-up page of the feed
import type { ReactNode } from 'react'
import { feedAnswerSchema, feedEntrySchema, type FeedEntry } from '../record-thread/all-of-customer/api'
import { afterFirst, EMPTY_FEED, feedModel } from '../record-thread/all-of-customer/model'
import { AllOfCustomerDock } from '../record-thread/all-of-customer/view/AllOfCustomerFeed'
// ---- end F-OP-217

/**
 * B-TH-257…264 (TH-6 part A; the rule of picture 38) — design only: the made-up docked thread a record page's design case passes to
 * its view as `thread`, inside the RecordFrame the case draws (whose width menu it drives). The page itself mounts the office's
 * `<OfficeRecordThread docked …/>`. No `designScreen` here: the record pages' own screens draw it.
 */
function DesignThread({ input, head }: { input: RecordDockedInput; head?: Partial<HeadModel> }) {
  const frame = useRecordFrame()
  const top = useDockTop() // F-OP-202
  return createElement(ThreadCase, { model: recordDockedThread(input, { width: frame?.width ?? null, ...head }), onWidth: frame?.choose, top })
}

/** The element a record page's design case passes to its view as its `thread` (its type, its number, its party or none). */
export const designDockedThread = (input: RecordDockedInput, head?: Partial<HeadModel>) => createElement(DesignThread, { input, head })

// ---- F-OP-217 (order page plan N4; 11-dock §3, §7): All of <customer> in a design case — the dock's card with its Head, a made-up page
// of compact lines (the customer's own line, our reply, an office note, the general thread, another record's line with two files) and
// the host's foot. Design only: the page reads the feed (useAllOfCustomer) and draws the same AllOfCustomerDock.
export interface DesignFeedInput {
  /** The customer's name and id (made-up). */
  readonly customer: { readonly id: string; readonly name: string; readonly code: string }
  /** The order the dock sits on (its line answers in This order) and another order of the customer. */
  readonly order: { readonly id: string; readonly number: string; readonly ownNumber: number | null }
  readonly other: { readonly id: string; readonly number: string }
  /** When "now" is (the lines' times). */
  readonly at: string
  /** No line at all: the empty state ("Write the first one in …"). */
  readonly empty?: boolean
}

const minutesBefore = (at: string, minutes: number) => new Date(Date.parse(at) - minutes * 60_000).toISOString()

/** A made-up page of the customer's feed (the API's own shape, checked by its schema). */
export function designFeedEntries(input: DesignFeedInput): FeedEntry[] {
  if (input.empty) return []
  const order = { type: 'SalesOrder', id: input.order.id, label: input.order.number, ownNumber: input.order.ownNumber, companyId: null, kind: 'ORDERS' }
  const general = { type: 'Party', id: input.customer.id, label: `${input.customer.code} ${input.customer.name}`, ownNumber: null, companyId: null, kind: 'GENERAL' }
  const other = { type: 'SalesOrder', id: input.other.id, label: input.other.number, ownNumber: null, companyId: null, kind: 'ORDERS' }
  const message = (id: string, minutes: number, over: Record<string, unknown>) => ({ id, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', author: { kind: 'PARTY', name: 'Giulia Esempio' }, body: '', bodyHtml: null, attachments: [], at: minutesBefore(input.at, minutes), ...over })
  const file = (id: string, name: string) => ({ id, kind: 'DOCUMENT', originalName: name, contentType: 'application/pdf', sizeBytes: 182_000, status: 'AVAILABLE' })
  return [
    { record: order, new: true, message: message('0190f0e2-7a00-7000-8000-000000000001', 12, { body: 'Can the sleeves be two centimetres longer on the size 52? We need them for the shop opening.' }) },
    { record: order, new: false, message: message('0190f0e2-7a00-7000-8000-000000000002', 45, { direction: 'OUTBOUND', author: { kind: 'USER', name: 'Sara Esempio' }, body: 'Yes, we can: the cutting starts on Monday, the new length is noted.' }) },
    { record: order, new: false, message: message('0190f0e2-7a00-7000-8000-000000000003', 70, { direction: 'INTERNAL_NOTE', audience: 'OFFICE', author: { kind: 'USER', name: 'Sara Esempio' }, body: 'Office note: check the sleeve pattern with the cutting room before we promise the date.' }) },
    { record: general, new: false, message: message('0190f0e2-7a00-7000-8000-000000000004', 1_500, { body: 'Our new address for the deliveries from December is in the attached letter.', attachments: [file('0190f0e2-7a00-7000-8000-0000000000f1', 'New delivery address.pdf')] }) },
    { record: other, new: false, message: message('0190f0e2-7a00-7000-8000-000000000005', 2_900, { body: 'The labels of the last delivery are fine, thank you.', attachments: [file('0190f0e2-7a00-7000-8000-0000000000f2', 'Label proof 1.pdf'), file('0190f0e2-7a00-7000-8000-0000000000f3', 'Label proof 2.pdf')] }) },
  ].map((entry) => feedEntrySchema.parse(entry))
}

/** The made-up All of <customer> card a design case docks (the order page's: Open <customer> in its ⋯, its foot given). */
export function designAllOfCustomer(input: DesignFeedInput & { readonly label: string; readonly prefix: string; readonly foot?: ReactNode }) {
  const answer = feedAnswerSchema.parse({ customer: input.customer, entries: designFeedEntries(input), nextCursor: input.empty ? null : 'design-older', threadsNotShown: 0, olderThreads: 0 })
  const model = feedModel(afterFirst(EMPTY_FEED, answer), { customerName: input.customer.name, prefix: input.prefix, view: 'all', kind: 'every', canReadFiles: true })
  const answerable = (record: { readonly type: string; readonly id: string }) => (record.type === 'SalesOrder' && record.id === input.order.id) || (record.type === 'Party' && record.id === input.customer.id)
  return createElement(AllOfCustomerDock, {
    label: input.label,
    model,
    actions: { canAnswer: answerable, onCompose: () => undefined, onAnswer: () => undefined, writeFirst: { thread: input.order.number, onWrite: () => undefined } },
    customerHref: `${input.prefix}/sales/customers/${input.customer.id}`,
    ...(input.foot ? { foot: input.foot } : {}),
  })
}
// ---- end F-OP-217
