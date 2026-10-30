import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { duplicateBody, duplicateHeld, duplicateOf } from './duplicate/model'
import { designScreen as listScreen } from './list/fixtures'
import { droppedWords, listPriceState, offListPct, termsDraftOf, termsPatch, warningWords } from './model'
import { designScreen as recordScreen, quote } from './record/fixtures'

/**
 * B-W2a-49 on the W1 quote screens (SCR-034, SCR-035): the list price on the lines (SAL-165), payment terms from the
 * library (FIN-075), Duplicate and New quote › Start from a past quote (SAL-155 on B-W2a-30's API). The W1 tests
 * (quotes.vitest.test.ts) stay as they were.
 */

describe('the list price of a colour line', () => {
  it('at, under or over the list; no list price when the customer has none', () => {
    expect(listPriceState({ unitPrice: '450', listUnitPrice: '450' })).toBe('atList')
    expect(listPriceState({ unitPrice: '440', listUnitPrice: '450' })).toBe('below')
    expect(listPriceState({ unitPrice: '460', listUnitPrice: '450' })).toBe('above')
    expect(listPriceState({ unitPrice: '450', listUnitPrice: null })).toBe('noList')
    expect(listPriceState({ listUnitPrice: '450' })).toBe('noList')
    expect(offListPct({ unitPrice: '440', listUnitPrice: '450' })).toBe('-2.2222')
    expect(offListPct({ unitPrice: '450', listUnitPrice: '450' })).toBeNull()
  })
})

describe('payment terms from the library', () => {
  const before = termsDraftOf(quote())
  it('picking library terms sends their id (their printed name follows); none keeps the typed text', () => {
    expect(termsPatch(before, { ...before, paymentTermsId: 't1' })).toEqual({ paymentTermsId: 't1' })
    expect(termsPatch(before, { ...before, paymentTermsId: 't1', paymentTerms: 'typed' })).toEqual({ paymentTermsId: 't1' })
    expect(termsPatch(before, { ...before, paymentTerms: 'Bonifico 30 gg' })).toEqual({ paymentTerms: 'Bonifico 30 gg' })
  })
})

describe('Duplicate', () => {
  const source = { id: 'q1', number: 'Q-1', partyId: 'p1', partyName: 'Demo', revision: 2, versions: [] }
  it('the same customer by default; another one must be picked and active', () => {
    const model = duplicateOf(source)
    expect(duplicateHeld(model, true)).toBeNull()
    expect(duplicateHeld(model, false)).toBe('held.noManage')
    expect(duplicateHeld({ ...model, target: 'other' }, true)).toBe('dup.held.customer')
    const other = { id: 'p2', code: 'P2', legalName: 'Other', tradeName: null, status: 'BLOCKED', country: 'IT', taxMode: null, vatNumber: null, city: null, vies: { state: 'NOT_APPLICABLE' } }
    expect(duplicateHeld({ ...model, target: 'other', party: other }, true)).toBe('dup.held.inactive')
  })
  it('sends only what differs from "the current version for the same customer"', () => {
    const model = duplicateOf(source)
    expect(duplicateBody(model)).toEqual({})
    const other = { id: 'p2', code: 'P2', legalName: 'Other', tradeName: null, status: 'ACTIVE', country: 'IT', taxMode: null, vatNumber: null, city: null, vies: { state: 'NOT_APPLICABLE' } }
    expect(duplicateBody({ ...model, versionId: 'v1', target: 'other', party: other })).toEqual({ versionId: 'v1', partyId: 'p2' })
  })
  it("what the copy left out is said in this screen's words (the API answers English sentences)", () => {
    expect(droppedWords({ seq: 10, size: null, reason: 'Made-to-measure comes later: the unit is not copied.' })).toEqual({ key: 'dup.dropped.mtm', params: { line: 10 } })
    expect(droppedWords({ seq: 20, size: '58', reason: 'Size 58 is no longer offered in this colourway.' })).toEqual({ key: 'dup.dropped.size', params: { line: 20, size: '58' } })
    expect(droppedWords({ seq: 30, size: null, reason: 'None of its sizes is offered any more: the line is not copied.' })).toEqual({ key: 'dup.dropped.noSizes', params: { line: 30 } })
    expect(droppedWords({ seq: 40, size: null, reason: 'Colourway RED is archived.' })).toEqual({ key: 'dup.dropped.other', params: { line: 40 } })
    expect(warningWords('The source was priced without VAT; this customer buys with VAT included: check the prices kept as typed.')).toEqual({ key: 'dup.warning.basis' })
  })
})

const LEFT_KEY = /\b(?:dup|newQuote|lines|price|terms|record|action|held|problem|status|common)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
const render = (view: ComponentType<{ model: unknown }>, model: unknown, locale: (typeof LOCALES)[number]) =>
  renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(view, { model })))

describe('every W2a design case of SCR-034 and SCR-035 draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      const cases = screen.cases.filter((item) => item.label.startsWith('W2a'))
      it(`${screen.screen} in ${locale}: ${cases.length} W2a cases`, () => {
        expect(cases.length).toBeGreaterThan(3)
        for (const item of cases) {
          const html = render(screen.view as ComponentType<{ model: unknown }>, item.model, locale).replace(/https?:\/\/[^"\s<]+/g, '').replace(/[\w.-]+@[\w.-]+\.example\.com/g, '')
          expect(html.length, item.id).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
  it('the Lines tab draws the list price and the distance from it; Price & margin names the list version kept', () => {
    const lines = render(recordScreen.view as ComponentType<{ model: unknown }>, recordScreen.cases.find((item) => item.id === 'list-price')!.model, 'en')
    expect(lines).toContain('List price')
    expect(lines).toContain('off the list')
    expect(lines).toContain('Use list price')
    expect(lines).toContain('List MODA-DEMO · version 1')
    const price = render(recordScreen.view as ComponentType<{ model: unknown }>, recordScreen.cases.find((item) => item.id === 'list-price-tab')!.model, 'it')
    expect(price).toContain('versione 1')
    expect(price).toContain('mancano')
  })
})
