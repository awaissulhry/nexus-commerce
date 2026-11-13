import { describe, expect, it } from 'vitest'
import { previewCellFacts } from '../product/routing-depth/preview'
import { garmentsOf } from './capacity/steps'
import { cellsOfDemand, stepsForCells } from './planned-orders/steps'
import { stepsForOptions } from './promise/steps'

/** B-W2b-365: only the steps a cell is for (the pure parts; the routes are option-steps.pg.vitest.test.ts). */

const step = (seq: number, variants: { sizes?: string[]; colourwayIds?: string[]; optionValueIds?: string[] } = {}) => ({ seq, appliesToSizes: variants.sizes ?? [], appliesToColourwayIds: variants.colourwayIds ?? [], appliesToOptionValueIds: variants.optionValueIds ?? [] })
const cut = step(10)
const perf = step(20, { optionValueIds: ['perf-front'] })
const big = step(25, { sizes: ['54'] })
const sew = step(30)

describe('only the steps a cell is for (B-W2b-365)', () => {
  const cells = [
    { colourwayId: 'blk', size: '50', quantity: 2, optionValueIds: [] },
    { colourwayId: 'blk', size: '54', quantity: 3, optionValueIds: ['perf-front'] },
  ]

  it('capacity: an operation is done on the garments of the cells its step is for', () => {
    expect([cut, perf, big, sew, null].map((entry) => garmentsOf(entry, cells))).toEqual([5, 3, 3, 5, 5])
    expect(garmentsOf(step(20, { optionValueIds: ['perf-full'] }), cells)).toBe(0)
  })

  it('planned work: the steps one of a planned order’s cells is for, with its order lines’ options', () => {
    const options = new Map([['ol-2', ['perf-front']]])
    const one = cellsOfDemand('blk', [{ orderLineId: 'ol-1', size: '50' }], options)
    const two = cellsOfDemand('blk', [{ orderLineId: 'ol-1', size: '50' }, { orderLineId: 'ol-2', size: '52' }], options)
    expect(stepsForCells([cut, perf, big, sew], one).map((entry) => entry.seq)).toEqual([10, 30])
    expect(stepsForCells([cut, perf, big, sew], two).map((entry) => entry.seq)).toEqual([10, 20, 30])
    // No cell known: every step, as a work order's copy.
    expect(stepsForCells([cut, perf], []).map((entry) => entry.seq)).toEqual([10, 20])
  })

  it('promises: a step only for some options is walked when one of them is asked', () => {
    expect(stepsForOptions([cut, perf, big, sew], []).map((entry) => entry.seq)).toEqual([10, 25, 30])
    expect(stepsForOptions([cut, perf, big, sew], ['perf-front', 'liner-yes']).map((entry) => entry.seq)).toEqual([10, 20, 25, 30])
    expect(stepsForOptions([perf], undefined)).toEqual([])
  })

  it('the routing preview keeps a cell’s options', () => {
    expect(previewCellFacts([{ colourwayId: 'blk', size: '52', optionValueIds: ['perf-front'] }, { colourwayId: 'blk', size: '50' }])).toEqual([
      { colourwayId: 'blk', size: '52', optionValueIds: ['perf-front'] },
      { colourwayId: 'blk', size: '50', optionValueIds: [] },
    ])
  })
})
