import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Explain, LedgerCounts, LedgerRow, MoveDetail } from '../../_shared/stock/api'
import { at, canFor, COLOURS, DEVICES, inShell, ITEMS, ledgerRow, LOCATIONS, LOTS, named, NOW, PEOPLE, PREFIX, RECEIPTS, SITE, SITE_SOUTH, TIME_ZONE, uid, WORK_ORDERS, type RoleCase } from '../../_shared/stock/fixtures'
import { blankDraft, type AdjustDialogModel } from '../stock/adjust/model'
import { movesAddressOf, type MovesAddress, type MovesPageModel } from './model'
import { MovesView } from './view/MovesView'

/**
 * SCR-064 — Movements (design warehouse.moves; Owner answer W2 B) with made-up data only: the ledger of one nappa hide
 * lot (received, moved to the cutting rack, issued to a work order, a remnant returned, an adjustment and its
 * reversal) among other moves, newest first. Cases: the whole ledger (owner with values; warehouse without), one stock
 * key explained ("why is it this number" adds up; a gap said in words) with the running balance, a reason picked, the
 * tiles as filters, the long grid loading its next page, a move's detail (office; floor with the worker where the site
 * records workers; station only), Reverse (the mirror first; refused when later moves used the stock; held for an
 * issue), Adjust, and the states.
 */

type Case = { role: RoleCase; page: MovesPageModel }

const leatherKey = { site: SITE.id, item: ITEMS.leather.id, lot: LOTS.nappa.id }
const rack = { kind: 'LOCATION' as const, location: named(LOCATIONS.cutting) }
const bin = { kind: 'LOCATION' as const, location: named(LOCATIONS.binA1) }
const receiving = { kind: 'LOCATION' as const, location: named(LOCATIONS.receiving) }
const valued = (amount: number, method = 'PURCHASE_PRICE') => ({ valuation: { method, quantity: '0', unitCost: '6.850000', valueAmount: amount, currency: 'EUR' } })

