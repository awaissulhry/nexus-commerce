import { informationRegistry, nativeFieldKeys } from '@nexus/shared/shopify-information'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
export const informationShopifySchema: ShopifyStoreSchema = {
  revision: 'information-fixture-2026-07', currency: 'EUR', definitions: [
    { id: 'flag', ownerType: 'PRODUCT', namespace: 'custom', key: 'flag', name: 'Custom product', type: 'boolean', validations: [], access: { admin: 'MERCHANT_READ_WRITE', storefront: null }, description: 'A typed product flag.' },
    { id: 'copy', ownerType: 'PRODUCT', namespace: 'custom', key: 'copy', name: 'Feature copy', type: 'multi_line_text_field', validations: [], access: { admin: 'MERCHANT_READ_WRITE', storefront: null }, description: 'Reusable descriptive content.' },
    { id: 'owned', ownerType: 'PRODUCT', namespace: 'app--1--test', key: 'owned', name: 'App-owned value', type: 'single_line_text_field', validations: [], access: { admin: 'MERCHANT_READ', storefront: null }, description: null, readOnlyReason: 'The owning app grants merchant read access only.' },
  ], types: [], metaobjectDefinitions: [], locales: [{ locale: 'en', primary: true, published: true }, { locale: 'it', primary: false, published: true }],
  native: { scopes: ['write_products', 'write_translations'], enums: { status: [{ name: 'ACTIVE', description: null }, { name: 'DRAFT', description: null }], inventoryPolicy: [{ name: 'DENY', description: null }, { name: 'CONTINUE', description: null }] },
    inputs: Object.fromEntries(['product', 'variant', 'inventory', 'measurement'].map(key => [key, [...nativeFieldKeys, 'seo']])) },
}
export function shopifyFixtureSnapshot(ids: string[], locale = 'en') {
  return { currency: 'EUR', timezone: 'Europe/Rome', locale, rows: ids.flatMap(id => {
    const number = Number(id.split('/').at(-1))
    const product = { id, productId: id, kind: 'PRODUCT', title: `Fixture Shopify ${number}`, handle: `fixture-${number}`, image: null, media: [],
      fields: [{ ownerId: id, namespace: 'custom', key: 'flag', type: 'boolean', value: 'false', compareDigest: `${id}-flag` }, { ownerId: id, namespace: 'custom', key: 'copy', type: 'multi_line_text_field', value: 'Provider copy', compareDigest: `${id}-copy` }],
      values: { title: `Fixture Shopify ${number}`, descriptionHtml: '<p>Provider description</p>', vendor: 'Nexus', category: null, status: 'DRAFT', handle: `fixture-${number}`, tags: '[]' } }
    const rows = [product, ...[1, 2].map(i => ({ id: `gid://shopify/ProductVariant/${number * 10 + i}`, productId: id, kind: 'PRODUCTVARIANT', title: i === 1 ? 'M' : 'L', handle: product.handle, image: null, media: [], fields: [], values: { sku: `SHOP-${number}-${i}`, price: '0.00', taxable: 'false', inventoryPolicy: 'DENY', category: null } }))]
    return rows.map(row => locale === 'en' ? row : { ...row, locale, primaryLocale: 'en', translations: Object.fromEntries(informationRegistry(informationShopifySchema).filter(f => ['title', 'descriptionHtml'].includes(f.id)).map(f => [f.id, { key: f.id === 'descriptionHtml' ? 'body_html' : f.id, value: null, digest: `${row.id}-${f.id}-digest`, outdated: false, resourceId: row.id }])) })
  }) }
}
