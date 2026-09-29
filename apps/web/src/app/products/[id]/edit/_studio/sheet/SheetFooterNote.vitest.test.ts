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

describe('retrying the refused cells of a save', () => {
  it('offers the retry beside the refusal, counting only the edits it will send again', () => {
    const onRetry = vi.fn()
    const html = render({ refused: 3, retryable: 2, onRetry })
    expect(html).toContain('3 cells blocked')
    expect(html).toContain('aria-label="Retry 2 failed cells"')
    expect(html).toContain('>Retry</button>')
  })

  it('offers no retry when nothing refused can be sent again as it is', () => {
    expect(render({ refused: 3, retryable: 0, onRetry: vi.fn() })).not.toContain('Retry')
    expect(render({ refused: 0, retryable: 0, onRetry: vi.fn(), layoutRecovery: null })).not.toContain('>Retry</button>')
  })
})
