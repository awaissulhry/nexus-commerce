import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { isBusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_ORDER_STATUSES, type SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { PRIORITY_WORDS, SALES_ORDER_PRIORITY_LEVELS } from '@nexus/factory-domain/sales/orders-depth/rules' // B-TH-018
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { ExportLocale } from '@nexus/factory-domain/views/exports'
import type { Prisma } from '@nexus/factory-db'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../../../modules/sales/orders/access'
import { listOrders, type ListFilters, type ListQuery } from '../../../modules/sales/orders/orders'
import { isOrderSort } from '../../../modules/sales/orders/sort' // B-TH-057
import { ordersDepth } from '../../../modules/sales/orders-depth/depth' // B-TH-018
// B-TH-058 / B-TH-059: the overall view's door terms and the later columns.
import { INVOICED_STATES, type InvoicedState } from '@nexus/factory-domain/sales/orders/invoiced'
import { CUSTOMER_URGENCIES, type CustomerUrgency } from '../../../modules/sales/orders/customer-urgency'
import { defineExportSource } from '../source'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions' // B-SA-020
import { holds } from '@nexus/factory-domain/core/permissions' // B-SA-021
import { RIDER_TERM_REFUSAL } from '../../../modules/sales/orders/orders' // B-SA-021
// B-SA-070: the production columns (Where it is, Waiting on, Supervisor) and the `waiting=us` term.
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { HEALTH_WORDS, OFFICE_WAITING_WORDS, STAGE_WORDS } from '@nexus/factory-domain/production-brand/words'
import { STAGE_BY_HAND_WORDS } from '@nexus/factory-domain/production-brand/stage-set' // B-MS-006
import { BRAND_HEALTHS } from '@nexus/factory-domain/production-brand/health'
import { BRAND_STAGES } from '@nexus/factory-domain/production-brand/stages'
import { ORDER_PHASES, type OrderPhase } from '@nexus/factory-domain/production-brand/stages' // B-CW-002
import { CUSTOMER_URGENCY_STATES, customerUrgencyStateWords } from '@nexus/factory-domain/production-brand/urgency-state' // B-CW-022
import { WAITING_ON } from '@nexus/factory-domain/production-brand/waiting'
// B-CP-018: the price check's term and columns (the price grain only).
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { PRICE_MATCHES, type PriceMatch } from '@nexus/factory-domain/sales/brand-prices/match'
import { PRICE_CHECK_EXPORT_WORDS, priceCheckExport } from '../../../modules/sales/brand-prices/columns'
import { NOT_A_PRICE_HOLDER } from '../../../modules/sales/brand-prices/store'

/**
 * Sales › Orders (SCR-038, `/sales/orders`): the export of the list as the screen shows it. The address is the list's
 * own (apps/factory-web areas/sales/orders model.ts listAddress): `?late=true`, `?deposit=OPEN`, `?reaccept=true`,
 * `?status=…`, `?rows=all` (every order), `?q=`; nothing: the open orders. Read through the module's listOrders
 * (orders.view, its companies and customers). The net amount is the price grain: absent from the file without it.
 *
 * B-TH-008 (WALL-G01, SHEET-G14; screen = file): the address's customer (`?party=`, or the API's own `partyId`), company
 * (`?company=` / `companyId`), promise range (`promiseFrom`, `promiseTo`) and `?reaccept=true` (Waiting for the customer)
 * narrow the file as they narrow the screen; a malformed one is refused, never dropped (a file of every customer for a
 * customer's sheet). The file and its Excel tab are named after the saved view, else "Orders - <customer>" for a
 * customer's sheet, with the rows they hold; a customer the person may not see is never named.
 *
 * B-TH-018 (ORD-G01, N22; threads plan TH-1a, picture 23): the file writes what the sheet shows — Picture (the first line's
 * style, "+N" more styles), the customer PO, the company, Brand (the label on the garment: its name, our own collection, or
 * "label not shown" for a label the person may not see), Invoiced (None / Part / All) and its amount (price grain), the
 * requested date, the gross (price grain), the days late, the priority and the season; `?brand=<party>|own` narrows the file
 * as it narrows the screen (malformed: refused). Priority, season and the company's name are read per page beside the list
 * (the list's own W2b read, GET /sales/orders/depth's ordersDepth; one query of the companies). The Margin % column stays out
 * of the file: its read (costing/margins) computes every order in scope, not a page.
 *
 * B-TH-057 (SHEET-G05, SHEET-G15, ORD-G07; threads plan TH-4): the file keeps the screen's order and rows — `?sort=` (customer,
 * brand, promise, daysLate, ordered; `-` the other way round) and `?cf=` (the custom field filter) are the list's own terms,
 * read by listOrders as the screen reads them (a sort it does not know is refused), and `?q=` searches what the screen searches.
 *
 * B-TH-058 / B-TH-059 (threads plan TH-4; N23, ORD-G08, SHEET-G08): the overall view's door terms narrow the file as they
 * narrow the screen — `?invoiced=NONE|PART|ALL`, `?atRisk=true`, `?customerUrgency=URGENT|REGULAR`, `?currency=EUR` (malformed:
 * refused) — and the file writes the later columns by the web's ids: `openUnits`, `progress` ("Cut 12 · Sewn 8 · Finished 4 of
 * 40": the list counts it for the file), `paid` and `balance` (price grain), `site`, `note` (the office's order note),
 * `priority` (now the row's own, the office's level), `atRisk` and `customerUrgency` (read-only, the customer's own mark).
 *
 * B-SA-020 (sales page plan N7, pick P12; 17-review F-4: screen = file = count): `?kind=mtm` (made-to-measure orders) narrows the
 * file as it narrows the screen (another value: refused in words), and the file writes `madeToMeasure` (the units still owed; 0 is
 * an answer for an order without one) and `riders` (the riders' names, "+N" for the rest) — a column only for a person holding
 * sales.measurements.view (the column's own right: left out and named above the header otherwise, never an empty column).
 *
 * B-SA-021: `?profile=<id>` (a rider's orders, any revision of the rider's garment profile) narrows the file as the screen; a
 * malformed one is refused, and a person without sales.measurements.view is refused the file in the list's own words ("You may not
 * narrow orders by rider."), before anything is read.
 *
 * B-SA-070 (sales page plan R5; 17-review F-4: screen = file): `?waiting=us` (the customer's Work tab's "Waiting on us") narrows the
 * file as it narrows the screen (another value: refused in words), and the file writes the production columns by the web's ids —
 * `whereItIs` (the plain stage and the shown health: "Sewing · At risk"), `waitingOn` (who it waits on), `held` and `supervisor` (Me /
 * Someone else / Not set, never a name: a column only for a person holding workorders.view, empty for an order the person's
 * workorders.view does not reach).
 *
 * B-CP-018 (customer page plan C2d; screen = file): `?priceMatch=NOT_EQUAL|NO_BRAND_PRICE|EQUAL` narrows the file as it narrows the
 * screen (another value: refused in words; a person without the price grain is refused the file in the list's own words), and the
 * file writes `ourPrice`, `brandPrice`, `priceMatch` and `priceDiff` (modules/sales/brand-prices columns.ts), each of the price grain.
 *
 * B-CW-002 (customer Work tab plan §1; screen = file = count): `?phase=NOT_SENT|NOT_STARTED|IN_PRODUCTION|READY|SHIPPED|DONE|CANCELLED`
 * (a door of the customer's big picture; the screen writes it with `rows=all`) narrows the file as it narrows the screen; another
 * value is refused in words.
 *
 * B-CW-022 (customer Work tab plan §2.8: the file says what the row says): `customerUrgency` writes the row's state of four with
 * its place, in the Work orders file's own words ("Urgent (customer) 2", "Urgent – asked", "Regular", "Set to Regular by us");
 * `deposit` writes the order page's words for an extra deposit still open on an order that needs none ("Not needed · an extra
 * deposit is open, due 2026-12-02": a day, never an amount); `whereItIs`, `waitingOn` and `held` are empty for an order whose stage
 * is not current (B-CW-020: the list's own rule; the Status column says where it is). No `phase` column: Status and Where it is
 * say it.
 */

// B-TH-018: a list row with what the sheet reads beside it (priority and season, the company's name).
type ListRow = Awaited<ReturnType<typeof listOrders>>['orders'][number]
type Row = ListRow & { readonly beside: { readonly season: string | null; readonly company: string | null } } // B-TH-059: priority is the row's own
type Query = Omit<ListQuery, 'cursor' | 'limit'>

const isStatus = (value: string | null): value is SalesOrderStatus => value !== null && (SALES_ORDER_STATUSES as readonly string[]).includes(value)

// ── B-TH-008 ──
/** An id term of the address (its web name, else the API's), or undefined; a malformed one is refused. */
function idTerm(address: URLSearchParams, names: readonly [string, string], what: string): string | undefined {
  for (const name of names) {
    const value = address.get(name)?.trim()
    if (!value) continue
    if (!isUuid(value)) throw new ValidationError(`Not a ${what}: the file would hold more than the screen.`, [{ path: `query/${name}`, message: 'An id.' }])
    return value
  }
  return undefined
}

/** A day term of the address (YYYY-MM-DD), or undefined; a malformed one is refused. */
function dayTerm(address: URLSearchParams, name: string): string | undefined {
  const value = address.get(name)?.trim()
  if (!value) return undefined
  if (!isBusinessDate(value)) throw new ValidationError('Not a day: the file would hold more than the screen.', [{ path: `query/${name}`, message: 'A day (YYYY-MM-DD).' }])
  return value
}

/** The terms every rows view keeps: the customer, the company, the promise range, the brand (the list's own filters). */
function narrowing(address: URLSearchParams): Pick<ListFilters, 'partyId' | 'companyId' | 'promiseFrom' | 'promiseTo' | 'brand'> {
  const brand = brandTerm(address) // B-TH-018
  const partyId = idTerm(address, ['party', 'partyId'], 'customer')
  const companyId = idTerm(address, ['company', 'companyId'], 'company')
  const promiseFrom = dayTerm(address, 'promiseFrom')
  const promiseTo = dayTerm(address, 'promiseTo')
  if (promiseFrom && promiseTo && promiseFrom > promiseTo) throw new ValidationError('The promise range ends before it starts.', [{ path: 'query/promiseTo', message: 'On or after promiseFrom.' }])
  return { ...(partyId ? { partyId } : {}), ...(companyId ? { companyId } : {}), ...(promiseFrom ? { promiseFrom } : {}), ...(promiseTo ? { promiseTo } : {}), ...(brand ? { brand } : {}) }
}

// ── B-TH-018 ──
/** The brand term of the address (the label on the garment): a party id or `own`; a malformed one is refused. */
function brandTerm(address: URLSearchParams): string | undefined {
  const value = address.get('brand')?.trim()
  if (!value) return undefined
  if (value === 'own') return value
  if (!isUuid(value)) throw new ValidationError('Not a brand: the file would hold more than the screen.', [{ path: 'query/brand', message: 'A party id or own.' }])
  return value
}

/** What the sheet reads beside a page of the list: each order's priority and season (ordersDepth), its company's name (as the office's company switcher names it). */
async function besides(caller: Parameters<typeof listOrders>[0], rows: readonly ListRow[]): Promise<Row[]> {
  if (rows.length === 0) return []
  const depth = new Map((await ordersDepth(caller, { orderIds: rows.map((row) => row.id).join(',') })).orders.map((entry) => [entry.orderId, entry]))
  const companyIds = [...new Set(rows.map((row) => row.companyId))]
  const companies = new Map((await caller.withClient((client) => client.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, legalName: true, tradeName: true } }))).map((company) => [company.id, company.tradeName ?? company.legalName]))
  return rows.map((row) => {
    const found = depth.get(row.id)
    return { ...row, beside: { season: found?.season?.code || null, company: companies.get(row.companyId) ?? null } }
  })
}

