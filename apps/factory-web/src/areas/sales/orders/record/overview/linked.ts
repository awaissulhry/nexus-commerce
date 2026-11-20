import type { Order } from '../../api'
import { depositGate, type Phrase } from '../../model'
import type { OrderProduction } from './api'
import { tabHref } from '../../../../_shared/record-frame/address' // F-OP-104: the tab links keep the dock's scope (F-OP-210)

/**
 * F-OO-100 (order overview lane: one file per section) — Linked records, its rules moved out of model.ts unchanged (F-SA-233).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** One linked record, a count button that is a real link — or, without its right, held in words with no number. */
export interface LinkedRecord {
  readonly key: 'quote' | 'workOrders' | 'shipments' | 'invoices' | 'deposit' | 'complaints' | 'returns' | 'sameQuote'
  /** A count (0 is an answer); null: the entry says words instead (the quote, the deposit's state). */
  readonly count: number | null
  readonly words: Phrase | null
  /** Where it opens; null: no door (a held entry, a quote the reader may not open). */
  readonly href: string | null
  /** Held: it needs a right the reader does not hold (said, never counted). */
  readonly held: Phrase | null
}

interface LinkedInput {
  readonly order: Pick<Order, 'id' | 'chain' | 'depositRequired'>
  readonly prefix: string
  readonly can: { readonly viewQuotes: boolean; readonly viewInvoices: boolean }
  /** The production read's work part (the work orders this reader reaches, the others counted); null: not read or withheld. */
  readonly work: OrderProduction['work'] | null | undefined
  readonly complaints: number | null
  readonly returns: number | null
  readonly sameQuote: readonly { readonly id: string; readonly number: string }[]
  /** B-TH-228: the request an order was made from straight (no quote between); undefined: still read (nothing claimed). */
  readonly madeFrom?: { readonly id: string; readonly number: string } | null
  /** F-OP-104: the page's address terms now (a tab link keeps the dock's scope, tabHref); absent: none. */
  readonly search?: string
}

/**
 * The order's linked records (industry idea 3; it replaces Lines' "Record chain"): Quote · Work orders · Shipments · Invoices · Deposit
 * · Complaints · Returns · Same quote. Counts are the rows the reader sees; work orders it does not reach are said apart ("1 work order
 * not shown"), never named; a list it may not read is held in words with no number.
 */
export function linkedRecordsOf(input: LinkedInput): { readonly records: readonly LinkedRecord[]; readonly workOrdersLeftOut: number } {
  const { order, prefix, can } = input
  const record = `${prefix}/sales/orders/${order.id}`
  // F-OP-104 (F-OP-210, R-19): the order's own tabs through tabHref — the dock's scope kept.
  const tab = (name: string, anchor?: string) => `${tabHref(record, name, input.search ?? '')}${anchor ? `#${anchor}` : ''}`
  const quote = order.chain.quote
  const work = input.work ?? null
  const workCount = work ? work.workOrders.length + work.mtm.reduce((sum, group) => sum + group.workOrders, 0) : order.chain.workOrders.length
  const gate = depositGate(order)
  const records: LinkedRecord[] = [
    ...(quote
      ? [{ key: 'quote' as const, count: null, words: phrase('chain.quoteValue', { number: quote.number, revision: quote.revision }), href: can.viewQuotes ? `${prefix}/sales/quotes/${quote.id}` : null, held: null }]
      : input.madeFrom
        ? [{ key: 'quote' as const, count: null, words: phrase('chain.fromRequest', { number: input.madeFrom.number }), href: `${prefix}/sales/incoming/${encodeURIComponent(input.madeFrom.id)}`, held: null }]
        : input.madeFrom === null
          ? [{ key: 'quote' as const, count: null, words: phrase('chain.noQuote'), href: null, held: null }]
          : []),
    { key: 'workOrders', count: workCount, words: null, href: workCount > 0 ? tab('production') : null, held: null },
    { key: 'shipments', count: order.chain.shipments.length, words: null, href: order.chain.shipments.length > 0 ? tab('shipments') : null, held: null },
    // F-OP-306 (walk #21): without invoices.view no number and the Money tab's own sentence (one rule, one wording for both).
    can.viewInvoices ? { key: 'invoices', count: order.chain.invoices.length, words: null, href: order.chain.invoices.length > 0 ? tab('money', 'invoices') : null, held: null } : { key: 'invoices', count: null, words: null, href: null, held: phrase('money.noInvoiceRight') },
    { key: 'deposit', count: null, words: phrase(`gate.state.${gate.state}`), href: tab('money'), held: null },
    ...(input.complaints !== null ? [{ key: 'complaints' as const, count: input.complaints, words: null, href: input.complaints > 0 ? tab('shipments') : null, held: null }] : []),
    ...(input.returns !== null ? [{ key: 'returns' as const, count: input.returns, words: null, href: input.returns > 0 ? tab('shipments') : null, held: null }] : []),
    ...input.sameQuote.map((other) => ({ key: 'sameQuote' as const, count: null, words: phrase('overview.linked.sameQuoteValue', { number: other.number }), href: `${prefix}/sales/orders/${other.id}`, held: null })),
  ]
  return { records, workOrdersLeftOut: work?.workOrdersLeftOut ?? 0 }
}
