import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SourceIndicator } from './SourceIndicator'

describe('SourceIndicator accessibility contract', () => {
  const props = { kind: 'master' as const, label: 'Follows Master', description: 'Uses the resolved Master value' }
  it('exposes a keyboard-focusable source with an accessible explanation', () => {
    const html = renderToStaticMarkup(createElement(SourceIndicator, props))
    expect(html).toContain('role="img"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="Follows Master. Uses the resolved Master value"')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('title=')
  })
  it('offers a button only when an action and explanation are supplied together', () => {
    const html = renderToStaticMarkup(createElement(SourceIndicator, { ...props, actionLabel: 'Click to override', onAction() {} }))
    expect(html).toContain('<button')
    expect(html).toContain('Click to override')
    expect(renderToStaticMarkup(createElement(SourceIndicator, { ...props, onAction() {} }))).not.toContain('<button')
  })
  it('keeps labels visible in legends', () => {
    const html = renderToStaticMarkup(createElement(SourceIndicator, { ...props, showLabel: true }))
    expect(html).toContain('<span>Follows Master</span>')
    expect(html).toContain('aria-hidden="true"')
  })
})
