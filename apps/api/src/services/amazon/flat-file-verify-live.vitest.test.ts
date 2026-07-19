import { describe, expect, it } from 'vitest'
import { diffMineVsLive } from './flat-file-verify-live.service.js'

const live = (over: Record<string, unknown> = {}, title = 'My Title') => ({
  title,
  attributes: {
    item_name: [{ value: title }],
    product_description: [{ value: 'Desc' }],
    brand: [{ value: 'XAVIA' }],
    bullet_point: [{ value: 'B1' }, { value: 'B2' }],
    purchasable_offer: [{ our_price: [{ schedule: [{ value_with_tax: 99.9 }] }] }],
    fulfillment_availability: [{ quantity: 5 }],
    ...over,
  },
})

describe('diffMineVsLive (FFT.4)', () => {
  it('no drift when both sides agree (numeric-tolerant)', () => {
    expect(diffMineVsLive(
      { title: 'My Title', description: 'Desc', brand: 'XAVIA', bullets: ['B1', 'B2'], price: '99,90', quantity: 5 },
      live(),
    )).toEqual([])
  })

  it('reports per-field drift with both values', () => {
    const d = diffMineVsLive(
      { title: 'Mine Title', price: '89.00', quantity: 5, description: 'Desc', brand: 'XAVIA', bullets: [] },
      live(),
    )
    expect(d).toEqual([
      { field: 'title', mine: 'Mine Title', live: 'My Title' },
      { field: 'price', mine: '89.00', live: '99.9' },
    ])
  })

  it('a blank side is a fill-gap, never drift', () => {
    expect(diffMineVsLive({ title: '', description: '', bullets: [], price: '', quantity: '' }, live())).toEqual([])
    expect(diffMineVsLive(
      { title: 'T', price: '10' },
      { title: 'T', attributes: {} },
    )).toEqual([])
  })

  it('bullets compare pairwise up to the shorter list', () => {
    const d = diffMineVsLive(
      { bullets: ['B1', 'DIFFERENT', 'EXTRA-MINE'], title: 'My Title' },
      live(),
    )
    expect(d).toEqual([{ field: 'bullet_2', mine: 'DIFFERENT', live: 'B2' }])
  })
})
