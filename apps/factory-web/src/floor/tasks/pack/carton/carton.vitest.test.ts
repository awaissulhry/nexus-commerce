import { describe, expect, it } from 'vitest'
import type { QueueItem } from '../../../queue/model'
import type { Bench, BenchCarton, BenchContent } from './api'
import {
  benchLeft,
  benchMain,
  cartonOfMarks,
  cartonsOf,
  cellsOfBatch,
  closeChoice,
  closeHeld,
  holdReasonOf,
  inFlash,
  keptScans,
  marksFacts,
  marksProblemOf,
  overweight,
  packGrid,
  problemRefusal,
  refusalCodeOf,
  settledSince,
  sizeColumns,
} from './model'

/** Scan into the carton's rules (B-W2b-387): figures worked out by hand. */

const content = (size: string, quantity: number, extra: Partial<BenchContent> = {}): BenchContent => ({
  id: `c-${size}-${quantity}`,
  shipmentLineId: `l-${size}`,
  cellId: `cell-${size}`,
  styleCode: 'GIA',
  styleName: 'Giacca',
  colourwayCode: 'NERO',
  colourwayName: 'Nero',
  size,
  quantity,
  workOrderNumber: 'WO-42',
  batchNumber: 'BT-41',
  serials: [],
  ...extra,
})
const carton = (seq: number, contents: BenchContent[], extra: Partial<BenchCarton> = {}): BenchCarton => ({
  id: `p${seq}`,
  version: 1,
  seq,
  closed: false,
  cartonNumber: null,
  cartonCount: null,
  marksPrintedAt: null,
  marksCurrent: false,
  labelled: false,
  packagingType: null,
  grossWeightKg: null,
  netWeightKg: null,
  garments: contents.reduce((sum, entry) => sum + entry.quantity, 0),
  contents,
  ...extra,
})
const closed = (seq: number, of: number, contents: BenchContent[], extra: Partial<BenchCarton> = {}) => carton(seq, contents, { closed: true, cartonNumber: seq, cartonCount: of, marksCurrent: true, grossWeightKg: '4.0000', ...extra })
const row = (packed: [number, number, number], extra: Partial<Bench['grid'][number]> = {}): Bench['grid'][number] => ({
  styleCode: 'GIA',
  styleName: 'Giacca',
  colourwayCode: 'NERO',
  colourwayName: 'Nero',
  serialTracked: false,
  batchNumbers: ['BT-41'],
  sizes: [
    { size: '50', cellIds: ['cell-50'], ordered: 2, packed: packed[0] },
    { size: '52', cellIds: ['cell-52'], ordered: 4, packed: packed[1] },
    { size: '54', cellIds: ['cell-54'], ordered: 2, packed: packed[2] },
  ],
  ...extra,
})
const TYPES: Bench['packagingTypes'] = [
  { id: 'big', name: 'Big', kind: 'CARTON', innerLengthCm: '60', innerWidthCm: '40', innerHeightCm: '40', tareKg: '0.8', maxWeightKg: '20.0000' },
  { id: 'small', name: 'Small', kind: 'BOX', innerLengthCm: null, innerWidthCm: null, innerHeightCm: null, tareKg: null, maxWeightKg: null },
]
const bench = (extra: Partial<Bench> = {}): Bench => ({
  shipment: { id: 'sh', number: 'SH-0012', status: 'DRAFT', version: 3 },
  hold: null,
  grid: [row([0, 0, 0])],
  cartons: [],
  openCartonId: null,
  packagingTypes: TYPES,
  suggestedPackagingTypeId: 'big',
  problems: ['NOT_SCANNED'],
  ...extra,
})

