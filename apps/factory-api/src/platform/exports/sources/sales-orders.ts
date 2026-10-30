import { SALES_ORDER_STATUSES, type SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { listOrders, type ListQuery } from '../../../modules/sales/orders/orders'
import { defineExportSource } from '../source'

/**
 * Sales › Orders (SCR-038, `/sales/orders`): the export of the list as the screen shows it. The address is the list's
 * own (apps/factory-web areas/sales/orders model.ts listAddress): `?late=true`, `?deposit=OPEN`, `?status=…`,
 * `?rows=all` (every order), `?q=`; nothing: the open orders. Read through the module's listOrders (orders.view, its
 * companies and customers). The net amount is the price grain: absent from the file without it.
 */

type Row = Awaited<ReturnType<typeof listOrders>>['orders'][number]

const isStatus = (value: string | null): value is SalesOrderStatus => value !== null && (SALES_ORDER_STATUSES as readonly string[]).includes(value)

export const salesOrders = defineExportSource<Omit<ListQuery, 'cursor' | 'limit'>, Row>({
  listKey: 'sales.orders',
  permission: ORDERS_VIEW,
  query(address) {
    const q = address.get('q')?.trim().slice(0, 100) || undefined
    const status = address.get('status')
    if (address.get('late') === 'true') return { late: 'true', q }
    if (address.get('deposit') === 'OPEN') return { deposit: 'OPEN', q }
    if (isStatus(status)) return { status, q }
    if (address.get('rows') === 'all') return { q }
    return { open: 'true', q }
  },
  async read(caller, query, cursor, limit) {
    const page = await listOrders(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.orders, next: page.nextCursor }
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
      'status.CONFIRMED': 'Confermato',
      'status.IN_PRODUCTION': 'In produzione',
      'status.READY': 'Pronto',
      'status.PARTLY_SHIPPED': 'Spedito in parte',
      'status.SHIPPED': 'Spedito',
      'status.CLOSED': 'Chiuso',
      'status.CANCELLED': 'Annullato',
      'deposit.NOT_NEEDED': 'Non serve',
      'deposit.MISSING': 'Non chiesto',
      'deposit.OPEN': 'Aperto',
      'deposit.PAID': 'Pagato',
      'deposit.WAIVED': 'Rinunciato',
    },
    en: {
      'status.CONFIRMED': 'Confirmed',
      'status.IN_PRODUCTION': 'In production',
      'status.READY': 'Ready',
      'status.PARTLY_SHIPPED': 'Partly shipped',
      'status.SHIPPED': 'Shipped',
      'status.CLOSED': 'Closed',
      'status.CANCELLED': 'Cancelled',
      'deposit.NOT_NEEDED': 'Not needed',
      'deposit.MISSING': 'Not asked',
      'deposit.OPEN': 'Open',
      'deposit.PAID': 'Paid',
      'deposit.WAIVED': 'Waived',
    },
  },
})
