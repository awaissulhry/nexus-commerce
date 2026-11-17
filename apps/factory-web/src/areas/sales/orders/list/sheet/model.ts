import type { ExportFormat } from '@nexus/factory-domain/views/exports'
import type { OrderCustomer, OrderRow } from '../../api'
import type { OrderAbilities } from '../../model'

/**
 * B-TH-225 / B-TH-226 (threads plan TH-1a, pictures 23 + 24; Owner rule 2026-11-16 "every cell is a door", features
 * O-SAL-ORD-LIST.grid-F27…F30, SHEET.switcher-F01…F07): the pure rules of the Orders sheet — where each cell leads (a real
 * address, so ⌘-click opens a new tab), what a cell the reader may not open says instead, the Brand and Invoiced words, the
 * Customer switcher's lines and label, and what the Export menu says the file holds. No React, no fetching: the tests hold them.
 * Words are keys of the `orders-sheet` catalogue.
 */

export const NAMESPACE = 'orders-sheet'

/** A cell's door: its address, or the reason it is plain text (a right the reader does not hold), or nothing to open. */
export type Door = { readonly href: string; readonly tip: Phrase } | { readonly held: Phrase } | null

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

const seg = encodeURIComponent

/** The order's own page, on one of its tabs. */
export const orderHref = (prefix: string, row: Pick<OrderRow, 'id'>, tab?: 'lines' | 'shipments' | 'money'): string => `${prefix}/sales/orders/${seg(row.id)}${tab ? `?tab=${tab}` : ''}`

/** Number and the empty part of the row → the order (its thread docked). */
export const orderDoor = (prefix: string, row: OrderRow): Door => ({ href: orderHref(prefix, row), tip: { key: 'door.order', params: { number: row.number } } })

/** Customer → the customer's record (the reader's orders.view reaches it: the row is theirs to see). */
export const customerDoor = (prefix: string, row: OrderRow): Door => ({ href: `${prefix}/sales/customers/${seg(row.partyId)}`, tip: { key: 'door.customer', params: { name: row.partyName } } })

/** Pieces and Promised → the order's Lines tab. */
export const linesDoor = (prefix: string, row: OrderRow, promise = false): Door => ({ href: orderHref(prefix, row, 'lines'), tip: { key: promise ? 'door.promise' : 'door.lines', params: { number: row.number } } })

/** Deposit → its deposit invoice (invoices.view); "Not needed" and a deposit without an invoice open nothing. */
export function depositDoor(prefix: string, row: OrderRow, can: Pick<OrderAbilities, 'viewInvoices'>): Door {
  if (row.deposit.state === 'NOT_NEEDED') return null
  if (row.doors.depositInvoice) return { href: `${prefix}/finance/invoices/${seg(row.doors.depositInvoice.id)}`, tip: { key: 'door.deposit', params: { number: row.number } } }
  return can.viewInvoices ? null : { held: { key: 'held.invoices' } }
}

/**
 * Shipped → the delivery notes: one DDT → its shipment's documents (a DDT has no page of its own); several, or DDTs of
 * several shipments → the order's Shipments tab (the DDT list has no order term). "0" opens nothing.
 */
export function shippedDoor(prefix: string, row: OrderRow): Door {
  if (row.shippedUnits <= 0) return null
  const notes = row.doors.deliveryNotes
  if (!notes) return { held: { key: 'held.shipping' } }
  if (notes.count === 0) return null
  if (notes.only && notes.shipmentId) return { href: `${prefix}/warehouse/shipments/${seg(notes.shipmentId)}?tab=documents`, tip: { key: 'door.shipOne', params: { ddt: notes.only.number } } }
  return { href: orderHref(prefix, row, 'shipments'), tip: { key: 'door.ship', params: { number: row.number } } }
}

/** Invoiced → the invoices: one → that invoice; several → the order's Invoices & payments tab (the list has no order term). */
export function invoicedDoor(prefix: string, row: OrderRow, can: Pick<OrderAbilities, 'viewInvoices'>): Door {
  const state = row.invoiced?.state ?? 'NONE'
  if (state === 'NONE') return null
  const invoices = row.doors.invoices
  if (!invoices || !can.viewInvoices) return { held: { key: 'held.invoices' } }
  if (invoices.only) return { href: `${prefix}/finance/invoices/${seg(invoices.only.id)}`, tip: { key: 'door.invoiceOne', params: { number: invoices.only.number ?? row.number } } }
  if (invoices.count > 0) return { href: orderHref(prefix, row, 'money'), tip: { key: 'door.invoices', params: { number: row.number } } }
  return null
}

/** From quote → the quote (quotes.view over the order's customer); none → "—". */
export function quoteDoor(prefix: string, row: OrderRow): Door {
  if (!row.quote) return null
  if (!row.doors.quote) return { held: { key: 'held.quotes' } }
  return { href: `${prefix}/sales/quotes/${seg(row.doors.quote.id)}`, tip: { key: 'door.quote', params: { number: row.quote.number } } }
}

// ---- Brand: the label on the garment ------------------------------------------------------------------------------------------

/** The value the Brand funnel writes in the address: the label's party, or `own`. */
export type BrandValue = string

export type BrandCell =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly value: BrandValue; readonly name: string | null; readonly own: boolean }
  /** A label the reader may not see whose it is: plain words, no filter (its id is not known either). */
  | { readonly kind: 'hidden' }
  | { readonly kind: 'several'; readonly labels: ReadonlyArray<{ readonly value: BrandValue | null; readonly name: string | null; readonly own: boolean }> }

