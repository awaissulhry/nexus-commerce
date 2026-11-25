import type { ExportFormat } from '@nexus/factory-domain/views/exports'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time' // F-MS-104
import { handSetOld } from '@nexus/factory-domain/production-brand/stage-set' // F-MS-104
import type { OrderRow } from '../../api'
import type { BrandHealth, BrandStage, SupervisorMark, WaitingOn } from '../../api' // F-SA-275
import type { OrderAbilities } from '../../model'
import type { OrderPhase } from '../../api' // F-CW-101
import type { OrderStatus } from '../../api' // F-CW-102
import { isAfterProduction, officeStripStateOf, orderPhaseOf } from '@nexus/factory-domain/production-brand/stages' // F-CW-102: the ONE phase rule

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
// F-CW-102: + the Production tab (the door of "On hold").
export const orderHref = (prefix: string, row: Pick<OrderRow, 'id'>, tab?: 'lines' | 'shipments' | 'money' | 'production' | 'files' /* F-CW-204 */): string => `${prefix}/sales/orders/${seg(row.id)}${tab ? `?tab=${tab}` : ''}`

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
  /**
   * F-CW-303: since when our oldest open ask of the customer on this order waits (an instant) — the customer page's own asks read
   * (what we put in the customer's to-do list). Sales › Orders and Made to measure have none.
   */
  readonly askedSince?: string | null
}
export type WaitingMarks = Readonly<Record<string, WaitingMark>>

/**
 * One thing an order waits on — the most urgent first: a request to answer, a reply that waits (both wait on US), then what WE asked
 * and still wait for (F-CW-303: production — the order's open production issues, since the oldest; the customer — our open ask of
 * it), then who acts next.
 */
export type WaitingItem =
  | { readonly kind: 'request'; readonly count: number; readonly requestId: string | null }
  | { readonly kind: 'reply'; readonly since: string }
  | { readonly kind: 'askedProduction'; readonly count: number; readonly since: string | null } // F-CW-303
  | { readonly kind: 'askedCustomer'; readonly since: string } // F-CW-303
  | { readonly kind: 'keeper'; readonly on: WaitingOn; readonly since: string | null }

/** The Waiting on cell's items (the cell shows the first and "+N more"); none: nothing waits (or the part was not read). */
export function waitingItemsOf(row: Pick<OrderRow, 'production'>, mark?: WaitingMark | null): WaitingItem[] {
  const production = row.production
  const items: WaitingItem[] = []
  const requests = Math.max(production?.openRequests ?? 0, mark?.requestIds?.length ?? 0)
  if (requests > 0) items.push({ kind: 'request', count: requests, requestId: mark?.requestIds?.[0] ?? null })
  if (mark?.replySince) items.push({ kind: 'reply', since: mark.replySince })
  // F-CW-303: what we asked and still wait for — "Asked production · 2 d" (the order's open production issues; a count withheld from
  // this reader is null: nothing is said) and, on the customer's page, "Asked <customer> · 3 d".
  const issues = production?.openIssues ?? 0
  if (issues > 0) items.push({ kind: 'askedProduction', count: issues, since: production?.openIssuesSince ?? null })
  const asked = mark?.askedSince ?? null
  if (asked) items.push({ kind: 'askedCustomer', since: asked })
  // The keeper's "waiting on us" while a request waits is that request, and its "waiting on the customer" while our ask of the
  // customer waits is that ask: each said once.
  if (production?.waitingOn && !(production.waitingOn === 'US' && requests > 0) && !(production.waitingOn === 'BRAND' && asked)) items.push({ kind: 'keeper', on: production.waitingOn, since: production.since })
  return items
}

/** "Answer request…": the review window on the page that holds it (the host's door), else the order's Changes tab. */
export function answerHrefOf(prefix: string, row: Pick<OrderRow, 'id'>, item: Extract<WaitingItem, { kind: 'request' }>, doorHref?: ((requestId: string) => string) | null): string {
  if (item.requestId && doorHref) return doorHref(item.requestId)
  return `${prefix}/sales/orders/${seg(row.id)}?tab=changes`
}

/** The keeper's health as the shared health chip names it (lib/production HealthState). */
export const HEALTH_CHIP: Readonly<Record<BrandHealth, 'LATE' | 'AT_RISK' | 'NOT_PROMISED' | 'ON_TIME'>> = Object.freeze({ LATE: 'LATE', AT_RISK: 'AT_RISK', NO_DATE: 'NOT_PROMISED', ON_TRACK: 'ON_TIME' })

/**
 * The Where it is cell's first line: not read yet, the order's status (no stage kept: waiting for a yes, shipped, …), or the stage +
 * health. F-MS-104 (04 §5, R17): `byHand` only while a stage set by hand stands — the stage keeps its place and gains a small mark
 * (never a third chip: the dense cell keeps the stage and the health), amber once it was set STAGE_SET_CHECK_DAYS days ago or more
 * (the domain's handSetOld, the order page's rule). No name and no reason in the list: the order says who and why.
 */
