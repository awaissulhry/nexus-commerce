import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { FileRow, type FileRowProps } from './FileRow'

const render = (props: Partial<FileRowProps> = {}) =>
  renderToStaticMarkup(createElement(FileRow, { name: 'nexus-products-2026-09-26.xlsx', ...props }))

it('shows the whole name as its title, the size in words and the status line', () => {
  const html = render({ size: 673 * 1024, status: 'Nexus file · 42 products' })
  expect(html).toContain('title="nexus-products-2026-09-26.xlsx"')
  expect(html).toContain('673 KB')
  expect(html).toContain('Nexus file · 42 products')
})

it('names both actions and ties them to the file they act on', () => {
  const html = render({ onReplace: () => {}, onRemove: () => {} })
  expect(html).toContain('Replace file')
  expect(html).toContain('aria-label="Remove file"')
  const nameId = /<span id="([^"]+)" class="nds-filerow-name"/.exec(html)?.[1]
  expect(nameId).toBeTruthy()
  expect(html.match(new RegExp(`aria-describedby="${nameId}"`, 'g'))).toHaveLength(2)
  expect(html).not.toContain('disabled=""')
})

it('renders no action without a handler, and locks both when disabled', () => {
  expect(render()).not.toContain('<button')
  expect(render({ onReplace: () => {}, onRemove: () => {}, disabled: true }).match(/disabled=""/g)).toHaveLength(2)
})

it('marks a refused file and keeps the reason as text', () => {
  const html = render({ tone: 'danger', status: 'Not a Nexus product file' })
  expect(html).toContain('class="nds-filerow danger"')
  expect(html).toContain('Not a Nexus product file')
  expect(render()).toContain('class="nds-filerow"')
})
