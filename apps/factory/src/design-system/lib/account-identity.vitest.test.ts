import { describe, expect, it } from 'vitest'
import { accountDisplayName, channelDisplayName } from './account-identity'

describe('account identity display', () => {
  it.each(['A1VRHKTGYO1JNU', '123456789012', 'Account 123456789012', 'cmothu9bo0000nz01asw6wx8j'])('hides legacy opaque label %s', (label) => {
    expect(accountDisplayName({ channel: 'AMAZON', label })).toBe('Amazon Seller account')
  })
  it('keeps real names', () => {
    expect(accountDisplayName({ channel: 'AMAZON', label: 'XAVIA RACING' })).toBe('XAVIA RACING')
    expect(accountDisplayName({ channel: 'EBAY', label: 'motovento' })).toBe('motovento')
    expect(accountDisplayName({ channel: 'AMAZON', label: 'ALPHARACING' })).toBe('ALPHARACING')
  })
  it('never reveals a server-flagged placeholder', () => {
    expect(accountDisplayName({ channel: 'AMAZON_ADS', label: 'opaque', labelIsPlaceholder: true })).toBe('Amazon Ads account')
  })
  it('uses human channel names', () => {
    expect(channelDisplayName('AMAZON_ADS')).toBe('Amazon Ads')
    expect(channelDisplayName('EBAY')).toBe('eBay')
  })
})
