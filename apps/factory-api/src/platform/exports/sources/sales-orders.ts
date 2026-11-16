import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { isBusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_ORDER_STATUSES, type SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { ExportLocale } from '@nexus/factory-domain/views/exports'
import type { Prisma } from '@nexus/factory-db'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../../../modules/sales/orders/access'
import { listOrders, type ListFilters, type ListQuery } from '../../../modules/sales/orders/orders'
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
 */

type Row = Awaited<ReturnType<typeof listOrders>>['orders'][number]
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

/** The terms every rows view keeps: the customer, the company, the promise range (the list's own filters). */
function narrowing(address: URLSearchParams): Pick<ListFilters, 'partyId' | 'companyId' | 'promiseFrom' | 'promiseTo'> {
  const partyId = idTerm(address, ['party', 'partyId'], 'customer')
  const companyId = idTerm(address, ['company', 'companyId'], 'company')
  const promiseFrom = dayTerm(address, 'promiseFrom')
  const promiseTo = dayTerm(address, 'promiseTo')
  if (promiseFrom && promiseTo && promiseFrom > promiseTo) throw new ValidationError('The promise range ends before it starts.', [{ path: 'query/promiseTo', message: 'On or after promiseFrom.' }])
  return { ...(partyId ? { partyId } : {}), ...(companyId ? { companyId } : {}), ...(promiseFrom ? { promiseFrom } : {}), ...(promiseTo ? { promiseTo } : {}) }
}

const NAMES: Readonly<Record<ExportLocale, { orders: string; rows: (count: number) => string }>> = {
  it: { orders: 'Ordini', rows: (count) => (count === 1 ? '1 ordine' : `${count} ordini`) },
  en: { orders: 'Orders', rows: (count) => (count === 1 ? '1 order' : `${count} orders`) },
}
// ── end B-TH-008 ──

export const salesOrders = defineExportSource<Query, Row>({
  listKey: 'sales.orders',
  permission: ORDERS_VIEW,
  query(address) {
    const q = address.get('q')?.trim().slice(0, 100) || undefined
    const status = address.get('status')
    const kept = narrowing(address) // B-TH-008
    if (address.get('late') === 'true') return { ...kept, late: 'true', q }
    if (address.get('deposit') === 'OPEN') return { ...kept, deposit: 'OPEN', q }
    if (address.get('reaccept') === 'true') return { ...kept, reaccept: 'true', q } // B-TH-008: Waiting for the customer
    if (isStatus(status)) return { ...kept, status, q }
    if (address.get('rows') === 'all') return { ...kept, q }
    return { ...kept, open: 'true', q }
  },
  async read(caller, query, cursor, limit) {
    const page = await listOrders(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.orders, next: page.nextCursor }
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
    },
  },
})
