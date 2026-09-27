import { describe, expect, it } from 'vitest'
import { sameCoordinate } from './useChannelSheet'

describe('a language switch keeps the page it has (2026-09-27)', () => {
  const base = 'https://api.test/api/products/p1/studio/sheet?channel=AMAZON&market=BE&locale=nl'
  it('is the same coordinate when only the languages asked for differ', () => {
    expect(sameCoordinate(base, `${base}&locales=nl%2Cfr`)).toBe(true)
    expect(sameCoordinate(`${base}&locales=nl%2Cfr`, base)).toBe(true)
  })
  it('is a new coordinate when the market, the first language or the account differs', () => {
    expect(sameCoordinate(base, base.replace('market=BE', 'market=DE'))).toBe(false)
    expect(sameCoordinate(base, base.replace('locale=nl', 'locale=fr'))).toBe(false)
    expect(sameCoordinate(base, `${base}&accountId=a2`)).toBe(false)
  })
})
