import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { CustomerGroup, ShipmentLine } from './model'
import { ReadyToShipView, type ReadyToShipViewModel } from './view/ReadyToShipView'

/**
 * owb-ss3 step 3.4 — Warehouse › Ready to ship in the design index (`/design/SCR-owb-ready-to-ship`): orders by customer with tick boxes,
 * one customer ticked (One shipment for the 2 orders + Add to SH-…), two customers ticked (the button says why), read only, nothing
 * ready, a part that failed. Made-up data only (Brand Alpha, Brand Beta, example numbers).
 */

const GROUPS: readonly CustomerGroup[] = [
  {
    partyId: 'party-a',
    code: 'C-ALPHA',
    name: 'Brand Alpha',
    pieces: 9,
    orders: [
      { salesOrderId: 'so-1', number: 'SO-2026-0101', customerRef: 'PO-ALPHA-12', pieces: 5 },
      { salesOrderId: 'so-2', number: 'SO-2026-0102', customerRef: null, pieces: 4 },
    ],
  },
  { partyId: 'party-b', code: 'C-BETA', name: 'Brand Beta', pieces: 12, orders: [{ salesOrderId: 'so-3', number: 'SO-2026-0103', customerRef: 'PO-BETA-7', pieces: 12 }] },
]
const SHIPS: readonly ShipmentLine[] = [
  { id: 'sh-1', number: 'SH-2026-0041', status: 'DRAFT', customer: 'Brand Alpha', orders: ['SO-2026-0099'], garments: 6, parcels: 1, carrier: null, at: '2026-11-27T09:00:00.000Z' },
  { id: 'sh-2', number: 'SH-2026-0040', status: 'PACKED', customer: 'Brand Beta', orders: ['SO-2026-0098', 'SO-2026-0097'], garments: 20, parcels: 3, carrier: 'GLS', at: '2026-11-26T09:00:00.000Z' },
]
const base: ReadyToShipViewModel = {
  prefix: '/w/DEMO',
  plan: true,
  groups: { state: 'ready', value: GROUPS },
  ticked: new Set(),
  picked: { orders: 0, customers: 0, pieces: 0 },
  one: { words: { key: 'act.makeShipment' }, held: { key: 'held.pick' } },
  drafts: [],
  busy: false,
  problem: null,
  chip: 'open',
  shipments: { state: 'ready', value: SHIPS },
}

export const designScreen = defineDesignScreen<ReadyToShipViewModel>({
  screen: 'SCR-owb-ready-to-ship',
  title: 'Warehouse › Ready to ship — orders by customer, one shipment for the ticked orders (owb-ss3)',
  view: ReadyToShipView,
  cases: [
    { id: 'normal', label: 'Two customers, nothing ticked', model: base, note: 'The act waits: "Tick the orders of one customer".' },
    {
      id: 'one-customer',
      label: 'Two orders of Brand Alpha ticked',
      model: { ...base, ticked: new Set(['so-1', 'so-2']), picked: { orders: 2, customers: 1, pieces: 9 }, one: { words: { key: 'act.oneShipment', params: { count: 2 } }, held: null }, drafts: [{ shipmentId: 'sh-1', number: 'SH-2026-0041' }] },
      note: 'One shipment for the 2 orders, and Add to SH-2026-0041 (a draft of Brand Alpha).',
    },
    {
      id: 'two-customers',
      label: 'Orders of two customers ticked',
      model: { ...base, ticked: new Set(['so-1', 'so-3']), picked: { orders: 2, customers: 2, pieces: 17 }, one: { words: { key: 'act.oneShipment', params: { count: 2 } }, held: { key: 'held.twoCustomers', params: { count: 2 } } } },
      note: 'The button stays and says why: two customers never travel in one shipment.',
    },
    { id: 'read-only', label: 'A reader without the plan right', model: { ...base, plan: false }, note: 'No tick boxes, no acts.' },
    { id: 'empty', label: 'Nothing is ready', model: { ...base, groups: { state: 'ready', value: [] }, shipments: { state: 'ready', value: [] } } },
    { id: 'failed', label: 'The orders could not be read', model: { ...base, groups: { state: 'failed', problem: 'problem.read.unavailable' } } },
  ],
})
