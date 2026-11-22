import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { textOf } from '../../../../../lib/record-thread/parts/testing'
import { designScreen } from './fixtures'

// The DS Modal draws into a portal once hydrated, never on the server: here it draws in place, so the dialog's words can be read.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

// F-OC-303 (order CHANGES tab, W3; C5-B9): Before → after — never an empty window, the order's own fields that changed, the reason in
// words, the customer's answer, amounts only with the price grain.

const screen = designScreen as unknown as DesignScreen<unknown>
const draw = (id: string, locale: 'en' | 'it' = 'en') => {
  const View = screen.view as ComponentType<{ model: unknown }>
  const item = screen.cases.find((entry) => entry.id === id)!
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model })))
}

describe('F-OC-303: Before → after', () => {
  it('a change of the order\'s own fields says them (the customer PO before → after) — it was an empty table', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(draw('compare-header', locale))
      expect(text).toContain(locale === 'en' ? 'Customer PO' : 'Ordine del cliente')
      expect(text).toContain('PO-ESEMPIO-88')
      expect(text).toContain('PO-ESEMPIO-88B')
    }
  })

  it('the window opens while the change is read, and says why when it cannot be read (Try again)', () => {
    expect(textOf(draw('compare-reading'))).toContain('Reading the change…')
    const failed = textOf(draw('compare-failed'))
    expect(failed).toContain("Couldn't read the change")
    expect(failed).toContain('Try again')
  })

  it('without the price grain no amount, said once in words; the reason as typed', () => {
    const manager = textOf(draw('compare-manager'))
    expect(manager).toContain('Not shown to you: the amounts')
    expect(manager).not.toMatch(/€/)
  })
})