describe('the size grid, ordered against packed', () => {
  it('lays the sizes out as columns, each cell packed of ordered with its state; a size a row lacks is empty', () => {
    const grid = packGrid(bench({ grid: [row([2, 1, 0]), row([0, 0, 0], { colourwayCode: 'ROSSO', serialTracked: true, sizes: [{ size: '56', cellIds: ['cell-r56'], ordered: 1, packed: 0 }] })] }))
    expect(grid.sizes).toEqual(['50', '52', '54', '56'])
    expect(grid.rows[0]!.cells.map((cell) => cell && [cell.packed, cell.ordered, cell.state])).toEqual([[2, 2, 'done'], [1, 4, 'part'], [0, 2, 'todo'], null])
    expect(grid.rows[1]!.cells.map((cell) => cell?.size ?? null)).toEqual([null, null, null, '56'])
    expect([grid.ordered, grid.packed, grid.rows[1]!.serialTracked]).toEqual([9, 3, true])
  })

  it('orders the size columns: numbers small to large, letter sizes in their run, else as the lines name them', () => {
    expect(packGrid(bench({ grid: [row([0, 0, 0], { sizes: [{ size: '52', cellIds: ['a'], ordered: 1, packed: 0 }, { size: '54', cellIds: ['b'], ordered: 1, packed: 0 }] }), row([0, 0, 0], { colourwayCode: 'ROSSO', sizes: [{ size: '54', cellIds: ['c'], ordered: 1, packed: 0 }, { size: '50', cellIds: ['d'], ordered: 1, packed: 0 }] })] })).sizes).toEqual(['50', '52', '54'])
    expect(sizeColumns(['L', 'S', 'XL', 'm'])).toEqual(['S', 'm', 'L', 'XL'])
    expect(sizeColumns(['UNICA', '52'])).toEqual(['UNICA', '52'])
  })

  it("names the sizes a batch label may be (its lines' work order or batch), those with garments left", () => {
    const grid = packGrid(bench({ grid: [row([2, 1, 0])] }))
    const lines = [
      { workOrderSizeId: 'cell-50', workOrderNumber: 'WO-42', batchNumber: 'BT-41' },
      { workOrderSizeId: 'cell-52', workOrderNumber: 'WO-42', batchNumber: 'BT-41' },
      { workOrderSizeId: 'cell-54', workOrderNumber: 'WO-43', batchNumber: 'BT-43' },
    ]
    expect(cellsOfBatch('bt-41', grid, lines)).toEqual(['cell-52'])
    expect(cellsOfBatch('WO-43', grid, lines)).toEqual(['cell-54'])
    expect(cellsOfBatch('BT-99', grid, lines)).toEqual([])
    // Without the lines: the grid rows that name the batch.
    expect(cellsOfBatch('BT-41', grid, null)).toEqual(['cell-52', 'cell-54'])
  })
})

describe('the cartons', () => {
  const value = bench({
    grid: [row([2, 3, 1])],
    cartons: [carton(2, [content('52', 1), content('54', 1)]), closed(1, 2, [content('50', 2), content('52', 2, { id: 'other', batchNumber: 'BT-41' }), content('52', 1, { id: 'b2', batchNumber: 'BT-77' })], { netWeightKg: '3.2000' })],
    openCartonId: 'p2',
  })
  it('in order, "n of N" once closed, the one scans go into, contents by size and batch, marks', () => {
    const cartons = cartonsOf(value)
    expect(cartons.map((entry) => [entry.seq, entry.numbered, entry.current, entry.marks, entry.garments])).toEqual([
      [1, { n: 1, of: 2 }, false, 'current', 5],
      [2, null, true, 'none', 2],
    ])
    expect(cartons[0]!.contents).toEqual([
      { label: 'GIA NERO 50', quantity: 2, batch: 'BT-41', serials: 0 },
      { label: 'GIA NERO 52', quantity: 2, batch: 'BT-41', serials: 0 },
      { label: 'GIA NERO 52', quantity: 1, batch: 'BT-77', serials: 0 },
    ])
    expect([cartons[0]!.grossKg, cartons[0]!.netKg]).toEqual(['4.0000', '3.2000'])
  })
  it("knows a carton's own marks code (`<shipment>-<n>`), in any case", () => {
    const cartons = cartonsOf(value)
    expect(cartonOfMarks(' sh-0012-2 ', 'SH-0012', cartons)?.seq).toBe(2)
    expect(cartonOfMarks('SH-0012-3', 'SH-0012', cartons)).toBeNull()
  })
})