/** Newest first, as the ledger answers. */
export const MOVES: LedgerRow[] = [
  ledgerRow(12, { reason: 'ADJUSTMENT', occurredAt: at(30, 9, 5), createdAt: at(30, 9, 5), from: { kind: 'ADJUSTMENT', location: null }, to: rack, quantity: '1.5000', baseQuantity: '1.5000', delta: '1.5000', note: 'Storno: rettifica registrata due volte', reversalOfId: uid('8383', 11), postedBy: { audience: 'OFFICE', name: PEOPLE.anna, device: null }, hide: { id: uid('8282', 6), code: 'HD-DEMO-0006' }, ...valued(1_028, 'LOT_COST') }),
  ledgerRow(11, { reason: 'ADJUSTMENT', occurredAt: at(30, 8, 50), createdAt: at(30, 8, 50), from: rack, to: { kind: 'ADJUSTMENT', location: null }, quantity: '1.5000', baseQuantity: '1.5000', delta: '-1.5000', note: 'Bordo rovinato in taglio', reversedById: uid('8383', 12), postedBy: { audience: 'OFFICE', name: PEOPLE.anna, device: null }, hide: { id: uid('8282', 6), code: 'HD-DEMO-0006' }, ...valued(1_028, 'LOT_COST') }),
  ledgerRow(10, { reason: 'RETURN', occurredAt: at(29, 16, 20), createdAt: at(29, 16, 21), from: { kind: 'WORK_ORDER', location: null }, to: rack, quantity: '12.5000', baseQuantity: '12.5000', delta: '12.5000', document: { type: 'WorkOrder', ...WORK_ORDERS.a }, reference: WORK_ORDERS.a.number, postedBy: { audience: 'FLOOR', name: null, device: DEVICES.cut }, hide: { id: uid('8282', 7), code: 'HD-DEMO-0007' }, ...valued(8_563, 'LOT_COST') }),
  ledgerRow(9, { reason: 'ISSUE', occurredAt: at(29, 10, 2), createdAt: at(29, 10, 2), from: rack, to: { kind: 'WORK_ORDER', location: null }, quantity: '49.6000', baseQuantity: '49.6000', delta: '-49.6000', document: { type: 'WorkOrder', ...WORK_ORDERS.a }, reference: WORK_ORDERS.a.number, postedBy: { audience: 'FLOOR', name: null, device: DEVICES.store }, hide: { id: uid('8282', 7), code: 'HD-DEMO-0007' }, ...valued(33_976, 'LOT_COST') }),
  ledgerRow(8, { reason: 'TRANSFER', occurredAt: at(29, 8, 40), createdAt: at(29, 8, 41), from: bin, to: rack, quantity: '49.6000', baseQuantity: '49.6000', delta: '0.0000', postedBy: { audience: 'FLOOR', name: null, device: DEVICES.store }, hide: { id: uid('8282', 7), code: 'HD-DEMO-0007' }, valuation: null }),
  ledgerRow(7, { reason: 'TRANSFER', occurredAt: at(29, 8, 38), createdAt: at(29, 8, 39), from: bin, to: rack, quantity: '31.2000', baseQuantity: '31.2000', delta: '0.0000', postedBy: { audience: 'FLOOR', name: null, device: DEVICES.store }, hide: { id: uid('8282', 6), code: 'HD-DEMO-0006' }, valuation: null }),
  ledgerRow(6, { reason: 'SCRAP', occurredAt: at(28, 15, 0), createdAt: at(28, 15, 0), item: ITEMS.protector, colour: null, lot: LOTS.protector, from: { kind: 'LOCATION', location: named(LOCATIONS.receiving) }, to: { kind: 'SCRAP', location: null }, quantity: '2.0000', uom: 'PCS', baseQuantity: '2.0000', delta: '-2.0000', note: 'Guscio incrinato', postedBy: { audience: 'OFFICE', name: PEOPLE.marco, device: null }, valuation: { method: 'PURCHASE_PRICE', quantity: '-2.0000', unitCost: '4.000000', valueAmount: -800, currency: 'EUR' } }),
  ledgerRow(5, { reason: 'COUNT', occurredAt: at(27, 17, 30), createdAt: at(27, 17, 30), item: ITEMS.lining, lot: LOTS.lining, from: { kind: 'COUNT', location: null }, to: { kind: 'LOCATION', location: named(LOCATIONS.binA2) }, quantity: '2.0000', uom: 'M', baseQuantity: '2.0000', delta: '2.0000', note: 'Conta di fine mese', reference: 'Conta 27/10', postedBy: { audience: 'OFFICE', name: PEOPLE.marco, device: null }, valuation: { method: 'LOT_COST', quantity: '2.0000', unitCost: '3.100000', valueAmount: 620, currency: 'EUR' } }),
  ledgerRow(4, { reason: 'RECEIPT', occurredAt: at(14, 10, 5), createdAt: at(14, 10, 5), from: { kind: 'SUPPLIER', location: null }, to: bin, quantity: '134.4000', uom: 'FT2', baseQuantity: '134.4000', delta: '134.4000', document: { type: 'GoodsReceipt', ...RECEIPTS.a }, reference: 'DDT 412/2026', postedBy: { audience: 'OFFICE', name: PEOPLE.marco, device: null }, ...valued(92_064) }),
  ledgerRow(3, { reason: 'RECEIPT', occurredAt: at(14, 10, 4), createdAt: at(14, 10, 4), from: { kind: 'SUPPLIER', location: null }, to: receiving, quantity: '12.4865', uom: 'M2', baseQuantity: '134.4000', delta: '134.4000', document: { type: 'GoodsReceipt', ...RECEIPTS.a }, reference: 'DDT 412/2026', postedBy: { audience: 'OFFICE', name: PEOPLE.marco, device: null }, ...valued(92_064) }),
  ledgerRow(2, { reason: 'OPENING', occurredAt: at(1, 8), createdAt: at(1, 8), item: ITEMS.zip, colour: null, lot: null, from: { kind: 'OPENING', location: null }, to: { kind: 'LOCATION', location: named(LOCATIONS.binA2) }, quantity: '300.0000', uom: 'PCS', baseQuantity: '300.0000', delta: '300.0000', reference: 'riga 14', postedBy: { audience: 'OFFICE', name: PEOPLE.anna, device: null }, valuation: null }),
]

const KEY_MOVES = MOVES.filter((move) => move.item.id === ITEMS.leather.id && move.lot?.id === LOTS.nappa.id)
const EXPLAIN: Explain = {
  siteId: SITE.id,
  item: ITEMS.leather,
  colour: COLOURS.black,
  lot: LOTS.nappa,
  hide: null,
  location: null,
  onHand: '252.0000',
  byReason: [
    { reason: 'RECEIPT', in: '268.8000', out: '0.0000', net: '268.8000', moves: 2 },
    { reason: 'ISSUE', in: '0.0000', out: '49.6000', net: '-49.6000', moves: 1 },
    { reason: 'RETURN', in: '12.5000', out: '0.0000', net: '12.5000', moves: 1 },
    { reason: 'TRANSFER', in: '80.8000', out: '80.8000', net: '0.0000', moves: 2 },
    { reason: 'ADJUSTMENT', in: '1.5000', out: '1.5000', net: '0.0000', moves: 2 },
  ],
  sum: '231.7000',
  addsUp: false,
  gap: '20.3000',
  moves: 8,
}
const EXPLAIN_OK: Explain = { ...EXPLAIN, onHand: '231.7000', addsUp: true, gap: '0.0000' }
const COUNTS: LedgerCounts = { adjustments7d: 2, scraps30d: 1, counts30d: 1, reversals30d: 1, unvalued: 3 }

