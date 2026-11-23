import type { IncomingRow } from '../../../inquiries/api'
import type { QuoteListRow } from '../../../quotes/api'

/**
 * F-CQ-305 (customer page › Quotes & incoming, 10-design §9; L10) — the dock's door line, pure: where a docked record came from and
 * what it became, from the row's own data (web only, nothing read): a quote "Came from request SEED-INQ-0005 ›" / "Came from portal
 * order SEED-RQ-0086 ›" and "Became order SEED-SO-0150 ›"; a request or a portal order "Became quote SEED-QT-0012 ›" / "Became order
 * …". A click docks that record's own thread (no thread is merged). Each link is there only when the row carries it (the reader's
 * right on the other record decides on the API).
 */
export type DockLinkKind = 'cameFromRequest' | 'cameFromPortal' | 'becameQuote' | 'becameOrder'

/** One door of the line: its words and the record it docks. */
export interface DockLink {
  readonly kind: DockLinkKind
  readonly pick: { readonly type: string; readonly id: string; readonly label: string; readonly companyId: string | null }
}

/** A quote's doors: the request or portal order it came from, the order it became. */
export function quoteLinksOf(row: Pick<QuoteListRow, 'companyId' | 'madeFrom' | 'fromPortalOrder' | 'order'>): DockLink[] {
  const links: DockLink[] = []
  if (row.madeFrom) links.push({ kind: 'cameFromRequest', pick: { type: 'Inquiry', id: row.madeFrom.inquiryId, label: row.madeFrom.number, companyId: row.companyId } })
  if (row.fromPortalOrder) links.push({ kind: 'cameFromPortal', pick: { type: 'PortalOrderRequest', id: row.fromPortalOrder.id, label: row.fromPortalOrder.number, companyId: row.companyId } })
  if (row.order?.state === 'MADE' && row.order.id && row.order.number) links.push({ kind: 'becameOrder', pick: { type: 'SalesOrder', id: row.order.id, label: row.order.number, companyId: row.companyId } })
  return links
}

/** A request's or a portal order's doors: the quote and the order it became. */
export function incomingLinksOf(row: Pick<IncomingRow, 'companyId' | 'request' | 'catalogueOrder'>): DockLink[] {
  const companyId = row.companyId ?? null
  const quote = row.request?.quote ?? row.catalogueOrder?.quote ?? null
  const order = row.request?.order ?? row.catalogueOrder?.salesOrder ?? null
  return [
    ...(quote ? [{ kind: 'becameQuote' as const, pick: { type: 'Quote', id: quote.id, label: quote.number, companyId } }] : []),
    ...(order ? [{ kind: 'becameOrder' as const, pick: { type: 'SalesOrder', id: order.id, label: order.number, companyId } }] : []),
  ]
}