/** The Brand cell: each label's name, our own collection or "label not shown", in the sheet's order. */
function brandText(row: Row, words: (code: string) => string): string | null {
  if (row.brands.length === 0) return null
  return row.brands.map((brand) => (brand.own ? words('brand.own') : (brand.name ?? words('brand.hidden')))).join(', ')
}

/** The Picture cell in a file: the first line's style ("CODE Name") and how many styles more ("(+2)"). */
function pictureText(row: Row): string | null {
  if (!row.picture) return null
  const more = row.styleCount > 1 ? ` (+${row.styleCount - 1})` : ''
  return `${row.picture.styleCode} ${row.picture.styleName}${more}`
}

const priorityWords = (locale: ExportLocale): Record<string, string> => Object.fromEntries(SALES_ORDER_PRIORITY_LEVELS.map((level) => [`priority.${level}`, PRIORITY_WORDS[level][locale]]))
// ── end B-TH-018 ──

const NAMES: Readonly<Record<ExportLocale, { orders: string; rows: (count: number) => string }>> = {
  it: { orders: 'Ordini', rows: (count) => (count === 1 ? '1 ordine' : `${count} ordini`) },
  en: { orders: 'Orders', rows: (count) => (count === 1 ? '1 order' : `${count} orders`) },
}
// ── end B-TH-008 ──

