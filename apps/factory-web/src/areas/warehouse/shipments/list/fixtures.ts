import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { ALL_ROWS, at, canOf, inShell, LEFT_ROWS, OPEN_ROWS, PREFIX, READY, rowsFor, SITE, TODAY, type Role } from '../_demo/fixtures'
import { cutOffCards, tileCounts, zonedToday } from '../model'
import type { NewShipmentModel, ShipmentsListModel } from './list-model'
import { ShipmentsListView } from './view/ShipmentsListView'

/**
 * SCR-066 — Shipments (design warehouse.shipments) with made-up data only: the ship-today queue with a card per carrier
 * (its cut-off today, what is ready and still to pack; a pressed card filters the queue), the tiles, every state of the
 * list (loading, error, empty, nothing today, nothing matching, short, more pages, live updates, no permission), the
 * selection and Export N, New shipment (both steps, held, refused), and the roles: Owner, Warehouse, Sales (read-only)
 * and Finance (read-only). Ticks, the header box, shift-click, j / k / x / Enter / c and ? work for real. B-W2a-71: the
 * Freight charged column (price grain only), Print N DDTs (the dialog, its outcome, held), the EU proof still to file.
 */

interface ListCase {
  role: Role
  list: ShipmentsListModel
}

// A cut-off late today counts down live; the made-up day's 17:00 has passed.
const CUT_OFFS = { map: new Map([[SITE, '17:00']]), day: TODAY }
const NOW_CUT_OFFS = { map: new Map([[SITE, '23:59']]), day: zonedToday() }

const base = (role: Role, over: Partial<ShipmentsListModel> = {}, cutOffs = NOW_CUT_OFFS): ListCase => withRole(role, {
  role,
  list: {
    prefix: PREFIX,
    can: canOf(role),
    today: TODAY,
    rows: 'today',
    q: '',
    carrier: null,
    list: { items: OPEN_ROWS, more: false, problem: null },
    cards: cutOffCards(OPEN_ROWS, canOf(role).viewSettings ? cutOffs.map : new Map(), cutOffs.day),
    tiles: tileCounts(OPEN_ROWS, false, 2),
    asOf: at(29, 9, 42),
    live: 'live',
    updates: 0,
    notice: null,
    create: null,
    ...over,
  },
})

/** Without the price grain the API sends no freight amount: the role's rows are drawn as that role reads them. */
function withRole(role: Role, item: ListCase): ListCase {
  return { ...item, list: { ...item.list, list: { ...item.list.list, items: item.list.list.items ? rowsFor(item.list.list.items, role) : null } } }
}

const create = (over: Partial<NewShipmentModel> = {}): NewShipmentModel => ({ step: 1, orders: READY, problem: null, salesOrderId: null, quantities: {}, transportBy: 'CARRIER', carrierCode: 'brt', serviceCode: '', busy: false, refused: null, ...over })

function ShipmentsDesign({ model }: { model: ListCase }) {
  return inShell('/warehouse/shipments', createElement(ShipmentsListView, { model: model.list }), model.role)
}

