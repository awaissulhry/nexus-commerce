import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { addressOf } from './model'
import { AVAILABILITY, canAs, CUTS, CUTTING, HELD, inShell, OPEN_CUTS, PREFIX, TILES, WAITING, WAITING_PNT, WAITING_TMO, YIELD_TODAY, type Role } from './demo/fixtures'
import { CuttingView, type CuttingModel } from './view/CuttingView'

/**
 * SCR-238 — Production › Cutting room › Cutting (design production.cutting; MES-056, MES-057), with made-up data only:
 * the tiles and the cuts across work orders (W2a: leather by hide), the saved filters, a selection, New cut order and
 * Allocate hides in their states (a hide on hold or reserved elsewhere cannot be ticked, a work order on hold says why),
 * and the page's states (loading, slow, error, offline, empty, empty by filters, no permission). Roles: production
 * manager, owner, floor supervisor (reads; allocates nothing), buyer (the list and yield; no record), sales (none).
 */

interface CuttingCase {
  role: Role
  model: CuttingModel
}

const page = (role: Role, over: Partial<CuttingModel> = {}, query = ''): CuttingCase => ({
  role,
  model: {
    prefix: PREFIX,
    can: canAs(role),
    address: addressOf(new URLSearchParams(query)),
    rows: { items: OPEN_CUTS, more: false, problem: null },
    tiles: TILES,
    yieldToday: YIELD_TODAY,
    asOf: '2026-10-30T08:40:00.000Z',
    live: 'live',
    updates: 0,
    slow: false,
    timeZone: 'Europe/Rome',
    notice: null,
    newCut: null,
    alloc: null,
    ...over,
  },
})

const newCut = { choices: [WAITING, WAITING_TMO, WAITING_PNT], problem: null, busy: false }
const alloc = (over: Partial<NonNullable<CuttingModel['alloc']>> = {}): NonNullable<CuttingModel['alloc']> => ({ cut: WAITING, material: { itemId: WAITING.materials[0]!.itemId, itemColourId: WAITING.materials[0]!.itemColourId }, availability: { value: AVAILABILITY, problem: null }, busy: false, problem: null, ...over })

