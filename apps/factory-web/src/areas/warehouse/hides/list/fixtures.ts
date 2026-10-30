import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, inShell, NOW, PREFIX, SITE, SITE_SOUTH, TIME_ZONE, type RoleCase } from '../../../_shared/stock/fixtures'
import { HIDE_COUNTS, HIDE_MATCHING, HIDE_ROWS, printDialog, printedDialog, PRINTERS } from '../demo/fixtures'
import { DEFAULT_HIDE_VIEW, type HideFilters, type HidesListModel, type HideView } from '../model'
import { HidesListView } from './view/HidesListView'

/**
 * SCR-200 — Hides (Warehouse › Main) with made-up data only: a released nappa lot's hides (full, partly cut at the
 * cutting table, a remnant, one consumed, defects), three of a lot in quarantine, two suede hides of a lot whose Cr VI
 * failed (in m² and dm²); the tiles with two numbers each, the filter's two numbers in the band, the selection's Print N
 * tags (printer, copies, PDF fallback, job states with Retry) and Export, a lot filter from the lot record, and the page's
 * states. Roles: Owner, Warehouse, Quality, Read-only (no print right), Sales and Admin (no inventory.stock.view).
 */

interface HidesCase {
  role: RoleCase
  list: HidesListModel
}

const NO_FILTERS: HideFilters = { lotId: null, grade: null, shade: null, locationId: null }
const inStock = HIDE_ROWS.filter((row) => row.state !== 'CONSUMED' && row.state !== 'SCRAPPED')

function listCase(role: RoleCase, over: Partial<HidesListModel> = {}, view: HideView = DEFAULT_HIDE_VIEW): HidesCase {
  return {
    role,
    list: {
      prefix: PREFIX,
      can: canFor(role),
      view,
      q: '',
      filters: NO_FILTERS,
      sites: [SITE, SITE_SOUTH],
      siteId: null,
      rows: { items: inStock, more: false, problem: null },
      counts: HIDE_COUNTS,
      matching: HIDE_MATCHING,
      asOf: NOW,
      live: 'live',
      updates: 0,
      timeZone: TIME_ZONE,
      print: null,
      ...over,
    },
  }
}

function HidesDesign({ model }: { model: HidesCase }) {
  return inShell('/warehouse/hides', createElement(HidesListView, { model: model.list }), model.role)
}

const three = inStock.slice(0, 3)

export const designScreen = defineDesignScreen<HidesCase>({
  screen: 'SCR-200',
  title: 'Hides (every hide one by one: area, grade, shade, lot, state, place)',
  view: HidesDesign,
  cases: [
    { id: 'in-stock', label: 'Warehouse: the hides in stock (default view)', model: listCase('warehouse'), note: 'Tag → the hide; lot → the lot record. A consumed hide is not in this view.' },
    { id: 'owner-all', label: 'Owner: every hide, consumed too', model: listCase('owner', { rows: { items: HIDE_ROWS, more: true, problem: null } }, 'all') },
    { id: 'tile-partly-cut', label: 'Tile pressed: partly cut (at the cutting table, what is left)', model: listCase('warehouse', { rows: { items: HIDE_ROWS.filter((row) => row.state === 'PARTLY_CUT'), more: false, problem: null }, matching: HIDE_COUNTS.partlyCut }, 'partlyCut') },
    { id: 'tile-quarantine', label: 'Tile pressed: in quarantine (the lot waits for Cr VI)', model: listCase('quality', { rows: { items: HIDE_ROWS.filter((row) => row.lot.qualityStatus === 'QUARANTINE'), more: false, problem: null }, matching: HIDE_COUNTS.quarantine }, 'quarantine') },
    { id: 'lot-filter', label: 'Opened from a lot: the lot filter, removable', model: listCase('warehouse', { filters: { ...NO_FILTERS, lotId: HIDE_ROWS[0]!.lot.id }, rows: { items: HIDE_ROWS.slice(0, 6), more: false, problem: null } }, 'all') },
    { id: 'selected', label: 'Three hides selected: Print 3 tags, Export 3, the area left of the selection', model: listCase('warehouse', { selected: three.map((row) => row.id) }) },
    { id: 'print', label: 'Print 3 tags: printer and copies, the tag as it prints', model: listCase('warehouse', { selected: three.map((row) => row.id), print: printDialog(three.map((row) => row.id)) }) },
    { id: 'print-jobs', label: 'Tags sent: printed, sent, failed + Retry', model: listCase('warehouse', { selected: three.map((row) => row.id), print: printedDialog(three) }) },
    { id: 'print-no-printer', label: 'No label printer at the site: the tags as a PDF in the browser', model: listCase('warehouse', { selected: three.map((row) => row.id), print: printDialog(three.map((row) => row.id), { printers: { value: [], problem: null }, printerId: null }) }) },
    { id: 'print-pick', label: 'Two printers: pick one first (Print held)', model: listCase('owner', { selected: three.map((row) => row.id), print: printDialog(three.map((row) => row.id), { printers: { value: PRINTERS, problem: null }, printerId: null }) }) },
    { id: 'quality', label: 'Quality: the hides with their lot’s quality', model: listCase('quality') },
    { id: 'read-only', label: 'Read-only: a hide selected, Print held in words (no print right)', model: listCase('readOnly', { selected: [inStock[0]!.id] }) },
    { id: 'scan', label: 'A scanned tag (several hits filter the list)', model: listCase('warehouse', { q: 'HD-DM', rows: { items: inStock.slice(0, 4), more: false, problem: null } }, 'all') },
    { id: 'keys', label: 'The keys (footer icon, ?)', model: listCase('warehouse', { helpOpen: true }) },
    { id: 'updates', label: 'Live: 3 updates waiting, one site only', model: listCase('warehouse', { updates: 3, sites: [SITE] }) },
    { id: 'loading', label: 'Loading', model: listCase('warehouse', { rows: { items: null, more: false, problem: null }, counts: null, matching: null, asOf: null }) },
    { id: 'error', label: "The hides couldn't be read", model: listCase('warehouse', { rows: { items: null, more: false, problem: 'problem.offline' }, counts: null, matching: null }) },
    { id: 'empty', label: 'No hides yet', model: listCase('warehouse', { rows: { items: [], more: false, problem: null }, counts: { full: { hides: 0, area: [] }, partlyCut: { hides: 0, area: [] }, remnant: { hides: 0, area: [] }, quarantine: { hides: 0, area: [] }, consumed: { hides: 0, area: [] } }, matching: { hides: 0, area: [] } }, 'all') },
    { id: 'no-match', label: 'Nothing matches', model: listCase('warehouse', { q: 'ZZZ', rows: { items: [], more: false, problem: null }, matching: { hides: 0, area: [] } }) },
    { id: 'sales', label: 'Sales: no inventory.stock.view (the page says so)', model: listCase('sales') },
    { id: 'admin', label: 'Admin: no inventory.stock.view (the page says so)', model: listCase('admin') },
  ],
})
