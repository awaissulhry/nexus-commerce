/**
 * CC-6 — one market per launch: what counts as a market change, and the sentence a builder shows after dropping the
 * old market's picks.
 */
import { describe, expect, it } from 'vitest'
import { isRealMarketChange, marketChangeNote } from './marketChange'

describe('CC-6 — a real market change', () => {
  it('is a move from one known market to another', () => {
    expect(isRealMarketChange('IT', 'DE')).toBe(true)
  })
  it('is not the console resolving its first market, nor the same market again', () => {
    expect(isRealMarketChange('', 'IT')).toBe(false)
    expect(isRealMarketChange('IT', 'IT')).toBe(false)
    expect(isRealMarketChange('IT', '')).toBe(false)
  })
})

describe('CC-6 — the note', () => {
  it('names what was removed and both markets', () => {
    expect(marketChangeNote('IT', 'DE', ['3 products', 'the portfolio'])).toBe('The marketplace changed from IT to DE, so 3 products and the portfolio chosen for IT were removed. Choose them again for DE.')
    expect(marketChangeNote('IT', 'FR', ['the portfolio'])).toContain('the portfolio chosen for IT was removed')
    expect(marketChangeNote('IT', 'FR', ['1 product'])).toContain('1 product chosen for IT was removed')
  })
  it('says nothing when nothing was picked', () => {
    expect(marketChangeNote('IT', 'DE', [])).toBe('')
  })
})
