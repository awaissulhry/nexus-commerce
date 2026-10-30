import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { COSTING_METHODS as DOMAIN_COSTING_METHODS } from '@nexus/factory-domain/costing/ledger/entries'
import { VALUATION_CATEGORIES as DOMAIN_CATEGORIES, VALUED_STATES as DOMAIN_VALUED } from '@nexus/factory-domain/costing/valuation/rules'
import { STOCK_MOVE_REASONS } from '@nexus/factory-domain/inventory/ledger/moves'
import { VALUATION_METHODS as DOMAIN_METHODS } from '@nexus/factory-domain/inventory/ledger/valuation'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES } from '../../../lib/records/record-links'
import { OFFICE_NAV, OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { COSTING_METHODS, getLayers, getValuation, MOVE_REASONS, VALUATION_CATEGORIES, VALUATION_METHODS, VALUED_STATES } from './api'
import { LAYERS_101, ROWS, VALUATION, VALUATION_SEPTEMBER, withoutCost } from './demo/fixtures'
import { designScreen as reportsScreen } from './fixtures'
import { addressOf, basisPhrase, layerKeyOf, liveTouches, methodPhrase, orderedRows, printHref, readProblem, reportNotes, reportsCanOf, reportsHref, rowId, valuationCsv } from './model'
import { designScreen as printScreen } from './print/fixtures'

/**
 * Finance › Reports › Stock valuation (SCR-239, SCR-239-print; B-W2a-51 on B-W2a-29's API): the lists equal
 * factory-domain's, the pure rules (who sees values, the address, the order, the key "How this lot is valued" reads, the
 * method and basis in words, the notes, the CSV by grain), the calls as the API takes them, the navigation row, and every
 * design case drawn in Italian and English with no message key or placeholder left on screen.
 */

describe('the lists mirror factory-domain', () => {
  it('categories, valued states, the ledger\'s methods, the costing methods, the move reasons', () => {
    expect(VALUATION_CATEGORIES).toEqual(DOMAIN_CATEGORIES)
    expect(VALUED_STATES).toEqual(DOMAIN_VALUED)
    expect(VALUATION_METHODS).toEqual(DOMAIN_METHODS)
    expect(COSTING_METHODS).toEqual(DOMAIN_COSTING_METHODS)
    expect(MOVE_REASONS).toEqual(STOCK_MOVE_REASONS)
  })
})

describe('who sees what', () => {
  it('the stock with inventory.stock.view, its values only with the cost grain', () => {
    expect(reportsCanOf(['inventory.stock.view'])).toEqual({ view: true, cost: false, lots: true, workOrders: false })
    expect(reportsCanOf(['inventory.stock.view', 'money.cost', 'workorders.view'])).toEqual({ view: true, cost: true, lots: true, workOrders: true })
    expect(reportsCanOf(['money.cost']).view).toBe(false)
  })

  it('"How this lot is valued" reads a stock key with the cost grain; never for WIP or without the grain', () => {
    const lot = ROWS[0]!
    expect(layerKeyOf(lot, '2026-09-30', { cost: true })).toEqual({ siteId: lot.site.id, itemId: lot.item!.id, itemColourId: lot.colour!.id, lotId: lot.lot!.id, asOf: '2026-09-30' })
    expect(layerKeyOf(lot, null, { cost: false })).toBeNull()
    expect(layerKeyOf(ROWS.find((row) => row.workOrder)!, null, { cost: true })).toBeNull()
  })
})

describe('the address', () => {
  it('reads the day, the site, the category, the search and the grouping; ignores what is not one', () => {
    const site = ROWS[0]!.site.id
    expect(addressOf(new URLSearchParams(`asOf=2026-09-30&site=${site}&category=LEATHER&q=LTH&group=0`))).toEqual({ asOf: '2026-09-30', site, category: 'LEATHER', q: 'LTH', group: false })
    expect(addressOf(new URLSearchParams('asOf=2026-13-01&site=nope&category=GOLD'))).toEqual({ asOf: null, site: null, category: null, q: null, group: true })
  })

  it('writes the same address back, and the print tab has it too', () => {
    const address = addressOf(new URLSearchParams('asOf=2026-09-30&category=TRIMS&group=0'))
    expect(reportsHref('/w/DEMO', address)).toBe('/w/DEMO/finance/reports?asOf=2026-09-30&category=TRIMS&group=0')
    expect(printHref('/w/DEMO', address)).toBe('/w/DEMO/finance/reports/print?asOf=2026-09-30&category=TRIMS&group=0')
    expect(reportsHref('/w/DEMO', addressOf(null))).toBe('/w/DEMO/finance/reports')
  })
})

describe('the rows and their words', () => {
  it('grouped: by category in the design\'s order, then by item; not grouped: by item', () => {
    expect(orderedRows(ROWS, true).map((row) => row.category)).toEqual(['LEATHER', 'LEATHER', 'MATERIALS', 'MATERIALS', 'TRIMS', 'PACKAGING', 'FINISHED_GOODS', 'WIP', 'WIP'])
    expect(orderedRows(ROWS, false)[0]!.item?.code).toBe('DEMO-BOX-05')
    expect(new Set(ROWS.map(rowId)).size).toBe(ROWS.length)
  })

  it('the method is the company\'s (UNDECIDED: to confirm with the accountant); a value says what it rests on', () => {
    expect(methodPhrase(VALUATION.methods)).toEqual({ key: 'method.company.UNDECIDED' })
    expect(methodPhrase([])).toEqual({ key: 'method.none' })
    expect(methodPhrase([...VALUATION.methods, { companyId: 'c2', method: 'FIFO', provisional: false }])).toEqual({ key: 'method.several' })
    expect(basisPhrase(ROWS[3]!)).toEqual({ key: 'basis.none', params: { count: 1 } })
    expect(basisPhrase(ROWS.find((row) => row.workOrder?.done)!)).toEqual({ key: 'basis.wipDone' })
    expect(basisPhrase(ROWS[0]!)).toEqual({ key: 'basis.full' })
  })

  it('notes under the totals: moves without a value, rounding left (cost grain), several currencies', () => {
    expect(reportNotes(VALUATION, { cost: true }).map((note) => note.key)).toEqual(['note.unvalued'])
    expect(reportNotes(VALUATION_SEPTEMBER, { cost: true }).map((note) => note.key)).toEqual(['note.residue'])
    expect(reportNotes(withoutCost(VALUATION_SEPTEMBER), { cost: false })).toEqual([])
    expect(reportNotes({ ...VALUATION, value: null, unvaluedMoves: 0, truncated: true }, { cost: true }).map((note) => note.key)).toEqual(['note.truncated', 'note.currencies'])
  })

  it('the totals add up to the rows (worked out by hand: 3,536.74)', () => {
    expect(ROWS.reduce((sum, row) => sum + (row.value ?? 0), 0)).toBe(VALUATION.value)
    expect(VALUATION.categories.reduce((sum, entry) => sum + (entry.value ?? 0), 0)).toBe(353674)
  })

  it('the CSV: ; and the decimal comma in Italian, the value columns only with the cost grain', () => {
    const words = { header: (column: string) => column, category: (category: string) => category, basis: () => 'basis' }
    const italian = valuationCsv([ROWS[0]!], { cost: true }, words, 'it').split('\n')
    expect(italian[0]).toBe('category;item;colour;lot;workOrder;site;quantity;uom;areaM2;hides;value;unitCost;currency;basis')
    expect(italian[1]).toBe('LEATHER;DEMO-LTH-01 · Pelle bovina demo;NERO;LOT-2026-0101;;STAB-N;186,5000;FT2;17,3264;4;783,30;4,200000;EUR;basis')
    const english = valuationCsv(withoutCost({ ...VALUATION, rows: [ROWS[0]!] }).rows, { cost: false }, words, 'en').split('\n')
    expect(english[0]).toBe('category,item,colour,lot,workOrder,site,quantity,uom,areaM2,hides,basis')
    expect(english[1]).toBe('LEATHER,DEMO-LTH-01 · Pelle bovina demo,NERO,LOT-2026-0101,,STAB-N,186.5000,FT2,17.3264,4,basis')
  })

  it('without the cost grain the answer holds no value at all (absent, never zero)', () => {
    const answer = withoutCost(VALUATION)
    expect(answer.rows.every((row) => !('value' in row) && !('unitCost' in row))).toBe(true)
    expect('value' in answer).toBe(false)
  })
})

describe('the API in this page\'s words; live', () => {
  it('reads refusals as keys', () => {
    expect(readProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('problem.forbidden')
    expect(readProblem(new Error('x'))).toBe('problem.internal')
  })

  it('stock moves, a work order\'s cost and a standard cost move the report', () => {
    expect(liveTouches({ type: 'inventory.moved' })).toBe(true)
    expect(liveTouches({ type: 'work_order_cost.posted' })).toBe(true)
    expect(liveTouches({ type: 'standard_cost.changed' })).toBe(true)
    expect(liveTouches({ type: 'invoice.issued' })).toBe(false)
  })
})

describe('the calls', () => {
  const recording = (answer: unknown) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
      csrfToken: () => 'csrf',
    })
    return { api, calls }
  }

  it('reads the valuation with the API\'s own filters, and how a lot is valued', async () => {
    const read = recording(VALUATION)
    await getValuation(read.api, { asOf: '2026-09-30', companyId: 'c1', siteId: null, category: 'LEATHER', q: 'LTH' })
    expect(read.calls[0]!.url).toBe('http://api.test/costing/valuation?asOf=2026-09-30&companyId=c1&category=LEATHER&q=LTH')
    const layers = recording(LAYERS_101)
    const key = layerKeyOf(ROWS[0]!, null, { cost: true })!
    const answer = await getLayers(layers.api, key)
    expect(layers.calls[0]!.url).toBe(`http://api.test/costing/valuation/layers?siteId=${key.siteId}&itemId=${key.itemId}&itemColourId=${key.itemColourId}&lotId=${key.lotId}&limit=50`)
    expect(answer.layers.map((layer) => layer.balanceValue)).toEqual([100800, 78330])
  })
})

