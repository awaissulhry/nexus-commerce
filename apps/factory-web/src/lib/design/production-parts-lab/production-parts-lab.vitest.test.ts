import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../../i18n/provider'
import { LOCALES } from '../../i18n/locales'
import { designScreen } from './fixtures'

/**
 * F-PR-01 — the production parts lab: the index finds it, every case draws in both languages with no catalogue key on
 * screen, and the customer cases show nothing of the office's (the brand wall in the review frame too).
 */
const render = (locale: (typeof LOCALES)[number], model: unknown) =>
  renderToString(createElement(I18nProvider, { locale, messages: {} }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model })))
const model = (id: string) => designScreen.cases.find((c) => c.id === id)!.model

describe('the /design/production-parts lab', () => {
  it('has its own screen id (the design index finds every fixtures.ts by itself) and the cases the review needs', () => {
    expect(designScreen.screen).toBe('production-parts')
    expect(designScreen.cases.map((c) => c.id)).toEqual(['office', 'customer', 'stages-office', 'stages-customer', 'pieces', 'requests-office', 'requests-customer', 'holds-customer', 'unknown', 'loading', 'problem'])
  })

  it('draws every case in both languages without a key on screen', () => {
    for (const locale of LOCALES) {
      for (const c of designScreen.cases) {
        const html = render(locale, c.model)
        expect(html, `${locale}/${c.id}`).not.toMatch(/>[^<]*\b(?:parts|progress|section|example|note|action|data)\.[a-zA-Z]+/)
      }
    }
  })

  it('the Italian frame speaks Italian', () => {
    const html = render('it', model('office'))
    for (const word of ['Parti di produzione condivise', 'Barra delle fasi', 'Tocca al terzista', 'Franco fabbrica', 'Cuciti 80 di 100', 'Rispondi in Approvazioni']) expect(html).toContain(word)
    expect(html).not.toMatch(/Shared production parts|Stage strip|Waiting on workshop|Ex-factory|Sewn 80 of 100|Answer in Approvals/)
  })

  it('the customer cases show nothing of the office’s', () => {
    for (const id of ['customer', 'holds-customer', 'requests-customer', 'stages-customer']) {
      const html = render('en', model(id))
      for (const text of ['supplier', 'workshop', 'Shade difference', 'Lab test re-run', 'Bea Esempio', 'Carlo Prova', 'Office only', 'Line moved to an urgent order', 'Planned', 'Ex-factory']) expect(html, `${id}: ${text}`).not.toContain(text)
    }
    const office = render('en', model('office'))
    for (const text of ['Waiting on workshop', 'Quality: shade difference on the red panels', 'Answered by Carlo Prova']) expect(office).toContain(text)
  })

  it('the office case shows the one rule: a bar and its words from one figure', () => {
    const html = render('en', model('office'))
    expect(html).toContain('Progress of WO-0311: Sewn 80 of 100')
    expect(html).toMatch(/aria-valuenow="80"[^>]*aria-label="Progress of WO-0311|aria-label="Progress of WO-0311[^"]*"[^>]*aria-valuenow="80"/)
  })
})