export type WhereLine =
  | { readonly kind: 'unread' }
  | { readonly kind: 'status' }
  | { readonly kind: 'stage'; readonly stage: BrandStage; readonly health: BrandHealth | null; readonly held: boolean; readonly byHand?: { readonly old: boolean } }

export function whereLineOf(row: Pick<OrderRow, 'production'>, today: BusinessDate = businessDate(new Date())): WhereLine {
  const production = row.production
  if (!production) return { kind: 'unread' }
  if (production.stage === null) return { kind: 'status' }
  const hand = production.stageByHand // F-MS-104
  return { kind: 'stage', stage: production.stage, health: production.health, held: production.held, ...(hand ? { byHand: { old: handSetOld(hand.since, today) } } : {}) }
}

// ── F-MS-104 ──
/** The words the Where it is line is said in (the grid's value and the phone card's line): the host's catalogues. */
export interface WhereWords {
  readonly status: (status: OrderRow['status']) => string
  readonly stage: (stage: BrandStage) => string
  readonly health: (chip: (typeof HEALTH_CHIP)[BrandHealth]) => string
  /** "Sewing (by hand)" (the export's own words, STAGE_BY_HAND_WORDS). */
  readonly byHand: (stage: string) => string
}

/** The Where it is line in words: "Sewing (by hand) · At risk"; the status when no stage is kept; "" while not read. */
export function whereTextOf(row: Pick<OrderRow, 'production' | 'status'>, words: WhereWords, today?: BusinessDate): string {
  const line = whereLineOf(row, today)
  if (line.kind === 'unread') return ''
  if (line.kind === 'status') return words.status(row.status)
  const stage = words.stage(line.stage)
  return [line.byHand ? words.byHand(stage) : stage, line.health ? words.health(HEALTH_CHIP[line.health]) : null].filter(Boolean).join(' · ')
}
// ── end F-MS-104 ──

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
  // F-CW-102 (the API's B-CW-015; lead settle S13): the order page's own base — "Sewn 152 of 244" of the pieces ORDERED (fees left
  // out), so the row and the page say the same; an older answer without `ordered` keeps "of the pieces in work".
  if (progress.ordered !== undefined) return { key: 'where.sewnOf', params: { sewn: progress.sewn, ordered: progress.ordered } }
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

// ── F-SA-280 (sales page plan N5, picks P10, P18; 11-customer-page §3.8): bulk on the sheet's own bar — one customer only ──
/**
 * Why the selection's windows are held before any opens (a phrase of this catalogue), or null: the orders of ONE customer only (on
 * the customer page the lock always holds; on Sales › Orders it says how many customers the ticks span). The server checks each
 * record again. Export N is a file of the list, not a window: it is never held here.
 */
export function oneCustomerHeld(rows: readonly Pick<OrderRow, 'partyId'>[], locked: string | null): Phrase | null {
  if (rows.length === 0) return null
  if (locked && rows.some((row) => row.partyId !== locked)) return { key: 'bulk.notThisCustomer' }
  const customers = new Set(rows.map((row) => row.partyId)).size
  return customers > 1 ? { key: 'bulk.oneCustomer', params: { count: customers } } : null
}

/** The orders Assign supervisor… sets (production's one dialog: its pick lists per customer and company). */
export const supervisorTargetsOf = (rows: readonly Pick<OrderRow, 'id' | 'number' | 'customerRef' | 'partyId' | 'partyName' | 'companyId'>[]) =>
  rows.map((row) => ({ orderId: row.id, number: row.number, customerRef: row.customerRef, partyId: row.partyId, partyName: row.partyName, companyId: row.companyId }))

/** The records Note to N… writes on: each order's own thread (no work order here: the dialog asks nothing about them). */
export const noteTargetsOf = (rows: readonly Pick<OrderRow, 'id' | 'number' | 'partyId' | 'partyName' | 'companyId'>[]) => ({
  workOrders: [] as const,
  salesOrders: rows.map((row) => ({ type: 'SalesOrder' as const, id: row.id, label: row.number, partyId: row.partyId, partyName: row.partyName, companyId: row.companyId })),
  withoutOrder: 0,
})
// ── end F-SA-280 ──

// ── F-CW-101 (customer Work tab; lead settles S2, S3, S17; 10-design §2): the phase's words — ONE word for one thing ──
// pg-w1: the rule lives with the groups of both faces (lib/order-groups/groups.ts); the sheet's importers keep this name.
export { phasePhrase } from '../../../../../lib/order-groups/groups'
// ── end F-CW-101 ──

