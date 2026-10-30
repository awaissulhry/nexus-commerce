import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, inShell, NOW, OPEN_ROWS, ORDER_ROWS, OTHER_WORKSHOPS, OUTSIDE, PREFIX, STOCK, TILE_COUNTS, TIME_ZONE, WORK_ORDER_CHOICES, WORKSHOPS, ZERO_COUNTS, withoutFee, type RoleCase } from '../demo/fixtures'
import { words } from '../model'
import { defaultPicks, NO_NEW_ORDER, type NewOrderDraft, type SubcontractingModel } from './list-model'
import { SubcontractingView } from './view/SubcontractingView'

/**
 * SCR-128 — Subcontract orders (design purchasing.subcontracting) with made-up orders only: the tiles "Outside work" (kit
 * to send, at workshops, due back this week, late; balance open '—' until W2b), the list frame of every job at a terzista
 * (draft, sent with the kit to send, in work, partly back and late, back, closed, cancelled), each tile and Rows ▾ view,
 * a search, the selection with Export, Show more, live updates, the keyboard, New subcontract order (the work order
 * picker, the routing's outside operations with the pieces still free, the routing's workshop or another one, held with
 * its reason, a refusal), and the states (loading with the slow note, error, empty, nothing matching). Roles: Owner and
 * Buyer (fees), Warehouse and Planner (no money: no fee column; New held), Read-only, Sales (no purchasing.view).
 */

export interface ListCase {
  role: RoleCase
  model: SubcontractingModel
}

export function listCase(role: RoleCase, over: Partial<SubcontractingModel> = {}): ListCase {
  const can = canFor(role)
  const rows = over.rows ?? { items: OPEN_ROWS, more: false, problem: null }
  const shown = can.cost ? rows : { ...rows, items: rows.items?.map(withoutFee) ?? null }
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      show: 'orders',
      view: 'open',
      q: '',
      counts: TILE_COUNTS,
      stock: { value: STOCK, problem: null },
      stockWorkshop: null,
      stockQ: '',
      asOf: NOW,
      live: 'live',
      updates: 0,
      notice: null,
      newOrder: null,
      timeZone: TIME_ZONE,
      now: NOW,
      ...over,
      rows: shown,
    },
  }
}

const only = (...statuses: string[]) => ({ items: ORDER_ROWS.filter((row) => statuses.includes(row.status)), more: false, problem: null })
const picking = (over: Partial<NewOrderDraft> = {}): NewOrderDraft => ({ ...NO_NEW_ORDER, workOrders: WORK_ORDER_CHOICES, ...over })
const picked = (over: Partial<NewOrderDraft> = {}): NewOrderDraft => picking({ workOrder: WORK_ORDER_CHOICES[0]!, outside: OUTSIDE, picked: defaultPicks(OUTSIDE), ...over })

