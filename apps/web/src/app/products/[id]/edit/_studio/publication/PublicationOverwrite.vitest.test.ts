import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { StudioPublishOverwrite } from '@nexus/shared/studio-publication'
import { PublicationOverwrite } from './PublicationOverwrite'

const product: StudioPublishOverwrite['products'][number] = { productId: 'p', sku: 'GALE-S', status: 'compared',
  checkedAt: '2026-09-24T18:40:00.000Z', differing: 2, notCompared: 12, omittedDifferences: 1,
  fields: [{ field: 'fabric_type', nexusAtRead: 'Polyester', channelAtRead: '100% Polyester', checkedAt: '2026-09-23T08:00:00.000Z' }] }
const render = (products: StudioPublishOverwrite['products'], confirmed = false) => renderToStaticMarkup(createElement(PublicationOverwrite, {
  overwrite: { requiresConfirmation: true, products }, confirmed, onConfirm: () => {}, disabled: false,
}))

it('labels observed values as historical and names incomplete/capped coverage', () => {
  const html = render([product])
  for (const text of ['GALE-S', 'fabric_type', 'Nexus at read', 'Channel at read', '100% Polyester', '12 fields', '1 additional difference', '2026-09-23', '2026-09-24']) expect(html).toContain(text)
  expect(html).toContain('not a live check')
  expect(html).not.toContain('No changes')
})

it('names unread and uncomparable products instead of presenting them as unchanged', () => {
  const html = render([{ ...product, sku: 'UNREAD', status: 'not_read', fields: [], checkedAt: null, differing: 0, notCompared: null, omittedDifferences: 0 },
    { ...product, productId: 'other', sku: 'UNCOMPARABLE', status: 'not_compared', reason: 'The channel read failed', fields: [], differing: 0, omittedDifferences: 0 }])
  for (const text of ['UNREAD', 'Not read yet', 'unknown', 'UNCOMPARABLE', 'Could not compare', 'The channel read failed']) expect(html).toContain(text)
  expect(html).not.toContain('No differences recorded')
})

it('uses an unchecked labelled design-system checkbox until this review is acknowledged', () => {
  const html = render([product])
  expect(html).toContain('class="nds-check')
  expect(html).toContain('type="checkbox"')
  expect(html).toContain('I understand this can overwrite channel values')
  expect(html).not.toContain('checked=""')
  expect(render([product], true)).toContain('checked=""')
})

it('renders channel content as text without interpreting markup', () => {
  const html = render([{ ...product, fields: [{ ...product.fields[0], channelAtRead: '<script>bad()</script>' }] }])
  expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
  expect(html).not.toContain('<script>')
})
