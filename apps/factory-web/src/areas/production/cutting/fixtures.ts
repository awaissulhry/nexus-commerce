import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { addressOf } from './model'
import { AVAILABILITY, canAs, CUTS, CUTTING, HELD, inShell, OPEN_CUTS, PREFIX, TILES, WAITING, WAITING_PNT, WAITING_TMO, YIELD_TODAY, type Role } from './demo/fixtures'
import { CELL_IDS, FABRIC_KEY, FABRIC_TILES, GROUPS, LEATHER_CELL_IDS, LEATHER_KEY, ORDER_CUT, ORDER_CUTTING, ORDER_LEATHER, ORDER_PLANNED, ORDER_ROWS, ordersCanAs, STATIONS } from './orders/demo/fixtures'
import { listRows, NO_DRAFT, type NewOrderDraft } from './orders/model'
import type { NewOrderModel } from './orders/view/NewCutOrderDialog'
import { CuttingView, type CuttingModel } from './view/CuttingView'

/**
 * SCR-238 — Production › Cutting room › Cutting (design production.cutting; MES-056, MES-057, MES-034), with made-up data only:
 * the tiles and the cuts across work orders — the cut orders of several work orders (W2b, fabric by lay, a leather group) and
 * each work order's leather cut (W2a, by hide) in one list —, the saved filters, a selection, New cut order (W2b: one material
 * and colour, the sizes of several work orders, the marker, plies and lays; leather: each size's garments) and Allocate hides
 * in their states (a hide on hold or reserved elsewhere cannot be ticked, a work order on hold says why), and the page's states
 * (loading, slow, error, offline, empty, empty by filters, no permission). Roles: production manager, owner, floor supervisor
 * (reads; plans nothing), buyer (the list and yield; no record), sales (none).
 */

interface CuttingCase {
  role: Role
  model: CuttingModel
}

const page = (role: Role, over: Partial<CuttingModel> = {}, query = ''): CuttingCase => {
  const address = addressOf(new URLSearchParams(query))
  return {
    role,
    model: {
      prefix: PREFIX,
      can: canAs(role),
      orders: ordersCanAs(role),
      address,
      rows: { items: listRows(address.view, ORDER_ROWS, OPEN_CUTS), more: false, problem: null },
      ordersProblem: null,
      tiles: TILES,
      fabric: FABRIC_TILES,
      yieldToday: YIELD_TODAY,
      asOf: '2026-10-30T08:40:00.000Z',
      live: 'live',
      updates: 0,
      slow: false,
      timeZone: 'Europe/Rome',
      notice: null,
      newOrder: null,
      alloc: null,
      ...over,
    },
  }
}

const newOrder = (draft: Partial<NewOrderDraft> = {}, over: Partial<NewOrderModel> = {}): NewOrderModel => ({ groups: GROUPS, problem: null, stations: STATIONS, draft: { ...NO_DRAFT, ...draft }, busy: false, error: null, ...over })
// Lining: 48 ×1, 50 ×2, 52 ×1 on 20 plies in 2 lays (10 · 10) = 20 + 40 + 20 = 80 garments.
const fabricDraft: Partial<NewOrderDraft> = { groupKey: FABRIC_KEY, picked: CELL_IDS.slice(0, 3), ratio: { [CELL_IDS[1]!]: '2' }, markerName: 'DEMO-MK-3S', markerLength: '2,40', markerWidth: '145', plies: '20', lays: '2', stationId: STATIONS[0]!.id }
const alloc = (over: Partial<NonNullable<CuttingModel['alloc']>> = {}): NonNullable<CuttingModel['alloc']> => ({ cut: WAITING, material: { itemId: WAITING.materials[0]!.itemId, itemColourId: WAITING.materials[0]!.itemColourId }, availability: { value: AVAILABILITY, problem: null }, busy: false, problem: null, ...over })

