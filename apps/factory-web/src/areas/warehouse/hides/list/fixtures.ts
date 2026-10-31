import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, inShell, NOW, PREFIX, SITE, SITE_SOUTH, TIME_ZONE, WORK_ORDERS, type RoleCase } from '../../../_shared/stock/fixtures'
import { HIDE_COUNTS, HIDE_HOLDS, HIDE_MATCHING, HIDE_ROWS, printDialog, printedDialog, PRINTERS } from '../demo/fixtures'
import { dailyFor, HOLD_REASONS, PM_CAN, PM_DAILY, reserveDialog, writeOffDialog } from '../../lots/demo/daily/fixtures'
import { reserveHides, scrapTarget } from '../../lots/shared/daily'
import { phrase } from '../../../_shared/stock/model'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { DEFAULT_HIDE_VIEW, type HideFilters, type HidesListModel, type HideView } from '../model'
import { HidesListView } from './view/HidesListView'

/**
 * SCR-200 — Hides (Warehouse › Main) with made-up data only: a released nappa lot's hides (full, partly cut at the
 * cutting table, a remnant, one consumed, defects), three of a lot in quarantine, two suede hides of a lot whose Cr VI
 * failed (in m² and dm²); the tiles with two numbers each, the filter's two numbers in the band, the selection's Print N
 * tags (printer, copies, PDF fallback, job states with Retry) and Export, a lot filter from the lot record, and the page's
 * states. B-W2a-64: the Reserved tile and view, "Reserved for" (one done: release it), held hides with the hold's reason,
 * Reserve N hides to a work order (searching, the list, picked, hides left out, refused, done, no work orders) and Scrap
 * N hides (held: reserved or on hold; ready with a photo and an NCR; done). Roles: Owner, Warehouse (reserves and scraps),
 * Quality (scraps, does not reserve), Production manager (reserves), Read-only (no print right), Sales and Admin (no
 * inventory.stock.view).
 */

interface HidesCase {
  role: RoleCase
  list: HidesListModel
}

const NO_FILTERS: HideFilters = { lotId: null, grade: null, shade: null, locationId: null }
const inStock = HIDE_ROWS.filter((row) => row.state !== 'CONSUMED' && row.state !== 'SCRAPPED')

