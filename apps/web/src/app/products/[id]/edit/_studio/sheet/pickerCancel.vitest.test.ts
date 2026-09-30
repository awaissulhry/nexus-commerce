import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const panel = vi.hoisted(() => ({ current: null as any }))
vi.mock('@/design-system/components', () => ({ AsyncListboxPanel: (props: unknown) => { panel.current = props; return null } }))
vi.mock('@/lib/workspaces/Link', () => ({ default: () => null }))
vi.mock('@/design-system/primitives', () => ({ Button: () => null, Select: () => null }))
vi.mock('@/app/catalog/categories/api', () => ({ categoryHref: () => '/' }))
vi.mock('./categoryOptions', () => ({ loadCategoryOptions: vi.fn(() => new Promise(() => {})) }))
vi.mock('./referenceOptions', () => ({ loadReferenceChoices: vi.fn(() => new Promise(() => {})) }))
vi.mock('./ebayPolicies', () => ({ loadEbayPolicies: vi.fn(() => new Promise(() => {})), policyLists: { fulfillmentPolicyId: 'fulfillmentPolicies' } }))

import { ChannelCategoryEditor } from './ChannelCategoryEditor'
import { ReferenceSelectEditor } from './ReferenceSelectEditor'
import { EbayPolicyEditor } from './EbayPolicyInput'

afterEach(() => { panel.current = null })

/**
 * Audit B09 (2026-09-30) — the pickers cancelled with AG's editor `stopEditing(true)`, which ENDS the edit with the value
 * last reported (the argument is `suppressNavigateAfterEdit`). A cancel is the grid API's `stopEditing(true)`.
 */
describe('category and reference pickers cancel through the grid API', () => {
  const mount = (component: unknown, props: Record<string, unknown>) => {
    const stopEditing = vi.fn()
    const api = { stopEditing: vi.fn() }
    renderToStaticMarkup(React.createElement(component as any, { value: 'OLD', onValueChange: vi.fn(), stopEditing, api, ...props }))
    return { stopEditing, api }
  }
  it.each([
    ['ChannelCategoryEditor', ChannelCategoryEditor, { channel: 'EBAY', market: 'IT' }],
    ['ReferenceSelectEditor', ReferenceSelectEditor, { fieldKey: 'shop_section_id', market: 'IT' }],
  ])('%s: Escape / Cancel is a real cancel', (_name, component, props) => {
    const { stopEditing, api } = mount(component, props)
    panel.current.onCancel()
    expect(api.stopEditing).toHaveBeenCalledWith(true)
    expect(stopEditing).not.toHaveBeenCalled()
  })
})

/** Audit B16 — the category, product-type and policy pickers offer Clear; Etsy's Clear stores null, never Number('') = 0. */
describe('pickers offer Clear', () => {
  it.each([
    ['ChannelCategoryEditor', ChannelCategoryEditor, { channel: 'EBAY', market: 'IT' }],
    ['EbayPolicyEditor', EbayPolicyEditor, { fieldKey: 'fulfillmentPolicyId', market: 'IT' }],
  ])('%s passes the Clear row', (_name, component, props) => {
    renderToStaticMarkup(React.createElement(component as any, { value: 'OLD', onValueChange: vi.fn(), stopEditing: vi.fn(), api: { stopEditing: vi.fn() }, ...props }))
    expect(panel.current.emptyLabel).toBe('Clear')
  })
  it('Clear on an Etsy category stores null', () => {
    const onValueChange = vi.fn()
    renderToStaticMarkup(React.createElement(ChannelCategoryEditor as any, { value: 1234, onValueChange, stopEditing: vi.fn(), api: { stopEditing: vi.fn() }, channel: 'ETSY', market: 'IT' }))
    panel.current.onKeyChoice('')
    expect(onValueChange).toHaveBeenCalledWith(null)
  })
})
