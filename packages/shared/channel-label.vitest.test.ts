import { describe, expect, it } from 'vitest'

import { channelLabel, channelPlace } from './channel-label'

describe('channelPlace — the place words of a listing sentence (browser check 2026-10-05, F4)', () => {
  it('a channel with markets: its name and the market, as the sheet writes it', () => {
    expect(channelPlace('EBAY', 'IT')).toBe('eBay · IT')
    expect(channelPlace('AMAZON', 'de')).toBe('Amazon · DE')
  })
  it('a channel that sells one listing everywhere (GLOBAL, or no market): its name alone', () => {
    expect(channelPlace('SHOPIFY', 'GLOBAL')).toBe('Shopify')
    expect(channelPlace('ETSY', 'global')).toBe('Etsy')
    expect(channelPlace('SHOPIFY', null)).toBe('Shopify')
    expect(channelPlace('SHOPIFY', '')).toBe('Shopify')
  })
  it('the channel name is the one label (`channelLabel`), never the database constant', () => {
    expect(channelPlace('WOOCOMMERCE', 'GLOBAL')).toBe(channelLabel('WOOCOMMERCE'))
    expect(channelPlace('EBAY', 'IT')).not.toContain('EBAY')
  })
})