describe('navigation', () => {
  it('Finance › Reports › Finance reports with inventory.stock.view; the print page is built; the list address maps', () => {
    const finance = OFFICE_NAV.areas.find((area) => area.id === 'finance')!
    const reports = (finance.sections ?? []).find((section) => section.id === 'finance-reports')!
    expect(reports.items.map((item) => [item.href, item.permission])).toEqual([['/finance/reports', 'inventory.stock.view']])
    expect(OFFICE_PAGES.has('/finance/reports')).toBe(true)
    expect(OFFICE_PAGES.has('/finance/reports/print')).toBe(true)
    expect(LIST_PAGES['/costing/valuation']).toBe('/finance/reports')
  })
})

const LEFT_KEY = /\b(?:noAccess|band|live|scope|category|method|totals|note|list|col|row|valued|basis|bulk|keys|csv|how|reason|print|common|problem)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission and grain names are said on purpose ("needs inventory.stock.view", "the cost grain (money.cost)"). */
const SAID = /\b(?:inventory\.stock\.view|money\.cost)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key or placeholder left on screen', () => {
  for (const screen of [reportsScreen, printScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['finance-reports'])['finance-reports']!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const category of VALUATION_CATEGORIES) has(`category.${category}`)
      for (const state of VALUED_STATES) has(`valued.${state}`)
      for (const method of VALUATION_METHODS) has(`basis.method.${method}`)
      for (const method of COSTING_METHODS) {
        has(`method.company.${method}`)
        has(`how.companyMethod.${method}`)
      }
      for (const reason of MOVE_REASONS) has(`reason.${reason}`)
      for (const kind of ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid', 'internal']) has(`problem.${kind}`)
      for (const column of ['category', 'item', 'colour', 'lot', 'workOrder', 'site', 'quantity', 'uom', 'areaM2', 'hides', 'value', 'unitCost', 'currency', 'basis']) has(`csv.${column}`)
      for (const state of ['connecting', 'live', 'offline']) has(`live.${state}`)
      has('basis.part', { count: 2 })
      has('basis.none', { count: 1 })
      has('note.unvalued', { count: 3 })
    }
  })
})
