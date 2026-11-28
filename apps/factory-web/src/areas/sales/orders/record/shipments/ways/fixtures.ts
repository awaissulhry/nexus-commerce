import { defineDesignScreen } from '../../../../../../lib/design/design-screen'
import { waysOf, type TogetherRow, type WarehouseChoice } from './model'
import { ShipWaysView, type ShipWaysViewModel } from './view/ShipWaysView'

/**
 * owb-ss3 step 3.1 — the window "Ship the whole order" in the design index (`/design/SCR-owb-ship-ways`): nothing chosen yet, together
 * with the customer's other ready orders (one may, one may not), to our warehouse first, made (Open it in Warehouse to pack and send),
 * no other order ready, nothing ready, a role that does not plan. Made-up data only (Brand Alpha, example numbers).
 */

const ROWS: readonly TogetherRow[] = [
  { salesOrderId: 'so-2', number: 'SO-2026-0102', customerRef: 'PO-ALPHA-13', pieces: 4, held: null },
  { salesOrderId: 'so-3', number: 'SO-2026-0103', customerRef: null, pieces: 2, held: { key: 'shipOrders.cannotJoin', ns: 'depth' } },
]
const WAREHOUSES: readonly WarehouseChoice[] = [
  { siteId: 'wh-1', name: 'Milan warehouse', city: 'Milan' },
  { siteId: 'wh-2', name: 'Lisbon warehouse', city: 'Lisbon' },
]
const base: ShipWaysViewModel = {
  open: true,
  state: 'ready',
  readProblem: null,
  order: { number: 'SO-2026-0101', customer: 'Brand Alpha', pieces: 12 },
  ways: waysOf({ rows: ROWS, warehouses: WAREHOUSES }),
  rows: ROWS,
  warehouses: WAREHOUSES,
  choice: { way: null, ticked: ['so-2'], siteId: null },
  held: { key: 'ways.held.pick' },
  busy: false,
  writeProblem: null,
  made: null,
}

export const designScreen = defineDesignScreen<ShipWaysViewModel>({
  screen: 'SCR-owb-ship-ways',
  title: 'Ship the whole order — alone · together · to our warehouse first (owb-ss3)',
  view: ShipWaysView,
  cases: [
    { id: 'choose', label: 'Nothing chosen yet', model: base, note: 'The act waits: "Choose how it ships".' },
    { id: 'together', label: 'Together with the customer’s other ready orders', model: { ...base, choice: { ...base.choice, way: 'TOGETHER' }, held: null }, note: 'One order may go with it (ticked); the other says why not.' },
    { id: 'warehouse', label: 'To our warehouse first', model: { ...base, choice: { ...base.choice, way: 'OUR_WAREHOUSE', siteId: 'wh-1' }, held: null }, note: 'The customer reads “At the factory’s warehouse”.' },
    { id: 'made', label: 'Made: a draft', model: { ...base, state: 'made', made: { number: 'SH-2026-0044', href: '/w/DEMO/warehouse/shipments/sh-44', way: 'ALONE' } }, note: 'Close, and Open it in Warehouse to pack and send.' },
    { id: 'alone-only', label: 'No other order ready, no warehouse of our own', model: { ...base, rows: [], warehouses: [], ways: waysOf({ rows: [], warehouses: [] }) } },
    { id: 'nothing', label: 'Nothing of this order is ready', model: { ...base, order: { number: 'SO-2026-0101', customer: 'Brand Alpha', pieces: 0 }, held: { key: 'ways.held.nothing' } } },
    { id: 'no-right', label: 'A role that does not plan shipments', model: { ...base, choice: { ...base.choice, way: 'ALONE' }, held: { key: 'ways.held.noRight' } } },
  ],
})