const withoutCost = (rows: LedgerRow[]) => rows.map(({ valuation: _value, ...row }) => row)

function page(role: RoleCase, over: Partial<MovesPageModel> = {}, address: Partial<MovesAddress> = {}): Case {
  const can = canFor(role)
  const { unvalued: _unvalued, ...plainCounts } = COUNTS
  return {
    role,
    page: {
      prefix: PREFIX,
      can,
      address: { ...movesAddressOf(null), ...address },
      sites: [],
      rows: can.cost ? MOVES : withoutCost(MOVES),
      problem: null,
      loadingMore: false,
      done: true,
      closing: null,
      counts: can.cost ? COUNTS : plainCounts,
      explain: null,
      asOf: NOW,
      live: 'live',
      updates: 0,
      timeZone: TIME_ZONE,
      notice: null,
      detail: null,
      reverse: null,
      adjust: null,
      now: NOW,
      ...over,
    },
  }
}

const keyed = (role: RoleCase, over: Partial<MovesPageModel> = {}, address: Partial<MovesAddress> = {}) =>
  page(role, { rows: canFor(role).cost ? KEY_MOVES : withoutCost(KEY_MOVES), closing: '231.7000', explain: { status: 'ready', value: EXPLAIN_OK }, ...over }, { ...leatherKey, period: 'all', ...address })

const detailOf = (move: LedgerRow, over: Partial<MoveDetail['move']> = {}, related: Partial<Pick<MoveDetail, 'original' | 'reversal'>> = {}): MovesPageModel['detail'] => ({
  status: 'ready',
  value: { move: { ...move, idempotencyKey: `inventory.adjust:${move.id.slice(-12)}:1`, receiptLineId: null, workOrderId: move.document?.type === 'WorkOrder' ? move.document.id : null, worker: null, stationOnly: false, ...over }, original: related.original ?? null, reversal: related.reversal ?? null },
})

/** A long ledger (the grid that reads on as you scroll): the moves repeated over earlier days. */
const LONG: LedgerRow[] = Array.from({ length: 160 }, (_, index) => {
  const base = MOVES[index % MOVES.length]!
  const when = new Date(Date.parse(NOW) - (index + 1) * 97 * 60_000).toISOString()
  return { ...base, id: uid('8484', index + 1), occurredAt: when, createdAt: when, reversalOfId: null, reversedById: null }
})

const ADJUST: AdjustDialogModel = {
  target: { siteId: SITE.id, siteCode: SITE.code, item: ITEMS.leather, colour: COLOURS.black, lot: LOTS.nappa, hide: { id: uid('8282', 6), code: 'HD-DEMO-0006' }, location: named(LOCATIONS.cutting), onHand: '31.2000' },
  draft: { ...blankDraft({ siteId: SITE.id, siteCode: SITE.code, item: ITEMS.leather, colour: COLOURS.black, lot: LOTS.nappa, hide: null, location: named(LOCATIONS.cutting), onHand: '31.2000' }), quantity: '0,8', note: 'Ritaglio inutilizzabile' },
  locations: [named(LOCATIONS.cutting), named(LOCATIONS.binA1)],
  withCost: false,
  posting: false,
  problem: null,
}

function MovesDesign({ model }: { model: Case }) {
  return inShell('/warehouse/moves', createElement(MovesView, { model: model.page }), model.role)
}

