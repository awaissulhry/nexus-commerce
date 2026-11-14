import { isUuid } from '@nexus/factory-domain/core/ids'
import { isBusinessDate } from '@nexus/factory-domain/core/time'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { SHIPMENT_STATUSES, type ShipmentStatus } from '@nexus/factory-domain/shipping/shipments'
import { searchShipments, type SearchQuery, type SearchRow } from '../../../modules/shipping/queue/search'
import { defineExportSource } from '../source'

/**
 * Warehouse › Shipments, its SECOND list frame "Search and history" (B-W2b-386; LOG-120: "search by order, tracking
 * number, SSCC, customer PO or serial, and the history export"; the page's first list is `warehouse.shipments`,
 * ./shipments.ts): every shipment the search finds, any status, newest first. The address is the frame's: `?q=` (a shipment,
 * order or tracking number, the customer's PO or name, a carton's marks code or a serial), `?status=`, `?site=`,
 * `?from=` / `?to=` (the days it left, YYYY-MM-DD). Read through the module's own search (shipping.view, its companies,
 * sites and customers), a page at a time. No money.
 */

type Query = Omit<SearchQuery, 'cursor' | 'limit'>

const isStatus = (value: string | null): value is ShipmentStatus => value !== null && (SHIPMENT_STATUSES as readonly string[]).includes(value)
const dayOrUndefined = (value: string | null): string | undefined => (value && isBusinessDate(value) ? value : undefined)
const day = (iso: string | null) => (iso ? { at: iso } : null)

export const shipmentsHistory = defineExportSource<Query, SearchRow>({
  listKey: 'warehouse.shipments.2',
  page: '/warehouse/shipments',
  permission: SHIPPING_VIEW,
  query(address) {
    const q = address.get('q')?.trim().slice(0, 80) || undefined
    const status = address.get('status')
    const site = address.get('site')
    return { q, status: isStatus(status) ? status : undefined, siteId: site && isUuid(site) ? site : undefined, shippedFrom: dayOrUndefined(address.get('from')), shippedTo: dayOrUndefined(address.get('to')) }
  },
  async read(caller, query, cursor, limit) {
    const page = await searchShipments(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.shipments, next: page.nextCursor }
  },
  columns: {
    number: { value: (row) => row.number },
    status: { value: (row, words) => words(`status.${row.status}`) },
    site: { value: (row) => row.siteCode },
    order: { value: (row) => row.salesOrderNumber },
    customerPo: { value: (row) => row.customerRef },
    customer: { value: (row) => row.partyName || null },
    carrier: {
      value: (row, words) => {
        if (row.transportBy === 'SENDER') return words('transport.SENDER')
        if (row.transportBy === 'RECIPIENT') return words('transport.RECIPIENT')
        return row.carrierName ?? row.carrierCode ?? words('transport.noCarrier')
      },
    },
    service: { value: (row) => row.serviceCode },
    tracking: { value: (row) => row.trackingNumbers.join(', ') || null },
    parcels: { value: (row) => row.parcels },
    garments: { value: (row) => row.garments },
    ddt: { value: (row) => row.ddtNumber },
    splitFrom: { value: (row) => row.splitFrom?.number ?? null },
    holds: { value: (row, words) => row.holdReasons.map((reason) => words(`hold.${reason}`)).join(', ') || null },
    created: { value: (row) => day(row.createdAt) },
    packed: { value: (row) => day(row.packedAt) },
    shipped: { value: (row) => day(row.shippedAt) },
    delivered: { value: (row) => day(row.deliveredAt) },
    matchedBy: { value: (row, words) => row.matchedBy.map((match) => words(`match.${match}`)).join(', ') || null },
  },
  words: {
    it: {
      'status.DRAFT': 'Bozza',
      'status.PACKED': 'Imballata',
      'status.SHIPPED': 'Spedita',
      'status.DELIVERED': 'Consegnata',
      'status.RETURNED': 'Resa',
      'status.CANCELLED': 'Annullata',
      'transport.SENDER': 'Nostro furgone',
      'transport.RECIPIENT': 'Ritira il cliente',
      'transport.noCarrier': 'Nessun corriere scelto',
      'hold.CREDIT': 'Credito',
      'hold.DEPOSIT': 'Acconto non pagato',
      'hold.BALANCE_UNPAID': 'Saldo prima della spedizione non pagato',
      'hold.QUALITY': 'Qualità',
      'hold.CUSTOMER_REQUEST': 'Richiesta del cliente',
      'hold.OTHER': 'Altro motivo',
      'match.NUMBER': 'Numero spedizione',
      'match.ORDER': 'Ordine',
      'match.CUSTOMER_PO': 'Ordine del cliente',
      'match.CUSTOMER': 'Cliente',
      'match.TRACKING': 'Tracking',
      'match.CARTON': 'Collo',
      'match.SERIAL': 'Matricola',
    },
    en: {
      'status.DRAFT': 'Draft',
      'status.PACKED': 'Packed',
      'status.SHIPPED': 'Shipped',
      'status.DELIVERED': 'Delivered',
      'status.RETURNED': 'Returned',
      'status.CANCELLED': 'Cancelled',
      'transport.SENDER': 'Own van',
      'transport.RECIPIENT': 'Customer collects',
      'transport.noCarrier': 'No carrier chosen',
      'hold.CREDIT': 'Credit',
      'hold.DEPOSIT': 'Deposit not paid',
      'hold.BALANCE_UNPAID': 'Balance before shipping not paid',
      'hold.QUALITY': 'Quality',
      'hold.CUSTOMER_REQUEST': "Customer's request",
      'hold.OTHER': 'Another reason',
      'match.NUMBER': 'Shipment number',
      'match.ORDER': 'Order',
      'match.CUSTOMER_PO': "Customer's PO",
      'match.CUSTOMER': 'Customer',
      'match.TRACKING': 'Tracking',
      'match.CARTON': 'Carton',
      'match.SERIAL': 'Serial',
    },
  },
})
