import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TransferCell } from '@nexus/shared/catalog-transfer'
import { DataGrid } from '@/design-system/components/DataGrid'
import { previewColumns } from './previewColumns'

const cell: TransferCell = {
  row: 2, entity: 'Overrides', sku: '001-JACKET', channel: 'AMAZON', accountId: 'account-1',
  marketplace: 'IT', aliasKey: '', locale: '', field: 'title', action: 'SET',
  before: 'Old title', after: 'New title', beforeState: 'stored', afterState: 'stored', verdict: 'changed',
}
const columns = previewColumns([{ id: 'account-1', displayName: 'Italy shop' }])
const render = (key: string, changes: Partial<TransferCell>) =>
  renderToStaticMarkup(createElement('div', null, columns.find(c => c.key === key)!.render({ ...cell, ...changes })))

describe('catalog review on the Nexus table', () => {
  it('shows resolved values, their source, friendly aliases and exact correction locations', () => {
    expect(render('before', { effectiveBefore: { value: 'Shared coat', source: 'Inherited from parent' } })).toContain('Shared coat')
    expect(render('after', { effectiveAfter: { value: false, source: 'Listing override' } })).toContain('false')
    expect(render('field', { label: 'Title', source: { file: 'part-2.xlsx', sheet: 'Amazon IT', column: 'F' }, row: 7 })).toContain('part-2.xlsx · Amazon IT · F7')
    const named = previewColumns([], [{ channel: 'AMAZON', accountId: 'account-1', marketplace: 'IT', aliasKey: 'stable-id', aliasLabel: 'Summer listing' }])
    const html = renderToStaticMarkup(createElement('div', null, named[0].render({ ...cell, aliasKey: 'stable-id' })))
    expect(html).toContain('Summer listing'); expect(html).not.toContain('stable-id')
    expect(previewColumns([], [], true).map(c => c.label)).toContain('Value before import')
    expect(previewColumns([], [], true).map(c => c.label)).not.toContain('Current value')
  })
  it('describes a Parent SKU change as a relationship, including explicit unlinking', () => {
    const parent = { entity: 'Products' as const, field: 'parentSku', beforeState: 'inherited' as const, before: null, after: '001-JACKET' }
    expect(render('field', parent)).toContain('Parent SKU')
    expect(render('before', parent)).toContain('No parent')
    expect(render('after', parent)).toContain('Child of 001-JACKET')
    const unlink = render('after', { ...parent, before: '001-JACKET', after: null, action: 'CLEAR' })
    expect(unlink).toContain('Unlink from parent')
    expect(unlink).not.toContain('Use inherited value')
  })
  it.each([[0, '0'], [false, 'false'], [null, 'Empty'], ['', 'Empty text'], ['00123', '00123']])('preserves stored %j as %s', (value, text) => {
    expect(render('before', { before: value })).toContain(`>${text}</div>`)
    expect(render('after', { after: value })).toContain(`${text}</div>`)
  })

  it('distinguishes inheritance from empty stored values and hides effective values', () => {
    const before = render('before', { beforeState: 'inherited', before: 'Resolved parent title' })
    const after = render('after', { action: 'INHERIT', afterState: 'inherited', after: 'Resolved parent title' })
    expect(before).toContain('No stored override')
    expect(after).toContain('INHERIT')
    expect(after).toContain('Use inherited value')
    expect(before + after).not.toContain('Resolved parent title')
    expect(render('after', { action: 'CLEAR', after: null })).toContain('Empty')
  })

  it('keeps product locale and exact listing scope visible', () => {
    expect(render('product', {})).toContain('AMAZON · IT · Italy shop · Primary')
    expect(render('product', { aliasKey: 'outlet' })).toContain('Italy shop · outlet')
    expect(render('product', { accountId: 'unavailable-account' })).toContain('unavailable-account · Primary')
    expect(render('product', { entity: 'Products', locale: 'it' })).toContain('Master · it')
    expect(render('product', {})).toContain('001-JACKET')
  })

  it('escapes file content and preserves structured values as text', () => {
    expect(render('after', { after: '<script>alert(1)</script>' })).toContain('&lt;script&gt;')
    expect(render('after', { after: ['red', 'blue'] })).toContain('[&quot;red&quot;,&quot;blue&quot;]')
  })

  it('renders the real shared table with its accessible name and all review headings', () => {
    const html = renderToStaticMarkup(createElement(DataGrid<TransferCell>, {
      ariaLabel: 'Catalog import changes', columns, rows: [cell], rowKey: row => String(row.row), size: 'sm',
    }))
    expect(html).toContain('<table aria-label="Catalog import changes"')
    for (const label of ['Product / scope', 'Attribute', 'Current value', 'Proposed value']) expect(html).toContain(label)
    expect(html).toContain('Old title')
    expect(html).toContain('New title')
  })
})
