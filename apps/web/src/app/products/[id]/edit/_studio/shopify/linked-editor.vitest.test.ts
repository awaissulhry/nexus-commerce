import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LinkedFieldEditor } from './LinkedFieldEditor'
import { ShopifyRichText } from '../images/shopify/ShopifyFieldValue'
import { OrderedList } from '@/design-system/components'
import type { ShopifyFieldDefinition, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
const schema: ShopifyStoreSchema = { definitions: [], metaobjectDefinitions: [], types: [], locales: [], revision: 'schema' }
const def = (type: string): ShopifyFieldDefinition => ({ id: 'field', namespace: 'custom', key: 'field', name: 'Store field', description: null, type, ownerType: 'PRODUCT', validations: [], access: { admin: null, storefront: null } })
const field = (type: string, value: string) => renderToStaticMarkup(createElement(LinkedFieldEditor, { path: '/fixture', definition: def(type), value, disabled: false, schema, onChange: () => {} }))
describe('Shopify values remain readable without coercion', () => {
  it('preserves long decimals and legacy units in typed list controls', () => {
    const raw = '[9007199254740993,0.1234567890123456789]'
    const decimals = field('list.number_decimal', raw)
    expect(decimals).toContain('value="9007199254740993"')
    expect(decimals).toContain('value="0.1234567890123456789"')
    const weights = field('list.weight', '[{"value":12.3,"unit":"kg"}]')
    expect(weights).toContain('value="12.3"')
    expect(weights).toContain('kg (current)')
  })
  it('preserves an invalid boolean as a visible repairable current option', () => expect(field('boolean', 'legacy')).toContain('legacy (current value)'))
  it.each(['null', '[]', '{"type":"root","children":[null]}', '{"type":"root","children":"wrong"}'])('keeps malformed rich text editable: %s', raw => {
    const html = renderToStaticMarkup(createElement(ShopifyRichText, { raw, disabled: false, onChange: () => {} }))
    expect(html).toContain('Repair rich text JSON'); expect(html).not.toContain('Add paragraph')
  })
  it('keeps formatting metadata visible in valid rich text', () => {
    const html = renderToStaticMarkup(createElement(ShopifyRichText, { raw: '{"type":"root","children":[{"type":"heading","level":2,"children":[{"type":"text","value":"Red","bold":true}]}]}', disabled: false, onChange: () => {} }))
    expect(html).toContain('Heading 1'); expect(html).toContain('Bold'); expect(html).toContain('Red')
  })
  it('uses product names for accessible ordering actions while retaining stable identifiers', () => {
    const html = renderToStaticMarkup(createElement(OrderedList, { label: 'Family order', items: ['gid://shopify/Product/1', 'gid://shopify/Product/2'], itemLabel: (id: string) => id.endsWith('/1') ? 'Red coat' : 'Blue coat', onChange: () => {} }))
    expect(html).toContain('aria-label="Move Blue coat up"'); expect(html).not.toContain('aria-label="Move gid:')
  })
})
