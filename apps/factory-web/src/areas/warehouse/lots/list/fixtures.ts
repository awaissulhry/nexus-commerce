import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, inShell, NOW, PREFIX, SITE, SITE_SOUTH, TIME_ZONE, type RoleCase } from '../../../_shared/stock/fixtures'
import { LOT_COUNTS, LOT_ROWS } from '../demo/fixtures'
import { defaultLotView, type LotsListModel, type LotView } from '../model'
import { LotsListView } from './view/LotsListView'

/**
 * SCR-201 — Lots & traceability (Warehouse › Main) with made-up data only: released, quarantined, Cr VI failed (blocked),
 * lining and protector lots, opening stock and a rejected lot; the tiles as saved views (holds reached here, Q3), the
 * search, the selection's Export, and the page's states. Roles: Owner, Warehouse, Quality (waits for release by default),
 * Read-only, Sales and Admin (no inventory.stock.view: the page says which permission is missing).
 */

interface LotsCase {
  role: RoleCase
  list: LotsListModel
}

function listCase(role: RoleCase, over: Partial<LotsListModel> = {}, view?: LotView): LotsCase {
  const can = canFor(role)
  return {
    role,
    list: {
      prefix: PREFIX,
      can,
      view: view ?? defaultLotView(can),
      q: '',
      sites: [SITE, SITE_SOUTH],
      siteId: null,
      rows: { items: LOT_ROWS, more: false, problem: null },
      counts: LOT_COUNTS,
      asOf: NOW,
      live: 'live',
      updates: 0,
      timeZone: TIME_ZONE,
      ...over,
    },
  }
}

function LotsDesign({ model }: { model: LotsCase }) {
  return inShell('/warehouse/lots', createElement(LotsListView, { model: model.list }), model.role)
}

const held = LOT_ROWS.filter((row) => row.qualityStatus === 'QUARANTINE' || row.qualityStatus === 'BLOCKED')

export const designScreen = defineDesignScreen<LotsCase>({
  screen: 'SCR-201',
  title: 'Lots & traceability (every lot with its tests, documents, stock and holds)',
  view: LotsDesign,
  cases: [
    { id: 'owner', label: 'Owner: every lot, in stock first', model: listCase('owner', {}, 'all'), note: 'Lot code → the lot record; row ⋯ Decide in Tests & substances (the one place lots are released).' },
    { id: 'warehouse', label: 'Warehouse: lots that hold stock', model: listCase('warehouse', { rows: { items: LOT_ROWS.filter((row) => row.onHand !== '0.0000'), more: true, problem: null } }) },
    { id: 'quality', label: 'Quality: waiting for release by default', model: listCase('quality', { rows: { items: held, more: false, problem: null } }) },
    { id: 'tile-cr-vi', label: 'Tile pressed: waiting for Cr VI evidence', model: listCase('quality', { rows: { items: held.filter((row) => row.crVi.status === 'PENDING'), more: false, problem: null } }, 'crViPending') },
    { id: 'tile-failed', label: 'Tile pressed: Cr VI failed (blocked, can never be issued)', model: listCase('owner', { rows: { items: held.filter((row) => row.crVi.status === 'FAIL'), more: false, problem: null } }, 'crViFailed') },
    { id: 'search', label: 'Searched a supplier lot', model: listCase('warehouse', { q: 'CD-26-04', rows: { items: LOT_ROWS.slice(0, 2), more: false, problem: null } }, 'all') },
    { id: 'selected', label: 'Three lots selected: Export 3 (CSV)', model: listCase('owner', { selected: LOT_ROWS.slice(0, 3).map((row) => row.id) }, 'all') },
    { id: 'one-site', label: 'One site only (no site menu), live updates waiting', model: listCase('warehouse', { sites: [SITE], updates: 3 }) },
    { id: 'read-only', label: 'Read-only: sees every lot, exports', model: listCase('readOnly', {}, 'all') },
    { id: 'keys', label: 'The keys (footer icon, ?)', model: listCase('warehouse', { helpOpen: true }) },
    { id: 'loading', label: 'Loading', model: listCase('warehouse', { rows: { items: null, more: false, problem: null }, counts: null, asOf: null }) },
    { id: 'error', label: "The lots couldn't be read", model: listCase('warehouse', { rows: { items: null, more: false, problem: 'problem.offline' }, counts: null }) },
    { id: 'empty', label: 'No lots yet', model: listCase('warehouse', { rows: { items: [], more: false, problem: null }, counts: { quarantine: 0, waitingCrVi: 0, crViFailed: 0, blocked: 0, rejected: 0, released: 0 } }, 'all') },
    { id: 'no-match', label: 'Nothing matches the search', model: listCase('warehouse', { q: 'ZZZ', rows: { items: [], more: false, problem: null } }, 'all') },
    { id: 'sales', label: 'Sales: no inventory.stock.view (the page says so)', model: listCase('sales') },
    { id: 'admin', label: 'Admin: no inventory.stock.view (the page says so)', model: listCase('admin') },
  ],
})
