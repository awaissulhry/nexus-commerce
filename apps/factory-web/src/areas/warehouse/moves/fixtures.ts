import { createElement } from 'react'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Explain, LedgerCounts, LedgerRow, MoveDetail } from '../../_shared/stock/api'
import { at, canFor, COLOURS, DEVICES, inShell, ITEMS, ledgerRow, LOCATIONS, LOTS, named, NOW, PEOPLE, PREFIX, RECEIPTS, ROLE_PERMISSIONS, SITE, SITE_SOUTH, TIME_ZONE, uid, WORK_ORDERS, type RoleCase } from '../../_shared/stock/fixtures'
import { blankDraft, type AdjustDialogModel } from '../stock/adjust/model'
import type { WriteOffDialogModel } from '../stock/daily/dialog-model'
import { blankWriteOff, type WriteOffTarget } from '../stock/daily/model'
import { holdOf, WRITE_OFF_REASONS } from '../stock/demo/fixtures'
import { dailyCan } from '../stock/model'
import { movesAddressOf, type MovesAddress, type MovesPageModel } from './model'
import { MovesView } from './view/MovesView'

/**
 * SCR-064 — Movements (design warehouse.moves; Owner answer W2 B) with made-up data only: the ledger of one nappa hide
 * lot (received, moved to the cutting rack, issued to a work order, a remnant returned, an adjustment and its
 * reversal) among other moves, newest first. Cases: the whole ledger (owner with values; warehouse without), one stock
 * key explained ("why is it this number" adds up; a gap said in words) with the running balance, a reason picked, the
 * tiles as filters, the long grid loading its next page, a move's detail (office; floor with the worker where the site
 * records workers; station only), Reverse (the mirror first; refused when later moves used the stock; held for an
 * issue), Adjust, and the states. B-W2a-64: Write off… (the reasons, a quantity with a photo and an NCR, stock on hold
 * held, refused in words, done with the photo and the NCR sending, sent or failed), the Write-offs tile, the search
 * across the ledger, and the filter's whole count.
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
  ledgerRow(6, { reason: 'SCRAP', occurredAt: at(28, 15, 0), createdAt: at(28, 15, 0), item: ITEMS.protector, colour: null, lot: LOTS.protector, from: { kind: 'LOCATION', location: named(LOCATIONS.receiving) }, to: { kind: 'SCRAP', location: null }, quantity: '2.0000', uom: 'PCS', baseQuantity: '2.0000', delta: '-2.0000', note: 'DAMAGED: Guscio incrinato', writeOff: { id: uid('8383', 6), reasonCode: 'DAMAGED', note: 'Guscio incrinato' }, postedBy: { audience: 'OFFICE', name: PEOPLE.marco, device: null }, valuation: { method: 'PURCHASE_PRICE', quantity: '-2.0000', unitCost: '4.000000', valueAmount: -800, currency: 'EUR' } }),
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
const COUNTS: LedgerCounts = { adjustments7d: 2, scraps30d: 1, counts30d: 1, reversals30d: 1, writeOffs30d: 1, unvalued: 3 }

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
      rowCount: null,
      writeOff: null,
      writeOffReasons: WRITE_OFF_REASONS,
      daily: dailyCan(ROLE_PERMISSIONS[role]),
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

/** Write off on the lining lot at bin A2 (Movements opened from that stock figure), as useWriteOff builds it. */
const LINING_TARGET: WriteOffTarget = { kind: 'quantity', siteId: SITE.id, item: ITEMS.lining, colour: COLOURS.black, lot: LOTS.lining, location: named(LOCATIONS.binA2), onHand: '120.0000', unitCost: '3.100000', currency: 'EUR', hold: null }
const PHOTO: CapturedPhoto = { photo: new Blob([], { type: 'image/jpeg' }), marks: [], marked: null, width: 1600, height: 1200, source: 'camera' }
const writeOff = (over: Partial<WriteOffDialogModel> = {}, withCost = false): WriteOffDialogModel => ({
  target: withCost ? LINING_TARGET : { ...LINING_TARGET, unitCost: null, currency: null },
  draft: blankWriteOff(),
  reasons: { value: WRITE_OFF_REASONS, problem: null },
  withCost,
  canPhoto: true,
  canNcr: true,
  posting: false,
  problem: null,
  done: null,
  prefix: PREFIX,
  ...over,
})
const READY = { ...blankWriteOff(), quantity: '2,5', reasonCode: 'DAMAGED', note: 'Rotolo bagnato dalla perdita del tetto', photo: PHOTO, openNcr: true, ncrSeverity: 'MAJOR' as const }
const liningKey = { site: SITE.id, item: ITEMS.lining.id, lot: LOTS.lining.id, location: LOCATIONS.binA2.id }
const LINING_MOVES = MOVES.filter((move) => move.item.id === ITEMS.lining.id)
const WRITE_OFFS = MOVES.filter((move) => move.writeOff)

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
    // B-W2a-64 — write-offs, the tiles, the search, the whole count.
    { id: 'write-off-row', label: 'A write-off in the ledger: the reason in words beside Scrap, its own note', model: page('warehouse', { rows: withoutCost(WRITE_OFFS) }, { writeOffs: 'yes', period: '30d' }) },
    { id: 'tile-write-offs', label: 'Tile pressed: write-offs of the last 30 days (its chip removable)', model: page('owner', { rows: WRITE_OFFS }, { writeOffs: 'yes', period: '30d' }) },
    { id: 'tile-counts', label: 'Tile pressed: count differences of the last 30 days', model: page('warehouse', { rows: withoutCost(MOVES.filter((move) => move.reason === 'COUNT')) }, { reasons: ['COUNT'], period: '30d' }) },
    { id: 'search', label: 'A search across the whole ledger (a lot code): every move that names it', model: page('warehouse', { rows: withoutCost(MOVES.filter((move) => move.lot?.id === LOTS.protector.id)), rowCount: 1 }, { q: LOTS.protector.code }) },
    { id: 'row-count', label: 'The long ledger with its whole count: 160 of 1.234 moves loaded', model: page('warehouse', { rows: withoutCost(LONG), done: false, rowCount: 1_234 }) },
    { id: 'write-off-held', label: 'Write off… held: open Movements from a stock figure (a material at a place) first', model: page('warehouse') },
    { id: 'write-off-loading', label: 'Write off: the reasons being read', model: page('warehouse', { rows: withoutCost(LINING_MOVES), writeOff: writeOff({ reasons: { value: null, problem: null } }) }, liningKey) },
    { id: 'write-off', label: 'Write off just opened on 120 m of lining at bin A2: held with the missing field named', model: page('warehouse', { rows: withoutCost(LINING_MOVES), writeOff: writeOff() }, liningKey) },
    { id: 'write-off-ready', label: 'Write off 2,5 m: damaged, the note, a photo ready, an NCR asked, the value leaving stock (owner)', model: page('owner', { rows: LINING_MOVES, writeOff: writeOff({ draft: READY }, true) }, liningKey) },
    { id: 'write-off-other', label: 'Reason “Other”: the note is required', model: page('warehouse', { rows: withoutCost(LINING_MOVES), writeOff: writeOff({ draft: { ...blankWriteOff(), quantity: '1', reasonCode: 'OTHER' } }) }, liningKey) },
    { id: 'write-off-too-much', label: 'More than there is: held with the quantity on hand', model: page('warehouse', { rows: withoutCost(LINING_MOVES), writeOff: writeOff({ draft: { ...blankWriteOff(), quantity: '140', reasonCode: 'LOST' } }) }, liningKey) },
    { id: 'write-off-on-hold', label: 'The lot is on hold (quality’s to decide): Write off held with the reason', model: page('warehouse', { rows: withoutCost(LINING_MOVES), writeOff: writeOff({ target: { ...LINING_TARGET, unitCost: null, currency: null, hold: { holdId: holdOf(1, 'Lot', [LOTS.lining]).id, reasonCode: 'QUALITY_CHECK', placedAt: at(28, 11, 15), subjectType: 'Lot' } }, draft: { ...READY, photo: null, openNcr: false } }) }, liningKey) },
    { id: 'write-off-refused', label: 'Refused: the stock went on hold meanwhile (409 QUALITY_HOLD, in our words)', model: page('warehouse', { rows: withoutCost(LINING_MOVES), writeOff: writeOff({ draft: { ...READY, photo: null }, problem: { key: 'wo.problem.onHold' } }) }, liningKey) },
    { id: 'write-off-no-photo-right', label: 'A role without files.upload or quality.ncr.raise: the photo held, no NCR offered', model: page('warehouse', { rows: withoutCost(LINING_MOVES), writeOff: writeOff({ canPhoto: false, canNcr: false, draft: { ...READY, photo: null, openNcr: false } }) }, liningKey) },
    { id: 'write-off-sending', label: 'Written off: the photo and the NCR being sent', model: page('warehouse', { rows: withoutCost(LINING_MOVES), writeOff: writeOff({ draft: READY, done: { writeOffId: uid('8383', 30), moves: 1, value: null, photo: 'sending', ncr: { state: 'sending', id: null, number: null }, overReserved: 0 } }) }, liningKey) },
    { id: 'write-off-done', label: 'Written off (owner): the value that left, the photo kept, the NCR opened with its link', model: page('owner', { rows: LINING_MOVES, writeOff: writeOff({ draft: READY, done: { writeOffId: uid('8383', 30), moves: 1, value: { amount: 775, currency: 'EUR' }, photo: 'sent', ncr: { state: 'sent', id: uid('7676', 7), number: 'NC-D-0007' }, overReserved: 0 } }, true) }, liningKey) },
    { id: 'write-off-failed', label: 'Written off, but the photo and the NCR failed: each with Try again; a key left over-reserved', model: page('warehouse', { rows: withoutCost(LINING_MOVES), writeOff: writeOff({ draft: READY, done: { writeOffId: uid('8383', 30), moves: 1, value: null, photo: 'failed', ncr: { state: 'failed', id: null, number: null }, overReserved: 1 } }) }, liningKey) },
  ],
})
