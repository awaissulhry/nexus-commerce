import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../../lib/api/errors'
import { messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { returnLabelsSchema } from './api'
import { designScreen } from './fixtures'
import { cancelHeldKey, confirmHeldKey, firstDraft, labelWindowHref, makeBodyOf, makeHeldKey, outcomeOfError } from './model'
import { designScreen as windowScreen } from './window/fixtures'

const model = (id: string) => designScreen.cases.find((entry) => entry.id === id)!.model
const KEY = /\b(?:rl|win|dv|link)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-112-return-label — the return labels on the RMA (B-W2b-398)', () => {
  it('every fixture is an answer the API may give', () => {
    for (const entry of designScreen.cases) if (entry.model.read) expect(() => returnLabelsSchema.parse(entry.model.read), entry.id).not.toThrow()
  })

  it('holds Make return label with why: no right, offline, a write running, what the API says stops it', () => {
    expect(makeHeldKey(model('labels'))).toBeNull()
    expect(makeHeldKey(model('read-only'))).toBe('rl.held.right')
    expect(makeHeldKey(model('offline'))).toBe('rl.held.offline')
    expect(makeHeldKey(model('making'))).toBe('rl.held.busy')
    expect(makeHeldKey(model('test-mode'))).toBe('rl.held.code.TEST_MODE')
    expect(makeHeldKey(model('loading'))).toBe('rl.held.loading')
  })

  it('withdraws only a label still waiting for the goods; a mailed link needs someone to mail it to', () => {
    const read = model('used').read!
    expect(cancelHeldKey(model('used'), read.labels[0]!)).toBe('rl.held.final')
    expect(cancelHeldKey(model('labels'), model('labels').read!.labels[0]!)).toBeNull()
    expect(confirmHeldKey(model('make-link-no-contact').read!, { mode: 'LINK', shipmentId: null, send: true }, null)).toBe('rl.held.code.NO_RECIPIENT')
    expect(confirmHeldKey(model('make-link-no-contact').read!, { mode: 'LINK', shipmentId: null, send: false }, null)).toBeNull()
  })

  it('sends the shipment only when another one is picked, and the link choice only for a link', () => {
    const read = model('make-label').read!
    expect(makeBodyOf(read, firstDraft(read))).toEqual({ mode: 'LABEL' })
    expect(makeBodyOf(read, { mode: 'LINK', shipmentId: read.make.shipments[1]!.id, send: false })).toEqual({ mode: 'LINK', shipmentId: read.make.shipments[1]!.id, send: false })
    expect(labelWindowHref('/w/DEMO', 'r 1', 'l/2')).toBe('/w/DEMO/sales/returns/label?return=r%201&label=l%2F2')
  })

  it('says a refusal by its code, else by its kind', () => {
    expect(outcomeOfError(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/TEST_MODE' }]))).toEqual({ kind: 'failed', key: 'rl.held.code.TEST_MODE' })
    expect(outcomeOfError(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ kind: 'failed', key: 'rl.failed.forbidden' })
    expect(outcomeOfError(new Error('boom'))).toEqual({ kind: 'failed', key: 'rl.failed.error' })
  })

  it('every case of the section and of the PDF window draws in Italian and English with no raw key', () => {
    for (const screen of [designScreen, windowScreen] as const) {
      for (const locale of ['it', 'en'] as const) {
        for (const entry of screen.cases) {
          const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'ds-words']) }, createElement(screen.view as never, { model: entry.model })))
          expect(html.match(KEY)?.[0] ?? null, `${screen.screen} ${entry.id} (${locale})`).toBeNull()
        }
      }
    }
  })
})
