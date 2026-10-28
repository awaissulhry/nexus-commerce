import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ListboxPanel, type ListboxPanelOption } from './ListboxPanel'

/** A panel option's `note` (sheet publish parity, 2026-10-04): a line under the label, read as the description. */
const panel = (options: ListboxPanelOption[]) => render(createElement(ListboxPanel, { options, onCommit: vi.fn(), onCancel: vi.fn(), autoFocus: false }))

it('draws the note under the label and reads it as the description, not the name', () => {
  const html = panel([{ value: 'inactive', label: 'Inactive', note: 'Waiting for Publish, set by Awais today 10:42.' }])
  expect(html).toContain('class="has-note"')
  expect(html).toContain('<span class="nds-listbox-text"><span class="nds-listbox-name">Inactive</span><span class="nds-listbox-note" aria-hidden="true">Waiting for Publish, set by Awais today 10:42.</span></span>')
  expect(html).toContain('aria-description="Waiting for Publish, set by Awais today 10:42."')
})

it('a held option stays reachable, says why once, and shows the reason under it', () => {
  const html = panel([{ value: 'ended', label: 'Ended', heldReason: 'Amazon has no End.', note: 'Amazon has no End.' }])
  expect(html).toContain('aria-disabled="true"')
  expect(html).toContain('aria-description="Amazon has no End."')
  expect(html).not.toMatch(/<button[^>]*\sdisabled=""/)
  expect(html).toContain('class="held has-note"')
})

it('an option without a note renders exactly as before', () => {
  const html = panel([{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Bravo', heldReason: 'Not yet.' }])
  expect(html).not.toContain('nds-listbox-note')
  expect(html).toContain('>Alpha</button>')
  expect(html).toContain('aria-description="Not yet."')
})