// ── B-TH-057 (SHEET-G05, SHEET-G15: screen = file) ──
/** The address's server sort and custom field filter, as the list reads them; a sort the list does not know is refused. */
function orderTerms(address: URLSearchParams): Pick<ListQuery, 'sort' | 'cf'> {
  const sort = address.get('sort')?.trim() || undefined
  if (sort !== undefined && !isOrderSort(sort)) throw new ValidationError('Not a sort of the orders: the file would not follow the screen.', [{ path: 'query/sort', message: 'customer, brand, promise, daysLate or ordered (- in front: the other way round).' }])
  const cf = address.get('cf')?.trim() || undefined
  return { ...(sort ? { sort } : {}), ...(cf ? { cf } : {}) }
}
// ── end B-TH-057 ──

// ── B-TH-058 / B-TH-059 ──
/** One of a term's values, or undefined; another value is refused (the file would not hold the screen's rows). */
function oneOf<T extends string>(address: URLSearchParams, name: string, values: readonly T[]): T | undefined {
  const value = address.get(name)?.trim()
  if (!value) return undefined
  if (!(values as readonly string[]).includes(value)) throw new ValidationError(`Not a value of ${name}: the file would not follow the screen.`, [{ path: `query/${name}`, message: values.join(', ') }])
  return value as T
}

