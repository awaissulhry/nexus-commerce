import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PortalActionBar } from './PortalActionBar'

/** B-W2b-155 — the portal action bar: the band's primary action above the BottomBar on a phone, held with its reason. */
describe('PortalActionBar markup', () => {
  it('a named region with the primary action; a spacer in the flow for the fixed bar', () => {
    const html = renderToStaticMarkup(createElement(PortalActionBar, { action: { label: 'Conferma tutto come richiesto', onClick: () => {} }, note: '3 righe come richiesto', label: 'Azioni dell’ordine' }))
    expect(html).toContain('<div class="nds-pab-host"><div class="nds-pab-spacer" aria-hidden="true"></div>')
    expect(html).toContain('role="region" aria-label="Azioni dell’ordine" class="nds-pab" data-above="bottombar"')
    expect(html).toContain('class="nds-btn primary lg nds-pab-action"')
    expect(html).toContain('3 righe come richiesto')
  })
  it('held: the button holds with the reason AND the reason is a line in the bar', () => {
    const html = renderToStaticMarkup(createElement(PortalActionBar, { action: { label: 'Send', heldReason: 'Answer line 2 first' } }))
    expect(html).toContain('aria-disabled="true" aria-description="Answer line 2 first"')
    expect(html).toContain('<p class="nds-pab-held">Answer line 2 first</p>')
  })
  it('busy: held with the busy words, no held line', () => {
    const html = renderToStaticMarkup(createElement(PortalActionBar, { action: { label: 'Send', busy: true }, labels: { busy: 'Invio…' } }))
    expect(html).toContain('aria-description="Invio…"')
    expect(html).not.toContain('nds-pab-held')
  })
  it('inline: in the flow, no spacer; at the bottom edge when there is no BottomBar', () => {
    const inline = renderToStaticMarkup(createElement(PortalActionBar, { action: { label: 'Go' }, inline: true }))
    expect(inline).not.toContain('nds-pab-spacer')
    expect(inline).toContain('class="nds-pab inline"')
    expect(renderToStaticMarkup(createElement(PortalActionBar, { action: { label: 'Go' }, aboveBottomBar: false }))).not.toContain('data-above')
  })
  it('a link action is a real link; nothing to show draws nothing', () => {
    expect(renderToStaticMarkup(createElement(PortalActionBar, { action: { label: 'Open the PDF', href: '/files/x.pdf' } }))).toContain('<a href="/files/x.pdf"')
    expect(renderToStaticMarkup(createElement(PortalActionBar, {}))).toBe('')
  })
  it('the stylesheet hides the bar from 720 px and sits it on the BottomBar below it', () => {
    const css = readFileSync(fileURLToPath(new URL('./portalActionBar.css', import.meta.url)), 'utf8')
    expect(css).toMatch(/\.nds-pab-host \{\s*display: none;/)
    expect(css).toContain('@media (max-width: 719px)')
    expect(css).toContain('bottom: calc(var(--nds-space-48) + var(--nds-space-8) + 1px + env(safe-area-inset-bottom))')
  })
})
