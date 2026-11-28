import { describe, expect, it } from 'vitest'
import en from '../../../../messages/en/production-chains.json'
import type { Chain } from './api'
import { cellFull, cellOf, cellShare, slowestOf } from './model'

const chain: Chain = {
  line: { id: 'line-1', code: 'L1', name: 'Chain 1' },
  steps: [
    { operationId: 'op-cut', name: 'Cutting', department: null, waiting: 0, done: 48, slowest: false },
    { operationId: 'op-sew', name: 'Stitching', department: null, waiting: 24, done: 24, slowest: true },
  ],
  lots: [{ workOrderSizeId: 'size-m', model: 'Hoodie Example', size: 'M', quantity: 48, bundleSize: 12, perStep: [{ operationId: 'op-cut', done: 48, waiting: 0 }, { operationId: 'op-sew', done: 24, waiting: 24 }] }],
}

describe('owb-fl9 — Chains (office)', () => {
  it('marks the slowest step with its number and its word, never colour alone', () => {
    expect(slowestOf(chain)).toEqual({ step: chain.steps[1], index: 1 })
    expect(slowestOf({ steps: [] })).toBeNull()
    expect(en.chain.slowWord_other.replace('{count}', '24')).toBe('Slowest · 24 wait')
  })

  it('reads each lot at each step: done, waiting, full and its share', () => {
    const lot = chain.lots[0]!
    expect(cellOf(lot, 'op-sew')).toEqual({ done: 24, waiting: 24 })
    expect(cellOf(lot, 'op-unknown')).toEqual({ done: 0, waiting: 0 })
    expect(cellFull(lot, 48)).toBe(true)
    expect(cellFull({ ...lot, quantity: undefined }, 48)).toBe(false)
    expect(cellShare(lot, 24)).toBe(50)
  })
})
