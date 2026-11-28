import { defineDesignScreen } from '../../../lib/design/design-screen'
import { sectionsOf } from './model'
import { OurWarehousesView, type OurWarehousesViewModel } from './view/OurWarehousesView'

/**
 * owb-ss3 step 3.4 — Warehouse › Our warehouses in the design index (`/design/SCR-owb-our-warehouses`): a warehouse with garments waiting
 * (one with the customer's label, one without) and one on the way; an empty warehouse; a reader without pack and send; no warehouse of
 * our own. Made-up data only (Brand Alpha, example numbers).
 */

const customer = { partyId: 'party-a', code: 'C-ALPHA', name: 'Brand Alpha' }
const SECTIONS = sectionsOf([
  {
    siteId: 'wh-1',
    code: 'WH-MI',
    name: 'Milan warehouse',
    city: 'Milan',
    country: 'IT',
    atWarehouse: [
      { shipmentId: 'sh-1', number: 'SH-2026-0041', customer, salesOrders: [{ id: 'so-1', number: 'SO-2026-0101' }], pieces: 4, arrivedAt: '2026-11-20T09:00:00.000Z', labelSentAt: null },
      { shipmentId: 'sh-2', number: 'SH-2026-0042', customer, salesOrders: [{ id: 'so-2', number: 'SO-2026-0102' }, { id: 'so-3', number: 'SO-2026-0103' }], pieces: 10, arrivedAt: '2026-11-24T09:00:00.000Z', labelSentAt: '2026-11-25T09:00:00.000Z' },
    ],
    onTheWay: [{ shipmentId: 'sh-3', number: 'SH-2026-0043', customer, pieces: 2, shippedAt: '2026-11-26T09:00:00.000Z' }],
  },
  { siteId: 'wh-2', code: 'WH-LX', name: 'Lisbon warehouse', city: 'Lisbon', country: 'PT', atWarehouse: [], onTheWay: [] },
])
const base: OurWarehousesViewModel = { prefix: '/w/DEMO', sections: { state: 'ready', value: SECTIONS }, acts: { sendOn: true, arrived: true } }

export const designScreen = defineDesignScreen<OurWarehousesViewModel>({
  screen: 'SCR-owb-our-warehouses',
  title: 'Warehouse › Our warehouses — at our warehouse and on the way, Send on to the customer (owb-ss3)',
  view: OurWarehousesView,
  cases: [
    { id: 'normal', label: 'Two warehouses, one with garments waiting', model: base, note: 'Send on is the primary where the customer’s label is here.' },
    { id: 'read-only', label: 'A reader without pack and send', model: { ...base, acts: { sendOn: false, arrived: false } } },
    { id: 'none', label: 'No warehouse of our own', model: { ...base, sections: { state: 'ready', value: [] } } },
    { id: 'reading', label: 'Reading', model: { ...base, sections: { state: 'reading' } } },
  ],
})
