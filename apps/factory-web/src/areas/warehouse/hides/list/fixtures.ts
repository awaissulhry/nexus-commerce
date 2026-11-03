import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, inShell, NOW, PREFIX, ROLE_PERMISSIONS, SITE, SITE_SOUTH, TIME_ZONE, WORK_ORDERS, type RoleCase } from '../../../_shared/stock/fixtures'
import { dashboardModel, findModel, FIND_ANSWER, MOVABLE_IDS, MOVE_TO, moveModel, REMNANT_RECORD, REMNANT_ROWS, REMNANT_TOTALS, remnantsModel } from '../demo/w2b/fixtures'
import { emptyDraft } from '../find/find-model'
import { HIDE_PHOTOS, lightboxOn } from '../photos/fixtures'
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
 * N hides (held: reserved or on hold; ready with a photo and an NCR; done). B-W2b-131: Find hides for a job (for a work order:
 * the proposal chosen, the running area; by article; mixing shades held or with the override's reason; a shade refusal; done),
 * Move N hides (left out with why, the place, the results), the Remnants tile as pieces and the Remnants view as the tagged
 * pieces (one opened with its history), the Photo column and its Lightbox (hd-photo). Roles: Owner, Warehouse (reserves and scraps),
 * Quality (scraps, does not reserve), Production manager (reserves), Read-only (no print right), Sales and Admin (no
 * inventory.stock.view).
 */

interface HidesCase {
  role: RoleCase
  list: HidesListModel
}

const NO_FILTERS: HideFilters = { lotId: null, grade: null, shade: null, locationId: null, itemId: null, itemColourId: null }
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
      // B-W2b-131: the dashboard hidden here (SCR-134 shows it), the remnant pieces' tile, Move… by the role's right.
      dashboard: dashboardModel({ open: false, cost: daily.cost }),
      remnantTotals: REMNANT_TOTALS,
      canTransfer: (ROLE_PERMISSIONS[role] as readonly string[]).includes('inventory.transfer'),
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
    { id: 'find', label: 'B-W2b-131 — Find hides for a job (WO-D-0031): one shade lot proposed, 4 hides chosen covering the need, the other lot and an out-of-shade remnant below', model: listCase('warehouse', { find: findModel() }) },
    { id: 'find-start', label: 'B-W2b-131 — Find hides: nothing asked yet (pick a work order or an article and the area)', model: listCase('warehouse', { find: findModel({ draft: emptyDraft('workOrder'), result: null, chosen: [] }) }) },
    {
      id: 'find-article',
      label: 'B-W2b-131 — Find by article and area: 150 ft² asked, the work order to reserve for picked under the list',
      model: listCase('warehouse', { find: findModel({ draft: { ...emptyDraft('article'), articleKey: `${FIND_ANSWER.item.id}|${FIND_ANSWER.colour!.id}`, area: '150', uom: 'FT2', workOrderId: WORK_ORDERS.b.id }, result: { value: { ...FIND_ANSWER, workOrder: null, ordersShadeLots: [], need: { baseArea: '150.0000', source: 'ASKED' } }, problem: null } }) }),
    },
    {
      id: 'find-short',
      label: 'B-W2b-131 — Find: two hides chosen, short of the need (said in words)',
      model: listCase('warehouse', { find: findModel({ chosen: FIND_ANSWER.proposal!.hideIds.slice(0, 2) }) }),
    },
    {
      id: 'find-mix-held',
      label: 'B-W2b-131 — Find: a hide of another shade lot chosen — Reserve held (no shade override)',
      model: listCase('warehouse', { find: findModel({ chosen: [...FIND_ANSWER.proposal!.hideIds, FIND_ANSWER.lots[1]!.hides[0]!.hideId] }) }),
    },
    {
      id: 'find-mix-override',
      label: 'B-W2b-131 — Find: mixing shades with the override: the reason asked, kept with the reservation',
      model: listCase('owner', { find: findModel({ chosen: [...FIND_ANSWER.proposal!.hideIds, FIND_ANSWER.lots[1]!.hides[0]!.hideId], can: { reserve: true, override: true, workOrders: true, grades: true }, overrideReason: 'Concordato con il cliente: pannelli interni' }) }),
    },
    {
      id: 'find-refused',
      label: 'B-W2b-131 — Reserve refused: a hide is of another shade lot (SHADE_LOT, in our words, naming it)',
      model: listCase('warehouse', { find: findModel({ problem: { key: 'find.refusal.SHADE_LOT', params: { count: 1, hides: FIND_ANSWER.lots[1]!.hides[0]!.hideCode } } }) }),
    },
    { id: 'find-none', label: 'B-W2b-131 — Find: no free hide matches', model: listCase('warehouse', { find: findModel({ result: { value: { ...FIND_ANSWER, lots: [], outOfShade: [], proposal: null }, problem: null }, chosen: [] }) }) },
    { id: 'find-error', label: "B-W2b-131 — Find: the hides couldn't be found (Try again)", model: listCase('warehouse', { find: findModel({ result: { value: null, problem: 'stock:problem.offline' }, chosen: [] }) }) },
    { id: 'find-which-leather', label: 'B-W2b-131 — Find: the work order cuts two leathers — pick the leather (asked in words)', model: listCase('warehouse', { find: findModel({ result: { value: null, problem: 'find.problem.whichLeather' }, chosen: [] }) }) },
    { id: 'find-no-reserve', label: 'B-W2b-131 — Quality: finds hides, Reserve held in words (no inventory.reserve)', model: listCase('quality', { find: findModel({ can: { reserve: false, override: true, workOrders: true, grades: true } }) }) },
    { id: 'find-done', label: 'B-W2b-131 — Reserved: 4 hides for WO-D-0031', model: listCase('warehouse', { find: findModel({ done: { count: 4, workOrder: WORK_ORDERS.a.number } }) }) },
    { id: 'move-selected', label: 'B-W2b-131 — Three hides selected: Move 3… beside Print, Reserve, Scrap', model: listCase('warehouse', { selected: MOVABLE_IDS }) },
    { id: 'move', label: 'B-W2b-131 — Move 3 hides: one at the cutting table left out with why, the place picked', model: listCase('warehouse', { move: moveModel({ toLocationId: MOVE_TO }) }) },
    { id: 'move-pick', label: 'B-W2b-131 — Move: the place not picked yet (Move held in words)', model: listCase('warehouse', { move: moveModel() }) },
    {
      id: 'move-done',
      label: 'B-W2b-131 — Moved: one moved, one refused (the stock was not there any more), each said',
      model: listCase('warehouse', { move: moveModel({ toLocationId: MOVE_TO, results: { [MOVABLE_IDS[0]!]: { moved: true }, [MOVABLE_IDS[1]!]: { moved: false, problem: { key: 'stock:problem.notEnough' } } } }) }),
    },
    { id: 'move-no-right', label: 'B-W2b-131 — Quality: Move held in words (no inventory.transfer)', model: listCase('quality', { selected: MOVABLE_IDS, canTransfer: false }) },
    { id: 'remnants', label: 'B-W2b-131 — Remnants view: the tagged pieces (RM tags), pieces beside area, the smallest piece kept', model: listCase('warehouse', { remnants: remnantsModel() }, 'remnants') },
    { id: 'remnant-open', label: 'B-W2b-131 — One remnant piece opened: its facts and history (a floor action by its audience only)', model: listCase('warehouse', { remnants: remnantsModel({ open: { id: REMNANT_ROWS[0]!.id, value: REMNANT_RECORD, problem: null } }) }, 'remnants') },
    { id: 'remnants-empty', label: 'B-W2b-131 — Remnants view: no pieces in stock', model: listCase('warehouse', { remnantTotals: [], remnants: remnantsModel({ rows: { items: [], more: false, problem: null }, totals: [] }) }, 'remnants') },
    { id: 'remnants-error', label: "B-W2b-131 — Remnants view: the pieces couldn't be read", model: listCase('warehouse', { remnantTotals: null, remnants: remnantsModel({ rows: { items: null, more: false, problem: 'problem.offline' }, totals: null }) }, 'remnants') },
    {
      id: 'photos',
      label: 'B-W2b-131 — The Photo column (files.read): the newest photo of a hide, — where none',
      model: listCase('owner', { photos: { canRead: true, byHide: { [inStock[0]!.id]: HIDE_PHOTOS, [inStock[2]!.id]: HIDE_PHOTOS.slice(1) }, loading: false, problem: null } }),
    },
    {
      id: 'photo-lightbox',
      label: 'B-W2b-131 — A Thumbnail pressed: the hide photo (photo 2 of 3) with its place and time',
      model: listCase('owner', { photos: { canRead: true, byHide: { [inStock[0]!.id]: HIDE_PHOTOS }, loading: false, problem: null }, lightbox: lightboxOn(inStock[0]!.id, inStock[0]!.code, 1) }),
    },
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