describe('what packing still needs, and the main action', () => {
  it('scan first: nothing to close yet', () => {
    const value = bench()
    const left = benchLeft(value, cartonsOf(value))
    expect(left).toEqual([{ kind: 'toScan', count: 8 }])
    expect(benchMain(cartonsOf(value), left)).toEqual({ kind: 'none', why: { kind: 'toScan', count: 8 } })
  })
  it('an open carton with garments: Close carton (a take-out opened another: that one when none is current)', () => {
    const value = bench({ grid: [row([2, 1, 0])], cartons: [closed(1, 2, [content('50', 2)]), carton(2, [content('52', 1)])], openCartonId: 'p2', problems: ['NOT_SCANNED', 'CARTON_OPEN'] })
    const cartons = cartonsOf(value)
    const left = benchLeft(value, cartons)
    expect(left).toEqual([{ kind: 'toScan', count: 5 }, { kind: 'open', seqs: [2] }])
    expect(benchMain(cartons, left)).toMatchObject({ kind: 'close', carton: { seq: 2 } })
    const reopened = cartonsOf({ ...value, openCartonId: null })
    expect(benchMain(reopened, left)).toMatchObject({ kind: 'close', carton: { seq: 2 } })
  })
  it('marks showing an old count: print them again; then Packed', () => {
    const due = bench({ grid: [row([2, 4, 2])], cartons: [closed(1, 2, [content('50', 2), content('52', 4)], { marksCurrent: false }), closed(2, 2, [content('54', 2)])], problems: ['MARKS_NOT_PRINTED'] })
    const left = benchLeft(due, cartonsOf(due))
    expect(left).toEqual([{ kind: 'marks', seqs: [1] }])
    expect(benchMain(cartonsOf(due), left)).toEqual({ kind: 'marks', seqs: [1] })
    const done = bench({ ...due, cartons: due.cartons.map((entry) => ({ ...entry, marksCurrent: true })), problems: [] })
    expect(benchLeft(done, cartonsOf(done))).toEqual([])
    expect(benchMain(cartonsOf(done), [])).toEqual({ kind: 'packed' })
  })
  it('a closed carton not weighed, an empty one, serials out of their carton, no lines', () => {
    const value = bench({ grid: [row([2, 4, 2])], cartons: [closed(1, 3, [content('50', 2), content('52', 4)], { grossWeightKg: null }), carton(2, []), closed(3, 3, [content('54', 2)])], problems: ['SERIALS_NOT_IN_CARTONS'] })
    expect(benchLeft(value, cartonsOf(value))).toEqual([{ kind: 'serials' }, { kind: 'unweighed', seqs: [1] }, { kind: 'empty', seqs: [2] }])
    expect(benchLeft(bench({ grid: [], problems: [] }), [])).toEqual([{ kind: 'noLines' }])
  })
})

describe('a refused scan, a hold', () => {
  it("reads the bench's codes and nothing else", () => {
    expect([refusalCodeOf('WRONG_STYLE'), refusalCodeOf('SIZE_NEEDED'), refusalCodeOf('CONTENTS_DO_NOT_ADD_UP'), refusalCodeOf(null)]).toEqual(['WRONG_STYLE', 'SIZE_NEEDED', null, null])
    expect(problemRefusal({ kind: 'refused', code: 'EXTRA_PIECE', message: 'x', fix: null })).toBe('EXTRA_PIECE')
    expect(problemRefusal({ kind: 'conflict', message: 'x' })).toBeNull()
  })
  it("words a hold by its reason, another reason as 'other'", () => {
    expect([holdReasonOf('CREDIT'), holdReasonOf('BALANCE_UNPAID'), holdReasonOf('SOMETHING_NEW')]).toEqual(['CREDIT', 'BALANCE_UNPAID', 'OTHER'])
  })
  it('a garment in: its size and count on the grid after the scan', () => {
    const grid = packGrid(bench({ grid: [row([2, 3, 0])] }))
    expect(inFlash(7, 'BT-41', grid, { cellId: 'cell-52', cartonSeq: 2, newCarton: true })).toEqual({ seq: 7, code: 'BT-41', kind: 'in', cell: 'GIA NERO 52', carton: 2, newCarton: true, packed: 3, ordered: 4 })
  })
})

