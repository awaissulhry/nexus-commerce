import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it } from 'vitest'
import { DrawerOverlayCard } from './DrawerOverlayCard'

it('is a modal dialog on its own surface, named by its heading', () => {
  const html = render(createElement(DrawerOverlayCard, { labelledBy: 'q-title', onCancel: () => undefined, children: createElement('h3', { id: 'q-title' }, 'Mark as checked?') }))
  expect(html).toMatch(/^<div class="nds-drawer-ovcard" role="dialog" aria-modal="true" aria-labelledby="q-title">/)
  expect(html).not.toContain('aria-label=')
})

it('takes a plain name when there is no heading, and alertdialog for a confirmation', () => {
  const html = render(createElement(DrawerOverlayCard, { label: 'Remove this listing?', role: 'alertdialog', className: 'extra', testId: 'card', children: 'Body' }))
  expect(html).toContain('class="nds-drawer-ovcard extra"')
  expect(html).toContain('role="alertdialog"')
  expect(html).toContain('aria-label="Remove this listing?"')
  expect(html).toContain('data-testid="card"')
})