/** One label: its name; `own` = our own collection; a label of a party the reader may not see has neither id nor name. */
export function brandCell(row: Pick<OrderRow, 'brands'>): BrandCell {
  const labels = row.brands.map((brand) => ({ value: brand.own ? 'own' : brand.partyId, name: brand.name, own: brand.own }))
  if (labels.length === 0) return { kind: 'none' }
  if (labels.length > 1) return { kind: 'several', labels }
  const only = labels[0]!
  return only.value === null ? { kind: 'hidden' } : { kind: 'one', value: only.value, name: only.name, own: only.own }
}

/** A brand's name for a chip or the export heading, from the rows read (null when none of them names it). */
export function brandName(rows: readonly Pick<OrderRow, 'brands'>[], value: string): { own: boolean; name: string | null } {
  if (value === 'own') return { own: true, name: null }
  for (const row of rows) for (const brand of row.brands) if (brand.partyId === value && brand.name) return { own: false, name: brand.name }
  return { own: false, name: null }
}

// ---- Invoiced ----------------------------------------------------------------------------------------------------------------

/** The Invoiced cell: the word for every reader; the amount only with the price grain (absent from the row otherwise). */
export function invoicedCell(row: Pick<OrderRow, 'invoiced' | 'currency'>, can: Pick<OrderAbilities, 'price'>): { readonly word: string; readonly amount: number | null } {
  const state = row.invoiced?.state ?? 'NONE'
  const amount = can.price && state !== 'NONE' && typeof row.invoiced?.amount === 'number' ? row.invoiced.amount : null
  return { word: `invoiced.${state}`, amount }
}

// ---- the Customer switcher -------------------------------------------------------------------------------------------------

export interface SwitcherState {
  /** The first page of the reader's customers (recent first); null while read. */
  readonly customers: readonly OrderCustomer[] | null
  /** How many customers match the search (or in all, unsearched). */
  readonly total: number
  /** Every grant of the reader's orders.view names its customers. */
  readonly limited: boolean
  readonly problem: string | null
}

/**
 * The switcher's face: hidden while there is no customer yet; a fixed label for a reader limited to one customer; else the
 * button with the customer chosen, "All my customers (n)" for a limited reader, "All customers" for the rest.
 */
export type SwitcherFace = { readonly kind: 'hidden' } | { readonly kind: 'fixed'; readonly name: string } | { readonly kind: 'button'; readonly label: Phrase }

export function switcherFace(state: SwitcherState, party: string | null, partyName: string | null | undefined): SwitcherFace {
  const customers = state.customers
  if (customers && state.limited && state.total === 1 && customers.length === 1 && (!party || party === customers[0]!.id)) return { kind: 'fixed', name: customers[0]!.name }
  if (party) {
    const known = customers?.find((customer) => customer.id === party)?.name ?? partyName
    return { kind: 'button', label: known === null ? { key: 'switcher.unknown' } : known === undefined ? { key: 'switcher.reading' } : { key: 'switcher.chosen', params: { name: known } } }
  }
  if (customers && customers.length === 0 && state.total === 0 && !state.problem) return { kind: 'hidden' }
  return { kind: 'button', label: state.limited ? { key: 'switcher.allMine', params: { count: state.total } } : { key: 'switcher.all' } }
}

export interface SwitcherLine {
  readonly value: string
  readonly label: string
  readonly group?: string
  readonly open?: number
  readonly late?: number
  readonly archived?: boolean
}

/**
 * The switcher's lines: unsearched, "All customers" (or "All my customers (n)") on top, then the two most recent customers,
 * then the others by name; searched, the matches recent first. Each customer once.
 */
export function switcherLines(customers: readonly OrderCustomer[], searched: boolean, words: { all: string; recent: string; others: string }): SwitcherLine[] {
  const line = (customer: OrderCustomer, group?: string): SwitcherLine => ({ value: customer.id, label: customer.name, ...(group ? { group } : {}), open: customer.open, late: customer.late, archived: customer.archived })
  if (searched) return customers.map((customer) => line(customer))
  const recent = customers.slice(0, 2)
  const rest = customers.slice(2).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return [{ value: '', label: words.all }, ...recent.map((customer) => line(customer, words.recent)), ...rest.map((customer) => line(customer, words.others))]
}

// ---- the Export menu: what the file holds --------------------------------------------------------------------------------------

/**
 * The words above Export ▾'s formats (band-F11, SHEET-G14, B-TH-008: screen = file): whose orders and which view, each format
 * with the number of orders the view holds (every page, not only the loaded rows), and the note that money columns are left out
 * without the price right.
 */
export function exportAbout(t: (key: string, params?: Readonly<Record<string, string | number>>) => string, input: { customer: string | null; view: string; count: number | null; price: boolean; formats: readonly ExportFormat[] }): { heading: string; formats: Partial<Record<ExportFormat, string>>; note: string } {
  const heading = t('export.heading', { customer: input.customer ?? t('switcher.all'), view: input.view })
  const formats: Partial<Record<ExportFormat, string>> = {}
  for (const format of input.formats) {
    if (format === 'XLSX_REIMPORT') continue
    const kind = format === 'XLSX' ? 'xlsx' : 'csv'
    formats[format] = input.count === null ? t(`export.${kind}Every`) : t(`export.${kind}`, { count: input.count })
  }
  return { heading, formats, note: input.price ? t('export.note') : `${t('export.note')} ${t('export.noteNoPrice')}` }
}
