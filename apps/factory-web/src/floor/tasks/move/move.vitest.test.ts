import { describe, expect, it } from 'vitest'
import { UNDO_WINDOW_MS } from '@nexus/factory-domain/inventory/bin-moves/rules'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { ApiError } from '../../../lib/api/errors'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { homeTiles } from '../../model'
import { readScan } from '../../scan/scan-model'
import { taskForScan, TASK_ROUTES } from '../routes'
import { warehouseProblemOf } from '../mywork/warehouse/write'
import { STEP_REFUSALS } from '../mywork/warehouse/view/InboxView'
import { designScreen } from './fixtures'
import { decimalsOf, fromOf, goesTo, moveBody, MOVE_REFUSALS, padOf, placeActOf, placeHeld, purposeOf, quarantineTaskOf, taskOfMove, undoLeftMs, undoOpen, type InHand, type MoveLast, type MoveScan } from './model'

/** SCR-177 Move & put away (B-W2b-308): the rules of the screen, the refusals' words, the scan router, the design cases. */

const place = (id: string, kind: string, onHand: string) => ({ locationId: id, code: id.toUpperCase(), name: id, kind, onHand })
const hand = (extra: Partial<InHand> = {}): InHand => ({
  kind: 'LOT',
  code: 'LOT-1',
  item: { id: 'i', code: 'FOD', name: 'Fodera', kind: 'LINING', tracking: 'LOT', baseUom: 'M' },
  colour: null,
  lot: { id: 'l', code: 'LOT-1', qualityStatus: 'RELEASED', lifecycle: 'ACTIVE' },
  hide: null,
  roll: null,
  remnant: null,
  quality: 'RELEASED',
  holdIds: [],
  whole: false,
  uom: 'M',
  onHand: '30',
  lying: [place('a1-rcv', 'RECEIVING', '30')],
  ...extra,
})
const taskOf = (id: string, kind: 'PUT_AWAY' | 'MOVE' | 'QUARANTINE', extra: Record<string, unknown> = {}) =>
  ({ id, kind, status: 'OPEN', source: null, item: null, colour: null, lot: null, hide: null, from: null, to: null, quantity: null, uom: null, dueAt: null, note: null, version: 1, createdAt: '2026-11-12T08:00:00.000Z', audience: 'ANYONE', mine: false, ...extra }) as MoveScan['tasks'][number]
const scanOf = (extra: Partial<MoveScan> = {}): MoveScan => ({ hand: hand(), from: null, suggestion: null, tasks: [], ...extra })