/** The overall view's door terms of the address, as the list reads them. */
function doorTerms(address: URLSearchParams): Pick<ListFilters, 'invoiced' | 'atRisk' | 'customerUrgency' | 'currency' | 'shippedNotInvoiced'> {
  const invoiced = oneOf<InvoicedState>(address, 'invoiced', INVOICED_STATES)
  const atRisk = oneOf(address, 'atRisk', ['true', 'false'] as const)
  const customerUrgency = oneOf<CustomerUrgency>(address, 'customerUrgency', CUSTOMER_URGENCIES)
  const currency = address.get('currency')?.trim() || undefined
  if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) throw new ValidationError('Not a currency: the file would not follow the screen.', [{ path: 'query/currency', message: 'Three capital letters (ISO 4217).' }])
  // B-TH-244: the built-in view "Shipped, not invoiced" (screen = file).
  const shippedNotInvoiced = oneOf(address, 'shippedNotInvoiced', ['true', 'false'] as const)
  return { ...(invoiced ? { invoiced } : {}), ...(atRisk ? { atRisk } : {}), ...(customerUrgency ? { customerUrgency } : {}), ...(currency ? { currency } : {}), ...(shippedNotInvoiced ? { shippedNotInvoiced } : {}) }
}

// ── B-SA-020 ──
/** The made-to-measure term of the address (`kind=mtm`), or undefined; another value is refused (a file of every order otherwise). */
function kindTerm(address: URLSearchParams): Pick<ListFilters, 'kind'> {
  const value = address.get('kind')?.trim()
  if (!value) return {}
  if (value !== 'mtm') throw new ValidationError('Not a kind: the file would hold more than the screen.', [{ path: 'query/kind', message: 'mtm' }])
  return { kind: value }
}

