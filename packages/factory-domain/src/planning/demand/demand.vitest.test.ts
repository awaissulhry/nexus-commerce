import { describe, expect, it } from 'vitest'
import {
  bucketKeyOf,
  daysLate,
  demandGrid,
  demandHorizon,
  kindCounts,
  kindCountWords,
  LATER,
  layerOf,
  mergedCells,
  openParts,
  PAST,
  UNDATED,
  type DemandPiece,
} from './rules'

/** B-W2b-319 (PLN-017, PLN-040, PLN-041, PLN-042): the one demand view's rules. Every style and number is made up. */

describe('the horizon and its buckets', () => {
  it('starts on this week’s Monday and ends on the Sunday of week N, in weeks or months', () => {
    const weeks = demandHorizon('2026-11-12', 3)
    expect(weeks).toMatchObject({ kind: 'WEEK', from: '2026-11-09', to: '2026-11-29', weeks: 3 })
    expect(weeks.buckets.map((bucket) => bucket.key)).toEqual(['2026-W46', '2026-W47', '2026-W48'])
    const months = demandHorizon('2026-11-12', 8, 'MONTH')
    expect(months.buckets.map((bucket) => [bucket.key, bucket.from, bucket.to])).toEqual([
      ['2026-11', '2026-11-09', '2026-11-30'],
      ['2026-12', '2026-12-01', '2026-12-31'],
      ['2027-01', '2027-01-01', '2027-01-03'],
    ])
    expect(() => demandHorizon('2026-11-12', 0)).toThrow(RangeError)
    expect(() => demandHorizon('2026-11-12', 105)).toThrow(RangeError)
  })

  it('puts a day in its bucket, before the horizon in PAST, after it in LATER, no day in NONE', () => {
    const horizon = demandHorizon('2026-11-12', 2)
    expect(bucketKeyOf(horizon, '2026-11-09')).toBe('2026-W46')
    expect(bucketKeyOf(horizon, '2026-11-22')).toBe('2026-W47')
    expect(bucketKeyOf(horizon, '2026-11-08')).toBe(PAST)
    expect(bucketKeyOf(horizon, '2026-11-23')).toBe(LATER)
    expect(bucketKeyOf(horizon, null)).toBe(UNDATED)
    expect(daysLate('2026-11-10', '2026-11-12')).toBe(2)
    expect(daysLate('2026-11-20', '2026-11-12')).toBe(0)
    expect(daysLate(null, '2026-11-12')).toBeNull()
  })
})

describe('what an order line still waits for', () => {
  it('spreads each size over its deliveries, the rest on the line’s day, and takes what shipped from the earliest', () => {
    const parts = openParts({
      dueDate: '2026-12-18',
      sizes: [
        { size: '50', ordered: 2, shipped: 0 },
        { size: '52', ordered: 3, shipped: 1 },
      ],
      deliveries: [
        { date: '2027-01-29', sizeQuantities: { '52': 2 }, quantity: 2 },
        { date: '2027-01-15', sizeQuantities: { '50': 1 }, quantity: 1 },
      ],
    })
    expect(parts).toEqual([
      // 50: one on the 15th, one more on the line's own day (earlier); nothing shipped.
      { size: '50', date: '2026-12-18', pieces: 1 },
      { size: '50', date: '2027-01-15', pieces: 1 },
      // 52: one on the line's day (the earliest) shipped; the two of the 29th still wait.
      { size: '52', date: '2027-01-29', pieces: 2 },
    ])
  })

  it('never schedules more than was ordered, leaves out what shipped in full, and keeps a made-to-measure unit sizeless', () => {
    expect(openParts({ dueDate: null, sizes: [{ size: '52', ordered: 1, shipped: 0 }], deliveries: [{ date: '2027-01-15', sizeQuantities: { '52': 5 }, quantity: 5 }] })).toEqual([{ size: '52', date: '2027-01-15', pieces: 1 }])
    expect(openParts({ dueDate: '2026-12-01', sizes: [{ size: '52', ordered: 2, shipped: 2 }], deliveries: [] })).toEqual([])
    expect(openParts({ dueDate: null, sizes: [{ size: null, ordered: 1, shipped: 0 }], deliveries: [] })).toEqual([{ size: null, date: null, pieces: 1 }])
    expect(openParts({ dueDate: null, sizes: [{ size: null, ordered: 1, shipped: 0 }], deliveries: [{ date: '2027-02-01', sizeQuantities: null, quantity: 1 }] })).toEqual([{ size: null, date: '2027-02-01', pieces: 1 }])
  })

  it('adds a round’s cells named twice and drops empty ones', () => {
    expect(
      mergedCells([
        { colourwayId: 'c1', size: '52', quantity: 1 },
        { colourwayId: 'c1', size: '52', quantity: 2 },
        { colourwayId: null, size: '50', quantity: 1 },
        { colourwayId: 'c1', size: '54', quantity: 0 },
      ]),
    ).toEqual([
      { colourwayId: 'c1', size: '52', pieces: 3 },
      { colourwayId: null, size: '50', pieces: 1 },
    ])
  })
})

