import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { ItemRef, LotCounts, Named, PastStockRow, QualityStatus, ReservedKey, StockRow } from '../../_shared/stock/api'
import { canFor, COLOURS, inShell, ITEMS, LOCATIONS, LOTS, named, NOW, PREFIX, ROLE_PERMISSIONS, SITE, SITE_SOUTH, stockRow, TIME_ZONE, uid, WORK_ORDERS, type RoleCase } from '../../_shared/stock/fixtures'
import { blankDraft, type AdjustDialogModel, type AdjustTarget } from './adjust/model'
import type { HoldPreview } from './daily/api'
import type { HoldDialogModel } from './daily/dialog-model'
import { blankHold } from './daily/model'
import { HOLD_REASONS, holdOf } from './demo/fixtures'
import { dailyCan, holdSubjectsOf, stockAddressOf, stockLines, type StockAddress, type StockPageModel } from './model'
import { StockView } from './view/StockView'

/**
 * SCR-060 — Stock (design warehouse.stock) with made-up data only: a released nappa lot in two places (hides one by
 * one, folded per place), a nappa lot in quarantine waiting for its Cr VI result, a suede lot blocked after a Cr VI fail,
 * a lining lot, protectors in quarantine (PPE documents), zips without a lot; values with the cost grain only. Cases:
 * the views (by material, by lot, by place, leather one row per hide, on hold), the tiles as filters, a search, a
 * selection with its totals, Adjust stock (empty, a decrease too large, refused because the stock went meanwhile,
 * posted), the notices, live updates, several sites, and the states (loading, error, empty, no permission).
 * B-W2a-64: what reservations hold per row (a hide reserved whole, a lot and an any-lot reservation placed on its rows,
 * one key over-reserved), a quality hold's reason on a row, stock as of 30 Sep (the pill, the read-only notice, every
 * change held) and its dialog, Put N lots on hold (who may, the reach, refused, done), and the phone card list.
 */

type Case = { role: RoleCase; page: StockPageModel }

const hideRow = (n: number, lot: { id: string; code: string }, quality: QualityStatus, location: typeof LOCATIONS.store, area: number, cost: string | null, item: ItemRef = ITEMS.leather, colour: Named = COLOURS.black): StockRow => {
  const onHand = area.toFixed(4)
  const held = quality === 'RELEASED' ? '0.0000' : onHand
  return stockRow({
    item,
    location: named(location),
    colour,
    lot: { id: lot.id, code: lot.code, qualityStatus: quality },
    hide: { id: uid('8282', n), code: `HD-DEMO-${String(n).padStart(4, '0')}` },
    onHand,
    held,
    available: quality === 'RELEASED' ? onHand : '0.0000',
    unitCost: cost,
    value: cost ? Math.round(area * Number(cost) * 100) : null,
  })
}

