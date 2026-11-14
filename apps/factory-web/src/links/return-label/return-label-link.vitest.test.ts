import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/api/errors'
import { messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { linkTaskOf } from '../_nav/link-types'
import { returnLabelPageSchema } from './api'
import { designScreen } from './fixtures'
import { bookHeldKey, downloadHeldKey, pressProblem } from './model'

const model = (id: string) => designScreen.cases.find((entry) => entry.id === id)!.model
const KEY = /\b(?:link|rl)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-436 — Your return label (B-W2b-398)', () => {
  it('a RETURN_LABEL link of a return opens this page', () => {
    expect(linkTaskOf({ purpose: 'RETURN_LABEL', record: { type: 'ReturnAuthorisation' } })).toBe('return-label')
  })

  it('every fixture is an answer the API may give', () => {
    for (const entry of designScreen.cases) if (entry.model.page) expect(() => returnLabelPageSchema.parse(entry.model.page), entry.id).not.toThrow()
  })

  it('holds Book and Download with why', () => {
    expect(bookHeldKey(model('offered'))).toBeNull()
    expect(bookHeldKey(model('held'))).toBe('link.held.NO_CARRIER_ACCOUNT')
    expect(bookHeldKey(model('offline'))).toBe('link.held.offline')
    expect(bookHeldKey(model('booking'))).toBe('link.held.busy')
    expect(downloadHeldKey(model('offered'))).toBe('link.held.notBooked')
    expect(downloadHeldKey(model('booked'))).toBeNull()
  })

  it('says a refused press by its code; a link that stopped opening ends the page', () => {
    expect(pressProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/CARRIER' }]))).toEqual({ key: 'link.held.CARRIER', link: null })
    expect(pressProblem(new ApiError('not_found', 404, 'LINK_UNAVAILABLE', 'x'))).toEqual({ key: 'link.problem.gone', link: 'unavailable' })
    expect(pressProblem(new Error('boom'))).toEqual({ key: 'link.problem.failed', link: null })
  })

  it('every case draws in Italian and English with no raw key and no price', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'ds-words']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html.match(KEY)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
        expect(html).not.toMatch(/€|EUR/)
      }
    }
  })
})