function ListDesign({ model }: { model: ListCase }) {
  return inShell('/purchasing/subcontracting', createElement(SubcontractingView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<ListCase>({
  screen: 'SCR-128',
  title: 'Subcontract orders',
  view: ListDesign,
  cases: [
    { id: 'list', label: 'The open orders: workshop, services, pieces sent / back, kit, expected back (red when late), fee (buyer)', model: listCase('buyer'), note: 'SC-2026-0004 is late; SC-2026-0006 waits for its kit.' },
    { id: 'tile-kit', label: 'Tile: kit to send', model: listCase('buyer', { view: 'kit', rows: { items: ORDER_ROWS.filter((row) => row.kit.state === 'TO_SEND' || row.kit.state === 'PARTLY_SENT'), more: false, problem: null } }) },
    { id: 'tile-workshop', label: 'Tile: at workshops', model: listCase('buyer', { view: 'workshop', rows: only('AT_WORKSHOP', 'PARTLY_RECEIVED') }) },
    { id: 'tile-due', label: 'Tile: due back this week', model: listCase('buyer', { view: 'due', rows: { items: ORDER_ROWS.filter((row) => row.expectedBackDate !== null && row.expectedBackDate >= '2026-11-18' && row.expectedBackDate <= '2026-11-22' && ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'].includes(row.status)), more: false, problem: null } }) },
    { id: 'tile-late', label: 'Tile: late', model: listCase('buyer', { view: 'late', rows: { items: ORDER_ROWS.filter((row) => row.late), more: false, problem: null } }) },
    { id: 'view-all', label: 'Rows ▾ every order (closed and cancelled too)', model: listCase('buyer', { view: 'all', rows: { items: ORDER_ROWS, more: false, problem: null } }) },
    { id: 'view-back', label: 'Rows ▾ back, to close', model: listCase('buyer', { view: 'back', rows: only('RECEIVED') }) },
    { id: 'search', label: 'Search by workshop', model: listCase('buyer', { q: 'ricami', rows: { items: ORDER_ROWS.filter((row) => row.workshop.id === WORKSHOPS.embroidery.id && row.status !== 'CANCELLED'), more: false, problem: null } }) },
    { id: 'no-match', label: 'Nothing matches the filters', model: listCase('buyer', { q: 'zzz', rows: { items: [], more: false, problem: null } }) },
    { id: 'selection', label: 'Selection: Export N (CSV)', model: listCase('buyer', { selected: OPEN_ROWS.slice(0, 3).map((row) => row.id) }) },
    { id: 'more', label: 'More than a page: Show more in the footer', model: listCase('buyer', { rows: { items: OPEN_ROWS, more: true, problem: null } }) },
    { id: 'live', label: 'Live: 2 updates waiting', model: listCase('buyer', { updates: 2 }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows', model: listCase('buyer', { focusRow: 2 }) },
    { id: 'shortcuts', label: 'Keyboard shortcuts (?)', model: listCase('buyer', { helpOpen: true }) },
    { id: 'new-pick', label: 'New subcontract order: pick the work order (released or running)', model: listCase('buyer', { newOrder: picking() }) },
    { id: 'new-operations', label: 'New subcontract order: the routing’s outside operations, pieces still free, its workshop', model: listCase('buyer', { newOrder: picked({ returnDate: '2026-11-27', note: 'Doppia cucitura sulle spalle.' }) }) },
    { id: 'new-other-workshop', label: 'New subcontract order: another active workshop (its location found at the create)', model: listCase('buyer', { newOrder: picked({ otherOpen: true, otherQuery: 'fin', others: OTHER_WORKSHOPS }) }) },
    { id: 'new-no-workshop', label: 'New subcontract order: an in-house operation picked, no workshop yet (held)', model: listCase('buyer', { newOrder: picked({ picked: [{ operationId: OUTSIDE.operations[4]!.id, pieces: '30' }] }) }) },
    { id: 'new-too-many', label: 'New subcontract order: more pieces than are free (held)', model: listCase('buyer', { newOrder: picked({ picked: [{ operationId: OUTSIDE.operations[2]!.id, pieces: '40' }] }) }) },
    { id: 'new-refused', label: 'New subcontract order: refused — the workshop has no stock location on the site', model: listCase('buyer', { newOrder: picked({ problem: words('new.refused.location', { workshop: WORKSHOPS.sewing.name }) }) }) },
    { id: 'new-loading', label: 'New subcontract order: reading the routing', model: listCase('buyer', { newOrder: picking({ workOrder: WORK_ORDER_CHOICES[0]! }) }) },
    { id: 'new-planner', label: 'New subcontract order: the routing without fees (no cost grain), Create held for the planner', model: listCase('planner', { newOrder: picked() }) },
    { id: 'empty', label: 'First day: no subcontract order yet (tiles 0)', model: listCase('buyer', { rows: { items: [], more: false, problem: null }, counts: ZERO_COUNTS }) },
    { id: 'loading', label: 'Loading (tiles “—”, skeleton rows, the slow note after a second)', model: listCase('buyer', { rows: { items: null, more: false, problem: null }, counts: null, asOf: null, live: 'connecting', slow: true }) },
    { id: 'error', label: "The list couldn't be read (never drawn as empty)", model: listCase('buyer', { rows: { items: null, more: false, problem: 'problem.offline' }, counts: null, countsProblem: 'problem.offline', asOf: null, live: 'offline' }) },
    { id: 'notice', label: 'A notice after an act', model: listCase('buyer', { notice: { tone: 'danger', words: words('problem.changed') } }) },
    { id: 'owner', label: 'Owner: everything, with fees', model: listCase('owner') },
    { id: 'warehouse', label: 'Warehouse: reads, sends kits and receives back; no fee column; New held with the permission', model: listCase('warehouse') },
    { id: 'planner', label: 'Planner: reads, no money (no fee column), New held', model: listCase('planner') },
    { id: 'read-only', label: 'Read-only: reads, nothing written', model: listCase('readOnly') },
    { id: 'sales', label: 'Sales: no purchasing.view — the page says so', model: listCase('sales') },
  ],
})
