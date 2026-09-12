import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProductRoleChip } from './ProductRoleChip'

describe('product role identity', () => {
  it.each([
    [{ parentId: null, isParent: false, childCount: 0 }, 'Standalone', 'S'],
    [{ parentId: null, isParent: true, childCount: 0 }, 'Parent · 0 children', 'P'],
    [{ parentId: null, isParent: false, childCount: 2 }, 'Parent · 2 children', 'P'],
    [{ parentId: 'root', parentSku: '001-JACKET', isParent: false, childCount: 0 }, 'Child · Parent SKU: 001-JACKET', 'C'],
  ] as const)('renders an accessible role for %j', (product, label, badge) => {
    const html = renderToStaticMarkup(createElement(ProductRoleChip, { product }))
    expect(html).toContain(`aria-label="${label}"`)
    expect(html).toContain(`>${badge}</span>`)
  })
})
