import { describe, expect, it } from 'vitest'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { ChannelScopePage, SheetColumn, StudioRow } from '../sheet/channel/types'
import { withUnlinkedShopifyColumns } from './unlinkedInformationColumns'

const schema: ShopifyStoreSchema = { revision: '1', types: [], locales: [], metaobjectDefinitions: [], definitions: [
  { id: '1', namespace: 'custom', key: 'name', name: 'Store-specific name', ownerType: 'PRODUCT', type: 'single_line_text_field', validations: [], access: { admin: null, storefront: null }, description: null },
] }
const title: SheetColumn = { key: 'name', writeField: 'shopify_title', label: 'Title', group: 'Content', kind: 'text', storage: 'listing', scope: 'global', editable: true, requiredBy: [], defaultVisible: true }
const page: ChannelScopePage = { scope: { kind: 'channel', channel: 'SHOPIFY', marketplace: 'GLOBAL', label: 'Shopify', connectionId: 'A', locale: 'en' },
  family: { id: 'p', sku: 'p', name: 'Product', productType: null, variationAxes: [] }, columns: [title], aliases: [],
  rows: [{ id: 'p', values: { name: { value: 'Saved title', writable: true, editable: true } } } as unknown as StudioRow], readiness: {},
  meta: { schemaMissing: [], schemaAge: [], droppedKeys: [], tookMs: 0 } }

describe('unlinked Shopify attribute discovery', () => {
  it('preserves local authoring and keeps unique store names separate without inventing values or mappings', () => {
    const next = withUnlinkedShopifyColumns(page, schema)!
    expect(next.columns.filter(c => c.key === 'name')).toHaveLength(1)
    expect(next.columns.find(c => c.key === 'name')).toEqual({ ...title, label: 'Name', helpText: 'Shopify: Title.' })
    expect(next.rows[0].values.name).toBe(page.rows[0].values.name)
    expect(next.columns).toHaveLength(1) // Definitions become columns through the authoritative API, with a writer.
    expect(page.columns).toEqual([title])
  })
  it('uses only current store definitions and does not leak them across channels', () => {
    const current = { ...page, columns: [title, { ...title, key: 'shopify_metafield:A:PRODUCT:custom:name:single_line_text_field' }] }
    const renamed = withUnlinkedShopifyColumns(current, { ...schema, definitions: [{ ...schema.definitions[0], name: 'Renamed' }] })!
    expect(renamed.columns.find(c => c.key === 'shopify_metafield:A:PRODUCT:custom:name:single_line_text_field')?.label).toBe('Renamed')
    expect(withUnlinkedShopifyColumns(page, { ...schema, definitions: [] })!.columns.some(c => c.key.includes('metafield:'))).toBe(false)
    const ebay = { ...page, scope: { ...page.scope, channel: 'EBAY' as const } }
    expect(withUnlinkedShopifyColumns(ebay, schema)).toBe(ebay)
    expect(withUnlinkedShopifyColumns(page, null)).toBe(page)
  })
})

it('keeps server mappings once and removes a stale definition as soon as the live schema changes', () => {
  const key = 'shopify_metafield:A:PRODUCT:custom:name:single_line_text_field'
  const column = { ...title, key, label: 'Store-specific name' }
  const cell = { ...page.rows[0].values.name, value: 'Mapped store value', writable: false, editable: false }
  const loaded = { ...page, columns: [...page.columns, column], rows: [{ ...page.rows[0], values: { ...page.rows[0].values, [key]: cell } }] } as ChannelScopePage
  const kept = withUnlinkedShopifyColumns(loaded, schema)!
  expect(kept.columns.filter(c => c.key.includes('metafield'))).toEqual([column])
  expect(kept.rows[0].values[key]).toBe(cell)
  expect(withUnlinkedShopifyColumns(loaded, { ...schema, definitions: [] })!.columns.some(c => c.key === key)).toBe(false)
  expect(withUnlinkedShopifyColumns(loaded, { ...schema, definitions: [{ ...schema.definitions[0], type: 'number_integer' }] })!.columns.some(c => c.key === key)).toBe(false)
})
