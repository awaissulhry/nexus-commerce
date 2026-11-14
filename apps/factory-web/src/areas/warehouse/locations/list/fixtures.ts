import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, LOCATIONS, NOW, PREFIX, ROLE_PERMISSIONS, TIME_ZONE, type RoleCase } from '../../../_shared/stock/fixtures'
import { EMPTY_SITE, NORTH, NORTH_ALL, overviewOf, SOUTH, STOCK_ROWS } from '../demo/fixtures'
import { locationsCan, type ListAddress } from '../model'
import { LocationsView, type LocationsListModel } from './view/LocationsView'
// B-W2b-327: Status (blocked), Default for, Label, Block / Unblock, Print labels, the W2b kinds of a new place.
import { CUSTOMERS, DEFAULTS, PLACES, PRINTERS } from '../../stock/depth/demo/fixtures'
import type { PlaceSite } from '../depth/api'
import type { PrintDialogModel } from '../depth/model'

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
      permissions: ROLE_PERMISSIONS[role],
      today: '2026-10-30',
      ...over,
    },
  }
}

// ---- B-W2b-327 ------------------------------------------------------------------------------------------------------------
const DEPTH: PlaceSite = { ...NORTH, locations: PLACES.filter((place) => place.status === 'ACTIVE') }
const deep = (role: RoleCase, over: Partial<LocationsListModel> = {}) => base(role, { sites: { status: 'ready', items: [DEPTH] }, site: DEPTH, defaults: DEFAULTS, ...over })
const at = (code: string) => DEPTH.locations.find((place) => place.code === code)!
const print = (codes: string[], over: Partial<PrintDialogModel> = {}): PrintDialogModel => ({ places: codes.map(at), siteCode: NORTH.code, draft: { printerId: PRINTERS[0]!.id, copies: 1, language: 'it' }, printers: { status: 'ready', value: PRINTERS }, posting: false, problem: null, done: null, ...over })
const W2B_CASES: { id: string; label: string; model: { role: RoleCase; model: LocationsListModel }; note?: string }[] = [
  { id: 'w2b-status', label: 'W2b · Status (bin A1 blocked by a running count, the quarantine shelf damaged until 2 Nov), Default for, Label', model: deep('warehouse'), note: 'Row ⋯: Block… / Change block… / Unblock · Print label… ; the band’s Print labels prints the selected places.' },
  { id: 'w2b-select-print', label: 'W2b · Three places selected: Print 3 labels beside Export', model: deep('warehouse', { selected: [LOCATIONS.binA1.id, LOCATIONS.binA2.id, at('N-TRANSIT').id] }) },
  { id: 'w2b-block', label: 'W2b · Block bin A2: the reason, a note, the last day it holds', model: deep('warehouse', { depthDialog: { kind: 'block', locationId: LOCATIONS.binA2.id, draft: { reason: 'CLEAN_UP', note: 'Pulizia scaffale', until: '2026-10-31' } } }) },
  { id: 'w2b-block-other', label: 'W2b · Block with reason Other and no words: held, the field says why', model: deep('warehouse', { depthDialog: { kind: 'block', locationId: LOCATIONS.binA2.id, draft: { reason: 'OTHER', note: '', until: '' } } }) },
  { id: 'w2b-block-change', label: 'W2b · Change the block of the quarantine shelf (damage, until 2 Nov)', model: deep('warehouse', { depthDialog: { kind: 'block', locationId: LOCATIONS.quarantine.id } }) },
  { id: 'w2b-block-refused', label: 'W2b · Block refused: someone changed the place meanwhile (409, in our words)', model: deep('warehouse', { depthDialog: { kind: 'block', locationId: LOCATIONS.binA2.id, draft: { reason: 'DAMAGE', note: '', until: '' }, refusal: { key: 'wd.loc.problem.changed' } } }) },
  { id: 'w2b-unblock', label: 'W2b · Unblock the quarantine shelf: moves go through again', model: deep('warehouse', { depthDialog: { kind: 'unblock', locationId: LOCATIONS.quarantine.id } }) },
  { id: 'w2b-print', label: 'W2b · Print labels: 2 of 3 places (bin A2 gets its suggested code first; the transit place is left out)', model: deep('warehouse', { print: print(['N-MAG-A-01', 'N-MAG-A-02', 'N-TRANSIT']) }) },
  { id: 'w2b-print-pdf', label: 'W2b · Print labels as a PDF in the browser (a new tab, one label per page)', model: deep('warehouse', { print: print(['N-MAG-A-01', 'N-MAG-A-02'], { draft: { printerId: 'PDF', copies: 2, language: 'en' } }) }) },
  { id: 'w2b-print-no-printer', label: 'W2b · No label printer at this site: the PDF only', model: deep('warehouse', { print: print(['N-MAG-A-01'], { printers: { status: 'ready', value: [] }, draft: { printerId: 'PDF', copies: 1, language: 'it' } }) }) },
  { id: 'w2b-print-read-only', label: 'W2b · Read-only: labels as a PDF only (a label printer needs print.labels)', model: deep('readOnly', { print: print(['N-MAG-A-01'], { draft: { printerId: 'PDF', copies: 1, language: 'it' } }) }) },
  { id: 'w2b-print-quality', label: 'W2b · Quality (print.labels, does not manage places): bin A2 has no code yet — held, in words', model: deep('quality', { print: print(['N-MAG-A-01', 'N-MAG-A-02']) }) },
  { id: 'w2b-print-done', label: 'W2b · Printed: 2 jobs queued, 1 place left out', model: deep('warehouse', { print: print(['N-MAG-A-01', 'N-MAG-A-02', 'N-TRANSIT'], { done: { jobs: [{ locationId: LOCATIONS.binA1.id, labelCode: 'STAB-N-N-MAG-A-01', jobId: 'job-1', state: 'QUEUED' }, { locationId: LOCATIONS.binA2.id, labelCode: 'STAB-N-N-MAG-A-02', jobId: 'job-2', state: 'QUEUED' }], refused: [{ code: 'N-TRANSIT', key: 'wd.loc.label.refused.kind' }] } }) }) },
  // B-W2b-383 (XF8:05): the PDF opened, and the API gave one place no label (its x-labels-refused: changed since the page read it).
  { id: 'w2b-383-pdf-left-out', label: 'W2b · The PDF opened; 1 place got no label (changed since the page read it)', model: deep('warehouse', { print: print(['N-MAG-A-01', 'N-MAG-A-02'], { draft: { printerId: 'PDF', copies: 1, language: 'it' }, done: { jobs: [], refused: [], pdfLeftOut: 1 } }) }) },
  { id: 'w2b-new-customer', label: 'W2b · New location “At a customer” inside rack A: held (it sits at the top) and the customer to name', model: deep('warehouse', { parties: { status: 'ready', value: CUSTOMERS }, dialog: { kind: 'new', parentId: LOCATIONS.rackA.id, form: { parentId: LOCATIONS.rackA.id, code: 'N-CLI-01', name: 'Presso Moto Esempio', kind: 'CUSTOMER', partyId: null } } }) },
  { id: 'w2b-new-customer-top', label: 'W2b · New location “At a customer” at the top: the customer picked', model: deep('warehouse', { parties: { status: 'ready', value: CUSTOMERS }, dialog: { kind: 'new', parentId: null, form: { parentId: null, code: 'N-CLI-01', name: 'Presso Moto Esempio', kind: 'CUSTOMER', partyId: CUSTOMERS[0]!.id } } }) },
  { id: 'w2b-new-inside-pickface', label: 'W2b · New location inside a pick face: held (nothing sits inside it)', model: deep('warehouse', { dialog: { kind: 'new', parentId: at('N-PF-01').id, form: { parentId: at('N-PF-01').id, code: 'N-PF-01-A', name: 'Vaschetta A', kind: 'BIN', partyId: null } } }) },
  { id: 'w2b-blocked-notice', label: 'W2b · Blocked: “N-MAG-A-02 blocked.”', model: deep('warehouse', { notice: { tone: 'success', key: 'wd.loc.done.blocked', params: { code: 'N-MAG-A-02' } } }) },
]

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
    ...W2B_CASES,
  ],
})