// ── F-CW-102 (customer Work tab plan §1; 10-design §3.5; lead settles S3, S6, S13, S15, S31, S38; the API's B-CW-010…015, 020) ──
// The row's chips — the shared sheet's cells (the customer's Work tab, Sales › Orders, Sales › Made to measure draw the SAME cell):
// Where it is = chip 1 the stage (the order's real status word where no stage is "now"), chip 2 the health (only Late / At risk),
// chip 3 the ONE thing that stops it or who it waits on; under them this order's own pieces. Customer urgency = the customer's own
// mark as its chip says it, read-only, with our Priority beside it when it is not Normal. Pure: the tests hold them without a DOM.

/**
 * Chip 1 — where the order is. In production: its stage (the floor's, or the one set by hand, with its mark), "Preparing" while no
 * stage is kept yet (S38); Ready: "Ready to ship"; every other state the order's real status word (S3: the pill keeps the status) —
 * Partly shipped with its pieces ("Partly shipped · 40 of 114"). `phase`: the group it counts in (the domain's orderPhaseOf: its
 * mark). null: the production part was not read (nothing is guessed).
 */
export type StageChip =
  | { readonly kind: 'stage'; readonly stage: BrandStage; readonly phase: OrderPhase; readonly byHand?: { readonly old: boolean } }
  | { readonly kind: 'status'; readonly status: OrderStatus; readonly phase: OrderPhase; readonly shipped?: { readonly shipped: number; readonly units: number } }

export function stageChipOf(row: Pick<OrderRow, 'status' | 'production' | 'units' | 'shippedUnits'>, today: BusinessDate = businessDate(new Date())): StageChip | null {
  const production = row.production
  if (!production) return null
  const phase = orderPhaseOf(row.status, production.stage)
  if (row.status === 'IN_PRODUCTION') {
    const hand = production.stage !== null ? production.stageByHand : null
    return { kind: 'stage', stage: production.stage ?? 'PREPARING', phase, ...(hand ? { byHand: { old: handSetOld(hand.since, today) } } : {}) }
  }
  if (row.status === 'READY') return { kind: 'stage', stage: 'READY', phase }
  if (row.status === 'PARTLY_SHIPPED') return { kind: 'status', status: row.status, phase, shipped: { shipped: row.shippedUnits, units: row.units } }
  return { kind: 'status', status: row.status, phase }
}

/** Chip 2 — the health, only when something is wrong: Late or At risk. Never "On track", never "No date yet" (a quiet row is fine). */
export function healthChipOf(row: Pick<OrderRow, 'production'>): 'LATE' | 'AT_RISK' | null {
  const health = row.production?.health ?? null
  return health === 'LATE' || health === 'AT_RISK' ? health : null
}

/**
 * Chip 3 — the ONE thing that stops the order or who it waits on, the first that applies: credit · the factory review · a deposit
 * open (the gate's, or an EXTRA one on an order that needs none; overdue once its day passed) · the customer's new yes · on hold ·
 * a request to answer · a reply that waits on us · waiting on the customer, a supplier or a workshop. "Waiting on us" alone is no
 * chip (it would be on nearly every row); a plain wait for a yes is chip 1's own word. After production nothing is "now": only a
 * request still to answer stays (it does wait on us).
 */
export type StopChip =
  | { readonly kind: 'credit' }
  | { readonly kind: 'review' }
  | { readonly kind: 'deposit'; readonly due: string | null; readonly overdue: boolean; readonly extra: boolean }
  | { readonly kind: 'reaccept' }
  | { readonly kind: 'held' }
  | { readonly kind: 'request'; readonly count: number; readonly requestId: string | null }
  | { readonly kind: 'reply'; readonly since: string }
  | { readonly kind: 'keeper'; readonly on: Exclude<WaitingOn, 'US'>; readonly since: string | null }

