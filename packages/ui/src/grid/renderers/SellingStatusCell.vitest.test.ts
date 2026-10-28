import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PublishActionView } from './PublishActionCell'
import { SellingStatusView } from './SellingStatusCell'

const now = new Date(2026, 9, 4, 15, 0).getTime()
const today = new Date(2026, 9, 4, 10, 42).toISOString()

describe('the Status cell', () => {
  it('a live state is a dotted pill; the eye gets the pill, a screen reader one sentence', () => {
    const html = render(createElement(SellingStatusView, { value: { state: 'paused' }, now }))
    expect(html).toContain('nds-pill warning has-dot')
    expect(html).toMatch(/<span class="nds-selling-visual" aria-hidden="true">/)
    expect(html).toContain('<span class="nds-vh">Status: Inactive.</span>')
  })

  it('a waiting target is a clock pill (a glyph, not a colour alone) with the live state beside it', () => {
    const html = render(createElement(SellingStatusView, { value: { state: 'active', waiting: { target: 'ended', setAt: today, setByName: 'Awais' } }, now }))
    expect(html).toContain('nds-pill danger')
    expect(html).not.toContain('has-dot')
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(html).toContain('>now Active<')
    expect(html).toContain('Status: Active. Ended is waiting for Publish, set by Awais today 10:42.')
  })

  it('a read-only draft (Not listed) shows a lock and says why; a renderer never claims title', () => {
    const html = render(createElement(SellingStatusView, { value: { state: 'draft' }, now }))
    expect(html).toContain('nds-selling-lock')
    expect(html).toContain('>Publish creates it<')
    expect(html).toContain('Status: Not listed. In Nexus only. Publish creates it on the channel.')
    expect(html).not.toContain('title=')
  })

  it('shows a skeleton while loading', () => {
    const html = render(createElement(SellingStatusView, { value: undefined, now }))
    expect(html).toContain('nds-skeleton')
    expect(html).toContain('Status: loading.')
  })
  it('a new row: its choice as a pill without a glyph, the "new" mark beside it, no lock', () => {
    const html = render(createElement(SellingStatusView, { value: { state: 'not_listed', create: { target: 'active', source: 'default', sentence: 'Publish creates it and it sells.' } }, now }))
    expect(html).toContain('nds-selling-cell is-new')
    expect(html).toContain('nds-pill info')
    expect(html).not.toContain('has-dot')
    expect(html).not.toContain('nds-selling-lock')
    expect(html).toContain('>new<')
  })
})

describe('the Action cell', () => {
  it('the default is quiet muted text with no pill', () => {
    const html = render(createElement(PublishActionView, { value: { mode: 'partial' }, now }))
    expect(html).toContain('<span class="nds-action-quiet">Partial update</span>')
    expect(html).not.toContain('nds-pill')
    expect(html).toContain('Action: Partial update. Publish sends only the fields you changed.')
  })

  it('a waiting Delete is a danger clock pill', () => {
    const html = render(createElement(PublishActionView, { value: { mode: 'delete', setAt: today, setByName: 'Awais' }, now }))
    expect(html).toContain('nds-pill danger')
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(html).toContain('Action: Delete is waiting for Publish, set by Awais today 10:42.')
    expect(html).not.toContain('title=')
  })

  it('a row not on the channel reads Full update as a pill without a glyph (sent whole)', () => {
    const html = render(createElement(PublishActionView, { value: { mode: 'full', newRow: true }, now }))
    expect(html).toContain('nds-action-cell is-new')
    expect(html).toContain('nds-pill info')
    expect(html).toContain('>Full update<')
    expect(html).not.toContain('<svg')
  })
})
