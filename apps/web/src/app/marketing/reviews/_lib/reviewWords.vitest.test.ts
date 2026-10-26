import { describe, expect, it } from 'vitest'
import { MOOD_WORD, STATUS_WORD, THEME_LABEL, channelMarketWords, starsWord, statusWord, themeWord } from './reviewWords'

describe('review words', () => {
  it('names every theme, mood and status the API stores', () => {
    for (const key of ['FIT_SIZING', 'DURABILITY', 'SHIPPING', 'VALUE', 'DESIGN', 'QUALITY', 'SAFETY', 'COMFORT', 'OTHER']) {
      expect(THEME_LABEL[key]).toMatch(/^[A-Z][a-z &]+$/)
    }
    expect(themeWord('FIT_SIZING')).toBe('Fit & sizing')
    expect(themeWord('SOMETHING_NEW')).toBe('SOMETHING_NEW')
    expect(Object.values(MOOD_WORD)).toEqual(['Positive', 'Neutral', 'Negative'])
    expect(Object.keys(STATUS_WORD)).toEqual(['NEW', 'IN_PROGRESS', 'RESPONDED', 'RESOLVED', 'IGNORED'])
  })

  it('reads a review with no status as New', () => {
    expect(statusWord(null)).toBe('New')
    expect(statusWord(undefined)).toBe('New')
    expect(statusWord('IN_PROGRESS')).toBe('In progress')
  })

  it('says a channel with its market, long or short', () => {
    expect(channelMarketWords('AMAZON', 'IT')).toBe('Amazon Italy')
    expect(channelMarketWords('EBAY', 'de')).toBe('eBay Germany')
    expect(channelMarketWords('EBAY', 'DE', 'short')).toBe('eBay DE')
    expect(channelMarketWords('SHOPIFY', null)).toBe('Shopify')
    expect(channelMarketWords('ETSY', '')).toBe('Etsy')
    expect(channelMarketWords('AMAZON', 'XX')).toBe('Amazon XX')
  })

  it('counts stars in words', () => {
    expect(starsWord(1)).toBe('1 star')
    expect(starsWord(4)).toBe('4 stars')
    expect(starsWord(4.5)).toBe('4.5 stars')
    expect(starsWord(4.44)).toBe('4.4 stars')
    expect(starsWord(null)).toBe('No rating')
    expect(starsWord(Number.NaN)).toBe('No rating')
  })
})
