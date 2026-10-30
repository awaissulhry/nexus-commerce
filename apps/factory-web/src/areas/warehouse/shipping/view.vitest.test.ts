import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen } from './fixtures'
import { ShippingSettingsView } from './view/ShippingSettingsView'

// A key left on screen: a path under one of the catalogue's top-level names ("connection.title", "problem.cutOff").
const TOP = Object.keys(CATALOGUE.en['shipping-setup'] ?? {}).map((key) => key.split('.')[0]!)
const LEFT_KEY = new RegExp(`(?:^|[\\s>"])(?:${[...new Set(TOP)].join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*`)

describe('SCR-068 draws every design case in both languages', () => {
  for (const locale of LOCALES) {
    it(`${designScreen.cases.length} cases in ${locale}: no key left, no English Discard/Save words in Italian`, () => {
      for (const item of designScreen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shipping-setup', 'shell']) }, createElement(ShippingSettingsView, { model: item.model.model })))
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        if (locale === 'it') expect(/>(Discard|Save|Apply changes|Cancel)</.test(html), item.id).toBe(false)
      }
    })
  }

  it('a read-only person gets no inputs; the TEST pill shows for a FAKE account; field problems show after Save was pressed', () => {
    const draw = (id: string) => {
      const item = designScreen.cases.find((entry) => entry.id === id)!
      return renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shipping-setup', 'shell']) }, createElement(ShippingSettingsView, { model: item.model.model })))
    }
    expect(draw('sales-read-only')).not.toContain('<input')
    expect(draw('owner')).toContain('TEST')
    expect(draw('owner-live')).not.toContain('>TEST<')
    expect(draw('field-problems')).toContain('Two capital letters, as IT.')
    expect(draw('unsaved')).toContain('unsaved changes')
  })
})
