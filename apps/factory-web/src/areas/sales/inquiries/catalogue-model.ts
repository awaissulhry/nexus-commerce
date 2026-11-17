import type { CatalogueAccepted, CatalogueRecord } from './api'
import type { InquiriesCan, Loaded, Notice, Phrase } from './model'

/**
 * B-TH-233 (threads plan TH-3; O-SAL-INQ-LIST.pane-actions-F13, B-TH-040): a catalogue order beside the Incoming list, pure — what
 * may be done now (the API's own `may`, the customer's state, the right, offline: in that order, so the words come before the
 * click), Accept as order (the promise date, a price typed per line — price grain only, blank = the customer's list price today),
 * Accept as quote, Refuse (the words the customer reads), and the receipt. Every word is a key of `sales-inquiries`.
 *
 * Only a SENT catalogue order is decided, once (factory-domain sales/portal-ordering/office decisionProblem); the customer may
 * withdraw it before. Deciding needs orders.manage over its company and customer (a quote also quotes.manage): the production
 * manager reads it and holds every action — "Only sales can accept or refuse a catalogue order" (held, not hidden).
 */

export type CatalogueAction = 'order' | 'quote' | 'refuse'

/** Why an action on the catalogue order waits, in words (null: it may run now). */
export function catalogueHeld(record: CatalogueRecord, action: CatalogueAction, can: Pick<InquiriesCan, 'orders' | 'quotes'>, offline: boolean): Phrase | null {
  const status = record.request.status
  if (status !== 'SENT') return { key: `catalogue.held.${status}` }
  if (!can.orders) return { key: 'catalogue.held.right', params: { right: 'right.orders.manage' } }
  if (action === 'quote' && !can.quotes) return { key: 'held.needs', params: { right: 'right.quotes.manage' } }
  if (!record.may[action]) return { key: 'held.notNow' }
  if (offline) return { key: 'held.offline' }
  return null
}

/** The main button follows the order: Accept as order while it may, else Accept as quote; nothing once it is decided. */
export function catalogueMain(record: CatalogueRecord, can: Pick<InquiriesCan, 'orders' | 'quotes'>): CatalogueAction | null {
  if (record.request.status !== 'SENT') return null
  if (catalogueHeld(record, 'order', can, false) === null) return 'order'
  if (catalogueHeld(record, 'quote', can, false) === null) return 'quote'
  return 'order'
}

/** What Accept sends, as typed. */
export interface AcceptDraft {
  readonly as: 'ORDER' | 'QUOTE'
  /** The promise date of the order (YYYY-MM-DD; starts as the date the customer asked for). */
  readonly promiseDate: string | null
  /** By line id: the unit price typed ('' = the customer's list price today). Only with the price grain. */
  readonly prices: Readonly<Record<string, string>>
}

/** The dialog starts from the catalogue order: the date asked, the price the customer was shown on each line (price grain only). */
export function acceptDraftOf(record: CatalogueRecord, as: 'ORDER' | 'QUOTE', can: Pick<InquiriesCan, 'price'>): AcceptDraft {
  const prices: Record<string, string> = {}
  for (const line of record.request.lines) prices[line.id] = can.price && typeof line.unitPriceShown === 'string' ? line.unitPriceShown : ''
  return { as, promiseDate: record.request.requestedDate, prices }
}

const PRICE = /^\d{1,12}(\.\d{1,6})?$/
/** A typed price as the API takes it (a comma accepted), or null when it is not one. */
export function typedPrice(text: string): string | null {
  const value = text.trim().replace(',', '.')
  return PRICE.test(value) ? value : null
}

/** Why Accept waits: the action's own hold, then a typed price that is not a price (the line named). */
export function acceptHeld(record: CatalogueRecord, draft: AcceptDraft, can: Pick<InquiriesCan, 'orders' | 'quotes'>, offline: boolean): Phrase | null {
  const held = catalogueHeld(record, draft.as === 'ORDER' ? 'order' : 'quote', can, offline)
  if (held) return held
  if (draft.as === 'ORDER') {
    const bad = record.request.lines.find((line) => (draft.prices[line.id] ?? '').trim() !== '' && typedPrice(draft.prices[line.id] ?? '') === null)
    if (bad) return { key: 'catalogue.accept.badPrice', params: { n: bad.seq / 10 } }
  }
  return null
}

