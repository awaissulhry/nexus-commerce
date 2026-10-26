import { describe, expect, it } from 'vitest'
import {
  EMPTY_OVERVIEW_QUERY, parseOverviewQuery, serializeOverviewQuery, toggleShow, withoutScope, withPeriod, withStars,
} from './overviewQuery'

describe('Overview address', () => {
  it('a plain visit is 30 days with nothing filtered, and writes nothing back', () => {
    expect(parseOverviewQuery('')).toEqual(EMPTY_OVERVIEW_QUERY)
    expect(serializeOverviewQuery(EMPTY_OVERVIEW_QUERY)).toBe('')
  })

  it('reads the period, the tile filter, the pressed bar and a channel scope', () => {
    expect(parseOverviewQuery('?period=7d&show=reply&stars=1&channel=ebay&market=it')).toEqual({ period: '7d', show: 'reply', stars: 1, channel: 'EBAY', market: 'IT' })
  })

  it('anything it does not know falls back: All time, a misspelt filter, six stars, odd codes', () => {
    expect(parseOverviewQuery('?period=all&show=everything&stars=6&channel=ALL&market=x;y')).toEqual(EMPTY_OVERVIEW_QUERY)
    expect(parseOverviewQuery('?stars=2.5').stars).toBeNull()
  })

  it('round-trips through the address in a fixed order', () => {
    const q = { period: '90d' as const, show: 'alerts' as const, stars: 2 as const, channel: 'AMAZON', market: 'DE' }
    const text = serializeOverviewQuery(q)
    expect(text).toBe('?period=90d&show=alerts&stars=2&channel=AMAZON&market=DE')
    expect(parseOverviewQuery(text)).toEqual(q)
  })

  it('a tile toggles its filter; the chip × clears it', () => {
    const on = toggleShow(EMPTY_OVERVIEW_QUERY, 'reply')
    expect(on.show).toBe('reply')
    expect(toggleShow(on, 'reply').show).toBeNull()
    expect(toggleShow(on, 'alerts').show).toBe('alerts')
    expect(toggleShow(on, null).show).toBeNull()
    expect(serializeOverviewQuery(on)).toBe('?show=reply')
  })

  it('a new period drops the pressed rating bar (its count was the old period’s); the same period changes nothing', () => {
    const pressed = withStars(EMPTY_OVERVIEW_QUERY, 1)
    expect(serializeOverviewQuery(pressed)).toBe('?stars=1')
    const moved = withPeriod(pressed, '12m')
    expect(moved).toMatchObject({ period: '12m', stars: null })
    expect(withPeriod(pressed, '30d')).toBe(pressed)
    expect(withPeriod(pressed, 'all')).toBe(pressed)
  })

  it('the scope chip × leaves channel and market', () => {
    expect(withoutScope({ ...EMPTY_OVERVIEW_QUERY, channel: 'EBAY', market: 'IT' })).toEqual(EMPTY_OVERVIEW_QUERY)
  })
})
