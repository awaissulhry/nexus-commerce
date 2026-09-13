import { expect, it } from 'vitest'
import { offerActiveHonoured } from './listing-capabilities.js'
it.each(['SHOPIFY', 'EBAY', 'WOOCOMMERCE', 'ETSY', 'shopify'])('%s does not honour the local offerActive flag', channel => {
  expect(offerActiveHonoured(channel)).toBe(false)
})
it('Amazon consumes the flag on its next flat-file submit', () => {
  expect(offerActiveHonoured('AMAZON')).toBe(true)
})
