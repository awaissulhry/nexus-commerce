import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { StudioPublishChange } from '@nexus/shared/studio-publication'
import { PublicationChanges, publicationValueText } from './PublicationChanges'

const change: StudioPublishChange = { id: 'title', productId: 'child', sku: 'CHILD', field: 'title', label: 'Title',
  current: { state: 'value', value: '<script>text only</script>' }, lastAccepted: { state: 'unknown', reason: 'No accepted publish record' },
  channel: { state: 'value', value: 'Channel title' }, status: 'DIFFERS', localChanged: null, channelChanged: null,
  selectable: true, selectedByDefault: false, reason: 'Choose explicitly.', operation: 'replace' }
it('keeps missing evidence, a deletion, null and empty text distinct', () => {
  expect(publicationValueText({ state: 'unknown', reason: 'Read failed' })).toBe('Unknown — Read failed')
  expect(publicationValueText({ state: 'absent' })).toBe('Cleared / absent')
  expect(publicationValueText({ state: 'value', value: null })).toBe('Empty value (null)')
  expect(publicationValueText({ state: 'value', value: '' })).toBe('(empty text)')
  expect(publicationValueText({ state: 'value', value: ['One', 'Two'] })).toContain('"Two"')
})
it('shows first publication differences unchecked with escaped values and exact selected counts', () => {
  const render = (selectedIds: string[]) => renderToStaticMarkup(createElement(PublicationChanges, { changes: [change], selectedIds, disabled: false, onSelectionChange: () => {} }))
  expect(render([])).toContain('0 changes'); expect(render([])).not.toContain('checked=""')
  const selected = render(['title'])
  expect(selected).toContain('1 change'); expect(selected).toContain('checked=""')
  expect(selected).toContain('Unknown — No accepted publish record')
  expect(selected).toContain('&lt;script&gt;text only&lt;/script&gt;'); expect(selected).not.toContain('<script>')
})
it('keeps unchanged evidence available and never counts unknown or refused rows as selected', () => {
  const rows = [change, { ...change, id: 'same', status: 'SAME' as const, selectable: false },
    { ...change, id: 'unread', status: 'CANNOT_COMPARE' as const, selectable: false, reason: 'Permission denied', channel: { state: 'unknown' as const, reason: 'Read failed' } }]
  const html = renderToStaticMarkup(createElement(PublicationChanges, { changes: rows, selectedIds: ['same', 'unread'], disabled: false, onSelectionChange: () => {} }))
  expect(html).toContain('0 changes'); expect(html).toContain('1 field needs no send')
  expect(html).toContain('Cannot compare'); expect(html).toContain('Permission denied'); expect(html).not.toContain('checked=""')
})
