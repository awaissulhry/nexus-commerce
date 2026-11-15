import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { inShell, OPEN_ROWS, type Role } from '../../_demo/fixtures'
import type { ShipmentsListModel } from '../../list/list-model'
import { ShipmentsListView } from '../../list/view/ShipmentsListView'
import { pickupRow } from '../../pickup/fixtures'
import { dispatchAbilitiesOf } from '../../pickup/dispatch'
import { designScreen as queueScreen } from '../../queue/fixtures'
import type { QueueRow } from '../../queue/api'
import type { DispatchListModel } from '../list-model'

/**
 * SCR-655 — the shipments list with B-W2b-412's parts (design warehouse.shipments page.h "End of day (W2b manifest)", ⋯ "Book
 * a pickup (W2b)", sh-cutoff "pickup booked 16:00", sh-grid "Export (W2b)", the selection row's "Book pickup" and "Mark handed
 * over (manual carriers)"), drawn inside the list as the Office shows it. Made-up data only (B-W2b-410's queue cases).
 */

const WAREHOUSE = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.pickups.book', 'shipping.customs.manage', 'shipping.settings.view', 'files.read', 'files.upload']
const SALES = ['shipping.view', 'orders.view', 'money.price']

interface ListCase {
  readonly role: Role
  readonly list: ShipmentsListModel
}

const base = (id: string): ShipmentsListModel => queueScreen.cases.find((entry) => entry.id === id)!.model.list

const dispatch = (over: Partial<DispatchListModel> = {}, permissions: readonly string[] = WAREHOUSE): DispatchListModel => ({
  siteId: base('today').depth?.siteId ?? null,
  pickups: { state: 'ready', value: [pickupRow(1, { readyTime: '16:00' }), pickupRow(2, { carrierCode: 'other', readyTime: '11:00' })] },
  pickup: null,
  endOfDay: null,
  handOver: null,
  can: dispatchAbilitiesOf(permissions),
  ...over,
})

const page = (role: Role, list: ShipmentsListModel, over: Partial<DispatchListModel> = {}, permissions?: readonly string[]): ListCase => ({ role, list: { ...list, dispatch: dispatch(over, permissions) } })

const withSelection = (id: string, selected: readonly string[]): ShipmentsListModel => {
  const list = base(id)
  return { ...list, selected: [...selected], depth: list.depth ? { ...list.depth, selected } : list.depth }
}

const todayRead = base('today').depth?.today
const QUEUE_ROWS: readonly QueueRow[] = todayRead?.state === 'ready' ? todayRead.value.shipments : []

function ListDesign({ model }: { model: ListCase }) {
  return inShell('/warehouse/shipments', createElement(ShipmentsListView, { model: model.list }), model.role)
}

export const designScreen = defineDesignScreen<ListCase>({
  screen: 'SCR-655',
  title: 'Shipments with pickups and the day\'s close: End of day, Book a pickup, pickup booked on the cards, Mark handed over',
  view: ListDesign,
  cases: [
    { id: 'today', label: 'Ship today: End of day in the band, Book a pickup in ⋯, "Pickup booked 16:00" on Demo Express', model: page('warehouse', base('today')) },
    { id: 'pickup-failed', label: 'A pickup failed today: said in red on its carrier\'s card', model: page('warehouse', base('today'), { pickups: { state: 'ready', value: [pickupRow(1, { status: 'FAILED', providerReference: null, errorWords: 'No driver free.' })] } }) },
    { id: 'pickups-waiting', label: 'Two pickups, one waiting for the carrier\'s answer', model: page('warehouse', base('today'), { pickups: { state: 'ready', value: [pickupRow(1, { readyTime: '11:00' }), pickupRow(3, { readyTime: '16:00', status: 'REQUESTED', providerReference: null })] } }) },
    { id: 'selected', label: 'Two rows picked (a draft, a packed one): Book pickup 2, Mark handed over 1 beside Hold', model: page('warehouse', withSelection('today', QUEUE_ROWS.slice(2, 4).map((row) => row.id))) },
    { id: 'hand-over', label: 'Mark handed over: the picked shipments going and those left out', model: page('warehouse', withSelection('today', QUEUE_ROWS.slice(3, 6).map((row) => row.id)), { handOver: { picked: QUEUE_ROWS.slice(3, 6).map((row) => ({ id: row.id, number: row.number, status: row.status, transportBy: row.transportBy })), busy: false, outcomes: null, can: { manage: true } } }) },
    {
      id: 'handed-over',
      label: 'Handed over: the outcome per shipment in words',
      model: page('warehouse', base('today'), {
        handOver: {
          picked: QUEUE_ROWS.slice(3, 6).map((row) => ({ id: row.id, number: row.number, status: row.status, transportBy: row.transportBy })),
          busy: false,
          outcomes: [
            { id: QUEUE_ROWS[3]!.id, number: QUEUE_ROWS[3]!.number, state: 'done', words: { key: 'handOver.why.done' } },
            { id: QUEUE_ROWS[4]!.id, number: QUEUE_ROWS[4]!.number, state: 'refused', words: { key: 'handOver.why.notReady' } },
            { id: QUEUE_ROWS[5]!.id, number: QUEUE_ROWS[5]!.number, state: 'skipped', words: { key: 'handOver.why.notPacked' } },
          ],
          can: { manage: true },
        },
      }),
    },
    { id: 'all-export', label: 'All shipments: the Export column (outside the EU: papers needed)', model: page('warehouse', { ...base('open'), rows: 'all', list: { items: [...OPEN_ROWS.slice(0, 3), { ...OPEN_ROWS[3]!, shipTo: { city: 'Zürich', country: 'CH' } }, { ...OPEN_ROWS[4]!, shipTo: { city: 'Lyon', country: 'FR' } }], more: false, problem: null }, depth: base('open').depth ? { ...base('open').depth!, grid: null } : null }) },
    { id: 'read-only', label: 'Sales (read-only): End of day opens to read; Book a pickup and Mark handed over held with why', model: page('sales', withSelection('today', [QUEUE_ROWS[0]!.id]), {}, SALES) },
  ],
})