export const ROWS: StockRow[] = [
  hideRow(1, LOTS.nappa, 'RELEASED', LOCATIONS.binA1, 52.4, '6.850000'),
  hideRow(2, LOTS.nappa, 'RELEASED', LOCATIONS.binA1, 51.8, '6.850000'),
  hideRow(3, LOTS.nappa, 'RELEASED', LOCATIONS.binA1, 50.9, '6.850000'),
  hideRow(4, LOTS.nappa, 'RELEASED', LOCATIONS.binA1, 49.6, '6.850000'),
  hideRow(5, LOTS.nappa, 'RELEASED', LOCATIONS.binA1, 53.1, '6.850000'),
  hideRow(6, LOTS.nappa, 'RELEASED', LOCATIONS.cutting, 31.2, '6.850000'),
  hideRow(7, LOTS.nappa, 'RELEASED', LOCATIONS.cutting, 12.5, '6.850000'),
  hideRow(11, LOTS.nappaQuarantine, 'QUARANTINE', LOCATIONS.quarantine, 48.2, '7.100000'),
  hideRow(12, LOTS.nappaQuarantine, 'QUARANTINE', LOCATIONS.quarantine, 47.5, '7.100000'),
  hideRow(13, LOTS.nappaQuarantine, 'QUARANTINE', LOCATIONS.quarantine, 50.3, '7.100000'),
  hideRow(21, LOTS.suedeFail, 'BLOCKED', LOCATIONS.quarantine, 4.6, '58.000000', ITEMS.suede, COLOURS.grey),
  hideRow(22, LOTS.suedeFail, 'BLOCKED', LOCATIONS.quarantine, 4.4, '58.000000', ITEMS.suede, COLOURS.grey),
  stockRow({ item: ITEMS.lining, location: named(LOCATIONS.binA2), colour: COLOURS.black, lot: { id: LOTS.lining.id, code: LOTS.lining.code, qualityStatus: 'RELEASED' }, onHand: '120.0000', held: '0.0000', available: '120.0000', unitCost: '3.100000', value: 37_200 }),
  stockRow({ item: ITEMS.lining, location: named(LOCATIONS.cutting), colour: COLOURS.black, lot: { id: LOTS.lining.id, code: LOTS.lining.code, qualityStatus: 'RELEASED' }, onHand: '20.0000', held: '0.0000', available: '20.0000', unitCost: '3.100000', value: 6_200 }),
  stockRow({ item: ITEMS.protector, location: named(LOCATIONS.receiving), lot: { id: LOTS.protector.id, code: LOTS.protector.code, qualityStatus: 'QUARANTINE' }, onHand: '48.0000', held: '48.0000', available: '0.0000', unitCost: '4.000000', value: 19_200 }),
  stockRow({ item: ITEMS.zip, location: named(LOCATIONS.binA2), onHand: '300.0000', held: '0.0000', available: '300.0000', unitCost: null, value: null }),
]
/** The same stock with the reservations the API answers: hide HD-DEMO-0001 reserved whole (its row's own `reserved`). */
const RESERVED_ROWS: StockRow[] = ROWS.map((row, index) => (index === 0 ? { ...row, reserved: row.onHand, available: '0.0000' } : { ...row, reserved: '0.0000' }))
/** Per key: the nappa lot (its hide's 52,4 ft² plus 80 ft² by area for WO-D-0032), lining by any lot (30 m). */
const RESERVATIONS: ReservedKey[] = [
  { siteId: SITE.id, itemId: ITEMS.leather.id, itemColourId: COLOURS.black.id, lotId: LOTS.nappa.id, reserved: '132.4000', reservations: 2, stale: 0 },
  { siteId: SITE.id, itemId: ITEMS.lining.id, itemColourId: COLOURS.black.id, lotId: null, reserved: '30.0000', reservations: 1, stale: 0 },
]
/** One key reserved beyond what is free: the suede lot is blocked, yet 6 m² of it are reserved for a work order. */
const OVER: ReservedKey[] = [...RESERVATIONS, { siteId: SITE.id, itemId: ITEMS.suede.id, itemColourId: COLOURS.grey.id, lotId: null, reserved: '6.0000', reservations: 1, stale: 0 }]
/** The lining lot under a quality hold (its stock counts as held: the API's rows say so). */
const HELD_ROWS: StockRow[] = RESERVED_ROWS.map((row) => (row.lot?.id === LOTS.lining.id ? { ...row, held: row.onHand, available: '0.0000' } : row))
const HOLDS = [holdOf(1, 'Lot', [LOTS.lining], 'SUPPLIER_CHECK', 28)]
/** As of 30 Sep 2026 23:59 (Rome): the moves up to then; held, reserved and available are not kept for past days. */
const AS_OF = '2026-09-30T21:59:59.999Z'
const PAST_ROWS: PastStockRow[] = ROWS.filter((row) => row.lot?.id !== LOTS.nappaQuarantine.id && row.lot?.id !== LOTS.suedeFail.id).map((row) => ({ ...row, held: null, reserved: null, available: null }))
const SOUTH_ROWS: StockRow[] = [
  stockRow({ siteId: SITE_SOUTH.id, siteCode: SITE_SOUTH.code, item: ITEMS.zip, location: { id: uid('2323', 41), code: 'S-MAG', name: 'Magazzino sud' }, onHand: '120.0000', held: '0.0000', available: '120.0000' }),
]
const COUNTS: LotCounts = { quarantine: 2, waitingCrVi: 1, crViFailed: 1, blocked: 1, rejected: 0, released: 2 }
const CURRENCIES = Object.fromEntries(Object.values(ITEMS).map((item) => [item.id, 'EUR']))
const withoutCost = <Row extends PastStockRow>(rows: Row[]) => rows.map(({ unitCost: _cost, value: _value, ...row }) => row)

