import { describe, expect, it } from 'vitest'
import { marketDifference } from './sheet-columns.service.js'

/**
 * 2026-09-27 — the Amazon scope names how one market's rules differ from most markets'. Measured on production:
 * DE declares `uvp_list_price` and `epr_eco_fee_eubr` and no `ghs`; UK has no `image_locator_ps01…06`.
 */
const base = ['brand', 'color', 'ghs', 'image_locator_ps01', 'item_name']
const label = (key: string) => key.toUpperCase()

describe('marketDifference', () => {
  it('names what DE adds and lacks against the fields most markets declare', () => {
    const de = ['brand', 'color', 'epr_eco_fee_eubr', 'image_locator_ps01', 'item_name', 'uvp_list_price']
    const diff = marketDifference(de, [{ market: 'IT', keys: base }, { market: 'FR', keys: base }, { market: 'ES', keys: base }], label)
    expect(diff).toEqual({
      comparedWith: ['ES', 'FR', 'IT'],
      onlyHere: [{ key: 'epr_eco_fee_eubr', label: 'EPR_ECO_FEE_EUBR' }, { key: 'uvp_list_price', label: 'UVP_LIST_PRICE' }],
      missingHere: [{ key: 'ghs', label: 'GHS' }],
    })
  })

  it('a market that matches the majority has no difference, even when one other market is odd', () => {
    const uk = base.filter((k) => k !== 'image_locator_ps01')
    const diff = marketDifference(base, [{ market: 'FR', keys: base }, { market: 'UK', keys: uk }], label)
    expect(diff).toEqual({ comparedWith: ['FR', 'UK'], onlyHere: [], missingHere: [] })
  })

  it('needs two other markets: with one, neither side can be called the odd one', () => {
    expect(marketDifference(base, [{ market: 'IT', keys: ['brand'] }], label)).toBeUndefined()
    expect(marketDifference(base, [], label)).toBeUndefined()
  })

  it('a tie is not a majority: a field half the markets declare is not "common"', () => {
    const diff = marketDifference(['a'], [{ market: 'X', keys: ['a'] }, { market: 'Y', keys: ['b'] }, { market: 'Z', keys: ['b'] }], (k) => k)
    // a: 2 of 4, b: 2 of 4 → neither is common; own `a` shows as "only here".
    expect(diff).toEqual({ comparedWith: ['X', 'Y', 'Z'], onlyHere: [{ key: 'a', label: 'a' }], missingHere: [] })
  })
})