const [adjustmentReversal, adjustment, returned, issued, , transfer] = MOVES

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-064',
  title: 'Movements (the stock ledger as one long grid; why is it this number; reverse; adjust)',
  view: MovesDesign,
  cases: [
    { id: 'owner', label: 'Owner: the last 30 days with values (cost grain), the tiles', model: page('owner'), note: 'One long grid: the next 500 rows load as you scroll (Owner answer W2 B).' },
    { id: 'warehouse', label: 'Warehouse: the same ledger without any money', model: page('warehouse') },
    { id: 'why', label: 'Opened from a stock figure: why is it 231,7 ft² — adds up ✓ — and the running balance', model: keyed('warehouse') },
    { id: 'why-gap', label: 'A figure that does not add up: the gap in words (a bug, reported)', model: keyed('owner', { explain: { status: 'ready', value: EXPLAIN } }) },
    { id: 'why-reason', label: 'A reason picked in the why table: the grid filtered to it', model: keyed('warehouse', { rows: withoutCost(KEY_MOVES.filter((move) => move.reason === 'ADJUSTMENT')), closing: null }, { reasons: ['ADJUSTMENT'] }) },
    { id: 'why-loading', label: 'The figure being explained', model: keyed('warehouse', { explain: { status: 'loading' } }) },
    { id: 'tile-adjustments', label: 'Tile pressed: adjustments of the last 7 days', model: page('warehouse', { rows: withoutCost(MOVES.filter((move) => move.reason === 'ADJUSTMENT')) }, { reasons: ['ADJUSTMENT'], period: '7d' }) },
    { id: 'reversed', label: 'Filter: reversed or reversing (both rows, linked both ways)', model: page('warehouse', { rows: withoutCost([adjustmentReversal!, adjustment!]) }, { reversed: 'yes' }) },
    { id: 'long', label: 'A long ledger: 160 rows loaded, the next page loading as the reader nears the end', model: page('warehouse', { rows: withoutCost(LONG), done: false, loadingMore: true }) },
    { id: 'selection', label: 'Rows selected: Export N; a reversal stays one deliberate act', model: page('warehouse', { selected: [MOVES[0]!.id, MOVES[1]!.id, MOVES[3]!.id] }) },
    { id: 'detail', label: 'A move in its detail: what, why, who and when, both clocks, the key, its value (owner)', model: page('owner', { detail: detailOf(adjustment!, {}, { reversal: adjustmentReversal! }) }, { open: adjustment!.id }) },
    { id: 'detail-floor', label: 'A floor move: the tablet, and the worker only because this site records workers', model: page('warehouse', { rows: withoutCost(MOVES), detail: detailOf(withoutCost([returned!])[0]!, { worker: PEOPLE.marco }) }, { open: returned!.id }) },
    { id: 'detail-station', label: 'A floor move where the site records the station only: no worker', model: page('warehouse', { rows: withoutCost(MOVES), detail: detailOf(withoutCost([transfer!])[0]!, { stationOnly: true }) }, { open: transfer!.id }) },
    { id: 'detail-issue', label: 'An issue: Reverse held (it is reversed from its work order’s pick list)', model: page('warehouse', { rows: withoutCost(MOVES), detail: detailOf(withoutCost([issued!])[0]!) }, { open: issued!.id }) },
    { id: 'detail-loading', label: 'A move being read', model: page('warehouse', { detail: { status: 'loading' } }, { open: adjustment!.id }) },
    { id: 'reverse', label: 'Reverse: the mirror move shown first, the reason required', model: page('warehouse', { reverse: { move: withoutCost([MOVES[6]!])[0]!, note: 'Registrato per errore: il guscio era sano', posting: false, problem: null } }) },
    { id: 'reverse-used', label: 'Reverse refused: later moves already used that stock (in words)', model: page('warehouse', { reverse: { move: withoutCost([MOVES[4]!])[0]!, note: 'Spostata per errore', posting: false, problem: { key: 'rev.problem.used' } } }) },
    { id: 'reversed-done', label: 'Reversal posted: the notice; the pair struck through and linked', model: page('warehouse', { notice: { tone: 'success', key: 'rev.done', params: { reason: 'Rettifica', material: 'DEMO-LEA-01' } } }) },
    { id: 'adjust', label: 'Adjust stock from a stock key (the same dialog as Stock)', model: keyed('warehouse', { adjust: ADJUST }) },
    { id: 'adjust-held', label: 'Adjust held: open Movements from a stock figure first', model: page('warehouse') },
    { id: 'live', label: 'Live: 12 new moves ("12 updates · Show"; never inserted under the reader)', model: page('warehouse', { updates: 12 }) },
    { id: 'sites', label: 'Several sites: the site picker', model: page('owner', { sites: [SITE, SITE_SOUTH] }) },
    { id: 'quality', label: 'Quality inspector: reads the ledger, reverses nothing', model: page('quality') },
    { id: 'read-only', label: 'Read-only', model: page('readOnly') },
    { id: 'keys', label: 'Keyboard shortcuts', model: page('warehouse', { helpOpen: true }) },
    { id: 'empty', label: 'No moves yet', model: page('warehouse', { rows: [], counts: { adjustments7d: 0, scraps30d: 0, counts30d: 0, reversals30d: 0 } }) },
    { id: 'filtered-empty', label: 'Filters that match nothing', model: page('warehouse', { rows: [] }, { reasons: ['COUNT'], period: '7d' }) },
    { id: 'loading', label: 'Loading', model: page('warehouse', { rows: null, counts: null, asOf: null, live: 'connecting', done: false }) },
    { id: 'error', label: "The ledger couldn't be read (never drawn as an empty list)", model: page('warehouse', { rows: null, problem: 'problem.offline', counts: null, asOf: null, live: 'offline', done: false }) },
    { id: 'sales', label: 'Sales: no inventory.stock.view — the page says so', model: page('sales') },
  ],
})
