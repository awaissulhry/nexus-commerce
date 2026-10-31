import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { OFFICE_NAV, officeNavFor } from '../../../shell/nav/office-nav'
import type { PolicyAnswer, SalesSettings } from './api'
import { designScreen } from './fixtures'
import { policyBody, policyDraftOf, policyProblems, quoteBody, quoteDraftOf, quoteProblems, refusalOf, ruleSentence, salesSeries, settingsCan, sourceWords } from './model'

const SETTINGS: SalesSettings = {
  tenant: { id: 't', companyId: null, marginFloorPct: '20', discountLimitPct: '15', defaultValidityDays: 30, defaultDepositPct: '30', version: 4, updatedAt: '2026-10-31T09:00:00.000Z' },
  company: null,
  inForce: { marginFloorPct: '20', discountLimitPct: '15', defaultValidityDays: 30, defaultDepositPct: '30', source: 'TENANT' },
  defaults: { marginFloorPct: '20', discountLimitPct: '15', defaultValidityDays: 30, defaultDepositPct: '30', source: 'DEFAULT' },
}
const POLICY: PolicyAnswer = {
  tenant: { id: 't', companyId: null, windowDays: 30, goodsDueDays: 15, freightPaidBy: 'BY_CAUSE', restockingFeePct: '10', conditions: null, version: 4, updatedAt: '2026-10-31T09:00:00.000Z' },
  company: null,
  inForce: { windowDays: 30, goodsDueDays: 15, freightPaidBy: 'BY_CAUSE', restockingFeePct: '10', conditions: null },
  followsTenant: true,
  canManage: true,
}

describe('the quote rules and defaults: one row, both cards in one save', () => {
  it('a company without its own row starts from the rules in force and saves without a version (its first row)', () => {
    const draft = quoteDraftOf(SETTINGS, 'company')
    expect(draft).toEqual({ marginFloorPct: '20', discountLimitPct: '15', validityDays: '30', depositPct: '30' })
    expect(quoteBody({ ...draft, depositPct: '' }, SETTINGS, 'company', 'c1')).toEqual({ companyId: 'c1', marginFloorPct: '20', discountLimitPct: '15', defaultValidityDays: 30, defaultDepositPct: null })
    expect(quoteBody(draft, SETTINGS, 'group', 'c1')).toMatchObject({ version: 4 })
    expect(quoteBody(draft, SETTINGS, 'group', 'c1')).not.toHaveProperty('companyId')
  })

  it('says what is wrong by field; the margin floor only with the margin grain', () => {
    expect(quoteProblems({ marginFloorPct: '120', discountLimitPct: '15,5', validityDays: '0', depositPct: '0' }, true).map((entry) => entry.field)).toEqual(['marginFloorPct', 'validityDays', 'depositPct'])
    expect(quoteProblems({ marginFloorPct: '', discountLimitPct: '15', validityDays: '30', depositPct: '' }, false)).toEqual([])
  })

  it('reads the rule as a sentence; without the margin grain no margin number', () => {
    expect(ruleSentence({ marginFloorPct: '20', discountLimitPct: '15' }, true)).toEqual({ key: 'rule.sentence', params: { margin: '20', discount: '15' } })
    expect(ruleSentence({ marginFloorPct: '', discountLimitPct: '15' }, false)).toEqual({ key: 'rule.sentenceNoMargin', params: { discount: '15' } })
    expect(sourceWords(SETTINGS, 'company')).toEqual({ key: 'source.companyFollows' })
    expect(sourceWords(SETTINGS, 'group')).toEqual({ key: 'source.groupOwn' })
  })
})

describe('the return policy', () => {
  it('days are whole and optional, the fee a percent; the body sends nulls for empty fields at the row’s version', () => {
    const draft = policyDraftOf(POLICY, 'group')
    expect(draft).toEqual({ windowDays: '30', goodsDueDays: '15', freightPaidBy: 'BY_CAUSE', restockingFeePct: '10', conditions: '' })
    expect(policyProblems({ ...draft, windowDays: '0', restockingFeePct: 'x' }).map((entry) => entry.field)).toEqual(['windowDays', 'restockingFeePct'])
    expect(policyBody({ ...draft, goodsDueDays: '', freightPaidBy: '' }, POLICY, 'group', 'c1')).toEqual({ windowDays: 30, goodsDueDays: null, freightPaidBy: null, restockingFeePct: '10', conditions: null, version: 4 })
  })

  it('a refusal for a company that follows the group says so; a stale version reads again', () => {
    expect(refusalOf(new ApiError('invalid', 400, 'invalid', 'x', 'r', [{ path: 'body/companyId', message: 'No sales settings of its own.' }]))).toEqual({ key: 'refusal.followsGroup' })
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'x', 'r', []))).toEqual({ key: 'refusal.stale' })
  })
})

describe('numbering and the navigation', () => {
  it('the newest active series of each sales document; a missing one says so', () => {
    const rows = salesSeries([
      { id: 'a', companyId: 'c', kind: 'QUOTE', code: 'QT-2025', year: 2025, nextNumber: 'QT-2025-9', status: 'ACTIVE' },
      { id: 'b', companyId: 'c', kind: 'QUOTE', code: 'QT-2026', year: 2026, nextNumber: 'QT-2026-1', status: 'ACTIVE' },
      { id: 'c', companyId: 'c', kind: 'RETURN', code: 'RMA', year: null, nextNumber: 'RMA-1', status: 'CLOSED' },
    ])
    expect(rows.map((row) => [row.kind, row.series?.code ?? null])).toEqual([
      ['QUOTE', 'QT-2026'],
      ['SALES_ORDER', null],
      ['RETURN', null],
      ['REPAIR', null],
    ])
  })

  it('Sales sections: Main, After-sales, Pricing, Settings; the settings row needs the quotes right', () => {
    const sales = OFFICE_NAV.areas.find((area) => area.id === 'sales')!
    expect(sales.sections!.map((section) => section.id)).toEqual(['sales-main', 'sales-aftersales', 'sales-pricing', 'sales-settings'])
    const warehouse = officeNavFor((permission) => ['sales.returns.view', 'home.view'].includes(permission)).areas.find((area) => area.id === 'sales')
    expect(warehouse?.sections?.map((section) => section.id)).toEqual(['sales-aftersales'])
    expect(settingsCan(['quotes.view']).quotesView).toBe(true)
  })
})

const en = CATALOGUE.en['sales-settings'] ?? {}
const PREFIXES = [...new Set(Object.keys(en).map((key) => key.split('.')[0]!))].filter((prefix) => prefix.length > 2)
const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z0-9_]+)*`)

describe('every design case draws in both languages with no key left on screen', () => {
  const render = (model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = (designScreen as DesignScreen<unknown>).view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  for (const locale of LOCALES) {
    it(`SCR-235 in ${locale}: ${designScreen.cases.length} cases`, () => {
      for (const item of designScreen.cases) {
        const html = render(item.model, locale).replace(/(?:href|src|id|class|aria-[a-z]+|data-[a-z-]+|name|for|value|placeholder|title)="[^"]*"/g, '')
        expect(html.length, item.id).toBeGreaterThan(300)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-235/${item.id} (${locale})`).toBeNull()
        expect(html, `SCR-235/${item.id} (${locale})`).not.toMatch(/\{[a-z]+\}/i)
      }
    })
  }

  it('the margin grain: a read-only person sees no margin floor number', () => {
    const readOnly = designScreen.cases.find((item) => item.id === 'read-only')!
    const html = render(readOnly.model, 'en')
    expect(html).toContain('Shown only with the margin right')
    expect(html).not.toContain('22 %')
  })
})