/** The Riders cell: the names the row names, and how many riders more ("Rider A, Rider B (+3)"); none: empty. */
function ridersText(row: Row): string | null {
  const riders = row.madeToMeasure?.riders
  if (!riders || riders.names.length === 0) return null
  const more = riders.count > riders.names.length ? ` (+${riders.count - riders.names.length})` : ''
  return `${riders.names.join(', ')}${more}`
}
// ── end B-SA-020 ──

// ── B-SA-070 ──
/** The `waiting=us` term of the address, or undefined; another value is refused (a file of every order otherwise). */
function waitingTerm(address: URLSearchParams): Pick<ListFilters, 'waiting'> {
  const value = address.get('waiting')?.trim()
  if (!value) return {}
  if (value !== 'us') throw new ValidationError('Not a waiting term: the file would hold more than the screen.', [{ path: 'query/waiting', message: 'us' }])
  return { waiting: value }
}

// ── B-CP-018 (customer page plan C2d; screen = file) ──
/** The `priceMatch` term of the address, or nothing; another value is refused (the file would not follow the screen). */
function priceMatchTerm(address: URLSearchParams): Pick<ListFilters, 'priceMatch'> {
  const value = oneOf<PriceMatch>(address, 'priceMatch', PRICE_MATCHES)
  return value ? { priceMatch: value } : {}
}
// ── end B-CP-018 ──

// ── B-CW-002 (customer Work tab plan §1; screen = file) ──
/** The `phase` term of the address, or nothing; another value is refused (the file would not follow the screen), never dropped. */
function phaseTerm(address: URLSearchParams): Pick<ListFilters, 'phase'> {
  const value = oneOf<OrderPhase>(address, 'phase', ORDER_PHASES)
  return value ? { phase: value } : {}
}
// ── end B-CW-002 ──

// ── B-CW-022 (customer Work tab plan §2.8): the file says what the row says ──
/**
 * The Customer urgency cell: the row's state with its place in the customer's own Urgent list ("Urgent (customer) 2"), as the Work
 * orders file writes it; a row with a mark and no state (a reader without states) writes the mark's word; none: empty. Exported
 * for its unit test.
 */
export function urgencyText(row: Pick<Row, 'customerUrgency' | 'customerUrgencyState'>, words: (code: string) => string): string | null {
  const state = row.customerUrgencyState
  if (state) return `${words(`urgency.${state.state}`)}${state.state === 'URGENT' && state.urgentRank !== null ? ` ${state.urgentRank}` : ''}`
  return row.customerUrgency ? words(`urgency.${row.customerUrgency}`) : null
}

/** The Deposit cell: the state's word, or the order page's words for an extra deposit still open with its due day. Exported for its unit test. */
export function depositText(row: Pick<Row, 'deposit'>, words: (code: string) => string): string {
  return row.deposit.extraOpenDue ? words('deposit.extraOpen').replace('{date}', row.deposit.extraOpenDue) : words(`deposit.${row.deposit.state}`)
}

/** Each Customer urgency state's words of the file's locale (factory-domain urgency-state: the Work orders file's own). */
export const urgencyWords = (locale: ExportLocale): Record<string, string> =>
  Object.fromEntries(CUSTOMER_URGENCY_STATES.map((state) => [`urgency.${state}`, customerUrgencyStateWords({ state, urgentRank: null })[locale]]))
// ── end B-CW-022 ──

/**
 * The Where it is cell: the plain stage and the shown health ("Sewing · At risk"); nothing kept yet: empty. B-MS-006 (R17): a stage
 * set by hand reads "Sewing (by hand) · At risk" (the office's file only; exported for its unit test).
 */
export function whereText(row: Pick<Row, 'production'>, words: (code: string) => string): string | null {
  const production = row.production
  if (!production || (production.stage === null && production.health === null)) return null
  const stage = production.stage ? `${words(`stage.${production.stage}`)}${production.stageByHand ? ` ${words('stage.byHand')}` : ''}` : null
  return [stage, production.health ? words(`health.${production.health}`) : null].filter((part) => part !== null).join(' · ')
}

