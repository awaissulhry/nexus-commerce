import type { ExportFormat } from '@nexus/factory-domain/views/exports'
import type { OrderRow } from '../../api'
import type { BrandHealth, BrandStage, SupervisorMark, WaitingOn } from '../../api' // F-SA-275
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

// F-SA-224: the Customer switcher moved to areas/sales/_shared/customer-switcher (one customer filter for every Sales list).

// ---- the Export menu: what the file holds --------------------------------------------------------------------------------------

/**
 * The words above Export ▾'s formats (band-F11, SHEET-G14, B-TH-008: screen = file): whose orders and which view, each format
 * with the number of orders the view holds (every page, not only the loaded rows), and the note that money columns are left out
 * without the price right.
 */
export function exportAbout(t: (key: string, params?: Readonly<Record<string, string | number>>) => string, input: { customer: string | null; view: string; count: number | null; price: boolean; formats: readonly ExportFormat[]; margin?: boolean }): { heading: string; formats: Partial<Record<ExportFormat, string>>; note: string } {
  const heading = t('export.heading', { customer: input.customer ?? t('switcher.all'), view: input.view })
  const formats: Partial<Record<ExportFormat, string>> = {}
  for (const format of input.formats) {
    if (format === 'XLSX_REIMPORT') continue
    const kind = format === 'XLSX' ? 'xlsx' : 'csv'
    formats[format] = input.count === null ? t(`export.${kind}Every`) : t(`export.${kind}`, { count: input.count })
  }
  // Margin % is estimated on screen per order; the export has no per-page margin read, so the file leaves it out and says so.
  const notes = [t('export.note'), ...(input.price ? [] : [t('export.noteNoPrice')]), ...(input.margin ? [t('export.noteMargin')] : [])]
  return { heading, formats, note: notes.join(' ') }
}

// ── F-SA-275 (sales page plan N5 / N2, picks R5, P10, P4; 11-customer-page §3.5; the API's B-SA-070): the production columns ──
/**
 * What a host knows of an order beside its row, joined by order id: the customer page reads the customer's requests that wait on
 * us and the conversations whose reply waits on us (one read each for the whole page). Sales › Orders has none: the row's own
 * production part says what it can (its open requests counted).
 */
export interface WaitingMark {
  /** The customer's requests on this order that wait on us, oldest first (the first opens the review window). */
  readonly requestIds?: readonly string[]
  /** Since when the customer's newest shared message on the order's conversation waits on us (an instant). */
  readonly replySince?: string | null
}
export type WaitingMarks = Readonly<Record<string, WaitingMark>>

/** One thing an order waits on — the most urgent first: a request to answer, a reply that waits, then who acts next. */
export type WaitingItem =
  | { readonly kind: 'request'; readonly count: number; readonly requestId: string | null }
  | { readonly kind: 'reply'; readonly since: string }
  | { readonly kind: 'keeper'; readonly on: WaitingOn; readonly since: string | null }

/** The Waiting on cell's items (the cell shows the first and "+N more"); none: nothing waits (or the part was not read). */
export function waitingItemsOf(row: Pick<OrderRow, 'production'>, mark?: WaitingMark | null): WaitingItem[] {
  const production = row.production
  const items: WaitingItem[] = []
  const requests = Math.max(production?.openRequests ?? 0, mark?.requestIds?.length ?? 0)
  if (requests > 0) items.push({ kind: 'request', count: requests, requestId: mark?.requestIds?.[0] ?? null })
  if (mark?.replySince) items.push({ kind: 'reply', since: mark.replySince })
  // The keeper's "waiting on us" while a request waits is that request: said once.
  if (production?.waitingOn && !(production.waitingOn === 'US' && requests > 0)) items.push({ kind: 'keeper', on: production.waitingOn, since: production.since })
  return items
}

/** "Answer request…": the review window on the page that holds it (the host's door), else the order's Changes tab. */
export function answerHrefOf(prefix: string, row: Pick<OrderRow, 'id'>, item: Extract<WaitingItem, { kind: 'request' }>, doorHref?: ((requestId: string) => string) | null): string {
  if (item.requestId && doorHref) return doorHref(item.requestId)
  return `${prefix}/sales/orders/${seg(row.id)}?tab=changes`
}

/** The keeper's health as the shared health chip names it (lib/production HealthState). */
export const HEALTH_CHIP: Readonly<Record<BrandHealth, 'LATE' | 'AT_RISK' | 'NOT_PROMISED' | 'ON_TIME'>> = Object.freeze({ LATE: 'LATE', AT_RISK: 'AT_RISK', NO_DATE: 'NOT_PROMISED', ON_TRACK: 'ON_TIME' })

/** The Where it is cell's first line: not read yet, the order's status (no stage kept: waiting for a yes, shipped, …), or the stage + health. */
export type WhereLine = { readonly kind: 'unread' } | { readonly kind: 'status' } | { readonly kind: 'stage'; readonly stage: BrandStage; readonly health: BrandHealth | null; readonly held: boolean }

export function whereLineOf(row: Pick<OrderRow, 'production'>): WhereLine {
  const production = row.production
  if (!production) return { kind: 'unread' }
  if (production.stage === null) return { kind: 'status' }
  return { kind: 'stage', stage: production.stage, health: production.health, held: production.held }
}

/**
 * The Where it is cell's second line: this order's OWN pieces in work orders ("120 of 300 sewn"), "Sewing not counted here" where a
 * site does not scan sewing (never 0), "Not in work yet"; null while the pieces were not read (`progress=true`). A key of the sheet,
 * or of the production parts' catalogue (`production: true`).
 */
export function piecesLineOf(row: Pick<OrderRow, 'progress'>): (Phrase & { readonly production?: true }) | null {
  const progress = row.progress
  if (progress === undefined) return null
  if (progress === null) return { key: 'progress.none' }
  if (progress.sewn === null) return { key: 'parts.stage.sewingNotCounted', production: true }
  return { key: 'where.sewn', params: { done: progress.sewn, total: progress.inWork } }
}

/** The Supervisor cell: not read, held (the reader's workorders.view does not reach the order: never guessed), or the mark — never a name. */
export type SupervisorCell = { readonly kind: 'unread' } | { readonly kind: 'withheld' } | { readonly kind: 'mark'; readonly mark: SupervisorMark }

export function supervisorCellOf(row: Pick<OrderRow, 'production'>): SupervisorCell {
  const production = row.production
  if (!production) return { kind: 'unread' }
  if (production.withheld.includes('supervisorMark') || production.supervisorMark === null) return { kind: 'withheld' }
  return { kind: 'mark', mark: production.supervisorMark }
}

/** The columns that read the rows' production part (`production=true`) while shown; Where it is reads the pieces too (`progress=true`). */
export const PRODUCTION_COLUMNS: readonly string[] = Object.freeze(['whereItIs', 'waitingOn', 'supervisor'])
export const PIECES_COLUMNS: readonly string[] = Object.freeze(['progress', 'whereItIs'])
// ── end F-SA-275 ──
