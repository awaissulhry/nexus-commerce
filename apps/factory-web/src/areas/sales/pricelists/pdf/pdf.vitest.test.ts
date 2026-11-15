import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as costScreen } from '../../_shared/cost-changed/fixtures'
import { designScreen } from './fixtures'
import { emptySend, keepHeld, sendBody, sendHeld, sendOpenHeld, type KeptPdfModel } from './model'

/** B-W2b-380 (XF6:01): the price list PDF kept for mail — what holds Keep and Send, the body sent; SCR-531 and SCR-530 in both languages. */

const kept = { listId: 'l', versionId: 'v', revision: 2, upToDate: true, needsCompany: false, pdfs: [] }
const ready: KeptPdfModel['read'] = { status: 'ready', value: kept }
const base = { can: { manage: true, price: true }, read: ready, busy: false, customers: [{ id: 'c1', code: 'CLI-1', legalName: 'Cliente Uno' }] }

describe('keep and send', () => {
  it('held with why: no price grain, no right, no version, still reading, busy; a list of every company sends from no company', () => {
    expect(keepHeld(base)).toBeNull()
    expect(keepHeld({ ...base, can: { manage: true, price: false } })).toEqual({ key: 'pdf.held.noPrice' })
    expect(keepHeld({ ...base, can: { manage: false, price: true } })).toEqual({ key: 'pdf.held.noManage' })
    expect(keepHeld({ ...base, read: { status: 'none' } })).toEqual({ key: 'pdf.held.noVersion' })
    expect(keepHeld({ ...base, read: { status: 'loading' } })).toEqual({ key: 'pdf.held.loading' })
    expect(keepHeld({ ...base, busy: true })).toEqual({ key: 'pdf.held.busy' })
    expect(sendOpenHeld({ ...base, read: { status: 'ready', value: { ...kept, needsCompany: true } } })).toEqual({ key: 'pdf.held.everyCompany' })
    expect(sendOpenHeld({ ...base, customers: [] })).toEqual({ key: 'pdf.held.noCustomer' })
  })

  it('Send held before the click: no customer, an address that is not one; the body takes only what was typed', () => {
    const draft = { ...emptySend('c1'), to: 'acquisti@cliente.example.com, agente@cliente.example.com', cc: '', subject: '  ', message: ' Ecco il listino. ' }
    expect(sendHeld(draft)).toBeNull()
    expect(sendHeld({ ...draft, partyId: '' })).toEqual({ key: 'pdf.sendHeld.customer' })
    // No address typed: the customer's own contact.
    expect(sendHeld({ ...draft, to: '' })).toBeNull()
    expect(sendBody({ ...draft, to: '' }, 'it')).toEqual({ partyId: 'c1', message: 'Ecco il listino.', language: 'it' })
    expect(sendHeld({ ...draft, to: 'acquisti@cliente' })).toEqual({ key: 'pdf.sendHeld.bad', params: { list: 'acquisti@cliente' } })
    expect(sendHeld({ ...draft, sending: true })).toEqual({ key: 'pdf.held.busy' })
    expect(sendBody(draft, 'en')).toEqual({ partyId: 'c1', to: ['acquisti@cliente.example.com', 'agente@cliente.example.com'], message: 'Ecco il listino.', language: 'en' })
  })
})

const LEFT_KEY = /\b(?:pdf|minimums|cost|design)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [designScreen, costScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale).replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it("uses the step's new screen ids", () => {
    expect([costScreen.screen, designScreen.screen]).toEqual(['SCR-530', 'SCR-531'])
  })
})
