/** E1 — the Etsy account's shown name: the operator's label, else the shop's name; never the login name (fake identities). */
import { describe, expect, it } from 'vitest'
import { etsyShopLabel } from './shop-label.js'

const LOGIN = 'abcdefgh12345678'
const identity = (extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  ({ userId: '1', username: LOGIN, storeName: 'Fake Shop', storeUrl: 'https://www.etsy.com/shop/FakeShop', extra: { shopId: '90000001', shopName: 'Fake Shop', ...extra }, ...over })

describe('etsyShopLabel', () => {
  it('a 16-character login name in displayName is never the label: the shop name is', () => {
    const account = { displayName: LOGIN, accountLabel: null, ebayStoreName: 'Fake Shop', identity: identity() }
    expect(etsyShopLabel(account)).toBe('Fake Shop')
    const loginOnly = { displayName: LOGIN, identity: { username: LOGIN } }
    expect(etsyShopLabel(loginOnly)).toBe('Etsy shop')
  })

  it('the operator\'s own label wins; then the shop name; storeName wins over ebayStoreName', () => {
    expect(etsyShopLabel({ accountLabel: '  Fake Etsy shop  ', ebayStoreName: 'Old copy', identity: identity() })).toBe('Fake Etsy shop')
    expect(etsyShopLabel({ accountLabel: ' ', ebayStoreName: 'Old copy', identity: identity({ shopName: null }, { storeName: 'Fake Shop' }) })).toBe('Fake Shop')
    expect(etsyShopLabel({ ebayStoreName: 'Old copy', identity: { storeName: 'Store Name' } })).toBe('Store Name')
    expect(etsyShopLabel({ ebayStoreName: 'Old copy', identity: null })).toBe('Old copy')
  })

  it('the connector\'s fallbacks for a shop with no name (the login name, "Etsy shop <id>") are not names', () => {
    expect(etsyShopLabel({ ebayStoreName: LOGIN, identity: identity({ shopName: null }, { storeName: LOGIN }) })).toBe('Etsy shop')
    expect(etsyShopLabel({ ebayStoreName: 'Etsy shop 90000001', identity: identity({ shopName: null }, { username: undefined, storeName: 'Etsy shop 90000001' }) })).toBe('Etsy shop')
  })
})