describe('In your hands: where it is taken from, what it is, how much', () => {
  it('from: the only place; the one tapped; its task\'s place; for a put-away the one dock among several; else the worker says', () => {
    expect(fromOf(scanOf(), null, null)?.locationId).toBe('a1-rcv')
    const two = scanOf({ hand: hand({ lying: [place('bulk', 'BULK', '20'), place('pf', 'PICK_FACE', '10')] }) })
    expect(fromOf(two, null, null)).toBeNull()
    expect(fromOf(two, 'pf', null)?.locationId).toBe('pf')
    const withTask = { ...two, tasks: [taskOf('t1', 'MOVE', { from: { id: 'pf', code: 'PF', name: 'pf', kind: 'PICK_FACE' } })] }
    expect(fromOf(withTask, null, 't1')?.locationId).toBe('pf')
    const dock = scanOf({ hand: hand({ lying: [place('bin', 'BIN', '5'), place('rcv', 'RECEIVING', '25')] }) })
    expect(fromOf(dock, null, null)?.locationId).toBe('rcv')
    expect(fromOf(scanOf({ hand: hand({ lying: [] }) }), null, null)).toBeNull()
  })

  it('a put-away from a dock or a quarantine place, else a move between bins', () => {
    expect(purposeOf({ kind: 'RECEIVING' })).toBe('PUT_AWAY')
    expect(purposeOf({ kind: 'QUARANTINE' })).toBe('PUT_AWAY')
    expect(purposeOf({ kind: 'BIN' })).toBe('MOVE')
    expect(purposeOf(null)).toBe('MOVE')
  })

  it('the pad: only a lot counted by quantity, defaulting to all that lies there; whole units for pieces', () => {
    expect(padOf(hand({ whole: true }), place('a', 'BIN', '52.4'))).toBeNull()
    expect(padOf(hand(), place('a', 'BIN', '30'))).toEqual({ min: 0.01, max: 30, decimals: 2 })
    expect(padOf(hand({ uom: 'PCS' }), place('a', 'BIN', '24'))).toEqual({ min: 1, max: 24, decimals: 0 })
    expect(padOf(hand(), null)).toBeNull()
    expect(decimalsOf('FT2')).toBe(2)
  })

  it('the move\'s body: the quantity only for part of it, where from only when it lies in several places, the task it works on', () => {
    const one = scanOf()
    const from = fromOf(one, null, null)
    const pad = padOf(one.hand, from)
    expect(moveBody({ code: ' LOT-1 ', placeCode: 'a1-bulk-01', hand: one.hand, from, pad, value: 30, taskId: null })).toEqual({ code: 'LOT-1', placeCode: 'a1-bulk-01' })
    expect(moveBody({ code: 'LOT-1', placeCode: 'A1-BULK-01', hand: one.hand, from, pad, value: 12, taskId: 't1' })).toEqual({ code: 'LOT-1', placeCode: 'A1-BULK-01', quantity: '12.00', taskId: 't1' })
    const two = scanOf({ hand: hand({ lying: [place('bulk', 'BULK', '20'), place('pf', 'PICK_FACE', '10')] }) })
    const picked = fromOf(two, 'pf', null)
    expect(moveBody({ code: 'LOT-1', placeCode: 'X', hand: two.hand, from: picked, pad: padOf(two.hand, picked), value: 10, taskId: null })).toEqual({ code: 'LOT-1', placeCode: 'X', fromLocationId: 'pf' })
    // Offline, a code never read: the label alone.
    expect(moveBody({ code: 'LOT-9', placeCode: 'X', hand: null, from: null, pad: null, value: null, taskId: null })).toEqual({ code: 'LOT-9', placeCode: 'X' })
  })

  it('the place scan waits, and says why: where from, nothing there, how much', () => {
    const two = scanOf({ hand: hand({ lying: [place('bulk', 'BULK', '20'), place('pf', 'PICK_FACE', '10')] }) })
    expect(placeHeld(two, null, null, null)).toBe('from')
    expect(placeHeld(scanOf({ hand: hand({ lying: [] }) }), null, null, null)).toBe('nothing')
    const from = fromOf(scanOf(), null, null)
    const pad = padOf(scanOf().hand, from)
    expect(placeHeld(scanOf(), from, pad, null)).toBe('empty')
    expect(placeHeld(scanOf(), from, pad, 31)).toBe('tooMuch')
    expect(placeHeld(scanOf(), from, pad, 30)).toBeNull()
    expect(placeHeld(null, null, null, null)).toBeNull()
  })

  it('a hold\'s quarantine move is the place scan\'s act: its task, never a move by two scans', () => {
    const quarantine = taskOf('tq', 'QUARANTINE', { to: { id: 'qua', code: 'A1-QUA', name: 'q', kind: 'QUARANTINE' } })
    const held = scanOf({ hand: hand({ quality: 'ON_HOLD', lying: [place('bulk', 'BULK', '20'), place('pf', 'PICK_FACE', '10')] }), tasks: [quarantine] })
    expect(quarantineTaskOf(held)?.id).toBe('tq')
    expect(placeActOf(held, null)).toEqual({ kind: 'quarantine', task: quarantine })
    expect(placeHeld(held, null, null, null)).toBeNull()
    expect(goesTo(held, null, 'MOVE')).toEqual({ code: 'A1-QUA', why: 'QUARANTINE' })
    expect(placeActOf(scanOf(), fromOf(scanOf(), null, null))).toEqual({ kind: 'move', purpose: 'PUT_AWAY' })
  })

  it('where it should go: the task\'s place, else the put-away\'s suggestion (a move gets none)', () => {
    const suggestion = { location: { id: 'b', code: 'A1-BULK-01', name: 'b', kind: 'BULK' }, why: 'DEFAULT' as const }
    const put = taskOf('tp', 'PUT_AWAY', { from: { id: 'a1-rcv', code: 'A1-RCV', name: 'r', kind: 'RECEIVING' }, to: { id: 'x', code: 'A1-X', name: 'x', kind: 'BIN' } })
    const scan = scanOf({ suggestion, tasks: [put] })
    const from = fromOf(scan, null, null)
    expect(taskOfMove(scan, from, null)?.id).toBe('tp')
    expect(goesTo(scan, taskOfMove(scan, from, null), 'PUT_AWAY')).toEqual({ code: 'A1-X', why: 'TASK' })
    expect(goesTo(scanOf({ suggestion }), null, 'PUT_AWAY')).toEqual({ code: 'A1-BULK-01', why: 'DEFAULT' })
    expect(goesTo(scanOf({ suggestion }), null, 'MOVE')).toBeNull()
  })
})

describe('Undo for 2 minutes', () => {
  const last = (extra: Partial<MoveLast>): MoveLast => ({ kind: 'moved', code: 'LOT-1', purpose: 'MOVE', quantity: null, uom: null, from: 'A', to: 'B', ticks: 'recorded', clientEventId: null, moveId: 'm1', at: '2026-11-12T09:00:00.000Z', ...extra })
  it('only a recorded move by scan, with its id, inside its window', () => {
    const at = new Date('2026-11-12T09:00:00.000Z')
    expect(undoOpen(last({}), new Date(at.getTime() + UNDO_WINDOW_MS - 1))).toBe(true)
    expect(undoOpen(last({}), new Date(at.getTime() + UNDO_WINDOW_MS))).toBe(false)
    expect(undoOpen(last({ ticks: 'saved', moveId: null, at: null }), at)).toBe(false)
    expect(undoOpen(last({ kind: 'quarantined' }), at)).toBe(false)
    expect(undoOpen(last({ kind: 'undone' }), at)).toBe(false)
    expect(undoLeftMs(last({}), new Date(at.getTime() + 60_000))).toBe(UNDO_WINDOW_MS - 60_000)
    expect(undoLeftMs(null, at)).toBeNull()
  })
})

