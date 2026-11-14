import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../../lib/i18n/provider'
import { deliveriesSchema } from './api'
import { designScreen } from './fixtures'
import { arrivalKey, downloadHeldKey } from './model'

const model = (id: string) => designScreen.cases.find((entry) => entry.id === id)!.model
const KEY = /\b(?:dv|rl)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-039-delivered — the order\'s Delivered (from carrier) card (B-W2b-398)', () => {
  it('every fixture is an answer the API may give', () => {
    for (const entry of designScreen.cases) if (entry.model.read) expect(() => deliveriesSchema.parse(entry.model.read), entry.id).not.toThrow()
  })

  it('says how each shipment arrived and holds the proof download with why', () => {
    const [carrier, typed] = model('delivered').read!.shipments
    expect(arrivalKey(carrier!)).toBe('dv.arrival.carrier')
    expect(arrivalKey(typed!)).toBe('dv.arrival.typed')
    expect(arrivalKey(model('travelling').read!.shipments[1]!)).toBe('dv.arrival.travelling')
    expect(downloadHeldKey(model('delivered'), carrier!)).toBeNull()
    expect(downloadHeldKey(model('delivered'), typed!)).toBe('dv.held.noImage')
    expect(downloadHeldKey(model('no-right'), model('no-right').read!.shipments[0]!)).toBe('dv.held.right')
    expect(downloadHeldKey(model('offline'), carrier!)).toBe('dv.held.offline')
  })

  it('every case draws in Italian and English with no raw key', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'ds-words']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html.match(KEY)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
      }
    }
  })
})
