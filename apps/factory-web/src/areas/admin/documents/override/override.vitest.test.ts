import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OVERRIDE_REFUSALS } from '@nexus/factory-domain/numbering/override'
import { ApiError } from '../../../../lib/api/errors'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { LOCALES } from '../../../../lib/i18n/locales'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { OVERRIDE_CODES, PREVIEW_HELD } from './api'
import { designScreen } from './fixtures'
import { emptyDraft, lineWords, mayOverride, overrideHeld, typedNumberRefusal, wellFormed, type NumberFieldModel } from './model'

/** SCR-014-override (B-W2b-24; PLT-125): the number line and the popup "Type a number for a migrated document", pure, and every case in it + en. */

const flat = (o: Record<string, unknown>, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]))

describe('the words', () => {
  it('say every refusal the API can give and every held preview, in both languages with the same placeholders', () => {
    expect([...OVERRIDE_CODES].sort()).toEqual(Object.keys(OVERRIDE_REFUSALS).sort())
    for (const locale of LOCALES) {
      const keys = new Set(flat(CATALOGUE[locale]!['numbering'] as Record<string, unknown>))
      for (const code of OVERRIDE_CODES) expect(keys.has(`override.refusal.${code}`), `${locale} ${code}`).toBe(true)
      for (const held of PREVIEW_HELD) expect(keys.has(`line.held.${held}`), `${locale} ${held}`).toBe(true)
    }
  })
})

describe('the number line and the popup', () => {
  const ready: NumberFieldModel = designScreen.cases.find((item) => item.id === 'line-may-type')!.model
  it('says the next number as not reserved, a new year, a held series, the typed number', () => {
    expect(lineWords(ready)).toEqual({ key: 'line.preview', params: { number: 'PO-2026-00018' } })
    expect(lineWords({ ...ready, typed: { number: 'OA-19-0412', reason: ' Open order ' } })).toEqual({ key: 'line.typed', params: { number: 'OA-19-0412', reason: 'Open order' } })
    expect(lineWords({ ...ready, preview: { state: 'loading' } }).key).toBe('line.loading')
    expect(lineWords({ ...ready, preview: { state: 'failed' } }).key).toBe('line.failed')
    expect(lineWords(designScreen.cases.find((item) => item.id === 'line-new-year')!.model)).toEqual({ key: 'line.newPeriod', params: { number: 'PO-2027-00001', year: '2027' } })
    expect(lineWords(designScreen.cases.find((item) => item.id === 'line-no-series')!.model).key).toBe('line.held.noSeries')
  })

  it('offers the popup only with numbering.override and never for a fiscal kind', () => {
    expect(mayOverride('PURCHASE_ORDER', true)).toBe(true)
    expect(mayOverride('PURCHASE_ORDER', false)).toBe(false)
    for (const kind of ['INVOICE', 'CREDIT_NOTE', 'DEPOSIT_INVOICE', 'DDT'] as const) expect(mayOverride(kind, true), kind).toBe(false)
  })

  it('holds Use with the reason: a number first, written as printed, checked free, then why', () => {
    const draft = emptyDraft('PURCHASE_ORDER')
    expect(overrideHeld(draft)).toBe('override.held.number')
    expect(overrideHeld({ ...draft, number: 'OA 19' })).toBe('override.refusal.shape')
    expect(wellFormed(' OA-19-0412 ')).toBe(true)
    expect(overrideHeld({ ...draft, number: 'OA-19-0412' })).toBe('override.held.checking')
    expect(overrideHeld({ ...draft, number: 'OA-19-0412', check: 'refused', refusal: 'future' })).toBe('override.refusal.future')
    expect(overrideHeld({ ...draft, number: 'OA-19-0412', check: 'failed' })).toBe('override.held.failed')
    expect(overrideHeld({ ...draft, number: 'OA-19-0412', check: 'ok', reason: 'no' })).toBe('override.held.reason')
    expect(overrideHeld({ ...draft, number: 'OA-19-0412', check: 'ok', reason: 'Open order' })).toBeNull()
  })

  it('reads a refused create at body/typedNumber/<code>', () => {
    expect(typedNumberRefusal(new ApiError('conflict', 409, 'conflict', 'taken', null, [{ path: 'body/typedNumber/taken', message: 'x' }]))).toBe('taken')
    expect(typedNumberRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/partyId', message: 'x' }]))).toBeNull()
    expect(typedNumberRefusal(new Error('x'))).toBeNull()
  })
})

const LEFT_KEY = /\b(?:line|override|common)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-014-override draws every case in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      const View = designScreen.view as ComponentType<{ model: unknown }>
      for (const item of designScreen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model })))
        expect(html.length, item.id).toBeGreaterThan(500)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }
})
