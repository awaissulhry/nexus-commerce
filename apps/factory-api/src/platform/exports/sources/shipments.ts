import { businessDate } from '@nexus/factory-domain/core/time'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { SHIPMENT_STATUSES, type ShipmentStatus } from '@nexus/factory-domain/shipping/shipments'
import { listShipments, type ListShipmentsQuery } from '../../../modules/shipping/shipments/shipments'
import { defineExportSource } from '../source'

/**
 * Warehouse › Shipments (SCR-066, `/warehouse/shipments`): the export of the list as the screen shows it. The address is
 * the list's own (apps/factory-web areas/warehouse/shipments model.ts rowsFromAddress / rowsQuery / listAddress):
 * `?rows=today|DRAFT|PACKED|SHIPPED|DELIVERED|RETURNED|CANCELLED|evidence|all` (nothing: the ship-today queue, what has
 * not left yet), `?q=`, `?carrier=` (a cut-off card's carrier: today's rows of that carrier, own van `SENDER` or the
 * customer `RECIPIENT`, `none` without one). Read through the module's listShipments (shipping.view, its companies,
 * sites and customers), a page at a time. Freight charged is the price grain: absent without it. "When" writes the day
 * a shipment left or was cancelled; today's cut-off countdown of an open shipment is the screen's only. Tracking lists
 * the first parcels' numbers (the list reads at most three per shipment).
 */

type Row = Awaited<ReturnType<typeof listShipments>>['shipments'][number]
type Query = Omit<ListShipmentsQuery, 'cursor' | 'limit'> & { readonly carrier: string | null }

const carrierKey = (row: Pick<Row, 'transportBy' | 'carrierCode'>): string => (row.transportBy !== 'CARRIER' ? row.transportBy : (row.carrierCode ?? 'none'))
const isStatus = (value: string): value is ShipmentStatus => (SHIPMENT_STATUSES as readonly string[]).includes(value)

export const shipments = defineExportSource<Query, Row>({
  listKey: 'warehouse.shipments',
  permission: SHIPPING_VIEW,
  query(address) {
    const rows = address.get('rows') ?? 'today'
    const q = address.get('q')?.trim().slice(0, 80) || undefined
    if (rows === 'all') return { q, carrier: null }
    if (rows === 'evidence') return { q, evidence: 'open', carrier: null }
    if (isStatus(rows)) return { q, status: rows, carrier: null }
    return { q, open: 'true', carrier: address.get('carrier') || null }
  },
  async read(caller, query, cursor, limit) {
    const { carrier, ...filter } = query
    const page = await listShipments(caller, { ...filter, cursor: cursor ?? undefined, limit })
    return { rows: carrier ? page.shipments.filter((row) => carrierKey(row) === carrier) : page.shipments, next: page.nextCursor }
  },
  columns: {
    number: { value: (row) => row.number },
    status: { value: (row, words) => words(`status.${row.status}`) },
    customer: { value: (row) => row.partyName || null },
    shipTo: { value: (row) => [row.shipTo.city, row.shipTo.country].filter((part): part is string => !!part).join(' · ') || null },
    carrier: {
      value: (row, words) => {
        if (row.transportBy === 'SENDER') return words('transport.SENDER')
        if (row.transportBy === 'RECIPIENT') return words('transport.RECIPIENT')
        return row.carrierName ?? row.carrierCode ?? words('transport.noCarrier')
      },
    },
    parcels: { value: (row) => row.parcels },
    weight: { value: (row) => (row.grossWeightKg === null ? null : { decimal: row.grossWeightKg }) },
    ddt: { value: (row, words) => (row.ddt ? row.ddt.number : row.status === 'CANCELLED' ? null : words('noDdt')) },
    tracking: { value: (row) => row.trackingNumbers.join(', ') || null },
    when: { value: (row) => (row.shippedAt ? { day: businessDate(new Date(row.shippedAt)) } : row.cancelledAt ? { day: businessDate(new Date(row.cancelledAt)) } : null) },
    freight: { grain: 'price', value: (row) => (row.freightCharge === null || row.freightCharge === undefined ? null : { minor: Number(row.freightCharge), currency: row.currency }) },
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
      noDdt: 'Non emesso',
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
      noDdt: 'Not issued',
    },
  },
})
