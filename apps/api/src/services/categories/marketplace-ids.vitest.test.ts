import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { amazonMarketplaceId } from './marketplace-ids.js'
import { MARKET_CATALOGUE } from '../pim/market-catalogue.js'
import { marketplaceCodeToId, normalizeMarketplaceCode } from '../../utils/marketplace-code.js'

const amazonMarkets = MARKET_CATALOGUE.filter((m) => m.channel === 'AMAZON')

describe('Amazon marketplace ids — every catalogue market resolves to its real id', () => {
  it('covers the five markets the short list never had', () => {
    expect(amazonMarkets.map((m) => m.code)).toEqual(expect.arrayContaining(['BE', 'PL', 'SE', 'IE', 'TR']))
  })

  it.each(amazonMarkets.map((m) => [m.code, m.marketplaceId]))('amazonMarketplaceId(%s) = %s', (code, id) => {
    expect(amazonMarketplaceId(code)).toBe(id)
    expect(amazonMarketplaceId(code.toLowerCase())).toBe(id)
  })

  it.each(amazonMarkets.map((m) => [m.code, m.marketplaceId]))('marketplaceCodeToId(%s) = %s', (code, id) => {
    expect(marketplaceCodeToId(code)).toBe(id)
  })

  it('reads South Africa as ZA, never as Belgium', () => {
    expect(normalizeMarketplaceCode('AE08WJ6YKNBMC')).toBe('ZA')
    expect(normalizeMarketplaceCode('AMEN7PMS3EDWL')).toBe('BE')
  })

  it('keeps an Amazon id and an unknown code as they are', () => {
    expect(amazonMarketplaceId('A1PA6795UKMFR9')).toBe('A1PA6795UKMFR9')
    expect(amazonMarketplaceId('XX')).toBe('XX')
  })
})
