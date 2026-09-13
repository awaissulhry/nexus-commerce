import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Menu } from './Menu'

// Node contract rendering: retain the real Menu tree; only the portal transport is replaced.
vi.mock('react-dom', async importOriginal => ({ ...await importOriginal<typeof import('react-dom')>(), createPortal: (child: unknown) => child }))
vi.stubGlobal('document', { body: {} })
afterAll(() => vi.unstubAllGlobals())

describe('Menu held semantics', () => {
  it('keeps explanations reachable and reasonless disabled items native-disabled', () => {
    const html = renderToStaticMarkup(createElement(Menu, { open: true, label: 'Actions', items: [
      { id: 'held', label: 'Held', disabled: true, description: 'Wait for the pending write to finish.', title: 'Wait for the pending write to finish.', tone: 'danger' },
      { id: 'off', label: 'Off', disabled: true },
      { id: 'sep', separator: true },
      { id: 'link', label: 'Linked action', href: '/example', tone: 'danger' },
    ] }))
    const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    const held = buttons.find(m => m[2].includes('Wait for'))!
    expect(held[1]).toContain('aria-disabled="true"'); expect(held[1]).not.toMatch(/\sdisabled=/)
    expect(held[1]).toContain('data-tone="danger"')
    expect(buttons.find(m => m[2] === 'Off')![1]).toMatch(/\sdisabled=/)
    expect(html).toMatch(/<a[^>]*data-tone="danger"[^>]*href="\/example"/)
    expect(html).toContain('role="separator"')
  })
})
