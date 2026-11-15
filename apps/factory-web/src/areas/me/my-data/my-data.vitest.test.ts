import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { LOCALES } from '../../../lib/i18n/locales'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import type { MyRequest } from './api'
import { designScreen } from './fixtures'
import { anyCollecting, askHeld, myProblem, myState } from './model'

/** B-W2b-414 Download my data: each request's state, why Ask is held, and SCR-663 drawn in it and en with no key on screen. */

const base: MyRequest = { id: 'r1', company: { id: 'c1', code: 'DEMO', name: 'Demo' }, kind: 'ACCESS', status: 'IN_PROGRESS', receivedAt: '2026-11-15T08:00:00.000Z', dueAt: '2026-12-15T08:00:00.000Z', package: null, collect: { state: 'RUNNING', at: '2026-11-15T08:00:00.000Z' } }
const pkg = { fileId: 'f1', name: 'my-data.zip', sizeBytes: 10, madeAt: null }

describe('Download my data', () => {
  it('a request is being collected, ready, handed over, failed or closed', () => {
    expect(myState(base)).toBe('collecting')
    expect(myState({ ...base, package: pkg, collect: { state: 'READY', at: null } })).toBe('ready')
    expect(myState({ ...base, status: 'DONE', package: pkg })).toBe('handed')
    expect(myState({ ...base, collect: { state: 'FAILED', at: null } })).toBe('failed')
    expect(myState({ ...base, status: 'WITHDRAWN' })).toBe('closed')
  })
  it('Ask is held while one is open or no company is picked; the dialog reads again while one is collected', () => {
    expect(askHeld(null)).toBe('dp.common.loading')
    expect(askHeld({ requests: [base], mayAsk: false, companyId: 'c1' })).toBe('dp.my.held.open')
    expect(askHeld({ requests: [], mayAsk: false, companyId: null })).toBe('dp.my.held.company')
    expect(askHeld({ requests: [], mayAsk: true, companyId: 'c1' })).toBeNull()
    expect(anyCollecting({ requests: [base], mayAsk: false, companyId: 'c1' })).toBe(true)
    expect(myProblem(new ApiError('conflict', 409, 'conflict', 'English'))).toBe('dp.my.held.open')
  })
})

describe('SCR-663 draws every case in both languages with no key on screen', () => {
  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      for (const item of designScreen.cases) {
        const View = designScreen.view as ComponentType<{ model: unknown }>
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'me']) }, createElement(View, { model: item.model })))
        expect(html.length, item.id).toBeGreaterThan(500)
        expect(html.match(/\bdp\.[a-zA-Z]+(?:\.[a-zA-Z_]+)+\b/)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }
  it('the button sits in My profile\'s head', () => {
    const View = designScreen.view as ComponentType<{ model: unknown }>
    const html = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell', 'me']) }, createElement(View, { model: designScreen.cases[0]!.model })))
    expect(html).toContain('Download my data')
  })
})