describe('the scans the tablet keeps', () => {
  const item = (id: string, state: QueueItem['state'], extra: Partial<QueueItem> = {}): QueueItem =>
    ({ clientEventId: id, seq: 1, kind: 'shipping.carton.scan', payload: { shipmentId: 'sh', code: `CODE-${id}` }, occurredAt: '2026-11-13T09:00:00.000Z', workerId: 'w', deviceId: 'd', state, attempts: 0, refusal: null, recordedAt: null, result: null, numbered: null, ...extra }) as QueueItem
  it("this shipment's waiting scans, and those refused when sent with their code", () => {
    const items = [item('a', 'waiting'), item('b', 'refused', { refusal: { id: 'r', code: 'WRONG_STYLE', message: 'x', fix: '', final: true } }), item('c', 'waiting', { payload: { shipmentId: 'other', code: 'X' } }), item('d', 'waiting', { kind: 'production.scan.report' } as Partial<QueueItem>)]
    expect(keptScans(items, 'sh')).toEqual({ waiting: [{ id: 'a', code: 'CODE-a', at: '2026-11-13T09:00:00.000Z', refusal: null }], refused: [{ id: 'b', code: 'CODE-b', at: '2026-11-13T09:00:00.000Z', refusal: 'WRONG_STYLE' }] })
  })
  it('knows when a kept scan of this shipment settled (the bench reads again)', () => {
    expect(settledSince([item('a', 'waiting')], [item('a', 'recorded')], 'sh')).toBe(true)
    expect(settledSince([item('a', 'waiting')], [], 'sh')).toBe(true)
    expect(settledSince([item('a', 'waiting')], [item('a', 'waiting')], 'sh')).toBe(false)
    expect(settledSince([item('a', 'waiting')], [item('a', 'recorded')], 'other')).toBe(false)
  })
})

describe('Close carton and its marks', () => {
  const value = bench({ cartons: [carton(2, [content('52', 1)], { packagingType: { id: 'small', name: 'Small', kind: 'BOX' } }), carton(3, [content('54', 1)])] })
  const [own, plain] = cartonsOf(value)
  it("opens with the carton's own packaging, else the suggested default, else the only one in use", () => {
    expect(closeChoice(own!, value)).toEqual({ cartonId: 'p2', seq: 2, packagingId: 'small', weight: null })
    expect(closeChoice(plain!, value).packagingId).toBe('big')
    expect(closeChoice(plain!, { packagingTypes: [TYPES[1]!], suggestedPackagingTypeId: null }).packagingId).toBe('small')
    expect(closeChoice(plain!, { packagingTypes: TYPES, suggestedPackagingTypeId: 'gone' }).packagingId).toBeNull()
    expect(closeChoice({ ...plain!, grossKg: '2.5000' }, value).weight).toBe(2.5)
  })
  it('waits for packaging set up, chosen, and a weight; warns above the most weight', () => {
    expect(closeHeld({ cartonId: 'p', seq: 1, packagingId: null, weight: 2 }, [])).toBe('noPackaging')
    expect(closeHeld({ cartonId: 'p', seq: 1, packagingId: null, weight: 2 }, TYPES)).toBe('packaging')
    expect(closeHeld({ cartonId: 'p', seq: 1, packagingId: 'big', weight: null }, TYPES)).toBe('weight')
    expect(closeHeld({ cartonId: 'p', seq: 1, packagingId: 'big', weight: 2 }, TYPES)).toBeNull()
    expect(overweight({ cartonId: 'p', seq: 1, packagingId: 'big', weight: 21 }, TYPES)).toBe('20.0000')
    expect(overweight({ cartonId: 'p', seq: 1, packagingId: 'big', weight: 20 }, TYPES)).toBeNull()
    expect(overweight({ cartonId: 'p', seq: 1, packagingId: 'small', weight: 99 }, TYPES)).toBeNull()
  })
  it("words a print problem by its code, and says what the floor knows of the marks", () => {
    expect([marksProblemOf('validation_failed'), marksProblemOf('invalid_state'), marksProblemOf('teapot'), marksProblemOf(null)]).toEqual(['validation_failed', 'invalid_state', 'other', 'other'])
    expect(marksFacts({ garments: 3, contents: [content('50', 1), content('52', 2, { batchNumber: null }), content('52', 1, { styleCode: 'TUT', colourwayCode: 'ROSSO', batchNumber: 'BT-55' })] })).toEqual({ styles: 'GIA NERO, TUT ROSSO', sizes: '50, 52', batches: 'BT-41, BT-55' })
  })
})