function CuttingDesign({ model }: { model: CuttingCase }) {
  return inShell('/production/cutting', createElement(CuttingView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<CuttingCase>({
  screen: 'SCR-238',
  title: 'Cutting: cut orders and cuts across work orders (Production)',
  view: CuttingDesign,
  cases: [
    { id: 'open', label: 'Production manager: open cut orders and cuts, the tiles, one on hold', model: page('manager'), note: 'A tile is a saved filter (Waiting to cut, Cutting now: the fabric cut orders added); c opens New cut order; a row opens its record.' },
    { id: 'owner', label: 'Owner', model: page('owner') },
    { id: 'all', label: 'All (Rows ▾): a cut order cut, a cut done', model: page('manager', { rows: { items: listRows('all', [...ORDER_ROWS, ORDER_CUT], CUTS), more: true, problem: null } }, 'view=all') },
    { id: 'waiting', label: 'Tile Waiting to cut pressed: planned and released cut orders, cuts waiting', model: page('manager', { rows: { items: listRows('waiting', [ORDER_PLANNED, ORDER_LEATHER], [WAITING, WAITING_TMO, WAITING_PNT]), more: false, problem: null } }, 'view=waiting') },
    { id: 'held', label: 'Held: the work order on hold says why (no cut order is held)', model: page('manager', { rows: { items: listRows('held', [], [HELD]), more: false, problem: null } }, 'view=held'), note: 'The cutting table refuses every cut of a held work order in the hold’s words (409); the list says the reason.' },
    { id: 'selected', label: 'Two rows selected: Export 2; Print tickets held (one row)', model: page('manager', { selected: [`CO:${ORDER_CUTTING.id}`, `WO:${CUTTING.workOrder.id}`] }) },
    { id: 'selected-order', label: 'One cut order selected: Print tickets opens its lay sheet and tickets (new tab)', model: page('manager', { selected: [`CO:${ORDER_CUTTING.id}`] }) },
    { id: 'selected-one', label: 'One cut selected: Print tickets opens its tickets', model: page('manager', { selected: [`WO:${CUTTING.workOrder.id}`] }) },
    { id: 'updates', label: 'Live: 3 updates behind Show', model: page('manager', { updates: 3 }) },
    { id: 'orders-failed', label: 'The cut orders could not be read (the cuts show; said with Try again)', model: page('manager', { rows: { items: listRows('open', [], OPEN_CUTS), more: false, problem: null }, ordersProblem: 'problem.offline' }) },
    { id: 'new', label: 'New cut order: pick a material and colour', model: page('manager', { newOrder: newOrder() }, 'new=1') },
    { id: 'new-fabric', label: 'New cut order, fabric: three sizes of two work orders, the marker, 20 plies in 2 lays', model: page('manager', { newOrder: newOrder(fabricDraft) }, 'new=1'), note: 'A size another cut order took all of cannot be ticked, with why. 80 garments; the ratio 48:1 · 50:2 · 52:1.' },
    { id: 'new-beyond', label: 'New cut order, fabric: a size asked beyond what is left — held with the numbers', model: page('manager', { newOrder: newOrder({ ...fabricDraft, plies: '30' }) }, 'new=1') },
    { id: 'new-leather', label: 'New cut order, leather: each size’s garments (empty: what is left)', model: page('manager', { newOrder: newOrder({ groupKey: LEATHER_KEY, picked: LEATHER_CELL_IDS, quantity: { [LEATHER_CELL_IDS[0]!]: '12' } }) }, 'new=1') },
    { id: 'new-refused', label: 'New cut order: refused (another cut order took a size meanwhile), in words', model: page('manager', { newOrder: newOrder(fabricDraft, { error: { key: 'refusal.CELL_FULL' } }) }, 'new=1') },
    { id: 'new-loading', label: 'New cut order: the sizes waiting being read', model: page('manager', { newOrder: newOrder({}, { groups: null }) }, 'new=1') },
    { id: 'new-empty', label: 'New cut order: nothing waits', model: page('manager', { newOrder: newOrder({}, { groups: [] }) }, 'new=1') },
    { id: 'new-error', label: 'New cut order: the read failed', model: page('manager', { newOrder: newOrder({}, { groups: null, problem: 'problem.offline' }) }, 'new=1') },
    { id: 'new-supervisor', label: 'New cut order: floor supervisor (no production.cutorders.manage) — held', model: page('supervisor', { newOrder: newOrder(fabricDraft) }, 'new=1') },
    { id: 'alloc', label: 'Allocate hides: free, mine, reserved elsewhere, on hold', model: page('manager', { alloc: alloc() }, `alloc=${WAITING.workOrder.id}`), note: 'A hide on hold (or of a lot not released) cannot be ticked: the table refuses to cut it in the same words.' },
    { id: 'alloc-picked', label: 'Allocate hides: three picked', model: page('manager', { alloc: alloc({ picked: [AVAILABILITY.hides[0]!.hide.id, AVAILABILITY.hides[1]!.hide.id, AVAILABILITY.hides[2]!.hide.id] }) }, `alloc=${WAITING.workOrder.id}`) },
    { id: 'alloc-held-order', label: 'Allocate hides for a work order on hold: the hold said first', model: page('manager', { alloc: alloc({ cut: HELD }) }, `alloc=${HELD.workOrder.id}`) },
    { id: 'alloc-refused', label: 'Allocate hides: refused (a hide taken meanwhile), in words', model: page('manager', { alloc: alloc({ picked: [AVAILABILITY.hides[0]!.hide.id], problem: { key: 'problem.alloc.hide' } }) }, `alloc=${WAITING.workOrder.id}`) },
    { id: 'alloc-loading', label: 'Allocate hides: the hides being read', model: page('manager', { alloc: alloc({ availability: { value: null, problem: null } }) }, `alloc=${WAITING.workOrder.id}`) },
    { id: 'notice', label: 'After Allocate: the notice', model: page('manager', { notice: { tone: 'success', words: { key: 'notice.allocated', params: { count: 3, number: WAITING.workOrder.number } } } }) },
    { id: 'supervisor', label: 'Floor supervisor: reads, opens the records', model: page('supervisor') },
    { id: 'buyer', label: 'Buyer: the list and the yield (no work order record)', model: page('buyer') },
    { id: 'offline', label: 'Offline: the last figures, said', model: page('manager', { live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: page('manager', { rows: { items: null, more: false, problem: null }, tiles: null, fabric: null, yieldToday: null, asOf: null, live: 'connecting' }) },
    { id: 'slow', label: 'Still loading after a second', model: page('manager', { rows: { items: null, more: false, problem: null }, tiles: null, fabric: null, yieldToday: null, asOf: null, slow: true }) },
    { id: 'error', label: 'The read failed: in words, with Try again', model: page('manager', { rows: { items: null, more: false, problem: 'problem.offline' }, tiles: null, fabric: null, live: 'offline' }) },
    { id: 'empty', label: 'No cut orders yet', model: page('manager', { rows: { items: [], more: false, problem: null }, tiles: { waiting: 0, cutting: 0, held: 0, piecesToday: 0, hidesToday: 0, areaTodayM2: '0.0000' }, fabric: { planned: 0, released: 0, cutting: 0, cut: 0, cancelled: 0 }, yieldToday: null }) },
    { id: 'empty-filters', label: 'No rows match these filters', model: page('manager', { rows: { items: [], more: false, problem: null } }, 'view=cutting&q=ZZZ') },
    { id: 'no-permission', label: 'Sales: no production.cutting.view', model: page('sales') },
  ],
})
