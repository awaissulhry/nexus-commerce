import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { CHECKED_SHEET, COMPLETE_SHEET, CREATE_RESULTS, createModel, inShell, listModel, PICK_ROWS, PICK_TILES, sheetModel, type PickRole } from './demo/fixtures'
import { PickingListView } from './list/view/PickingListView'
import type { PickingListModel } from './view-model'

/**
 * SCR-237 — Picking & kits (Warehouse › In the warehouse; design warehouse.picking) with made-up data only: six work
 * orders (one partly picked by the cutting team, one delayed by a late purchase order, one expected, one short, one kit
 * complete, one on hold with its reason); the tiles as saved rows; the readiness popover ("Why 'Delayed'": the late PO
 * with Open PO and Buy); the pick list dialog (pk-list: lines by bin path, reserved hides with their places, a hide on a
 * quality hold and a lot waiting for its chromium VI result held in words, the kit complete check, Mark kit complete held
 * with why; J / K; B-W2b-15: the kit's place chosen from the site's places, Mark kit complete once every line is picked,
 * Checked complete with when and Open again with the reason, a refused write in words); Create pick lists (pk-create: the released work orders without a pick list by cut date, one on hold
 * that cannot be ticked, then the outcomes); the selection's Print N; the page's states. Roles: Owner, Warehouse, Planner,
 * Read-only (Create held), Sales (no inventory.stock.view: the page says so). The paper is SCR-237-print.
 */

interface PickingCase {
  role: PickRole
  list: PickingListModel
}

const listCase = (role: PickRole, over: Partial<PickingListModel> = {}): PickingCase => ({ role, list: listModel(role, over) })
const rows = (filter: (row: (typeof PICK_ROWS)[number]) => boolean) => ({ items: PICK_ROWS.filter(filter), more: false, total: PICK_ROWS.filter(filter).length, problem: null })
const view = (name: PickingListModel['address']['view']) => ({ ...listModel('warehouse').address, view: name })

function PickingDesign({ model }: { model: PickingCase }) {
  return inShell('/warehouse/picking', createElement(PickingListView, { model: model.list }), model.role)
}

