import { describe, it, expect } from 'vitest'
import { resolveEffective } from '../resolver'

describe('resolveEffective', () => {
  const priceField = {
    source: { column: 'price' },
    followMaster: {
      followColumn: 'followMasterPrice',
      overrideColumn: 'priceOverride',
      masterCacheColumn: 'masterPrice',
    },
  } as any

  it('follows master → effective is the master cache', () => {
    expect(resolveEffective({ followMasterPrice: true, masterPrice: 189.9, priceOverride: 999 }, priceField)).toEqual({
      value: 189.9,
      followsMaster: true,
    })
  })

  it('not following → effective is the override', () => {
    expect(resolveEffective({ followMasterPrice: false, masterPrice: 189.9, priceOverride: 199.9 }, priceField)).toEqual({
      value: 199.9,
      followsMaster: false,
    })
  })
})