/** The production columns' words of the file's locale (exported for its unit test). */
export const productionWords = (locale: ExportLocale): Record<string, string> => ({
  'stage.byHand': STAGE_BY_HAND_WORDS[locale], // B-MS-006
  ...Object.fromEntries(BRAND_STAGES.map((stage) => [`stage.${stage}`, STAGE_WORDS[stage][locale]])),
  ...Object.fromEntries(BRAND_HEALTHS.map((health) => [`health.${health}`, HEALTH_WORDS[health][locale]])),
  ...Object.fromEntries(WAITING_ON.map((on) => [`waitingOn.${on}`, OFFICE_WAITING_WORDS[on][locale]])),
})
// ── end B-SA-070 ──

/** The Progress cell: cut, sewn and finished of the pieces in work orders ("—" for a step nothing counts); none yet: empty. */
function progressText(row: Row, words: (code: string) => string): string | null {
  const progress = row.progress
  if (!progress) return null
  const figure = (value: number | null) => (value === null ? '—' : String(value))
  return words('progress.text').replace('{cut}', figure(progress.cut)).replace('{sewn}', figure(progress.sewn)).replace('{finished}', figure(progress.finished)).replace('{inWork}', String(progress.inWork))
}
// ── end B-TH-058 / B-TH-059 ──