export const designScreen = defineDesignScreen<ListCase>({
  screen: 'SCR-066',
  title: 'Shipments (Warehouse): the ship-today queue, then every shipment',
  view: ShipmentsDesign,
  cases: [
    { id: 'today', label: 'Warehouse: the ship-today queue with the carrier cut-offs, live', model: base('warehouse'), note: 'Press a carrier card: the queue shows that carrier only. Tick a row: Export N. c opens New shipment.' },
    { id: 'cutoff-passed', label: 'The 17:00 cut-off passed (it leaves the next working day)', model: base('warehouse', {}, CUT_OFFS) },
    { id: 'carrier', label: 'A carrier card pressed: only BRT today', model: base('warehouse', { carrier: 'brt', list: { items: OPEN_ROWS.filter((entry) => entry.carrierCode === 'brt' && entry.transportBy === 'CARRIER'), more: false, problem: null } }) },
    { id: 'owner-all', label: 'Owner: every shipment (Rows ▾ All shipments)', model: base('owner', { rows: 'all', list: { items: ALL_ROWS, more: false, problem: null } }) },
    { id: 'in-transit', label: 'The In transit tile pressed', model: base('warehouse', { rows: 'SHIPPED', list: { items: LEFT_ROWS.filter((entry) => entry.status === 'SHIPPED'), more: false, problem: null } }) },
    { id: 'to-pack', label: 'The To pack tile pressed', model: base('warehouse', { rows: 'DRAFT', list: { items: OPEN_ROWS.filter((entry) => entry.status === 'DRAFT'), more: false, problem: null } }) },
    { id: 'selected', label: 'Three shipments selected: Export 3 (CSV)', model: base('warehouse', { selected: OPEN_ROWS.slice(0, 3).map((entry) => entry.id) }) },
    { id: 'live-updates', label: 'Live: 2 changes wait behind Show (a carton packed, a label bought)', model: base('warehouse', { updates: 2 }) },
    { id: 'more', label: 'More pages: Show 50 more in the footer', model: base('warehouse', { rows: 'all', list: { items: ALL_ROWS, more: true, problem: null } }) },
    { id: 'short', label: 'A short list: two rows, no empty band', model: base('warehouse', { list: { items: OPEN_ROWS.slice(0, 2), more: false, problem: null } }) },
    { id: 'nothing-today', label: 'Nothing to ship today', model: base('warehouse', { list: { items: [], more: false, problem: null }, cards: [], tiles: tileCounts([], false, 0) }) },
    { id: 'empty', label: 'No shipments yet (All shipments)', model: base('warehouse', { rows: 'all', list: { items: [], more: false, problem: null }, cards: [], tiles: tileCounts([], false, 0) }) },
    { id: 'no-match', label: 'A search that matches nothing', model: base('warehouse', { q: 'XYZ-404', list: { items: [], more: false, problem: null }, cards: [] }) },
    { id: 'loading', label: 'Loading', model: base('warehouse', { list: { items: null, more: false, problem: null }, cards: null, tiles: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'The read failed: in words, with Try again (never drawn as empty); the tiles say —', model: base('warehouse', { list: { items: null, more: false, problem: 'problem.read.unavailable' }, cards: null, tiles: null, live: 'offline' }) },
    { id: 'no-permission', label: 'No permission: the API refused the read (shipping.view)', model: base('warehouse', { list: { items: null, more: false, problem: 'problem.read.forbidden' }, cards: null, tiles: null }) },
    { id: 'sales', label: 'Sales: read-only (no New shipment), no cut-off shown (no settings right)', model: base('sales') },
    { id: 'finance', label: 'Finance: read-only, every shipment', model: base('finance', { rows: 'all', list: { items: ALL_ROWS, more: false, problem: null } }) },
    { id: 'help', label: '? the keys of this list', model: base('warehouse', { helpOpen: true }) },
    // ---- B-W2a-71 (every day) ----
    { id: 'freight', label: 'Finance: every shipment with the Freight charged column (price grain)', model: base('finance', { rows: 'all', list: { items: ALL_ROWS, more: false, problem: null } }) },
    { id: 'evidence', label: 'Rows ▾ EU proof to file: gone to another EU state, the transport evidence awaited or partial', model: base('warehouse', { rows: 'evidence', list: { items: LEFT_ROWS.filter((entry) => entry.transportEvidence === 'AWAITED' || entry.transportEvidence === 'PARTIAL'), more: false, problem: null } }) },
    { id: 'print-selected', label: 'Four shipments selected: Print 3 DDTs (one has no DDT yet)', model: base('warehouse', { selected: [OPEN_ROWS[1]!.id, OPEN_ROWS[3]!.id, OPEN_ROWS[4]!.id, OPEN_ROWS[5]!.id] }) },
    { id: 'print-dialog', label: 'Print 3 DDTs: on each site\'s document printer', model: base('warehouse', { selected: [OPEN_ROWS[1]!.id, OPEN_ROWS[3]!.id, OPEN_ROWS[4]!.id, OPEN_ROWS[5]!.id], printDdts: { ids: [OPEN_ROWS[1]!.id, OPEN_ROWS[3]!.id, OPEN_ROWS[4]!.id, OPEN_ROWS[5]!.id], busy: false, outcomes: null } }) },
    {
      id: 'print-done',
      label: 'Print DDTs: queued, one refused (no document printer), one skipped',
      model: base('warehouse', {
        printDdts: {
          ids: [OPEN_ROWS[1]!.id, OPEN_ROWS[3]!.id, OPEN_ROWS[4]!.id],
          busy: false,
          outcomes: [
            { id: OPEN_ROWS[3]!.id, number: OPEN_ROWS[3]!.number, ddt: OPEN_ROWS[3]!.ddt!.number, state: 'queued', words: { key: 'printDdts.why.queued' } },
            { id: OPEN_ROWS[4]!.id, number: OPEN_ROWS[4]!.number, ddt: OPEN_ROWS[4]!.ddt?.number ?? null, state: 'refused', words: { key: 'printDdts.why.noPrinter' } },
            { id: OPEN_ROWS[1]!.id, number: OPEN_ROWS[1]!.number, ddt: null, state: 'skipped', words: { key: 'printDdts.why.noDdt' } },
          ],
        },
      }),
    },
    { id: 'print-held', label: 'Sales: Print DDTs held (packing right missing)', model: base('sales', { selected: [OPEN_ROWS[3]!.id, OPEN_ROWS[5]!.id] }) },
    { id: 'new-order', label: 'New shipment, step 1: the order and who carries it', model: base('warehouse', { create: create({ salesOrderId: READY[0]!.salesOrderId }) }) },
    { id: 'new-quantities', label: 'New shipment, step 2: garments per size, each capped at what can still ship', model: base('warehouse', { create: create({ step: 2, salesOrderId: READY[0]!.salesOrderId, quantities: { [READY[0]!.cells[0]!.workOrderSizeId]: 3, [READY[0]!.cells[1]!.workOrderSizeId]: 5 } }) }) },
    { id: 'new-too-many', label: 'New shipment: a size asks more than it can ship (held, with the range)', model: base('warehouse', { create: create({ step: 2, salesOrderId: READY[0]!.salesOrderId, quantities: { [READY[0]!.cells[2]!.workOrderSizeId]: 4 } }) }) },
    { id: 'new-refused', label: 'New shipment refused by the API (said inside the dialog)', model: base('warehouse', { create: create({ step: 2, salesOrderId: READY[0]!.salesOrderId, quantities: { [READY[0]!.cells[0]!.workOrderSizeId]: 1 }, refused: { words: { key: 'problem.write.state' }, detail: 'Only released garments ship: BLK 50 has 3 released (less reversals) and 1 on shipments, so 2 can still ship; 3 asked.' } }) }) },
    { id: 'new-nothing', label: 'New shipment: nothing released to ship yet', model: base('warehouse', { create: create({ orders: [] }) }) },
    { id: 'new-loading', label: 'New shipment: reading what quality released', model: base('warehouse', { create: create({ orders: null }) }) },
  ],
})
