import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LockedCell, LockGlyph } from './cells'

/**
 * The locked cell (Owner 2026-10-07): the value, then an OUTLINE lock icon in the muted grid ink — never the 🔒 emoji —
 * named with the reason for a screen reader. The FBA qty column on the Matrix and the Information page draws it.
 */
const html = (reason?: string, value: unknown = 14) =>
  renderToStaticMarkup(createElement(LockedCell, { value, kind: 'integer', reason } as never))

describe('the locked cell\'s lock', () => {
  it('is the outline icon (an svg), never the emoji', () => {
    const out = html('Amazon-managed — Nexus shows this number and never changes it')
    expect(out).not.toContain('🔒')
    expect(out).toMatch(/<svg[^>]*class="[^"]*nds-cell-lock-glyph/)
    expect(out).toMatch(/<svg[^>]*role="img"/)
  })

  it('says why on the icon, and "Read-only" when no reason is given', () => {
    expect(html('Amazon-managed — Nexus shows this number and never changes it')).toContain('aria-label="Amazon-managed — Nexus shows this number and never changes it"')
    expect(html()).toContain('aria-label="Read-only"')
    expect(renderToStaticMarkup(createElement(LockGlyph, { reason: null }))).toContain('aria-label="Read-only"')
  })

  it('keeps the value: a measured 0 reads 0, an empty value the dash', () => {
    expect(html(undefined, 0)).toMatch(/^<span class="nds-cell-locked">0<svg/)
    expect(html(undefined, null)).toMatch(/^<span class="nds-cell-locked">—<svg/)
  })
})
