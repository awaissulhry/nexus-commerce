import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it } from 'vitest'
import { FileRow } from './FileRow'
import { FILE_ROW_LABELS } from './FileRowLabels'

/** B-W2b-09 — FileRow's actions slot (the app's Download / Open beside Replace and Remove) and its words. */
const NAME = 'ddt-2026-0042.pdf'

it('draws the app actions first, in the same cluster, before Replace and Remove', () => {
  const html = render(h(FileRow, { name: NAME, actions: h('a', { href: '/files/1', className: 'app-download' }, 'Download'), onReplace: () => {}, onRemove: () => {} }))
  const cluster = /<div class="nds-filerow-actions">(.*)<\/div><\/div>$/.exec(html)?.[1] ?? ''
  expect(cluster.indexOf('app-download')).toBeGreaterThanOrEqual(0)
  expect(cluster.indexOf('app-download')).toBeLessThan(cluster.indexOf('Replace file'))
  expect(cluster.indexOf('Replace file')).toBeLessThan(cluster.indexOf('aria-label="Remove file"'))
})

it('draws the cluster for actions alone, and nothing for a false or empty slot', () => {
  expect(render(h(FileRow, { name: NAME, actions: h('a', { href: '/x' }, 'Open') }))).toContain('nds-filerow-actions')
  expect(render(h(FileRow, { name: NAME, actions: false }))).not.toContain('nds-filerow-actions')
  expect(render(h(FileRow, { name: NAME, actions: '' }))).not.toContain('nds-filerow-actions')
  expect(render(h(FileRow, { name: NAME, actions: null }))).toBe(render(h(FileRow, { name: NAME })))
})

it('does not lock the app actions with `disabled` (the app holds its own)', () => {
  const html = render(h(FileRow, { name: NAME, disabled: true, actions: h('button', { type: 'button' }, 'Open'), onRemove: () => {} }))
  expect(html).toContain('<button type="button">Open</button>')
  expect(html.match(/disabled=""/g)).toHaveLength(1)
})

it('says its own actions in the words it is given; English when none', () => {
  const it = render(h(FileRow, { name: NAME, onReplace: () => {}, onRemove: () => {}, labels: { replace: 'Sostituisci file', remove: 'Rimuovi file' } }))
  expect(it).toContain('Sostituisci file')
  expect(it).toContain('aria-label="Rimuovi file"')
  expect(it).not.toContain('Replace file')
  const en = render(h(FileRow, { name: NAME, onReplace: () => {}, onRemove: () => {}, labels: { replace: undefined } }))
  expect(en).toContain(FILE_ROW_LABELS.replace)
  expect(en).toContain(`aria-label="${FILE_ROW_LABELS.remove}"`)
})