describe('the grid: tiles and style-colour rows by bucket and layer', () => {
  const horizon = demandHorizon('2026-11-12', 4)
  const piece = (over: Partial<DemandPiece>): DemandPiece => ({ kind: 'ORDER_LINE', sourceId: 'line-1', styleId: 's1', colourwayId: 'blk', size: '52', date: '2026-11-18', pieces: 1, planned: true, ...over })
  const pieces: DemandPiece[] = [
    piece({ pieces: 3 }),
    piece({ sourceId: 'line-2', size: '50', date: '2026-11-03', pieces: 2 }),
    piece({ kind: 'QUOTE_LINE', sourceId: 'q-1', planned: false, pieces: 4 }),
    piece({ kind: 'SAMPLE_ROUND', sourceId: 'sr-1', colourwayId: null, size: '52', date: null, planned: false }),
    piece({ kind: 'REWORK', sourceId: 'rw-1', planned: false }),
    piece({ kind: 'RECUT', sourceId: 'rc-1', date: '2026-11-25', planned: false }),
    piece({ kind: 'MTM_UNIT', sourceId: 'line-3', size: null, date: '2026-11-30' }),
    piece({ sourceId: 'line-4', date: '2027-03-01', pieces: 7 }),
    piece({ kind: 'RETURN_REPLACEMENT', sourceId: 'line-5', styleId: 's2', colourwayId: 'red', size: '48', date: '2026-11-20' }),
  ]

  it('counts the tiles per layer: past due, undated and later apart, unplanned pieces, sources once', () => {
    const { tiles } = demandGrid(pieces, horizon)
    const tile = (layer: string) => tiles.find((entry) => entry.layer === layer)
    expect(tile('ORDERS')).toEqual({ layer: 'ORDERS', pieces: 5, sources: 2, pastDue: 2, undated: 0, later: 7, unplanned: 0 })
    expect(tile('QUOTES')).toEqual({ layer: 'QUOTES', pieces: 4, sources: 1, pastDue: 0, undated: 0, later: 0, unplanned: 4 })
    expect(tile('SAMPLES')).toEqual({ layer: 'SAMPLES', pieces: 1, sources: 1, pastDue: 0, undated: 1, later: 0, unplanned: 1 })
    expect(tile('REMAKES')).toEqual({ layer: 'REMAKES', pieces: 3, sources: 3, pastDue: 0, undated: 0, later: 0, unplanned: 2 })
    expect(tile('MTM')).toEqual({ layer: 'MTM', pieces: 1, sources: 1, pastDue: 0, undated: 0, later: 0, unplanned: 0 })
  })

  it('makes one row per style and colourway (any colourway apart), opened to sizes in the style’s order, the unit of no size last', () => {
    const { rows } = demandGrid(pieces, horizon, (styleId) => (styleId === 's1' ? ['48', '50', '52', '54'] : []))
    expect(rows.map((row) => row.key)).toEqual(['s1:-', 's1:blk', 's2:red'])
    const blk = rows.find((row) => row.key === 's1:blk')!
    expect(blk.sizes.map((size) => size.size)).toEqual(['50', '52', null])
    // The firm total takes every layer but quotes.
    expect(blk.totals).toEqual({ ORDERS: 5, QUOTES: 4, MTM: 1, SAMPLES: 0, REMAKES: 2, firm: 8 })
    expect(blk.cells.map((cell) => cell.bucket)).toEqual([PAST, '2026-W47', '2026-W48', '2026-W49'])
    expect(blk.cells.find((cell) => cell.bucket === '2026-W47')).toEqual({ bucket: '2026-W47', ORDERS: 3, QUOTES: 4, MTM: 0, SAMPLES: 0, REMAKES: 1, firm: 4 })
    expect(blk.cells.find((cell) => cell.bucket === '2026-W48')).toEqual({ bucket: '2026-W48', ORDERS: 0, QUOTES: 0, MTM: 0, SAMPLES: 0, REMAKES: 1, firm: 1 })
    expect(blk.cells.find((cell) => cell.bucket === '2026-W49')).toEqual({ bucket: '2026-W49', ORDERS: 0, QUOTES: 0, MTM: 1, SAMPLES: 0, REMAKES: 0, firm: 1 })
    // A size row carries its own cells: the made-to-measure unit in its week only.
    expect(blk.sizes.find((size) => size.size === null)!.cells).toEqual([{ bucket: '2026-W49', ORDERS: 0, QUOTES: 0, MTM: 1, SAMPLES: 0, REMAKES: 0, firm: 1 }])
    const anyColour = rows.find((row) => row.key === 's1:-')!
    expect(anyColour.cells).toEqual([{ bucket: UNDATED, ORDERS: 0, QUOTES: 0, MTM: 0, SAMPLES: 1, REMAKES: 0, firm: 1 }])
    // A replacement for a return is a remake, never an order.
    expect(rows.find((row) => row.key === 's2:red')!.totals).toMatchObject({ ORDERS: 0, REMAKES: 1 })
  })

  it('says what makes a number, per kind', () => {
    const counts = kindCounts(pieces.filter((entry) => entry.date !== '2027-03-01'))
    expect(counts.map((count) => [count.kind, count.sources, count.pieces])).toEqual([
      ['ORDER_LINE', 2, 5],
      ['QUOTE_LINE', 1, 4],
      ['MTM_UNIT', 1, 1],
      ['SAMPLE_ROUND', 1, 1],
      ['REWORK', 1, 1],
      ['RECUT', 1, 1],
      ['RETURN_REPLACEMENT', 1, 1],
    ])
    expect(kindCountWords(counts.slice(0, 1))).toBe('2 orders')
    expect(kindCountWords([{ kind: 'ORDER_LINE', sources: 3, pieces: 9 }, { kind: 'RETURN_REMAKE', sources: 1, pieces: 1 }])).toBe('3 orders, 1 remake for a return')
    expect(kindCountWords([{ kind: 'REWORK', sources: 1, pieces: 1 }], 'it')).toBe('1 rilavorazione')
    expect(kindCountWords([])).toBe('nothing')
    expect(layerOf('RECUT')).toBe('REMAKES')
  })
})
