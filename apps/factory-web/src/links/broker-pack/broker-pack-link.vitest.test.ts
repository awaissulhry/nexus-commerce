import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/api/errors'
import { messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { linkTaskOf } from '../_nav/link-types'
import { brokerPackPageSchema } from './api'
import { designScreen } from './fixtures'
import { downloadHeldKey, mrnProblemKey, pressProblem, sendHeldKey } from './model'

const model = (id: string) => designScreen.cases.find((entry) => entry.id === id)!.model
const KEY = /\b(?:held|problem|mrn|filed|status)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-580 — Export declaration papers (B-W2b-409)', () => {
  it('a BROKER_PACK link of a customs declaration opens this page', () => {
    expect(linkTaskOf({ purpose: 'BROKER_PACK', record: { type: 'CustomsDeclaration' } })).toBe('broker-pack')
  })

  it('every fixture is an answer the API may give', () => {
    for (const entry of designScreen.cases) if (entry.model.page) expect(() => brokerPackPageSchema.parse(entry.model.page), entry.id).not.toThrow()
  })

  it('checks the MRN while it is typed and holds Send with why', () => {
    expect(mrnProblemKey('')).toBeNull()
    expect(mrnProblemKey('26CH0000')).toBe('held.MRN_FORMAT')
    expect(mrnProblemKey('26ch 0000 0000 0000 42')).toBeNull()
    expect(sendHeldKey(model('papers'))).toBe('held.empty')
    expect(sendHeldKey(model('typing'))).toBe('held.MRN_FORMAT')
    expect(sendHeldKey(model('ready'))).toBeNull()
    expect(sendHeldKey(model('sending'))).toBe('held.busy')
    expect(sendHeldKey(model('offline'))).toBe('held.offline')
    expect(sendHeldKey(model('filed'))).toBe('held.FILED')
  })

  it('holds a withdrawn paper and a download while another press runs', () => {
    const gone = model('paper-gone')
    expect(downloadHeldKey(gone, gone.page!.papers[0]!)).toBe('held.gone')
    expect(downloadHeldKey(gone, gone.page!.papers[1]!)).toBeNull()
    expect(downloadHeldKey(model('downloading'), { available: true })).toBe('held.busy')
  })

  it('says a refused press by its code; a link that stopped opening ends the page', () => {
    expect(pressProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/FILED' }]))).toEqual({ key: 'held.FILED', link: null })
    expect(pressProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/mrn' }]))).toEqual({ key: 'held.MRN_FORMAT', link: null })
    expect(pressProblem(new ApiError('not_found', 404, 'LINK_UNAVAILABLE', 'x'))).toEqual({ key: 'problem.gone', link: 'unavailable' })
    expect(pressProblem(new Error('boom'))).toEqual({ key: 'problem.failed', link: null })
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
