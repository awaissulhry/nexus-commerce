import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { shopifyShopDomain, verifyShopifyCallbackHmac } from './auth.js'

describe('Shopify OAuth input verification', () => {
  it('accepts only an anchored permanent myshopify.com domain', () => {
    expect(shopifyShopDomain(' Xavia-Shop.myshopify.com ')).toBe('xavia-shop.myshopify.com')
    expect(shopifyShopDomain('xavia-shop')).toBeNull()
    expect(shopifyShopDomain('https://xavia-shop.myshopify.com')).toBeNull()
    expect(shopifyShopDomain('xavia-shop.myshopify.com.attacker.example')).toBeNull()
    expect(shopifyShopDomain('attacker.example/xavia-shop.myshopify.com')).toBeNull()
  })

  it('verifies every signed callback parameter and rejects malformed signatures', () => {
    const secret = 'shopify-test-client-secret'
    const query = {
      code: 'authorization-code',
      shop: 'xavia-shop.myshopify.com',
      state: 'single-use-state',
      timestamp: '1788883200',
    }
    const message = Object.entries(query).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&')
    const hmac = createHmac('sha256', secret).update(message).digest('hex')
    expect(verifyShopifyCallbackHmac({ ...query, hmac }, secret)).toBe(true)
    expect(verifyShopifyCallbackHmac({ ...query, shop: 'another.myshopify.com', hmac }, secret)).toBe(false)
    expect(verifyShopifyCallbackHmac({ ...query, hmac: 'not-hex' }, secret)).toBe(false)
    expect(verifyShopifyCallbackHmac(query, secret)).toBe(false)
  })
})
