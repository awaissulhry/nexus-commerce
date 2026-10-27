import { describe, expect, it } from 'vitest'
import { familyMentions, fitBasis, fitHeaderWords, fitMentions, fitPill, fitShare, fitTableFootnote, fitVerdictPill, type FitCell } from './fitView'

const cell = (over: Partial<FitCell>): FitCell => ({
  size: 'M', total: 12, small: 7, true: 4, large: 1, reviews: 9, returns: 3, verdict: 'small', shares: { small: 58, true: 33, large: 8 }, share: 58,
  words: 'Runs small: 7 of 12 fit mentions (58%), from 9 reviews and 3 returns.', ...over,
})

describe('fit in words', () => {
  it('a Themes cell: the verdict with its share, over what it rests on', () => {
    expect(fitPill(cell({}))).toEqual({ text: 'Runs small 58%', tone: 'warning', note: 'of 12 · 9 reviews, 3 returns', words: 'Runs small: 7 of 12 fit mentions (58%), from 9 reviews and 3 returns.' })
    expect(fitPill(cell({ verdict: 'large', share: 52 }))).toMatchObject({ text: 'Runs large 52%', tone: 'info' })
    expect(fitPill(cell({ verdict: 'true', share: 80, reviews: 5, returns: 0, total: 5 }))).toMatchObject({ text: 'True to size 80%', tone: 'success', note: 'of 5 · 5 reviews' })
    expect(fitPill(cell({ verdict: 'mixed', share: null }))).toMatchObject({ text: 'Mixed', tone: 'neutral' })
  })

  it('below the minimum: "Too few" and how many there are — never a share', () => {
    const few = cell({ verdict: 'too_few', total: 3, shares: null, share: null, words: 'Too few: …' })
    expect(fitPill(few)).toEqual({ text: 'Too few', tone: 'neutral', note: '3 of 5 needed', words: 'Too few: …' })
    expect(fitVerdictPill(few)).toEqual({ text: 'Too few', tone: 'neutral', note: '3 of 5 needed' })
    expect(fitShare(few, 'small')).toBeNull()
    expect(fitShare(cell({}), 'true')).toBe(33)
  })

  it('a size the family does not sell', () => {
    expect(fitPill({ size: 'XXL', verdict: 'not_sold' })).toMatchObject({ text: 'Not sold', note: 'no XXL in this family' })
  })

  it('the pop-up verdict says what to do', () => {
    expect(fitVerdictPill(cell({})).text).toBe('Order one size up')
    expect(fitVerdictPill(cell({ verdict: 'large' })).text).toBe('Order one size down')
    expect(fitVerdictPill(cell({ verdict: 'true' })).text).toBe('True to size')
    expect(fitVerdictPill(cell({ verdict: 'mixed' })).text).toBe('Buyers disagree')
  })

  it('basis, header, counts and footnote', () => {
    expect(fitBasis({ reviews: 1, returns: 0 })).toBe('1 review')
    expect(fitBasis({ reviews: 0, returns: 0 })).toBe('nothing yet')
    expect(fitHeaderWords({ reviews: 79, returns: 34 })).toBe('from 79 reviews and 34 returns that mention fit')
    expect(fitHeaderWords({ reviews: 0, returns: 0 })).toBe('no review or return says how it fits yet')
    expect(fitMentions({ reviews: 2, returns: 1 })).toBe(3)
    expect(fitMentions(null)).toBeNull()
    expect(familyMentions({ signals: 12, noSize: 0 })).toBe('12 fit mentions')
    expect(familyMentions({ signals: 1, noSize: 2 })).toBe('1 fit mention · 2 name no size')
    expect(familyMentions({ signals: 15, noSize: 1 })).toBe('15 fit mentions · 1 names no size')
    expect(fitTableFootnote({ words: 'From 6 reviews.', moreFamilies: 0 })).toBe('From 6 reviews.')
    expect(fitTableFootnote({ words: 'From 6 reviews.', moreFamilies: 2 })).toBe('From 6 reviews. 2 more families have fewer fit mentions and are not shown.')
  })
})
