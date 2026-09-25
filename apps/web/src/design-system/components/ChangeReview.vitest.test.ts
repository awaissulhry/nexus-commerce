import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ChangeReview, type ChangeReviewItem } from './ChangeReview'

const items: ChangeReviewItem[] = [{ id: 'title', label: 'Title · CHILD-S', status: 'Differs on channel', note: 'No accepted publication yet', selectable: true,
  values: [{ label: 'Nexus now', value: '<b>New title</b>' }, { label: 'Last accepted', value: 'Unknown' }, { label: 'Channel now', value: 'Old title' }] },
{ id: 'stock', label: 'Stock · CHILD-S', status: 'Cannot compare', note: 'Read failed', selectable: false, values: [{ label: 'Channel now', value: 'Unknown' }] }]
const render = (selectedIds: string[] = [], disabled = false) => renderToStaticMarkup(createElement(ChangeReview, { label: 'Fields to publish', items, selectedIds, disabled, onSelectionChange: () => {} }))

it('associates each named checkbox with its reason and labels all comparison values', () => {
  const html = render()
  for (const value of ['Fields to publish', 'Title · CHILD-S', 'Differs on channel', 'No accepted publication yet', 'Nexus now', 'Last accepted', 'Channel now', 'Read failed']) expect(html).toContain(value)
  expect(html).toContain('aria-labelledby='); expect(html).toContain('aria-describedby=')
  expect(html.match(/type="checkbox"/g)).toHaveLength(2)
  expect(html.match(/disabled=""/g)).toHaveLength(1)
  expect(html).not.toContain('checked=""')
})
it('never shows an ineligible row as selected and locks all choices during submission', () => {
  expect(render(['title', 'stock']).match(/checked=""/g)).toHaveLength(1)
  expect(render(['title'], true).match(/disabled=""/g)).toHaveLength(2)
})
it('renders comparison content as text without interpreting channel markup', () => {
  expect(render()).toContain('&lt;b&gt;New title&lt;/b&gt;')
  expect(render()).not.toContain('<b>New title</b>')
})
