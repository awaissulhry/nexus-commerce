import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { leftKeys, textOf } from '../../../../lib/record-thread/parts/testing'
import { designScreen } from './fixtures'

// The DS Modal draws into a portal once hydrated, never on the server: here it draws in place, so the dialog's words can be read.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/**
 * op-fx1 (F-OP-101's design case "f-op-101-refuse"): Refuse… the yes — the dialog names the order, the reason picked from the list and
 * the words typed. Moved here from orders.vitest: there the page is drawn to a string and a DS dialog never draws on the server.
 */
describe('F-OP-101: Refuse… the yes — its dialog in the design case', () => {
  const draw = (locale: (typeof LOCALES)[number]) => {
    const View = designScreen.view as unknown as ComponentType<{ model: unknown }>
    const model = (designScreen as unknown as DesignScreen<unknown>).cases.find((item) => item.id === 'f-op-101-refuse')!.model
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }

  it('names the order, the reason from the list and the words; Refuse is the dialog’s one go; no key on screen in it or en', () => {
    const en = draw('en')
    expect(en).toContain('role="dialog"')
    expect(en).toContain('Refuse the yes for')
    expect(en).toContain('Price below the agreed list')
    expect(textOf(draw('it'))).toContain('Prezzo sotto il listino concordato')
    for (const locale of LOCALES) expect(leftKeys(draw(locale), ['approval'])).toEqual([])
  })
})
