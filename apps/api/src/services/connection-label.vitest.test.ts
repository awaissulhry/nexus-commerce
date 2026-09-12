import { describe, expect, it } from 'vitest'
import { connectionLabel } from './connection-label.js'

describe('human-facing connection names', () => {
  it('prefers the operator name consistently', () => {
    expect(connectionLabel({ channelType: 'AMAZON', accountLabel: ' XAVIA RACING ', displayName: 'A1VRHKTGYO1JNU' }))
      .toEqual({ label: 'XAVIA RACING', labelSource: 'accountLabel', labelIsPlaceholder: false })
  })
  it.each(['A1VRHKTGYO1JNU', '123456789012', 'Account 123456789012', 'cmothu9bo0000nz01asw6wx8j', '0e31caaf-9a00-454d-b5dd-1d4459fc3cf8'])('does not turn %s into a name', (id) => {
    expect(connectionLabel({ channelType: 'AMAZON', accountLabel: id, displayName: id, id }).label).toBe('Amazon Seller account')
  })
  it('skips an opaque display name when a real sign-in name exists', () => {
    expect(connectionLabel({ channelType: 'EBAY', displayName: 'eBay seller (verified)', ebaySignInName: 'xaviaracing', externalAccountId: 'xaviaracing' }).label).toBe('xaviaracing')
  })
  it('keeps provider store names and human eBay identities', () => {
    expect(connectionLabel({ channelType: 'EBAY', ebayStoreName: 'Motovento', displayName: 'xaviaracing' }).label).toBe('Motovento')
  })
  it.each(['AMAZON', 'AMAZON_ADS', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])('uses a named fallback for %s', (channelType) => {
    const result = connectionLabel({ channelType, externalAccountId: '123456789012', displayName: '123456789012' })
    expect(result.label).not.toContain('123456789012')
    expect(result.label).not.toContain('_')
    expect(result.labelIsPlaceholder).toBe(true)
  })
  it.each(['AMAZON', 'EBAY', 'SHOPIFY'])('preserves uppercase company names on %s', (channelType) => {
    expect(connectionLabel({ channelType, accountLabel: 'ALPHARACING' }).label).toBe('ALPHARACING')
  })
})
