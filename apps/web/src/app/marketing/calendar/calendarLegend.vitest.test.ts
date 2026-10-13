/**
 * Google Ads step 1a, W3 (D3) — the calendar legend lists only the channels on the calendar, by plain name.
 */
import { describe, expect, it } from 'vitest'
import { calendarLegend, channelPlainName } from './calendarLegend'

describe('calendarLegend', () => {
  it('an empty calendar has no channel in its legend (no Google dot by default)', () => {
    expect(calendarLegend([])).toEqual([])
  })

  it('lists each present channel once, in a fixed order, by plain name', () => {
    expect(calendarLegend([{ channel: 'GOOGLE' }, { channel: 'EBAY' }, { channel: 'EBAY' }, { channel: 'AMAZON' }]))
      .toEqual([{ channel: 'AMAZON', name: 'Amazon' }, { channel: 'EBAY', name: 'eBay' }, { channel: 'GOOGLE', name: 'Google' }])
  })

  it('never prints a raw code', () => {
    for (const { name } of calendarLegend([{ channel: 'TIKTOK' }, { channel: 'META' }, { channel: 'INTERNAL' }, { channel: 'NEW_THING' }])) {
      expect(name).not.toMatch(/^[A-Z_]+$/)
    }
    expect(channelPlainName('NEW_THING')).toBe('Other')
  })
})
