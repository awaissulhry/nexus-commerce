import { formatNumber } from '../../../../../lib/i18n/format'
import type { Locale } from '../../../../../lib/i18n/locales'
import { money } from '../../../quotes/model'
import type { InvoiceCandidates, OrderRow, OrderSummary, SummaryDoor, SummaryFigures, SummaryGroup } from '../../api'
import { doorAddress } from '../../model'

/**
 * B-TH-244 (threads plan TH-4, picture 26; features SHEET.overall-F02 … F11, ORD-G06; wall W19, W27, W30): the overall view's pure
 * rules. Every figure of a customer's header and of the grand total is the SERVER's (GET /sales/orders/summary, for every order the
 * view's terms keep — never summed from the rows the screen has loaded), and each is a door: a real address that opens exactly the
 * rows it counts (the filter the API gave it). A figure still read is "—" and no door; a 0 is plain words; money only with the price
 * grain (the API leaves it out), one amount per currency, never added across currencies. Words: `orders-sheet` keys.
 */

type Translate = (key: string, params?: Record<string, string | number>) => string

/** One figure as drawn: its words, and its door (null: plain words — nothing to open, or a figure the view cannot open). */
export interface FigureDoor {
  readonly key: string
  readonly words: string
  readonly href: string | null
  readonly tone?: 'danger' | 'warning'
}

/** A figure's door: its count opens its rows when it counts something and the API gave its filter. */
const hrefOf = (path: string, door: SummaryDoor): string | null => (door.count > 0 && door.filter ? doorAddress(path, door.filter) : null)

/**
 * The figures of a customer's header or of the grand total, in the picture's order: orders; pieces ordered, shipped and still owed;
 * late; at risk; Invoiced None / Part / All; the net per currency (price grain only).
 */
export function figureDoors(figures: SummaryFigures, input: { path: string; t: Translate; locale: Locale }): FigureDoor[] {
  const { path, t, locale } = input
  const n = (value: number) => formatNumber(value, locale)
  const item = (key: string, door: SummaryDoor, words: string, tone?: FigureDoor['tone']): FigureDoor => ({ key, words, href: hrefOf(path, door), ...(tone && door.count > 0 ? { tone } : {}) })
  const out: FigureDoor[] = [
    item('orders', figures.orders, t('totals.orders', { count: figures.orders.count, n: n(figures.orders.count) })),
    item('ordered', figures.pieces.ordered, t('totals.ordered', { n: n(figures.pieces.ordered.count) })),
    item('shipped', figures.pieces.shipped, t('totals.shipped', { n: n(figures.pieces.shipped.count) })),
    item('open', figures.pieces.open, t('totals.open', { n: n(figures.pieces.open.count) })),
    item('late', figures.late, t('totals.late', { n: n(figures.late.count) }), 'danger'),
    item('atRisk', figures.atRisk, t('totals.atRisk', { n: n(figures.atRisk.count) }), 'warning'),
    item('NONE', figures.invoiced.NONE, t('totals.invoiced.NONE', { n: n(figures.invoiced.NONE.count) })),
    item('PART', figures.invoiced.PART, t('totals.invoiced.PART', { n: n(figures.invoiced.PART.count) })),
    item('ALL', figures.invoiced.ALL, t('totals.invoiced.ALL', { n: n(figures.invoiced.ALL.count) })),
  ]
  for (const entry of figures.net ?? []) {
    out.push({ key: `net-${entry.currency}`, words: money(entry.amount, entry.currency, locale), href: entry.amount !== 0 && entry.filter ? doorAddress(path, entry.filter) : null })
  }
  return out
}

/** A customer's header name: a door to that customer's own sheet with the same view (its orders' filter: the view's terms + it). */
export function groupHref(path: string, group: SummaryGroup): string {
  return doorAddress(path, group.figures.orders.filter ?? { partyId: group.partyId })
}

/** The header's line under the figures: how the customer is invoiced (a monthly customer's Part mid-month is no problem). */
export const timingKey = (group: Pick<SummaryGroup, 'invoiceTiming'>): string => `totals.timing.${group.invoiceTiming}`

/** The grand total's name: "All customers", or "All my customers" for a person limited to some (never the others). */
export const totalNameKey = (summary: Pick<OrderSummary, 'limited'>): string => (summary.limited ? 'totals.allMine' : 'totals.all')

/** The rows one customer's group has read so far (its own pages of 50, read when it is opened). */
export interface GroupRows {
  readonly items: readonly OrderRow[] | null
  readonly cursor: string | null
  readonly more: boolean
  readonly problem: string | null
  readonly loading: boolean
}

/** The loaded rows of the grouped view, in the groups' order (each group's own read). */
export function groupedItems(groups: readonly Pick<SummaryGroup, 'partyId'>[], rows: Readonly<Record<string, GroupRows>>): OrderRow[] {
  return groups.flatMap((group) => [...(rows[group.partyId]?.items ?? [])])
}

/** The groups whose rows are wanted now: open (not folded), not read and not being read. */
export function groupsToRead(groups: readonly Pick<SummaryGroup, 'partyId'>[], collapsed: readonly string[], rows: Readonly<Record<string, GroupRows>>): string[] {
  return groups.map((group) => group.partyId).filter((key) => !collapsed.includes(key) && !rows[key])
}

// ── "Invoice shipped goods for N" (finance only; ORD-G06, N21): Finance's From-DDTs dialog with the DDTs chosen ──

/** Finance's From-DDTs dialog for one draft: the DDTs chosen and the customer (`?new=1&ddts=…&party=…`). */
export function fromDdtsHref(prefix: string, draft: Pick<InvoiceCandidates['drafts'][number], 'body' | 'partyId'>): string {
  const query = new URLSearchParams({ new: '1', ddts: draft.body.ddtIds.join(','), party: draft.partyId })
  return `${prefix}/finance/invoices?${query.toString()}`
}

/** The words of an order the candidates hold back (the API's reason codes; never its English). */
export const heldKey = (reason: string): string => `invoiceShipped.held.${['NOTHING_SHIPPED', 'SHIPPED_WITHOUT_DDT', 'IN_DRAFT', 'INVOICED'].includes(reason) ? reason : 'OTHER'}`

/** Why "Invoice shipped goods for N" waits: no right (the action is absent then), nothing picked, more than 100 picked. */
export function invoiceShippedHeld(count: number): string | null {
  if (count === 0) return 'invoiceShipped.pick'
  if (count > 100) return 'invoiceShipped.tooMany'
  return null
}
