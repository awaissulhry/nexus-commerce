import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'

// The DS Modal draws only once hydrated (a portal): drawn in place here, so a dialog's body renders on the server.
vi.mock('@nexus/ui/components', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    Modal: ({ open, title, children, footer }: { open: boolean; title?: ReactNode; children?: ReactNode; footer?: ReactNode }) => (open ? createElement('div', { role: 'dialog' }, createElement('h2', null, title), children, footer) : null),
  }
})

const { designScreen } = await import('./fixtures')

/** Every dialog case of the subcontract order's record draws its body in both languages, with no key left on screen. */
const groups = [...new Set(['subcontract-order', 'subcontracting'].flatMap((namespace) => Object.keys(CATALOGUE.en[namespace] ?? {}).map((key) => key.split('.')[0]!)))].join('|')
const LEFT_KEY = new RegExp(`\\b(?:${groups})\\.[a-zA-Z_]+(?:\\.[a-zA-Z_]+)*\\b`)
const SAID = /\b(?:purchasing\.(?:view|subcontract\.(?:manage|kit|receive))|shipping\.ddt\.(?:issue|cancel)|workorders\.view|files\.read|inventory\.locations\.view|product\.materials\.view|money\.cost)\b/g

describe('the record’s dialogs', () => {
  const cases = designScreen.cases.filter((item) => item.model.record.dialog !== null)
  it(`${cases.length} dialog cases × it, en`, () => {
    expect(cases.length).toBeGreaterThan(15)
    for (const item of cases) {
      for (const locale of LOCALES) {
        const View = designScreen.view as ComponentType<{ model: unknown }>
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'subcontracting', 'subcontract-order', 'lists', 'records']) }, createElement(View, { model: item.model }))).replace(SAID, '')
        expect(html, item.id).toContain('role="dialog"')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    }
  })

  it('Send kit names where the lining leaves from and the DDT; without shipping.ddt.issue it says the kit goes without one', () => {
    const render = (id: string) => {
      const item = designScreen.cases.find((entry) => entry.id === id)!
      const View = designScreen.view as ComponentType<{ model: unknown }>
      return renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell', 'subcontracting', 'subcontract-order', 'lists', 'records']) }, createElement(View, { model: item.model })))
    }
    expect(render('send')).toContain('N-STORE-01 · LT-DEMO-FOD-11')
    expect(render('send')).toContain('DDT for work on our behalf')
    expect(render('send-no-ddt-right')).toContain('the kit goes without one')
    expect(render('receive')).toContain('Cucitura tasca aperta')
    expect(render('receive-held')).toMatch(/only \d+ pieces are at the workshop/)
    expect(render('return-line')).toContain('Annul it in Documents first')
  })
})