function listCase(role: RoleCase, over: Partial<HidesListModel> = {}, view: HideView = DEFAULT_HIDE_VIEW): HidesCase {
  const daily = dailyFor(role)
  return {
    role,
    list: {
      prefix: PREFIX,
      can: canFor(role),
      daily,
      holds: daily.holdsView ? HIDE_HOLDS : {},
      holdReasons: HOLD_REASONS,
      reserve: null,
      writeOff: null,
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
const WORK_ORDER_A = WORK_ORDERS.a.id
/** A photo already taken (made-up: no pixels, the dialog says its size). */
const DEMO_PHOTO: CapturedPhoto = { photo: new Blob([]), marks: [], marked: null, width: 1600, height: 1200, source: 'file' }
const reserved = HIDE_ROWS.filter((row) => row.reservedFor)
/** Hide 1 reserved, hide 2 on hold, hides 6 and 7: what a reservation can take of them. */
const toReserve = [HIDE_ROWS[0]!, HIDE_ROWS[1]!, HIDE_ROWS[6]!, HIDE_ROWS[7]!, HIDE_ROWS[9]!, HIDE_ROWS[10]!]
const reserveHidesOf = (rows = toReserve) => reserveHides(rows, HIDE_HOLDS, HOLD_REASONS, 'it')
const free = [HIDE_ROWS[1]!, HIDE_ROWS[5]!].map((row) => ({ ...row, reservedFor: null }))
const freeReserve = reserveHides([HIDE_ROWS[5]!, HIDE_ROWS[3]!].map((row) => ({ ...row, reservedFor: null })), {}, HOLD_REASONS, 'it')
const scrapRows = [HIDE_ROWS[3]!, HIDE_ROWS[5]!].map((row) => ({ ...row, reservedFor: null }))

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
    { id: 'quality', label: 'Quality: the hides with their lot’s quality, held ones with their hold’s reason', model: listCase('quality') },
    { id: 'tile-reserved', label: 'B-W2a-64 — Tile pressed: reserved (whole hides for a work order; one done: release it)', model: listCase('warehouse', { rows: { items: reserved, more: false, problem: null }, matching: HIDE_COUNTS.reserved! }, 'reserved') },
    { id: 'held-reasons', label: 'B-W2a-64 — A hide on hold by its own quality hold and a lot held: the reason in the row, never free', model: listCase('warehouse', { rows: { items: HIDE_ROWS, more: false, problem: null } }, 'all') },
    { id: 'selected-daily', label: 'B-W2a-64 — Two free hides selected: Reserve to a work order… and Scrap… with Print and Export', model: listCase('warehouse', { selected: free.map((row) => row.id), rows: { items: [...free, ...inStock.slice(2)], more: false, problem: null } }) },
    { id: 'reserve-held-role', label: 'B-W2a-64 — Quality: Reserve held in words (no inventory.reserve), Scrap allowed', model: listCase('quality', { selected: free.map((row) => row.id), rows: { items: [...free, ...inStock.slice(2)], more: false, problem: null } }) },
    { id: 'reserve-searching', label: 'B-W2a-64 — Reserve: looking for open work orders', model: listCase('warehouse', { reserve: reserveDialog(freeReserve, { workOrders: { value: null, problem: null } }) }) },
    { id: 'reserve-list', label: 'B-W2a-64 — Reserve 6 hides: 2 free, the rest left out with why (reserved, on hold, lot not released)', model: listCase('warehouse', { reserve: reserveDialog(reserveHidesOf()) }) },
    { id: 'reserve-picked', label: 'B-W2a-64 — Reserve 2 hides: a work order picked, a note', model: listCase('warehouse', { reserve: reserveDialog(freeReserve, { workOrderId: WORK_ORDER_A, note: 'Per il taglio di lunedì' }) }) },
    { id: 'reserve-refused', label: 'B-W2a-64 — Reserve refused: a hide was reserved meanwhile (HIDE_RESERVED, in our words)', model: listCase('warehouse', { reserve: reserveDialog(freeReserve, { workOrderId: WORK_ORDER_A, problem: phrase('reserve.refusal.HIDE_RESERVED') }) }) },
    { id: 'reserve-none-found', label: 'B-W2a-64 — Reserve: no open work order matches the search', model: listCase('warehouse', { reserve: reserveDialog(freeReserve, { query: 'zzz', workOrders: { value: [], problem: null } }) }) },
    { id: 'reserve-done', label: 'B-W2a-64 — Reserved: 2 hides for WO-D-0031', model: listCase('warehouse', { reserve: reserveDialog(freeReserve, { done: { count: 2, workOrder: 'WO-D-0031' } }) }) },
    { id: 'reserve-no-orders', label: 'B-W2a-64 — Reserve for a role without workorders.view: the picker says so in words', model: { role: 'warehouse', list: { ...listCase('warehouse').list, can: PM_CAN, daily: { ...PM_DAILY, workOrders: false }, reserve: reserveDialog(freeReserve, { canSeeWorkOrders: false, workOrders: { value: null, problem: null } }) } } },
    { id: 'production-manager', label: 'B-W2a-64 — Production manager: reserves, does not scrap (held in words)', model: { role: 'warehouse', list: { ...listCase('warehouse').list, can: PM_CAN, daily: PM_DAILY, selected: free.map((row) => row.id), rows: { items: [...free, ...inStock.slice(2)], more: false, problem: null } } } },
    { id: 'scrap-held', label: 'B-W2a-64 — Scrap 2 hides held: one is reserved, one on hold (each said in the list)', model: listCase('warehouse', { writeOff: writeOffDialog(scrapTarget([HIDE_ROWS[0]!, HIDE_ROWS[1]!], HIDE_HOLDS, null)) }) },
    {
      id: 'scrap-ready',
      label: 'B-W2a-64 — Scrap 2 hides (owner, cost grain): reason, note, a photo ready, open an NCR, the value leaving',
      model: listCase('owner', {
        writeOff: writeOffDialog(scrapTarget(scrapRows, {}, { amount: 38_220, currency: 'EUR' }), {
          withCost: true,
          draft: { reasonCode: 'DAMAGED', note: 'Macchie d’acqua sul fiore', reference: '', quantity: '', photo: DEMO_PHOTO, photoStep: false, openNcr: true, ncrSeverity: 'MAJOR' },
        }),
      }),
    },
    { id: 'scrap-other', label: 'B-W2a-64 — Scrap: the reason “Other” asks for a note (held in words)', model: listCase('warehouse', { writeOff: writeOffDialog(scrapTarget(scrapRows, {}, null), { draft: { reasonCode: 'OTHER', note: '', reference: '', quantity: '', photo: null, photoStep: false, openNcr: false, ncrSeverity: '' } }) }) },
    { id: 'scrap-refused', label: 'B-W2a-64 — Scrap refused: the hide went on hold meanwhile (QUALITY_HOLD, in our words)', model: listCase('warehouse', { writeOff: writeOffDialog(scrapTarget(scrapRows, {}, null), { draft: { reasonCode: 'DAMAGED', note: 'Strappo', reference: '', quantity: '', photo: null, photoStep: false, openNcr: false, ncrSeverity: '' }, problem: phrase('wo.problem.onHold') }) }) },
    {
      id: 'scrap-done',
      label: 'B-W2a-64 — Scrapped: 2 moves, the value, the photo sent, the NCR opened',
      model: listCase('owner', { writeOff: writeOffDialog(scrapTarget(scrapRows, {}, null), { withCost: true, done: { writeOffId: scrapRows[0]!.id, moves: 2, value: { amount: 38_220, currency: 'EUR' }, photo: 'sent', ncr: { state: 'sent', id: scrapRows[0]!.id, number: 'NC-D-0004' }, overReserved: 0 } }) }),
    },
    { id: 'scrap-done-failed', label: 'B-W2a-64 — Scrapped, but the photo and the NCR failed: each with Try again', model: listCase('warehouse', { writeOff: writeOffDialog(scrapTarget(scrapRows, {}, null), { done: { writeOffId: scrapRows[0]!.id, moves: 2, value: null, photo: 'failed', ncr: { state: 'failed', id: null, number: null }, overReserved: 1 } }) }) },
    { id: 'read-only', label: 'Read-only: a hide selected, Print held in words (no print right)', model: listCase('readOnly', { selected: [inStock[0]!.id] }) },
    { id: 'scan', label: 'A scanned tag (several hits filter the list)', model: listCase('warehouse', { q: 'HD-DM', rows: { items: inStock.slice(0, 4), more: false, problem: null } }, 'all') },
    { id: 'keys', label: 'The keys (footer icon, ?)', model: listCase('warehouse', { helpOpen: true }) },
    { id: 'updates', label: 'Live: 3 updates waiting, one site only', model: listCase('warehouse', { updates: 3, sites: [SITE] }) },
    { id: 'loading', label: 'Loading', model: listCase('warehouse', { rows: { items: null, more: false, problem: null }, counts: null, matching: null, asOf: null }) },
    { id: 'error', label: "The hides couldn't be read", model: listCase('warehouse', { rows: { items: null, more: false, problem: 'problem.offline' }, counts: null, matching: null }) },
    { id: 'empty', label: 'No hides yet', model: listCase('warehouse', { rows: { items: [], more: false, problem: null }, counts: { full: { hides: 0, area: [] }, partlyCut: { hides: 0, area: [] }, remnant: { hides: 0, area: [] }, quarantine: { hides: 0, area: [] }, consumed: { hides: 0, area: [] }, reserved: { hides: 0, area: [] } }, matching: { hides: 0, area: [] } }, 'all') },
    { id: 'no-match', label: 'Nothing matches', model: listCase('warehouse', { q: 'ZZZ', rows: { items: [], more: false, problem: null }, matching: { hides: 0, area: [] } }) },
    { id: 'sales', label: 'Sales: no inventory.stock.view (the page says so)', model: listCase('sales') },
    { id: 'admin', label: 'Admin: no inventory.stock.view (the page says so)', model: listCase('admin') },
  ],
})
