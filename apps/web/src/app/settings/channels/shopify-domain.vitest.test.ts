import { describe, expect, it } from 'vitest'
import { isShopifyDomain, normalizeShopifyDomain } from './shopify-domain'

describe('Shopify domain input', () => {
  it.each([
    ['xavia-shop', 'xavia-shop.myshopify.com'],
    ['Xavia-Shop.myshopify.com', 'xavia-shop.myshopify.com'],
    ['https://xavia-shop.myshopify.com/admin/settings', 'xavia-shop.myshopify.com'],
    ['https://admin.shopify.com/store/xavia-shop/products', 'xavia-shop.myshopify.com'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeShopifyDomain(input)).toBe(expected)
    expect(isShopifyDomain(input)).toBe(true)
  })

  it.each([
    'shop.example.com',
    'xavia-shop.myshopify.com.attacker.example',
    'https://admin.shopify.com/settings',
    'xavia shop',
    '',
  ])('rejects %s', (input) => {
    expect(normalizeShopifyDomain(input)).toBe('')
    expect(isShopifyDomain(input)).toBe(false)
  })
})