function page(role: RoleCase, over: Partial<StockPageModel> = {}, address: Partial<StockAddress> = {}): Case {
  const can = canFor(role)
  return {
    role,
    page: {
      prefix: PREFIX,
      can,
      address: { ...stockAddressOf(null), ...address },
      sites: [],
      rows: can.cost ? RESERVED_ROWS : withoutCost(RESERVED_ROWS),
      daily: dailyCan(ROLE_PERMISSIONS[role]),
      reservations: RESERVATIONS,
      holds: [],
      holdReasons: HOLD_REASONS,
      now: NOW,
      problem: null,
      truncated: false,
      counts: COUNTS,
      crViLots: [LOTS.nappaQuarantine.id],
      unvalued: can.cost ? 0 : null,
      currencies: CURRENCIES,
      asOf: NOW,
      live: 'live',
      updates: 0,
      dismissed: [],
      timeZone: TIME_ZONE,
      notice: null,
      adjust: null,
      ...over,
    },
  }
}

const TARGET: AdjustTarget = { siteId: SITE.id, siteCode: SITE.code, item: ITEMS.leather, colour: COLOURS.black, lot: LOTS.nappa, hide: { id: uid('8282', 6), code: 'HD-DEMO-0006' }, location: named(LOCATIONS.cutting), onHand: '31.2000' }
const LINING_TARGET: AdjustTarget = { siteId: SITE.id, siteCode: SITE.code, item: ITEMS.lining, colour: COLOURS.black, lot: LOTS.lining, hide: null, location: named(LOCATIONS.binA2), onHand: '120.0000' }
const PLACES = Object.values(LOCATIONS).filter((place) => place.status === 'ACTIVE').map(named)
const adjust = (over: Partial<AdjustDialogModel> = {}, target: AdjustTarget = TARGET, withCost = false): AdjustDialogModel => ({ target, draft: blankDraft(target), locations: PLACES, withCost, posting: false, problem: null, ...over })

/** The hold dialog over the two lots of a selection (the nappa lot and the lining lot), as useHold builds it. */
const holdLines = stockLines(RESERVED_ROWS, false, false).filter((line) => line.lot?.id === LOTS.nappa.id || line.lot?.id === LOTS.lining.id || line.item.id === ITEMS.zip.id)
const HOLD_SUBJECTS = holdSubjectsOf(holdLines)
const PREVIEW: HoldPreview = {
  siteId: SITE.id,
  subjects: HOLD_SUBJECTS.subjects.map((subject) => ({ id: subject.id, code: subject.code, label: subject.code, state: 'RELEASED', quantity: null, problem: null })),
  quantity: null,
  workOrders: [],
  quarantinePlaces: [named(LOCATIONS.quarantine)],
}
const hold = (over: Partial<HoldDialogModel> = {}): HoldDialogModel => ({
  subjectType: 'Lot',
  subjects: HOLD_SUBJECTS.subjects,
  leftOut: HOLD_SUBJECTS.leftOut,
  preview: { value: PREVIEW, problem: null },
  reservedBy: { value: [WORK_ORDERS.a.number, WORK_ORDERS.b.number], problem: null },
  reasons: { value: HOLD_REASONS, problem: null },
  draft: blankHold(),
  posting: false,
  problem: null,
  done: null,
  ...over,
})
const REJECTED_PREVIEW: HoldPreview = { ...PREVIEW, subjects: [{ ...PREVIEW.subjects[0]!, state: 'REJECTED', problem: 'Lot is rejected.' }, ...PREVIEW.subjects.slice(1)] }
const lineId = (row: StockRow) => `${SITE.id}|${row.location.id}|${row.item.id}|${row.colour?.id ?? '-'}|${row.lot?.id ?? '-'}|-`

function StockDesign({ model }: { model: Case }) {
  return inShell('/warehouse/stock', createElement(StockView, { model: model.page }), model.role)
}

