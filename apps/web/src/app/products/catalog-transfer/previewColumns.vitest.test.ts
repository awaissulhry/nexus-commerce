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

describe('channel-file rows and the channel read (CFI)', () => {
  const file = { origin: 'channel-file' as const }
  it('shows what the channel held at its last read, and never claims a read that did not happen', () => {
    expect(render('channel', {})).toContain('Not read yet')
    // A field no read compares (e.g. Amazon's RRP) must never read "Same as Nexus" (production GALE DE, 2026-09-25).
    const notCompared = render('channel', { channelRead: { notCompared: true, readAt: '2026-09-24T03:37:00.000Z' } })
    expect(notCompared).toContain('Not compared by the channel read')
    expect(notCompared).not.toContain('Same as Nexus')
    expect(render('channel', { entity: 'Products' })).toContain('Not a channel value')
    const same = render('channel', { channelRead: { differs: false, readAt: '2026-09-24T03:37:00.000Z', source: 'amazon-content' } })
    expect(same).toContain('Same as Nexus at the last read')
    expect(same).toContain('2026-09-24T03:37:00.000Z')
    const differs = render('channel', { channelRead: { differs: true, value: 'Giacca Gale', ours: 'Old', readAt: '2026-09-24T03:37:00.000Z', source: 'amazon-content' } })
    expect(differs).toContain('Giacca Gale')
    expect(differs).not.toContain('Same as Nexus')
    expect(columns.map(c => c.label)).toContain('On the channel')
  })
  it('names presence, price and sale in words and says nothing is sent', () => {
    const ended = render('after', { ...file, entity: 'Listings', field: 'presence', after: 'ENDED' })
    expect(ended).toContain('Listing ended on the channel')
    expect(ended).toContain('nothing is sent')
    expect(render('field', { ...file, entity: 'Listings', field: 'presence' })).toContain('Listing on the channel')
    const price = render('after', { ...file, field: 'price', after: 89.9 })
    expect(price).toContain('89.90')
    expect(price).toContain('not sent to the channel')
    expect(render('after', { ...file, field: 'sale', after: { value: 69, start: '2026-10-01', end: '2026-10-31' } })).toContain('69.00 · 2026-10-01 to 2026-10-31')
    expect(render('after', { ...file, field: 'sale', after: { value: null, start: null, end: null } })).toContain('No sale')
    expect(render('field', { ...file, entity: 'Listings', field: 'sellerSku' })).toContain('Channel SKU')
  })
  it('explains a full-update blank as a removal on the channel', () => {
    const cleared = render('after', { ...file, action: 'CLEAR', clearIfPresent: true, after: null, before: 'Poliestere' })
    expect(cleared).toContain('Removed on the channel — will be cleared')
    expect(render('before', { ...file, action: 'CLEAR', clearIfPresent: true, before: 'Poliestere', beforeState: 'inherited' })).toContain('Poliestere')
  })
  it('shows the SKU as written in the file and marks rows from the channel file', () => {
    const product = render('product', { ...file, sku: 'IT-MOSS-JACKET', fileSku: 'MOSS-JACKET' })
    expect(product).toContain('File SKU: MOSS-JACKET')
    expect(product).toContain('From the channel file')
    expect(render('product', {})).not.toContain('From the channel file')
  })
})
