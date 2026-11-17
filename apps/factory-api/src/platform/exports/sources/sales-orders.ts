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
    const kept = { ...narrowing(address) /* B-TH-008 */, ...orderTerms(address) /* B-TH-057 */, ...doorTerms(address) /* B-TH-058 / B-TH-059 */ }
    if (address.get('late') === 'true') return { ...kept, late: 'true', q }
    if (address.get('deposit') === 'OPEN') return { ...kept, deposit: 'OPEN', q }
    if (address.get('reaccept') === 'true') return { ...kept, reaccept: 'true', q } // B-TH-008: Waiting for the customer
    if (isStatus(status)) return { ...kept, status, q }
    if (address.get('rows') === 'all') return { ...kept, q }
    return { ...kept, open: 'true', q }
  },
  async read(caller, query, cursor, limit) {
    // B-TH-059: the file counts the progress (its Progress column).
    const page = await listOrders(caller, { ...query, cursor: cursor ?? undefined, limit, progress: 'true' })
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
    deposit: { value: (row, words) => words(`deposit.${row.deposit.state}`) },
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
    customerUrgency: { value: (row, words) => (row.customerUrgency ? words(`urgency.${row.customerUrgency}`) : null) },
    // ── end B-TH-059 ──
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
      // ── B-TH-018 ──
      'invoiced.NONE': 'Nessuno',
      'invoiced.PART': 'In parte',
      'invoiced.ALL': 'Tutto',
      'brand.own': 'Collezione propria',
      'brand.hidden': 'Etichetta non visibile',
      ...priorityWords('it'),
      // ── B-TH-059 ──
      'progress.text': 'Tagliati {cut} · Cuciti {sewn} · Finiti {finished} su {inWork}',
      'atRisk.text': 'A rischio (mancano {days} giorni)',
      'urgency.URGENT': 'Urgente',
      'urgency.REGULAR': 'Regolare',
    },
    en: {
      'status.PENDING_APPROVAL': 'Waiting for approval', // B-TH-008
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
      // ── B-TH-018 ──
      'invoiced.NONE': 'None',
      'invoiced.PART': 'Part',
      'invoiced.ALL': 'All',
      'brand.own': 'Own collection',
      'brand.hidden': 'Label not shown',
      ...priorityWords('en'),
      // ── B-TH-059 ──
      'progress.text': 'Cut {cut} · Sewn {sewn} · Finished {finished} of {inWork}',
      'atRisk.text': 'At risk ({days} days left)',
      'urgency.URGENT': 'Urgent',
      'urgency.REGULAR': 'Regular',
    },
  },
})
