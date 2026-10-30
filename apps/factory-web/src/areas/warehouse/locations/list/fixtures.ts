import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, LOCATIONS, NOW, PREFIX, ROLE_PERMISSIONS, TIME_ZONE, type RoleCase } from '../../../_shared/stock/fixtures'
import { EMPTY_SITE, NORTH, NORTH_ALL, overviewOf, SOUTH, STOCK_ROWS } from '../demo/fixtures'
import { locationsCan, type ListAddress } from '../model'
import { LocationsView, type LocationsListModel } from './view/LocationsView'

/**
 * Design cases of SCR-065, Warehouse › Settings › Locations (made-up data: ../demo.ts). Roles: the owner (stock with
 * values), the warehouse (manages places, no money), quality (sees, changes nothing here), read-only, sales (no
 * permission: the page says which one).
 */

const ADDRESS: ListAddress = { siteId: null, archived: false, q: '' }

function base(role: RoleCase, over: Partial<LocationsListModel> = {}): { role: RoleCase; model: LocationsListModel } {
  const can = locationsCan(ROLE_PERMISSIONS[role])
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      sites: { status: 'ready', items: [NORTH] },
      site: NORTH,
      address: ADDRESS,
      stock: { value: can.stock ? overviewOf(can.cost) : null, problem: null },
      asOf: NOW,
      live: 'live',
      updates: 0,
      timeZone: TIME_ZONE,
      notice: null,
      ...over,
    },
  }
}

function LocationsDesign({ model }: { model: { role: RoleCase; model: LocationsListModel } }) {
  return inShell('/warehouse/locations', createElement(LocationsView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<{ role: RoleCase; model: LocationsListModel }>({
  screen: 'SCR-065',
  title: 'Locations (Warehouse › Settings)',
  view: LocationsDesign,
  cases: [
    { id: 'owner', label: 'Owner: the site’s tree, what lies in each place, places inside', model: base('owner'), note: 'Row ⋯: New location inside · Move under… · Archive (held while the place holds stock or places) · Open. c = New location.' },
    { id: 'warehouse', label: 'Warehouse: manages places (no money anywhere on this page)', model: base('warehouse') },
    { id: 'quality', label: 'Quality: sees places and stock, changes nothing (no New, no row actions)', model: base('quality') },
    { id: 'read-only', label: 'Read-only: sees, changes nothing', model: base('readOnly') },
    { id: 'sales-no-permission', label: 'Sales: no permission — the page names inventory.locations.view', model: base('sales') },
    { id: 'archived-shown', label: 'Show archived: the archived mezzanine, struck through, read only', model: base('warehouse', { sites: { status: 'ready', items: [NORTH_ALL] }, site: NORTH_ALL, address: { ...ADDRESS, archived: true } }) },
    { id: 'search', label: 'Search “A-0”: the two bins of rack A (a scanned bin label finds its place)', model: base('warehouse', { address: { ...ADDRESS, q: 'A-0' } }) },
    { id: 'no-match', label: 'Search with no match: “No rows match” + Clear filters', model: base('warehouse', { address: { ...ADDRESS, q: 'XYZ' } }) },
    { id: 'selection', label: 'Two places selected: Export 2 (CSV)', model: base('warehouse', { selected: [LOCATIONS.binA1.id, LOCATIONS.binA2.id] }) },
    { id: 'two-sites', label: 'Two sites: the site picker', model: base('warehouse', { sites: { status: 'ready', items: [NORTH, SOUTH] } }) },
    { id: 'empty', label: 'A site with no places yet: New location · Import locations', model: base('warehouse', { sites: { status: 'ready', items: [EMPTY_SITE] }, site: EMPTY_SITE }) },
    { id: 'new', label: 'New location at the top: code suggested, kind Warehouse', model: base('warehouse', { dialog: { kind: 'new', parentId: null } }) },
    { id: 'new-inside', label: 'New location inside rack A: code N-MAG-A-03 suggested, kind Bin', model: base('warehouse', { dialog: { kind: 'new', parentId: LOCATIONS.rackA.id } }) },
    {
      id: 'new-code-taken',
      label: 'New location: the code is taken on this site (the API’s 409 in words)',
      model: base('warehouse', { dialog: { kind: 'new', parentId: LOCATIONS.rackA.id, form: { parentId: LOCATIONS.rackA.id, code: 'N-MAG-A-07', name: 'Ripiano A7', kind: 'BIN' }, refusal: { key: 'lc.new.codeTaken', field: 'code' } } }),
    },
    { id: 'new-missing', label: 'New location: Create pressed with no name (held, the field says why)', model: base('warehouse', { dialog: { kind: 'new', parentId: null, tried: true, form: { parentId: null, code: 'n mag 2', name: '', kind: 'WAREHOUSE' } } }) },
    { id: 'move', label: 'Move bin A2 under…: only places that are not itself or below it', model: base('warehouse', { dialog: { kind: 'move', locationId: LOCATIONS.binA2.id } }) },
    { id: 'archive', label: 'Archive the empty goods-in dock? An archived place takes no more stock', model: base('warehouse', { stock: { value: overviewOf(false, STOCK_ROWS.filter((row) => row.location.id !== LOCATIONS.receiving.id)), problem: null }, dialog: { kind: 'archive', locationId: LOCATIONS.receiving.id } }) },
    { id: 'archive-refused', label: 'Archive refused meanwhile (stock arrived): in words', model: base('warehouse', { dialog: { kind: 'archive', locationId: LOCATIONS.binA1.id, refusal: { key: 'lc.problem.notNow' } } }) },
    { id: 'created', label: 'Created: “Location N-MAG-A-03 created”', model: base('warehouse', { notice: { tone: 'success', key: 'lc.done.created', params: { code: 'N-MAG-A-03' } } }) },
    { id: 'updates', label: 'Stock moved meanwhile: “2 updates · Show” (rows never move under the reader)', model: base('warehouse', { updates: 2 }) },
    { id: 'keys', label: 'The keys (the footer’s information icon; ? opens them all)', model: base('warehouse', { helpOpen: true }) },
    { id: 'loading', label: 'Loading', model: base('warehouse', { sites: { status: 'loading' }, site: null, stock: { value: null, problem: null }, asOf: null }) },
    { id: 'error', label: 'The read failed: in words with Try again (never an empty list)', model: base('warehouse', { sites: { status: 'error', problem: 'problem.offline' }, site: null }) },
    { id: 'stock-failed', label: 'The places read, the stock did not: said above the list', model: base('warehouse', { stock: { value: null, problem: 'problem.read' } }) },
    { id: 'no-sites', label: 'No site within the person’s access', model: base('warehouse', { sites: { status: 'ready', items: [] }, site: null }) },
  ],
})

