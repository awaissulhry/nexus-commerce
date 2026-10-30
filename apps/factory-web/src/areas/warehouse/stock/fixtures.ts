import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { ItemRef, LotCounts, Named, QualityStatus, StockRow } from '../../_shared/stock/api'
import { canFor, COLOURS, inShell, ITEMS, LOCATIONS, LOTS, named, NOW, PREFIX, SITE, SITE_SOUTH, stockRow, TIME_ZONE, uid, type RoleCase } from '../../_shared/stock/fixtures'
import { blankDraft, type AdjustDialogModel, type AdjustTarget } from './adjust/model'
import { stockAddressOf, type StockAddress, type StockPageModel } from './model'
import { StockView } from './view/StockView'

/**
 * SCR-060 — Stock (design warehouse.stock) with made-up data only: a released nappa lot in two places (hides one by
 * one, folded per place), a nappa lot in quarantine waiting for its Cr VI result, a suede lot blocked after a Cr VI fail,
 * a lining lot, protectors in quarantine (PPE documents), zips without a lot; values with the cost grain only. Cases:
 * the views (by material, by lot, by place, leather one row per hide, on hold), the tiles as filters, a search, a
 * selection with its totals, Adjust stock (empty, a decrease too large, refused because the stock went meanwhile,
 * posted), the notices, live updates, several sites, and the states (loading, error, empty, no permission).
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
const SOUTH_ROWS: StockRow[] = [
  stockRow({ siteId: SITE_SOUTH.id, siteCode: SITE_SOUTH.code, item: ITEMS.zip, location: { id: uid('2323', 41), code: 'S-MAG', name: 'Magazzino sud' }, onHand: '120.0000', held: '0.0000', available: '120.0000' }),
]
const COUNTS: LotCounts = { quarantine: 2, waitingCrVi: 1, crViFailed: 1, blocked: 1, rejected: 0, released: 2 }
const CURRENCIES = Object.fromEntries(Object.values(ITEMS).map((item) => [item.id, 'EUR']))
const withoutCost = (rows: StockRow[]) => rows.map(({ unitCost: _cost, value: _value, ...row }) => row)

function page(role: RoleCase, over: Partial<StockPageModel> = {}, address: Partial<StockAddress> = {}): Case {
  const can = canFor(role)
  return {
    role,
    page: {
      prefix: PREFIX,
      can,
      address: { ...stockAddressOf(null), ...address },
      sites: [],
      rows: can.cost ? ROWS : withoutCost(ROWS),
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
    { id: 'sales', label: 'Sales: no inventory.stock.view — the page says so', model: page('sales') },
  ],
})