export const designScreen = defineDesignScreen<PickingCase>({
  screen: 'SCR-237',
  title: 'Picking & kits (pick lists per work order with material readiness)',
  view: PickingDesign,
  cases: [
    { id: 'warehouse', label: 'Warehouse: every pick list with its readiness, lines picked, kit and team', model: listCase('warehouse'), note: 'Work order → its page; the readiness word opens why; a row opens its pick list.' },
    { id: 'owner', label: 'Owner: the same, with Open PO and Buy in the readiness popover', model: listCase('owner') },
    { id: 'tile-today', label: 'Tile pressed: to pick today', model: listCase('warehouse', { address: view('today'), rows: rows((row) => row.cutDate !== null && row.cutDate <= '2026-10-30' && row.kit.status !== 'COMPLETE' && row.workOrder.status !== 'ON_HOLD') }) },
    { id: 'tile-waiting', label: 'Tile pressed: waiting for material', model: listCase('warehouse', { address: view('waiting'), rows: rows((row) => ['NOT_ENOUGH', 'DELAYED', 'REQUESTED', 'EXPECTED'].includes(row.readiness.word)) }) },
    { id: 'tile-complete', label: 'Tile pressed: kits complete', model: listCase('warehouse', { address: view('complete'), rows: rows((row) => row.kit.status === 'COMPLETE') }) },
    { id: 'ready-delayed', label: "Why 'Delayed': PO-D-0102 was due 28 Oct (Open PO, Buy)", model: listCase('owner', { readinessOpen: PICK_ROWS[1]!.workOrder.id }) },
    { id: 'ready-short', label: "Why 'Not enough': nothing ordered yet (Buy)", model: listCase('owner', { readinessOpen: PICK_ROWS[3]!.workOrder.id }) },
    { id: 'selected', label: 'Three rows ticked: Print 3 pick lists (one paper, by bin path)', model: listCase('warehouse', { selected: PICK_ROWS.slice(0, 3).map((row) => row.workOrder.id) }) },
    { id: 'sheet', label: 'Pick list WO-D-0031: lines by bin path, reserved hides, held stock in words, the kit check (J / K)', model: listCase('warehouse', { sheet: sheetModel() }) },
    { id: 'sheet-complete', label: 'Every line picked, staged at the cutting rack: Mark kit complete may be pressed', model: listCase('warehouse', { sheet: sheetModel({ id: PICK_ROWS[4]!.workOrder.id, sheet: COMPLETE_SHEET }) }) },
    { id: 'kit-checked', label: 'Kit checked complete (when, never who): Open again offered; the row says Checked', model: listCase('warehouse', { sheet: sheetModel({ id: PICK_ROWS[4]!.workOrder.id, sheet: CHECKED_SHEET }) }) },
    { id: 'kit-reopen', label: 'Open again: the reason is asked before the kit opens', model: listCase('warehouse', { sheet: sheetModel({ id: PICK_ROWS[4]!.workOrder.id, sheet: CHECKED_SHEET, reopen: { reason: 'Manca una tasca protezione' } }) }) },
    { id: 'kit-saving', label: 'A kit write on its way: the buttons held (Saving…)', model: listCase('warehouse', { sheet: sheetModel({ id: PICK_ROWS[4]!.workOrder.id, sheet: COMPLETE_SHEET, kitBusy: true }) }) },
    { id: 'kit-refused', label: 'A kit write refused in words (a line short meanwhile): the pick list read again', model: listCase('warehouse', { sheet: sheetModel({ kitProblem: { key: 'kit.refused.LINES_SHORT' } }) }) },
    { id: 'kit-places-loading', label: 'The places of the site being read: the place field waits', model: listCase('warehouse', { sheet: sheetModel({ places: { items: null, problem: null } }) }) },
    { id: 'kit-read-only', label: 'Read-only: the kit place in words, Mark kit complete held (no right to pick)', model: listCase('readOnly', { sheet: sheetModel({ id: PICK_ROWS[4]!.workOrder.id, sheet: COMPLETE_SHEET, places: null }) }) },
    { id: 'sheet-loading', label: 'Pick list: reading', model: listCase('warehouse', { sheet: sheetModel({ sheet: null }) }) },
    { id: 'sheet-error', label: "Pick list: couldn't be read (Try again)", model: listCase('warehouse', { sheet: sheetModel({ sheet: null, problem: 'problem.offline' }) }) },
    { id: 'create', label: 'Create pick lists: released work orders without one, by cut date (two ticked)', model: listCase('warehouse', { create: createModel({ picked: [PICK_ROWS[1]!.workOrder.id, PICK_ROWS[2]!.workOrder.id] }) }) },
    { id: 'create-results', label: 'Create pick lists: what each work order got (made, made with a shortage, refused)', model: listCase('warehouse', { create: createModel({ results: CREATE_RESULTS }), notice: { tone: 'warning', words: { key: 'create.notice', params: { created: 2, count: 3 } } } }) },
    { id: 'create-empty', label: 'Create pick lists: every released work order has its pick list', model: listCase('warehouse', { create: createModel({ choices: { items: [], problem: null } }) }) },
    { id: 'create-error', label: 'Create pick lists: refused (offline)', model: listCase('warehouse', { create: createModel({ picked: [PICK_ROWS[1]!.workOrder.id], problem: { key: 'stock:problem.offline' } }) }) },
    { id: 'on-hold', label: 'A work order on hold: its reason on the row, it cannot be ticked in Create', model: listCase('warehouse', { rows: rows((row) => row.workOrder.status === 'ON_HOLD') }) },
    { id: 'planner', label: 'Planner: sees and creates pick lists, Buy in the popover', model: listCase('planner') },
    { id: 'read-only', label: 'Read-only: sees pick lists, Create pick lists held with the reason', model: listCase('readOnly') },
    { id: 'live', label: 'Live updates waiting (3 updates · Show)', model: listCase('warehouse', { updates: 3 }) },
    { id: 'offline', label: 'Live updates paused', model: listCase('warehouse', { live: 'offline' }) },
    { id: 'two-sites', label: 'Two sites: the site menu', model: listCase('owner', { sites: [{ id: 's1', code: 'STAB-N', name: 'Stabilimento Demo Nord' }, { id: 's2', code: 'MAG-S', name: 'Magazzino Demo Sud' }] }) },
    { id: 'keys', label: 'The keys (footer icon, ?)', model: listCase('warehouse', { helpOpen: true }) },
    { id: 'loading', label: 'Loading', model: listCase('warehouse', { rows: { items: null, more: false, total: null, problem: null }, tiles: null, asOf: null }) },
    { id: 'error', label: "The pick lists couldn't be read", model: listCase('warehouse', { rows: { items: null, more: false, total: null, problem: 'problem.offline' }, tiles: null }) },
    { id: 'empty', label: 'No pick lists yet (first action: Create pick lists)', model: listCase('warehouse', { rows: { items: [], more: false, total: 0, problem: null }, tiles: { ...PICK_TILES, today: 0, waiting: 0, complete: 0, toCreate: 0, all: 0 } }) },
    { id: 'no-match', label: 'Nothing matches the search', model: listCase('warehouse', { address: { ...view('all'), q: 'ZZZ' }, rows: { items: [], more: false, total: 0, problem: null } }) },
    { id: 'sales', label: 'Sales: no inventory.stock.view (the page says so)', model: listCase('sales') },
  ],
})