const rowId = (n: number) => ROWS.length > n ? `${SITE.id}|${ROWS[n]!.location.id}|${ROWS[n]!.item.id}|${ROWS[n]!.colour?.id ?? '-'}|${ROWS[n]!.lot?.id ?? '-'}|-` : ''

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-060',
  title: 'Stock (by material, lot and place; tiles, notices, Adjust stock)',
  view: StockDesign,
  cases: [
    { id: 'owner', label: 'Owner: stock by material with unit costs and values (cost grain), the notices and tiles', model: page('owner'), note: 'Every on-hand figure opens Movements for that stock key, explained.' },
    { id: 'warehouse', label: 'Warehouse: the same rows without any money (no cost grain: the columns are absent)', model: page('warehouse') },
    { id: 'by-lot', label: 'Rows ▾ By lot', model: page('warehouse', {}, { view: 'lot' }) },
    { id: 'by-location', label: 'Rows ▾ By place', model: page('warehouse', {}, { view: 'location' }) },
    { id: 'leather', label: 'Rows ▾ Leather: one row per hide (each adjustable)', model: page('warehouse', {}, { view: 'leather' }) },
    { id: 'on-hold', label: 'Rows ▾ On hold: lots not released, why each waits', model: page('warehouse', {}, { view: 'quarantine' }) },
    { id: 'tile-crvi', label: 'Tile pressed: waiting for the Cr VI result (its chip removable)', model: page('warehouse', {}, { tile: 'crvi' }) },
    { id: 'tile-blocked', label: 'Tile pressed: blocked or rejected', model: page('owner', {}, { tile: 'blocked' }) },
    { id: 'search', label: 'A search (a scanned lot code filters to it)', model: page('warehouse', {}, { q: 'LOT-D-000104' }) },
    { id: 'search-empty', label: 'A search that matches nothing', model: page('warehouse', {}, { q: 'zzz' }) },
    { id: 'selection', label: 'Two rows selected: Export 2 with their totals per unit', model: page('owner', { selected: [rowId(0), rowId(12)] }) },
    { id: 'adjust', label: 'Adjust stock on one hide: Down, the reason, the preview', model: page('warehouse', { adjust: adjust({ draft: { ...blankDraft(TARGET), quantity: '1,5', note: 'Bordo rovinato in taglio' } }) }) },
    { id: 'adjust-up-cost', label: 'Adjust up at another place with a unit cost (owner, cost grain)', model: page('owner', { adjust: adjust({ draft: { ...blankDraft(LINING_TARGET), direction: 'IN', locationId: LOCATIONS.binA1.id, quantity: '12', note: 'Rotolo ritrovato in conta', reference: 'Conta 30/10', unitCost: '3,10' } }, LINING_TARGET, true) }) },
    { id: 'adjust-too-much', label: 'Adjust held: a decrease larger than what is there', model: page('warehouse', { adjust: adjust({ draft: { ...blankDraft(TARGET), quantity: '40', note: 'Errore' } }) }) },
    { id: 'adjust-empty', label: 'Adjust just opened: Post held with the missing field named', model: page('warehouse', { adjust: adjust() }) },
    { id: 'adjust-refused', label: 'Adjust refused: the stock went meanwhile (409, in our words)', model: page('warehouse', { adjust: adjust({ draft: { ...blankDraft(TARGET), quantity: '2', note: 'Scarto' }, problem: { key: 'adj.problem.notEnough' } }) }) },
    { id: 'adjusted', label: 'Adjustment posted: the notice, the figures read again', model: page('warehouse', { notice: { tone: 'success', key: 'adj.done.down', params: { code: 'DEMO-LEA-01', place: 'N-TAG' } } }) },
    { id: 'notices-more', label: 'Several notices: the most serious first, the rest behind "2 more"', model: page('owner', { truncated: true, unvalued: 4 }) },
    { id: 'live', label: 'Live: 3 moves posted meanwhile ("3 updates · Show"; rows never move under the reader)', model: page('warehouse', { updates: 3 }) },
    { id: 'sites', label: 'Several sites: the site picker, the site beside each place', model: page('owner', { sites: [SITE, SITE_SOUTH], rows: [...ROWS, ...SOUTH_ROWS] }) },
    { id: 'quality', label: 'Quality inspector: sees stock, adjusts nothing (Adjust held with its reason)', model: page('quality') },
    { id: 'read-only', label: 'Read-only: sees, changes nothing', model: page('readOnly') },
    { id: 'keys', label: 'Keyboard shortcuts', model: page('warehouse', { helpOpen: true }) },
    { id: 'empty', label: 'First day: no stock yet (Receive goods · Import opening stock)', model: page('owner', { rows: [], counts: { quarantine: 0, waitingCrVi: 0, crViFailed: 0, blocked: 0, rejected: 0, released: 0 }, crViLots: [] }) },
    { id: 'loading', label: 'Loading', model: page('warehouse', { rows: null, counts: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The stock couldn't be read (never drawn as an empty list)", model: page('warehouse', { rows: null, problem: 'problem.offline', counts: null, asOf: null, live: 'offline' }) },
    { id: 'admin', label: 'Administrator: no inventory.stock.view — the page says so', model: page('admin') },
    // B-W2a-64 — reservations, holds, stock as of a date, Put on hold, the phone cards.
    { id: 'reserved', label: 'Reserved: a hide reserved whole, the lot’s and the any-lot reservations placed on its rows; available what is left', model: page('warehouse', {}, { tile: 'reserved' }), note: 'Lot and any-lot reservations hold a site’s stock: they are placed on the lot’s rows in place order.' },
    { id: 'over-reserved', label: 'A key reserved beyond what is free: the notice, available below 0 said as over-reserved', model: page('warehouse', { reservations: OVER }) },
    { id: 'held-reason', label: 'A quality hold on a released lot: held, with the hold’s reason and day (never free to use)', model: page('warehouse', { rows: withoutCost(HELD_ROWS), holds: HOLDS }) },
    { id: 'held-no-right', label: 'The same hold for a role without quality.holds.view (a buyer): held in the figures, no reason read', model: page('warehouse', { rows: withoutCost(HELD_ROWS), holds: HOLDS, daily: { ...dailyCan(ROLE_PERMISSIONS.warehouse), holdsView: false } }) },
    { id: 'as-of', label: 'Stock as of 30 Sep 2026 23:59: the pill, the read-only notice, held/reserved/available “—”, every change held', model: page('warehouse', { rows: withoutCost(PAST_ROWS), reservations: [], asOf: NOW }, { asOf: AS_OF }) },
    { id: 'as-of-owner', label: 'As of 30 Sep with values (owner): the valued list of that day in ⋯ (PDF, a new tab)', model: page('owner', { rows: PAST_ROWS, reservations: [] }, { asOf: AS_OF }) },
    { id: 'as-of-dialog', label: 'Stock as of a date… open: the day, end of day by default, Now, the note', model: page('warehouse', { asOfDialog: { day: '2026-09-30', time: '23:59' } }) },
    { id: 'as-of-future', label: 'Stock as of a date: a day still to come holds the button with the reason', model: page('warehouse', { asOfDialog: { day: '2026-11-02', time: '23:59' } }) },
    { id: 'hold-select-quality', label: 'Quality inspector: three rows selected — “Put 2 lots on hold” (a row without a lot is left out)', model: page('quality', { selected: [lineId(ROWS[0]!), lineId(ROWS[12]!), lineId(ROWS[15]!)] }) },
    { id: 'hold-select-warehouse', label: 'Warehouse: the same selection — Put on hold held (the role may not place holds)', model: page('warehouse', { selected: [lineId(ROWS[0]!), lineId(ROWS[12]!)] }) },
    { id: 'hold-loading', label: 'Put 2 lots on hold: what the hold reaches being read', model: page('quality', { hold: hold({ preview: { value: null, problem: null }, reservedBy: { value: null, problem: null }, reasons: { value: null, problem: null } }) }) },
    { id: 'hold-ready', label: 'Put 2 lots on hold: the reach (hides and area), 2 work orders reserved them, the reason, quarantine asked', model: page('quality', { hold: hold({ draft: { ...blankHold(), reasonCode: 'QUALITY_CHECK', reasonNote: 'Macchie sul fiore da verificare', askQuarantine: true, quarantineLocationId: LOCATIONS.quarantine.id } }) }) },
    { id: 'hold-other-note', label: 'Reason “Other”: the note is required (held until written)', model: page('quality', { hold: hold({ draft: { ...blankHold(), reasonCode: 'OTHER' } }) }) },
    { id: 'hold-rejected', label: 'A rejected lot cannot be held: said in our words, the button held', model: page('quality', { hold: hold({ preview: { value: REJECTED_PREVIEW, problem: null }, draft: { ...blankHold(), reasonCode: 'QUALITY_CHECK' } }) }) },
    { id: 'hold-refused', label: 'The hold refused (a lot’s state changed meanwhile, 409): in our words', model: page('quality', { hold: hold({ draft: { ...blankHold(), reasonCode: 'QUALITY_CHECK' }, problem: { key: 'hold.problem.subjects' } }) }) },
    { id: 'hold-done', label: 'Placed: 2 lots on hold, the page reads again', model: page('quality', { hold: hold({ done: { count: 2 } }) }) },
    { id: 'phone', label: 'Phone (open at 390): the same rows as cards (the list frame’s DS card list), with search and Rows ▾', model: page('warehouse') },
    { id: 'phone-select', label: 'Phone (open at 390): Select mode, two cards ticked, the bulk actions', model: page('quality', { selected: [lineId(ROWS[0]!), lineId(ROWS[12]!)] }) },
    { id: 'sales', label: 'Sales: no inventory.stock.view — the page says so', model: page('sales') },
  ],
})

