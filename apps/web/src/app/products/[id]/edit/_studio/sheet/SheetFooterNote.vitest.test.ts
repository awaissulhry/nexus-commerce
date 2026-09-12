import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SheetFooterNote, type SheetFooterNoteProps } from './SheetFooterNote'

const props: SheetFooterNoteProps = {
  offline: false, refused: 0, showRefusedOnly: false, onToggleRefused: vi.fn(), lastSavedAt: null,
  layoutRecovery: { retry: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) },
}
const render = (overrides: Partial<SheetFooterNoteProps> = {}) => renderToStaticMarkup(createElement(SheetFooterNote, { ...props, ...overrides }))

describe('saved layout recovery in the sheet status footer', () => {
  it('identifies the failed layout request and offers a specific recovery action', () => {
    const html = render()
    expect(html).toContain('Saved column layout unavailable')
    expect(html).toContain('Retry layout</button>')
    expect(html).toContain('role="status"')
    expect(html).not.toContain('Failed to fetch')
  })

  it('gives product-save connection failures and refusals priority over layout recovery', () => {
    const offline = render({ offline: true, refused: 2 })
    expect(offline).toContain('Connection lost')
    expect(offline).not.toContain('Retry layout')
    const refused = render({ refused: 2 })
    expect(refused).toContain('2 cells blocked')
    expect(refused).not.toContain('Retry layout')
  })

  it('removes the recovery notice after the layout becomes available', () => {
    const html = render({ layoutRecovery: null })
    expect(html).not.toContain('Saved column layout unavailable')
    expect(html).not.toContain('Retry layout')
    expect(html).toContain('Show the keyboard shortcuts')
  })
})
