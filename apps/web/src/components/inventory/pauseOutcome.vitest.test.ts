import { describe, expect, it } from 'vitest'
import { pauseOutcomeOf, type PauseResult } from './pauseOutcome'

const base: PauseResult = { products: 2, variations: 3, notFound: 0, paused: 4, units: 17, skipped: 0, failed: [], notFollowing: 0 }

describe('the Pause toast says exactly what ran', () => {
  it('all levels set: what changed, that following listings show 0, FBA untouched; never "paused N listings"', () => {
    const o = pauseOutcomeOf(base)
    expect(o.tone).toBe('success')
    expect(o.message).toBe('✓ Set own-warehouse stock to the reserved count at 4 stock levels (17 units) of 2 products and 3 variations. Listings that follow stock now show 0. Amazon FBA units are not changed.')
  })
  it('names the listings that keep their own quantity, the levels with nothing to sell and the rows that are not products', () => {
    const o = pauseOutcomeOf({ ...base, variations: 0, products: 1, paused: 1, units: 1, skipped: 2, notFollowing: 3, notFound: 1 })
    expect(o.message).toBe('✓ Set own-warehouse stock to the reserved count at 1 stock level (1 unit) of 1 product. Listings that follow stock now show 0. 2 stock levels had nothing left to sell. 3 listings keep their own quantity (a fixed number, a held sync or shared stock). Amazon FBA units are not changed. 1 selected row skipped (not a product).')
  })
  it('part ran and part failed: an error toast with both, the failures by SKU and location', () => {
    const failed = [1, 2, 3, 4].map((i) => ({ sku: `TEST-SKU-${i}`, location: 'IT-MAIN', reason: 'lock timeout' }))
    const o = pauseOutcomeOf({ ...base, failed })
    expect(o.tone).toBe('error')
    expect(o.message).toContain('✗ Set own-warehouse stock to the reserved count at 4 stock levels')
    expect(o.message).toContain('4 stock levels could not be changed: TEST-SKU-1 at IT-MAIN (lock timeout); TEST-SKU-2 at IT-MAIN (lock timeout); TEST-SKU-3 at IT-MAIN (lock timeout); and 1 more.')
    expect(pauseOutcomeOf({ ...base, paused: 0, units: 0, failed }).message).toMatch(/^✗ No own-warehouse stock was changed\. /)
  })
  it('nothing to sell: says so; an unknown not-following count is left out, never guessed', () => {
    const o = pauseOutcomeOf({ ...base, paused: 0, units: 0, skipped: 5, notFollowing: null })
    expect(o).toEqual({ tone: 'success', message: '✓ Nothing to change: no own-warehouse stock is left to sell for 2 products and 3 variations. Amazon FBA units are not changed.' })
  })
})