// cw fx5 (walk W-29; F-CP-107 "the same fact never twice in one row"): `waitingShown` — the Waiting on column is on screen. It says
// the request to answer, the reply that waits and who acts next: chip 3 then leaves those three to it (what stops the order for
// another reason — credit, measurements, a deposit, a new yes, a hold — stays chip 3).
export function stopChipOf(row: Pick<OrderRow, 'status' | 'waits' | 'deposit' | 'reaccept' | 'production'>, mark: WaitingMark | null | undefined, today: string, waitingShown = false): StopChip | null {
  const waiting: readonly WaitingItem[] = waitingShown ? [] : waitingItemsOf(row, mark)
  const request = waiting.find((item): item is Extract<WaitingItem, { kind: 'request' }> => item.kind === 'request')
  const asked: StopChip | null = request ? { kind: 'request', count: request.count, requestId: request.requestId } : null
  if (isAfterProduction(officeStripStateOf(row.status))) return asked
  if (row.waits?.includes('CREDIT_HOLD')) return { kind: 'credit' }
  if (row.waits?.includes('MEASUREMENTS')) return { kind: 'review' }
  if (row.deposit.state === 'OPEN') return { kind: 'deposit', due: row.deposit.dueDate, overdue: row.deposit.dueDate !== null && row.deposit.dueDate < today, extra: false }
  const extra = row.deposit.extraOpenDue ?? null
  if (extra) return { kind: 'deposit', due: extra, overdue: extra < today, extra: true }
  if (row.reaccept) return { kind: 'reaccept' }
  if (row.production?.held) return { kind: 'held' }
  if (asked) return asked
  const reply = waiting.find((item): item is Extract<WaitingItem, { kind: 'reply' }> => item.kind === 'reply')
  if (reply) return { kind: 'reply', since: reply.since }
  if (waitingShown) return null
  const on = row.production?.waitingOn ?? null
  return on && on !== 'US' ? { kind: 'keeper', on, since: row.production?.since ?? null } : null
}

/**
 * Line 2 — this order's own pieces, in parts (joined by " · "): while it is being made "Sewn 152 of 244" and, when some are, "24
 * ready now" (strong); "Not in work yet" before any work order; a partly shipped order starts with its open lines' stage (S38);
 * once it left: "64 of 64 shipped"; cancelled with nothing gone: "Nothing shipped". No "cut" (S13). None: not read yet.
 */
export type PiecesPart =
  | { readonly kind: 'stage'; readonly stage: BrandStage; readonly byHand?: { readonly old: boolean } }
  | { readonly kind: 'words'; readonly words: Phrase & { readonly production?: true; readonly orders?: true }; readonly strong?: boolean }

export function piecesPartsOf(row: Pick<OrderRow, 'status' | 'progress' | 'production' | 'units' | 'shippedUnits'>, today: BusinessDate = businessDate(new Date())): PiecesPart[] {
  if (isAfterProduction(officeStripStateOf(row.status))) {
    if (row.status === 'CANCELLED' && row.shippedUnits <= 0) return [{ kind: 'words', words: { key: 'where.nothingShipped' } }]
    return [{ kind: 'words', words: { key: 'list.shipped', params: { shipped: row.shippedUnits, units: row.units }, orders: true } }]
  }
  const parts: PiecesPart[] = []
  const production = row.production
  if (row.status === 'PARTLY_SHIPPED' && production?.stage) {
    const hand = production.stageByHand
    parts.push({ kind: 'stage', stage: production.stage, ...(hand ? { byHand: { old: handSetOld(hand.since, today) } } : {}) })
  }
  const made = piecesLineOf(row)
  if (made) parts.push({ kind: 'words', words: made })
  const ready = production?.readyNow ?? 0
  if (ready > 0) parts.push({ kind: 'words', words: { key: 'where.readyNow', params: { count: ready } }, strong: true })
  return parts
}

/**
 * The customer's own urgency as its chip says it (S6, S7; read-only here): Urgent with its place in the customer's OWN urgent list
 * ("Urgent 2": never a place in our plan), "Urgent – asked" (its request waits on us), "Set to regular by us" (with a lock when we
 * locked it); Regular, or none that counts (the order left production, the customer's switch is off): nothing. An older answer
 * without the state: "Urgent" / nothing from the old mark — no place, no "asked", no lock.
 */
export type UrgencyChip =
  | { readonly state: 'URGENT'; readonly rank: number | null }
  | { readonly state: 'ASKED'; readonly requestId: string | null }
  | { readonly state: 'SET_BACK'; readonly locked: boolean }

export function urgencyChipOf(row: Pick<OrderRow, 'customerUrgency' | 'customerUrgencyState'>): UrgencyChip | null {
  const state = row.customerUrgencyState
  if (state === undefined) return row.customerUrgency === 'URGENT' ? { state: 'URGENT', rank: null } : null
  if (state === null) return null
  if (state.state === 'URGENT') return { state: 'URGENT', rank: state.urgentRank }
  if (state.state === 'ASKED') return { state: 'ASKED', requestId: state.requestId }
  if (state.state === 'SET_BACK') return { state: 'SET_BACK', locked: state.locked }
  return null
}

/**
 * OUR priority beside the customer's chip (S31: "Priority: Top", never a bare "Top" under the header "Customer urgency"): only when
 * it is not Normal and the order is still ours to make (nothing after production). The customer never sees it.
 */
export function priorityChipOf(row: Pick<OrderRow, 'priority' | 'status'>): 'LOW' | 'HIGH' | 'URGENT' | null {
  const level = row.priority?.level
  if (!level || level === 'NORMAL' || isAfterProduction(officeStripStateOf(row.status))) return null
  return level
}
// ── end F-CW-102 ──