function CuttingDesign({ model }: { model: CuttingCase }) {
  return inShell('/production/cutting', createElement(CuttingView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<CuttingCase>({
  screen: 'SCR-238',
  title: 'Cutting: cuts across work orders (Production)',
  view: CuttingDesign,
  cases: [
    { id: 'open', label: 'Production manager: open cuts, the tiles, one cutting, one on hold', model: page('manager'), note: 'A tile is a saved filter (Waiting to cut, Cutting now); c opens New cut order; a cut opens its record.' },
    { id: 'owner', label: 'Owner', model: page('owner') },
    { id: 'all', label: 'All cuts (Rows ▾), the cut one included', model: page('manager', { rows: { items: CUTS, more: true, problem: null } }, 'view=all') },
    { id: 'waiting', label: 'Tile Waiting to cut pressed', model: page('manager', { rows: { items: [WAITING, WAITING_TMO, WAITING_PNT], more: false, problem: null } }, 'view=waiting') },
    { id: 'held', label: 'Held: the work order on hold says why', model: page('manager', { rows: { items: [HELD], more: false, problem: null } }, 'view=held'), note: 'The cutting table refuses every cut of a held work order in the hold’s words (409); the list says the reason.' },
    { id: 'selected', label: 'Two cuts selected: Export 2; Print tickets held (one cut)', model: page('manager', { selected: [CUTTING.workOrder.id, WAITING.workOrder.id] }) },
    { id: 'selected-one', label: 'One cut selected: Print tickets opens its tickets', model: page('manager', { selected: [CUTTING.workOrder.id] }) },
    { id: 'updates', label: 'Live: 3 updates behind Show', model: page('manager', { updates: 3 }) },
    { id: 'new', label: 'New cut order: the work orders waiting, no hide allocated', model: page('manager', { newCut }, 'new=1') },
    { id: 'new-picked', label: 'New cut order: one picked, another leather cannot be ticked (with why)', model: page('manager', { newCut: { ...newCut, picked: [WAITING.workOrder.id] } }, 'new=1') },
    { id: 'new-many', label: 'New cut order: two of the same leather picked — held (W2b groups)', model: page('manager', { newCut: { ...newCut, picked: [WAITING.workOrder.id, WAITING_PNT.workOrder.id] } }, 'new=1') },
    { id: 'new-empty', label: 'New cut order: nothing waits', model: page('manager', { newCut: { choices: [], problem: null, busy: false } }, 'new=1') },
    { id: 'new-supervisor', label: 'New cut order: floor supervisor (no inventory.reserve) — held', model: page('supervisor', { newCut: { ...newCut, picked: [WAITING.workOrder.id] } }, 'new=1') },
    { id: 'alloc', label: 'Allocate hides: free, mine, reserved elsewhere, on hold', model: page('manager', { alloc: alloc() }, `alloc=${WAITING.workOrder.id}`), note: 'A hide on hold (or of a lot not released) cannot be ticked: the table refuses to cut it in the same words.' },
    { id: 'alloc-picked', label: 'Allocate hides: three picked', model: page('manager', { alloc: alloc({ picked: [AVAILABILITY.hides[0]!.hide.id, AVAILABILITY.hides[1]!.hide.id, AVAILABILITY.hides[2]!.hide.id] }) }, `alloc=${WAITING.workOrder.id}`) },
    { id: 'alloc-held-order', label: 'Allocate hides for a work order on hold: the hold said first', model: page('manager', { alloc: alloc({ cut: HELD }) }, `alloc=${HELD.workOrder.id}`) },
    { id: 'alloc-refused', label: 'Allocate hides: refused (a hide taken meanwhile), in words', model: page('manager', { alloc: alloc({ picked: [AVAILABILITY.hides[0]!.hide.id], problem: { key: 'problem.alloc.hide' } }) }, `alloc=${WAITING.workOrder.id}`) },
    { id: 'alloc-loading', label: 'Allocate hides: the hides being read', model: page('manager', { alloc: alloc({ availability: { value: null, problem: null } }) }, `alloc=${WAITING.workOrder.id}`) },
    { id: 'notice', label: 'After Allocate: the notice', model: page('manager', { notice: { tone: 'success', words: { key: 'notice.allocated', params: { count: 3, number: WAITING.workOrder.number } } } }) },
    { id: 'supervisor', label: 'Floor supervisor: reads, opens the record', model: page('supervisor') },
    { id: 'buyer', label: 'Buyer: the list and the yield (no work order record)', model: page('buyer') },
    { id: 'offline', label: 'Offline: the last figures, said', model: page('manager', { live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: page('manager', { rows: { items: null, more: false, problem: null }, tiles: null, yieldToday: null, asOf: null, live: 'connecting' }) },
    { id: 'slow', label: 'Still loading after a second', model: page('manager', { rows: { items: null, more: false, problem: null }, tiles: null, yieldToday: null, asOf: null, slow: true }) },
    { id: 'error', label: 'The read failed: in words, with Try again', model: page('manager', { rows: { items: null, more: false, problem: 'problem.offline' }, tiles: null, live: 'offline' }) },
    { id: 'empty', label: 'No cut orders yet', model: page('manager', { rows: { items: [], more: false, problem: null }, tiles: { waiting: 0, cutting: 0, held: 0, piecesToday: 0, hidesToday: 0, areaTodayM2: '0.0000' }, yieldToday: null }) },
    { id: 'empty-filters', label: 'No rows match these filters', model: page('manager', { rows: { items: [], more: false, problem: null } }, 'view=cutting&q=ZZZ') },
    { id: 'no-permission', label: 'Sales: no production.cutting.view', model: page('sales') },
  ],
})
