import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { ARCHIVED_ROW, inShell, LIST_ROWS, listModel, newListModel, type PriceListRole } from '../_demo/fixtures'
import type { PriceListsViewModel } from './list-model'
import { PriceListsView } from './view/PriceListsView'

/**
 * SCR-106 — Price lists & contracts (Sales › Pricing; B-W2a-49) with made-up data only: a base list for every company,
 * a customer list in force that ends within 30 days with a draft waiting, a group list, a contract that starts within 30
 * days, a draft list in CHF and an expired one; the tiles as saved filters, Rows ▾ and Kind ▾ with their chips, Export N
 * and Archive N held with its reason, New price list (a customer list falling back to the base list; a second base list
 * refused in words) and the page's states. Roles: Owner and Sales keep lists, Finance reads them, Planner has no
 * pricelists.view (the page says so).
 */

interface ListCase {
  role: PriceListRole
  list: PriceListsViewModel
}

const listCase = (role: PriceListRole, over: Partial<PriceListsViewModel> = {}): ListCase => ({ role, list: listModel(role, over) })

function PriceListsDesign({ model }: { model: ListCase }) {
  return inShell('/sales/price-lists', createElement(PriceListsView, { model: model.list }), model.role)
}

const rows = (filter: (row: (typeof LIST_ROWS)[number]) => boolean) => ({ items: LIST_ROWS.filter(filter), problem: null })

export const designScreen = defineDesignScreen<ListCase>({
  screen: 'SCR-106',
  title: 'Price lists & contracts',
  view: PriceListsDesign,
  cases: [
    { id: 'sales', label: 'Sales: every list the company may use', model: listCase('sales'), note: 'Name → the list record; row ⋯ Open, new tab, Versions, Export. No price column: prices are on the record.' },
    { id: 'owner', label: 'Owner: the same lists', model: listCase('owner') },
    { id: 'tile-active', label: 'Tile pressed: Active (its chip in the toolbar)', model: listCase('sales', { filters: { rows: 'active', soon: null, kind: null, q: '' }, rows: rows((row) => row.state === 'IN_FORCE') }) },
    { id: 'tile-ending', label: 'Tile pressed: Expiring in 30 days', model: listCase('sales', { filters: { rows: 'all', soon: 'ending', kind: null, q: '' } }) },
    { id: 'tile-starting', label: 'Tile pressed: Starting in 30 days', model: listCase('sales', { filters: { rows: 'all', soon: 'starting', kind: null, q: '' } }) },
    { id: 'drafts', label: 'Rows ▾ Drafts', model: listCase('sales', { filters: { rows: 'drafts', soon: null, kind: null, q: '' }, rows: rows((row) => row.state === 'DRAFT') }) },
    { id: 'kind-group', label: 'Kind ▾ Group + a search', model: listCase('sales', { filters: { rows: 'all', soon: null, kind: 'GROUP', q: 'Esempio' }, rows: rows((row) => row.kind === 'GROUP') }) },
    { id: 'archived', label: 'Rows ▾ Archived', model: listCase('owner', { filters: { rows: 'archived', soon: null, kind: null, q: '' }, rows: { items: [ARCHIVED_ROW], problem: null } }) },
    {
      id: 'selected',
      label: 'Three lists selected: Export 3, Archive 1 (the others price customers)',
      model: listCase('sales', { selected: [LIST_ROWS[3]!.id, LIST_ROWS[4]!.id, LIST_ROWS[5]!.id] }),
      note: 'Archive says its reach: lists that price customers are left out, and the dialog says why.',
    },
    { id: 'archive', label: 'Archive 2 lists (one left out)', model: listCase('sales', { selected: [LIST_ROWS[2]!.id, LIST_ROWS[4]!.id, LIST_ROWS[5]!.id], dialog: 'archive' }) },
    { id: 'new', label: 'New price list: a customer list falling back to the base list', model: listCase('sales', { newList: newListModel({}, { code: 'NUOVO-PROVA', name: 'Nuovo Prova S.p.A. — 2027', baseListId: LIST_ROWS[0]!.id, validFrom: '2027-01-01' }) }) },
    { id: 'new-empty', label: 'New price list: nothing typed yet (Create draft held with the reason)', model: listCase('sales', { newList: newListModel() }) },
    {
      id: 'new-base-refused',
      label: 'New price list refused: a second base list in EUR',
      model: listCase('owner', { newList: newListModel({ problem: { key: 'new.refused.codeOrBase' } }, { code: 'BASE-EUR-2', name: 'Secondo listino base', kind: 'BASE' }) }),
    },
    { id: 'notice', label: 'After Archive: one notice at a time', model: listCase('sales', { notice: { tone: 'success', words: { key: 'list.bulk.archived', params: { count: 2 } } } }) },
    { id: 'updates', label: 'Live: changes wait behind "N updates · Show"', model: listCase('sales', { updates: 2 }) },
    { id: 'offline', label: 'Offline: rows stay readable', model: listCase('sales', { live: 'offline' }) },
    { id: 'finance', label: 'Finance: reads the lists; New price list held with the reason', model: listCase('finance') },
    { id: 'keys', label: 'The keys (footer icon, ?)', model: listCase('sales', { dialog: 'help' }) },
    { id: 'loading', label: 'Loading', model: listCase('sales', { rows: { items: null, problem: null }, tiles: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The lists couldn't be read (tiles say —)", model: listCase('sales', { rows: { items: null, problem: 'problem.read.unavailable' }, tiles: null }) },
    { id: 'empty', label: 'No price lists yet', model: listCase('sales', { rows: { items: [], problem: null }, tiles: { inForce: 0, startingIn30Days: 0, endingIn30Days: 0 } }) },
    { id: 'no-match', label: 'Nothing matches the search', model: listCase('sales', { filters: { rows: 'all', soon: null, kind: null, q: 'ZZZ' }, rows: { items: [], problem: null } }) },
    { id: 'no-permission', label: 'Planner: no pricelists.view (the page says so)', model: listCase('planner') },
  ],
})
