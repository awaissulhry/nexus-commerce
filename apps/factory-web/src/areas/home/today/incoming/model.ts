import type { IncomingList } from '@nexus/factory-domain/sales/incoming/contracts'
import type { Loaded } from '../model'

/**
 * B-TH-239 (threads plan TH-3; O-HOME-TODAY.incoming-F01 / F03, picture 17): Today's "Incoming" lines, pure. They count with the
 * SAME read as Sales › Incoming's tiles — GET /sales/incoming (B-TH-039, #1561) with no filter — so Today and Incoming never say two
 * numbers for one thing: "New incoming requests" is the New tile's count, "Catalogue orders to decide" the New tile's catalogue orders
 * (`kinds.CATALOGUE_ORDER`: SENT and not decided yet), "Waiting on us over a working day" the WAITING_US tile (everyone's; Today's
 * own INQUIRY_WAITING alert in "Needs me now" is the reader's or nobody's). Each line opens Incoming at that tile.
 *
 * Brand wall (W27, W30, W37): the API counts only the rows the reader may open (each kind by its own view permission over each row's
 * company and customer); a kind the reader may not see comes back null and its line is not drawn. The lines show only to a reader of
 * requests (sales.inquiries.view) once Incoming is built; otherwise the section is absent. An unknown count is "—", never 0.
 */

/** Sales › Incoming (B-TH-216): the page the lines open. */
export const INCOMING_PAGE = '/sales/incoming'

/** The live changes after which the counts are read again (requests, catalogue orders, change requests). */
export const INCOMING_LIVE_PREFIXES: readonly string[] = Object.freeze(['inquiry.', 'portal_order_request.', 'order_change_request.'])

export const incomingWants = (type: string): boolean => INCOMING_LIVE_PREFIXES.some((prefix) => type.startsWith(prefix))

export type IncomingLineId = 'NEW' | 'CATALOGUE_ORDERS' | 'WAITING_US'

export interface IncomingLine {
  readonly id: IncomingLineId
  /** A `home` key: its label. */
  readonly label: string
  /** A `home` key: what it counts, in one line (the hover and the screen reader). */
  readonly hint: string
  /** The count as Incoming's tile has it; null: unknown ("—"). */
  readonly count: number | null
  /** The API counted only part of it (WAITING_US over 1000 open rows): "1000+". */
  readonly partial: boolean
  /** Incoming at the matching tile (a real link). */
  readonly href: string
}

export interface IncomingToday {
  readonly lines: readonly IncomingLine[]
  readonly asOf: string
}

/** What Today draws: null when the reader does not read requests (the section is absent). */
export type IncomingState = Loaded<IncomingToday> | null

/** Whether Today shows the Incoming lines to this reader (sales.inquiries.view, and Incoming is built). */
export function mayReadIncoming(permissions: ReadonlySet<string>, built: ReadonlySet<string>): boolean {
  return permissions.has('sales.inquiries.view') && built.has(INCOMING_PAGE)
}

/** Incoming at one tile (and one kind), company-prefixed. */
export function incomingHref(prefix: string, query: Readonly<Record<string, string>>): string {
  const text = new URLSearchParams(query).toString()
  return `${prefix}${INCOMING_PAGE}${text ? `?${text}` : ''}`
}

/**
 * A catalogue order opened in Incoming's reading pane (O-HOME-TODAY.incoming-F03: Today's PORTAL_ORDER_REQUEST rows opened nowhere
 * before). The list of every catalogue order (`tile=ALL&kind=CATALOGUE_ORDER`, so a row decided meanwhile is still found) with that
 * order open beside it — B-TH-233: Incoming's address for a catalogue order in the pane is `catalogue=<id>` (`open=` is a request's).
 */
export const catalogueOrderHref = (prefix: string, id: string): string => incomingHref(prefix, { tile: 'ALL', kind: 'CATALOGUE_ORDER', catalogue: id })

const known = (value: number | null | undefined): number | null => (typeof value === 'number' ? value : null)

/** The lines of one read (the New tile asked): New, catalogue orders to decide (only for a reader of orders), waiting on us. */
export function incomingLinesOf(answer: Pick<IncomingList, 'counts' | 'kinds' | 'complete'>, prefix: string): IncomingLine[] {
  const lines: IncomingLine[] = [{ id: 'NEW', label: 'today.incoming.new', hint: 'today.incoming.newHint', count: known(answer.counts.NEW), partial: false, href: incomingHref(prefix, { tile: 'NEW' }) }]
  // A catalogue order is read with orders.view: without it the API says null and the line is not drawn (never "0").
  if (answer.kinds.CATALOGUE_ORDER !== null) lines.push({ id: 'CATALOGUE_ORDERS', label: 'today.incoming.catalogue', hint: 'today.incoming.catalogueHint', count: answer.kinds.CATALOGUE_ORDER, partial: false, href: incomingHref(prefix, { tile: 'NEW', kind: 'CATALOGUE_ORDER' }) })
  lines.push({ id: 'WAITING_US', label: 'today.incoming.waiting', hint: 'today.incoming.waitingHint', count: known(answer.counts.WAITING_US), partial: !answer.complete, href: incomingHref(prefix, { tile: 'WAITING_US' }) })
  return lines
}

/** A count in words: "—" unknown, "1000+" partial, else the number. */
export function countText(line: Pick<IncomingLine, 'count' | 'partial'>): string {
  if (line.count === null) return '—'
  return line.partial ? `${line.count}+` : String(line.count)
}
