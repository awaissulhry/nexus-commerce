import { describe, expect, it } from 'vitest'
import { markLiveVariants } from './live-read.js'

const price = { state: 'value' as const, value: { amount: '19.90', currency: 'EUR' } }
const stock = { state: 'value' as const, value: 3 }

describe('markLiveVariants', () => {
  it('marks live, extra and missing variants against Nexus SKUs', () => {
    const marked = markLiveVariants(['A', 'B'], [{ sku: 'A', values: { Size: 'M' }, price, stock }, { sku: 'X', values: { Size: 'L' }, price, stock }])
    expect(marked.map(v => [v.sku, v.state])).toEqual([['A', 'live'], ['X', 'extra'], ['B', 'missing']])
  })
  it('a missing variant carries no invented price or stock', () => {
    const [missing] = markLiveVariants(['B'], [])
    expect(missing).toEqual({ sku: 'B', values: {}, price: { state: 'absent' }, stock: { state: 'absent' }, state: 'missing' })
  })
})
