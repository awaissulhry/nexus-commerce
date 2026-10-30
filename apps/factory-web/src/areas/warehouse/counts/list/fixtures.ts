import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { COUNT_ROWS, inShell, listModel, MATERIALS, newCountModel, type CountRole } from '../demo/fixtures'
import type { CountsListModel } from '../view-model'
import { CountsListView } from './view/CountsListView'

/**
 * SCR-132 — Counts (Warehouse › In the warehouse) with made-up data only: cycle counts of a rack, of leather and of a
 * material, the year-end inventory as a draft, one submitted over the approval limit and one under it, an approved and an
 * applied count; the tiles as saved rows, the search, Export N, the New count dialog (cycle, year-end with its start held
 * until 31 December, a refusal in words) and the page's states. Roles: Owner (values), Warehouse (no money), Finance
 * (signs the year-end inventory off), Read-only (New count held), Sales (no inventory.counts.view: the page says so).
 */

interface CountsCase {
  role: CountRole
  list: CountsListModel
}

const listCase = (role: CountRole, over: Partial<CountsListModel> = {}): CountsCase => ({ role, list: listModel(role, over) })

function CountsDesign({ model }: { model: CountsCase }) {
  return inShell('/warehouse/counts', createElement(CountsListView, { model: model.list }), model.role)
}

const rows = (filter: (row: (typeof COUNT_ROWS)[number]) => boolean) => ({ items: COUNT_ROWS.filter(filter), more: false, problem: null })

export const designScreen = defineDesignScreen<CountsCase>({
  screen: 'SCR-132',
  title: 'Counts (cycle counts and the year-end physical inventory)',
  view: CountsDesign,
  cases: [
    { id: 'owner', label: 'Owner: open counts with the value of their differences', model: listCase('owner'), note: 'Number → the count record; row ⋯ the count sheets with or without the expected quantities.' },
    { id: 'warehouse', label: 'Warehouse: the same counts, no values (no cost access)', model: listCase('warehouse') },
    { id: 'tile-waiting', label: 'Tile pressed: waiting for approval', model: listCase('owner', { view: 'waiting', rows: rows((row) => row.status === 'SUBMITTED' && row.approvalRequired === true) }) },
    { id: 'tile-to-apply', label: 'Tile pressed: to apply (approved, or under the limit)', model: listCase('warehouse', { view: 'toApply', rows: rows((row) => row.status === 'APPROVED' || (row.status === 'SUBMITTED' && row.approvalRequired === false)) }) },
    { id: 'finance-year-end', label: 'Finance: the year-end inventory tile', model: listCase('finance', { view: 'yearEnd', rows: rows((row) => row.kind === 'YEAR_END') }) },
    { id: 'search', label: 'Searched a team', model: listCase('warehouse', { q: 'Squadra B', rows: rows((row) => row.countTeam === 'Squadra B') }) },
    { id: 'selected', label: 'Three counts selected: Export 3 (CSV)', model: listCase('owner', { selected: COUNT_ROWS.slice(0, 3).map((row) => row.id) }) },
    { id: 'new-cycle', label: 'New count: a cycle count of rack N-MAG-A, starting now', model: listCase('warehouse', { newCount: newCountModel() }) },
    {
      id: 'new-material',
      label: 'New count: a material searched, one lot picked',
      model: listCase('warehouse', { newCount: newCountModel({ found: MATERIALS, lots: [{ id: 'l1', code: 'LOT-D-000101', onHand: '106.4000' }] }, { item: MATERIALS[1]!, lotId: 'l1', locationId: null }) }),
    },
    {
      id: 'new-year-end',
      label: 'New count: the year-end inventory as of 31 Dec 2026 (start held until that day)',
      model: listCase('owner', { newCount: newCountModel({}, { kind: 'YEAR_END', year: 2026, locationId: null, team: 'Tutto il magazzino', start: false }) }),
      note: 'Made as a draft now; Start counting opens on 31 December (art. 2217 c.c.).',
    },
    {
      id: 'new-refused',
      label: 'New count refused: the rack is held by another open count',
      model: listCase('warehouse', { newCount: newCountModel({ problem: { key: 'problem.HELD_BY_OTHER_COUNT', params: { counts: 'CNT-D-0001' } } }) }),
    },
    { id: 'notice', label: 'Count sheets could not be made (offline)', model: listCase('warehouse', { notice: { tone: 'danger', words: { key: 'stock:problem.offline' } } }) },
    { id: 'one-site-live', label: 'One site only (no site menu), live updates waiting', model: listCase('warehouse', { sites: [], updates: 3 }) },
    { id: 'offline', label: 'Live updates paused', model: listCase('warehouse', { live: 'offline' }) },
    { id: 'read-only', label: 'Read-only: sees counts, New count held with the reason', model: listCase('readOnly') },
    { id: 'keys', label: 'The keys (footer icon, ?)', model: listCase('warehouse', { helpOpen: true }) },
    { id: 'loading', label: 'Loading', model: listCase('warehouse', { rows: { items: null, more: false, problem: null }, tiles: null, asOf: null }) },
    { id: 'error', label: "The counts couldn't be read", model: listCase('warehouse', { rows: { items: null, more: false, problem: 'problem.offline' }, tiles: null }) },
    { id: 'empty', label: 'No counts yet', model: listCase('warehouse', { rows: { items: [], more: false, problem: null }, tiles: { drafts: 0, counting: 0, waitingApproval: 0, toApply: 0, yearEnd: 0 } }) },
    { id: 'no-match', label: 'Nothing matches the search', model: listCase('warehouse', { q: 'ZZZ', rows: { items: [], more: false, problem: null } }) },
    { id: 'sales', label: 'Sales: no inventory.counts.view (the page says so)', model: listCase('sales') },
  ],
})