/** The Accept body: an order's typed prices (price grain only: a price is never sent without it) and its promise date; a quote alone. */
export function acceptBodyOf(record: CatalogueRecord, draft: AcceptDraft, can: Pick<InquiriesCan, 'price'>): { version: number; as: 'ORDER' | 'QUOTE'; promiseDate?: string | null; lines?: Array<{ lineId: string; unitPrice: string }> } {
  if (draft.as === 'QUOTE') return { version: record.request.version, as: 'QUOTE' }
  const lines = can.price
    ? record.request.lines.flatMap((line) => {
        const price = typedPrice(draft.prices[line.id] ?? '')
        return price ? [{ lineId: line.id, unitPrice: price }] : []
      })
    : []
  return { version: record.request.version, as: 'ORDER', ...(draft.promiseDate !== record.request.requestedDate ? { promiseDate: draft.promiseDate } : {}), ...(lines.length > 0 ? { lines } : {}) }
}

/** The receipt: what was made and its number; the sizes the colourway no longer offers named by line; the API's copy warnings counted. */
export function acceptDone(made: CatalogueAccepted['made'], number: string): { readonly phrase: Phrase; readonly lines: Phrase[] } {
  const phrase: Phrase = { key: made.as === 'ORDER' ? 'catalogue.done.order' : 'catalogue.done.quote', params: { made: made.number, number } }
  const lines: Phrase[] = made.dropped.map((one) => (one.size ? { key: 'catalogue.done.droppedSize', params: { n: one.seq / 10, size: one.size } } : { key: 'catalogue.done.droppedLine', params: { n: one.seq / 10 } }))
  if (made.warnings.length > 0) lines.push({ key: 'catalogue.done.warnings', params: { count: made.warnings.length } })
  return { phrase, lines }
}

/** The refusal's words (the customer reads them): 1 to 1000 characters (factory-domain refuseReasonProblem). */
export const REFUSE_MAX = 1000
export function refuseHeld(reason: string, offline: boolean): Phrase | null {
  const text = reason.trim()
  if (text === '') return { key: 'catalogue.refuseHeld' }
  if (text.length > REFUSE_MAX) return { key: 'decline.held.long', params: { max: REFUSE_MAX } }
  if (offline) return { key: 'held.offline' }
  return null
}

/** Once decided or withdrawn: the outcome line (what it became, the words it was refused with, the customer's withdrawal). */
export function catalogueOutcome(record: CatalogueRecord): Phrase | null {
  const request = record.request
  if (request.status === 'ACCEPTED') return request.salesOrder ? { key: 'catalogue.outcome.order', params: { made: request.salesOrder.number } } : request.quote ? { key: 'catalogue.outcome.quote', params: { made: request.quote.number } } : { key: 'catalogue.outcome.accepted' }
  if (request.status === 'REFUSED') return { key: 'catalogue.outcome.refused', params: { reason: request.refuseReason ?? '—' } }
  if (request.status === 'WITHDRAWN') return { key: 'catalogue.outcome.withdrawn' }
  return null
}

/** A line's sizes as the office reads them ("S:2 M:5 L:3"). */
export const lineSizes = (line: Pick<CatalogueRecord['request']['lines'][number], 'sizes'>): string => line.sizes.map((size) => `${size.size}:${size.quantity}`).join(' ')

// ---- the pane's model (the container use-catalogue-order.tsx fills it; the view draws it) ----------------------------------------------

export type CatalogueDialog =
  | { readonly kind: 'accept'; readonly draft: AcceptDraft; readonly busy: boolean; readonly notice: Notice | null }
  | { readonly kind: 'refuse'; readonly reason: string; readonly busy: boolean; readonly notice: Notice | null }

export interface CatalogueModel {
  readonly prefix: string
  readonly can: InquiriesCan
  readonly offline: boolean
  readonly loaded: Loaded<CatalogueRecord>
  readonly notice: Notice | null
  readonly dialog: CatalogueDialog | null
  /** Someone else decided or changed it while it was open: when. */
  readonly handled: string | null
}

export interface CatalogueActions {
  onRetry?: () => void
  onReload?: () => void
  onAccept?: (as: 'ORDER' | 'QUOTE') => void
  onRefuse?: () => void
  onDraft?: (patch: Partial<AcceptDraft>) => void
  onPrice?: (lineId: string, price: string) => void
  onReason?: (reason: string) => void
  onSubmit?: () => void
  onCloseDialog?: () => void
  onDismissNotice?: () => void
}
