import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VARIANCE_CATEGORIES as DOMAIN_CATEGORIES } from '@nexus/factory-domain/costing/variances/split'
import { createApiClient } from '../../../../lib/api/client'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { CLOSE_NS } from '../../../production/work-orders/close/model'
import { getVariances, VARIANCE_CATEGORIES } from './api'
import { designScreen as variancesScreen, VARIANCE_ROWS } from './fixtures'
import { amountTone, totalsOf, varianceUnit, variancesCsv, variancesTouches, type VariancesCsvWords } from './model'

/**
 * B-W2b-GB02 (G053; B-W2b-424's gap 5) — Finance › Costing › Variances by work order (SCR-462-variances) on B-W2b-411's
 * GET /costing/variances: the categories equal factory-domain's, the rules (the amount's tone, a line's unit, the totals
 * per currency and category, the CSV by grain, the live events), the call as the API takes it, and every design case drawn
 * in Italian and English with no key or placeholder left — and no amount without the cost grain.
 */

describe('variances by work order', () => {
  it('VARIANCE_CATEGORIES mirrors factory-domain', () => {
    expect(VARIANCE_CATEGORIES).toEqual(DOMAIN_CATEGORIES)
  })

  it('the amount’s tone, a line’s unit, the totals in the categories’ order', () => {
    expect(VARIANCE_ROWS.map(amountTone)).toEqual(['warning', 'success', 'warning', 'warning'])
    expect(amountTone({})).toBe('neutral')
    expect(VARIANCE_ROWS.map(varianceUnit)).toEqual(['FT2', 'MIN', 'PCS', 'FT2'])
    expect(
      totalsOf([
        { currency: 'EUR', category: 'SCRAP', lines: 1, amount: 3900 },
        { currency: 'EUR', category: 'MATERIAL_PRICE', lines: 2, amount: 1200 },
        { currency: 'CHF', category: 'LABOUR_RATE', lines: 1, amount: -500 },
      ]),
    ).toEqual([
      { currency: 'CHF', amount: -500, lines: 1, categories: [{ category: 'LABOUR_RATE', amount: -500, lines: 1 }] },
      { currency: 'EUR', amount: 5100, lines: 3, categories: [{ category: 'MATERIAL_PRICE', amount: 1200, lines: 2 }, { category: 'SCRAP', amount: 3900, lines: 1 }] },
    ])
    // Without the cost grain the totals carry no amount.
    expect(totalsOf([{ currency: 'EUR', category: 'SCRAP', lines: 1 }])[0]).toMatchObject({ amount: null, lines: 1 })
  })

  it('the CSV: amounts only with the cost grain; the decimal comma in Italian', () => {
    const words: VariancesCsvWords = { header: (column) => column, category: (row) => row.category }
    const it = variancesCsv(VARIANCE_ROWS.slice(0, 1), true, words, 'it')
    expect(it.split('\n')[0]).toBe('workOrder;category;material;closed;standard;actual;unit;standardCost;actualCost;amount;currency')
    expect(it.split('\n')[1]).toBe('WO-2026-0198;MATERIAL_USAGE;DEMO-LTH-01 · Pelle bovina demo;2026-10-27;400,0000;416,0000;FT2;3,900000;3,900000;62,40;EUR')
    const none = variancesCsv(VARIANCE_ROWS.slice(1, 2), false, words, 'en')
    expect(none.split('\n')[0]).toBe('workOrder,category,material,closed,standard,actual,unit')
    expect(none).not.toContain('-15.00')
  })

  it('a close, an undo, a reopen or the switch reads it again', () => {
    expect(variancesTouches({ type: 'work_order_close.changed' })).toBe(true)
    expect(variancesTouches({ type: 'actual_cost_settings.changed' })).toBe(true)
    expect(variancesTouches({ type: 'work_order_cost.posted' })).toBe(false)
  })

  it('reads the period’s lines of the closes that stand', async () => {
    const calls: string[] = []
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: (async (url: string) => {
        calls.push(url)
        return new Response(JSON.stringify({ rows: VARIANCE_ROWS, totals: [], nextCursor: null, waits: null }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
      csrfToken: () => 'csrf',
    })
    const answer = await getVariances(api, { companyId: 'c1', from: '2026-10-01', to: '2026-10-30', cursor: 'k' })
    expect(calls[0]).toBe('http://api.test/costing/variances?from=2026-10-01&to=2026-10-30&live=true&limit=50&companyId=c1&cursor=k')
    expect(answer.rows).toHaveLength(4)
  })
})

const LEFT_KEY = /\b(?:variancesList|variance|category|figure|waits|common|problem)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:costing\.view|costing\.ledger\.manage|money\.cost|workorders\.view)\b/g
const AMOUNT = /€\s?\d|\d\s?€/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key or placeholder left on screen', () => {
  const screen = variancesScreen as unknown as DesignScreen<unknown>
  it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
    for (const item of screen.cases) {
      for (const locale of LOCALES) {
        const html = render(screen, item.model, locale).replace(SAID, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('money only by grain; the totals per currency and category draw on the server', () => {
    const manager = variancesScreen.cases.find((entry) => entry.id === 'manager')!
    for (const locale of LOCALES) expect(render(screen, manager.model, locale).match(AMOUNT)?.[0] ?? null, `manager (${locale})`).toBeNull()
    const full = render(screen, variancesScreen.cases.find((entry) => entry.id === 'finance')!.model, 'en')
    expect(full).toContain('Total +€98.40 (4 lines)')
    expect(full).toContain('Material usage (yield) +€62.40')
    expect(render(screen, variancesScreen.cases.find((entry) => entry.id === 'waits')!.model, 'en')).toContain('Waits for the accountant')
  })

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [CLOSE_NS])[CLOSE_NS]!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const category of VARIANCE_CATEGORIES) has(`category.${category}`)
      for (const column of ['workOrder', 'category', 'material', 'closed', 'standard', 'actual', 'unit', 'standardCost', 'actualCost', 'amount', 'currency']) has(`variancesList.csv.${column}`)
      has('variancesList.total', { amount: '1', count: 2 })
      has('variancesList.count', { count: 2 })
      has('variancesList.export', { count: 2 })
    }
  })
})