describe('refusals in the screen\'s words', () => {
  const error = (status: number, kind: 'conflict' | 'invalid', path: string, message = 'words') => new ApiError(kind, status, kind === 'conflict' ? 'conflict' : 'validation_failed', message, null, [{ path, message }])
  it('reads the moves\' own codes, the warehouse rules, the place that is none here, the place that does not take the goods', () => {
    expect(warehouseProblemOf(error(409, 'conflict', 'refusal/QUARANTINE_ONLY'))).toMatchObject({ kind: 'refused', code: 'QUARANTINE_ONLY' })
    expect(warehouseProblemOf(error(400, 'invalid', 'refusal/TOO_MUCH'))).toMatchObject({ kind: 'refused', code: 'TOO_MUCH' })
    expect(warehouseProblemOf(error(409, 'conflict', 'warehouse/COUNT_FROZEN'))).toMatchObject({ kind: 'refused', code: 'COUNT_FROZEN' })
    expect(warehouseProblemOf(error(409, 'conflict', 'warehouse/LOCATION_BLOCKED'))).toMatchObject({ kind: 'refused', code: 'LOCATION_BLOCKED' })
    expect(warehouseProblemOf(error(400, 'invalid', 'body/placeCode', 'No place of this site carries label B2-X: scan the label of a place here.'))).toMatchObject({ kind: 'refused', code: 'NOT_A_PLACE' })
    expect(warehouseProblemOf(error(400, 'invalid', 'body/placeCode', 'A1-BULK-01 is not a quarantine place: scan the label of the quarantine place (A1-QUA).'))).toMatchObject({ kind: 'refused', code: 'NOT_A_QUARANTINE_PLACE' })
    expect(warehouseProblemOf(error(400, 'invalid', 'body/toLocationId'))).toMatchObject({ kind: 'refused', code: 'DOES_NOT_HOLD' })
    expect(warehouseProblemOf(error(409, 'conflict', 'body/version'))).toMatchObject({ kind: 'conflict' })
    expect(warehouseProblemOf(new ApiError('unavailable', 0, 'network', 'offline'))).toEqual({ kind: 'offline' })
  })

  it('every refusal the screens know has its words in Italian and English', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['floor-move'] ?? {}
      for (const code of MOVE_REFUSALS) {
        expect(words[`refusal.${code}.message`], `${locale} ${code}`).toBeTruthy()
        expect(words[`refusal.${code}.fix`], `${locale} ${code}`).toBeTruthy()
      }
      for (const code of STEP_REFUSALS) expect(words[`inbox.refusal.${code}`], `${locale} inbox ${code}`).toBeTruthy()
    }
  })
})

describe('the scan router and the tile (B-W2b-308)', () => {
  const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
  const WAREHOUSE = ['floor.work', 'inventory.transfer', 'inventory.issue', 'inventory.receive']
  it('at the warehouse a lot, hide, roll or remnant label opens Move & put away; a work order still opens Pick & issue', () => {
    const tiles = homeTiles('warehouse', WAREHOUSE, false)
    for (const type of ['LOT', 'HIDE', 'ROLL', 'REMNANT'] as const) expect(taskForScan('warehouse', readScan(formatScanId({ type, tenantTag: TAG, ref: 42 }), TAG), tiles), type).toBe('move')
    expect(taskForScan('warehouse', readScan('WO-0042', TAG), tiles)).toBe('pick')
    // Without inventory.transfer there is no Move tile: the label goes to Scan anything.
    expect(taskForScan('warehouse', readScan(formatScanId({ type: 'LOT', tenantTag: TAG, ref: 42 }), TAG), homeTiles('warehouse', ['floor.work', 'inventory.issue'], false))).toBeNull()
    expect(TASK_ROUTES.move).toBe('/floor/move')
  })
})

describe('SCR-177\'s design cases', () => {
  it('cover the three steps, the states and the refusals', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    expect(designScreen.screen).toBe('SCR-177')
    for (const id of ['scan-what', 'put-away', 'put-away-part', 'hide-whole', 'several-places', 'quarantine-task', 'moved', 'moved-saved', 'quarantined', 'refused-other-site', 'refused-blocked', 'refused-frozen', 'offline-hand', 'offline-blind', 'loading', 'error', 'notice-held', 'no-permission']) expect(ids).toContain(id)
  })
})