export const salesOrders = defineExportSource<Query, Row>({
  listKey: 'sales.orders',
  permission: ORDERS_VIEW,
  query(address) {
    const q = address.get('q')?.trim().slice(0, 100) || undefined
    const status = address.get('status')
    const profile = idTerm(address, ['profile', 'profileId'], 'rider') // B-SA-021
    const kept = { ...narrowing(address) /* B-TH-008 */, ...orderTerms(address) /* B-TH-057 */, ...doorTerms(address) /* B-TH-058 / B-TH-059 */, ...kindTerm(address) /* B-SA-020 */, ...(profile ? { profile } : {}) /* B-SA-021 */, ...waitingTerm(address) /* B-SA-070 */, ...priceMatchTerm(address) /* B-CP-018 */, ...phaseTerm(address) /* B-CW-002 */ }
    if (address.get('late') === 'true') return { ...kept, late: 'true', q }
    if (address.get('deposit') === 'OPEN') return { ...kept, deposit: 'OPEN', q }
    if (address.get('reaccept') === 'true') return { ...kept, reaccept: 'true', q } // B-TH-008: Waiting for the customer
    if (isStatus(status)) return { ...kept, status, q }
    if (address.get('rows') === 'all') return { ...kept, q }
    return { ...kept, open: 'true', q }
  },
  // B-SA-021: the rider term only for a reader of measurements (the list's own words; the read refuses it too).
  // B-CP-018: and the price check term only for a price holder (the list's own words; the read refuses it too).
  refusal: (actor, query) => (query.profile && !holds(actor, SALES_MEASUREMENTS_VIEW) ? RIDER_TERM_REFUSAL : null) ?? (query.priceMatch && !heldGrains(actor).has('price') ? NOT_A_PRICE_HOLDER : null),
  async read(caller, query, cursor, limit) {
    // B-TH-059: the file counts the progress (its Progress column).
    // B-SA-070: and the production columns.
    const page = await listOrders(caller, { ...query, cursor: cursor ?? undefined, limit, progress: 'true', production: 'true' })
    return { rows: await besides(caller, page.orders) /* B-TH-018 */, next: page.nextCursor }
  },
  // ── B-TH-008: the saved view's name, else "Orders - <customer>" for a customer's sheet; the rows it holds. ──
  async title(caller, query, facts) {
    const words = NAMES[facts.locale]
    const rows = words.rows(facts.rows)
    if (facts.viewName) return { name: facts.viewName, rows }
    if (!query.partyId) return null
    const partyId = query.partyId
    // Named only when the person's orders scope reaches the customer (a person limited to other customers reads none).
    const party = await caller.withClient((client) =>
      client.party.findFirst({ where: { AND: [scopeWhere(actorOf(officeContextOf(caller)), ORDERS_VIEW, { party: 'id' }) as Prisma.PartyWhereInput, { id: partyId }] }, select: { legalName: true } }),
    )
    return party ? { name: `${words.orders} - ${party.legalName}`, rows } : null
  },
  columns: {
    number: { value: (row) => row.number },
    customer: { value: (row) => row.partyName },
    status: { value: (row, words) => words(`status.${row.status}`) },
    deposit: { value: (row, words) => depositText(row, words) }, // B-CW-022: + an extra deposit still open
    units: { value: (row) => row.units },
    orderDate: { value: (row) => ({ day: row.orderDate }) },
    promised: { value: (row) => (row.promiseDate ? { day: row.promiseDate } : null) },
    shipped: { value: (row) => row.shippedUnits },
    net: { grain: 'price', value: (row) => ({ minor: Number(row.netAmount), currency: row.currency }) },
    quote: { value: (row) => (row.quote ? `${row.quote.number} r${row.quote.revision}` : null) },
    // ── B-TH-018: the sheet's other columns ──
    picture: { value: (row) => pictureText(row) },
    customerRef: { value: (row) => row.customerRef },
    company: { value: (row) => row.beside.company },
    brand: { value: (row, words) => brandText(row, words) },
    invoiced: { value: (row, words) => words(`invoiced.${row.invoiced.state}`) },
    invoicedAmount: { grain: 'price', value: (row) => ({ minor: Number(row.invoiced.amount), currency: row.currency }) },
    requested: { value: (row) => (row.requestedDate ? { day: row.requestedDate } : null) },
    gross: { grain: 'price', value: (row) => ({ minor: Number(row.grossAmount), currency: row.currency }) },
    daysLate: { value: (row) => (row.daysLate !== null && row.daysLate > 0 ? row.daysLate : null) },
    priority: { value: (row, words) => words(`priority.${row.priority.level}`) }, // B-TH-059: the row's own
    season: { value: (row) => row.beside.season },
    // ── end B-TH-018 ──
    // ── B-TH-059: the later columns ──
    openUnits: { value: (row) => row.openUnits },
    progress: { value: (row, words) => progressText(row, words) },
    paid: { grain: 'price', value: (row) => ({ minor: Number(row.paid), currency: row.currency }) },
    balance: { grain: 'price', value: (row) => ({ minor: Number(row.balance), currency: row.currency }) },
    site: { value: (row) => (row.sites.length > 0 ? row.sites.map((site) => site.name).join(', ') : null) },
    note: { value: (row) => row.internalNote },
    atRisk: { value: (row, words) => (row.atRisk ? words('atRisk.text').replace('{days}', String(row.atRisk.daysLeft)) : null) },
    customerUrgency: { value: (row, words) => urgencyText(row, words) }, // B-CW-022: the state of four with its place
    // ── end B-TH-059 ──
    // ── B-SA-020: the made-to-measure units (0 is an answer) and the riders (only with sales.measurements.view: else no column) ──
    madeToMeasure: { value: (row) => row.madeToMeasure?.units ?? 0 },
    riders: { permission: SALES_MEASUREMENTS_VIEW, value: (row) => ridersText(row) },
    // ── end B-SA-020 ──
    // ── B-SA-070: the production columns (the supervisor mark only with workorders.view: else no column) ──
    whereItIs: { value: (row, words) => whereText(row, words) },
    waitingOn: { value: (row, words) => (row.production?.waitingOn ? words(`waitingOn.${row.production.waitingOn}`) : null) },
    held: { value: (row, words) => (row.production?.held ? words('held.yes') : null) },
    supervisor: { permission: WORKORDERS_VIEW, value: (row, words) => (row.production?.supervisorMark ? words(`supervisor.${row.production.supervisorMark}`) : null) },
    // ── end B-SA-070 ──
    // ── B-CP-018: Our price, Customer's price, Price check, Difference (the price grain: left out and named for anyone else) ──
    ...priceCheckExport<Row>(),
    // ── end B-CP-018 ──
  },
  words: {
    it: {
      'status.PENDING_APPROVAL': 'In attesa di approvazione', // B-TH-008: every status has its words
      'status.CONFIRMED': 'Confermato',
      'status.IN_PRODUCTION': 'In produzione',
      'status.READY': 'Pronto',
      'status.PARTLY_SHIPPED': 'Spedito in parte',
      'status.SHIPPED': 'Spedito',
      'status.CLOSED': 'Chiuso',
      'status.CANCELLED': 'Annullato',
      'status.DELIVERED': 'Consegnato', // B-TH-008
      'deposit.NOT_NEEDED': 'Non serve',
      'deposit.MISSING': 'Non chiesto',
      'deposit.OPEN': 'Aperto',
      'deposit.PAID': 'Pagato',
      'deposit.WAIVED': 'Rinunciato',
      'deposit.extraOpen': 'Non serve · è aperto un acconto aggiuntivo, scade il {date}', // B-CW-022: orders.json notNeededExtraWords
      // ── B-TH-018 ──
      'invoiced.NONE': 'Nessuno',
      'invoiced.PART': 'In parte',
      'invoiced.ALL': 'Tutto',
      'brand.own': 'Collezione propria',
      'brand.hidden': 'Etichetta non visibile',
      ...priorityWords('it'),
      // ── B-TH-059 ──
      'progress.text': 'Tagliati {cut} · Cuciti {sewn} · Finiti {finished} su {inWork}',
      'atRisk.text': 'Vicino alla data promessa (mancano {days} giorni)', // F-SA-216: the list rule reads "Close to promise" (P15)
      ...urgencyWords('it'), // B-CW-022: Urgente (cliente) · Urgente – richiesto · Normale · Riportato a normale da noi
      // ── B-SA-070 ──
      ...productionWords('it'),
      'held.yes': 'In sospeso', // production-work-orders.json status.ON_HOLD
      'supervisor.ME': 'Io',
      'supervisor.SOMEONE_ELSE': "Un'altra persona",
      'supervisor.NOT_SET': 'Non impostato',
      ...PRICE_CHECK_EXPORT_WORDS.it, // B-CP-018
    },
    en: {
      'status.PENDING_APPROVAL': 'Waiting for a yes', // B-TH-008; Round 5 (R9): the catalogue's word, as the pill, the lane and the tile
      'status.CONFIRMED': 'Confirmed',
      'status.IN_PRODUCTION': 'In production',
      'status.READY': 'Ready',
      'status.PARTLY_SHIPPED': 'Partly shipped',
      'status.SHIPPED': 'Shipped',
      'status.CLOSED': 'Closed',
      'status.CANCELLED': 'Cancelled',
      'status.DELIVERED': 'Delivered', // B-TH-008
      'deposit.NOT_NEEDED': 'Not needed',
      'deposit.MISSING': 'Not asked',
      'deposit.OPEN': 'Open',
      'deposit.PAID': 'Paid',
      'deposit.WAIVED': 'Waived',
      'deposit.extraOpen': 'Not needed · an extra deposit is open, due {date}', // B-CW-022: orders.json notNeededExtraWords
      // ── B-TH-018 ──
      'invoiced.NONE': 'None',
      'invoiced.PART': 'Part',
      'invoiced.ALL': 'All',
      'brand.own': 'Own collection',
      'brand.hidden': 'Label not shown',
      ...priorityWords('en'),
      // ── B-TH-059 ──
      'progress.text': 'Cut {cut} · Sewn {sewn} · Finished {finished} of {inWork}',
      'atRisk.text': 'Close to promise ({days} days left)', // F-SA-216: "At risk / Late" is order health only (P15)
      ...urgencyWords('en'), // B-CW-022: Urgent (customer) · Urgent – asked · Regular · Set to Regular by us
      // ── B-SA-070 ──
      ...productionWords('en'),
      'held.yes': 'On hold',
      'supervisor.ME': 'Me',
      'supervisor.SOMEONE_ELSE': 'Someone else',
      'supervisor.NOT_SET': 'Not set',
      ...PRICE_CHECK_EXPORT_WORDS.en, // B-CP-018
    },
  },
})
