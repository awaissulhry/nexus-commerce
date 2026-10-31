import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WATERFALL_REASONS as DOMAIN_REASONS } from '@nexus/factory-domain/costing/margins/rules'
import { SALES_ORDER_STATUSES as DOMAIN_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { createApiClient } from '../../../lib/api/client'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen as ordersListCases } from '../../sales/orders/list/fixtures'
import { designScreen as orderRecordCases } from '../../sales/orders/record/fixtures'
import { RECORD_TABS as ORDER_TABS } from '../../sales/orders/model'
import { RECORD_TABS as WORK_ORDER_TABS } from '../../production/_shared/model'
import { getMargins, getOrderMargin, SALES_ORDER_STATUSES, WATERFALL_REASONS } from './api'
import { asSeenBy, DETAIL_1043, MARGINS, ROWS } from './demo/fixtures'
import { designScreen as marginsScreen } from './fixtures'
import { addressOf, barsOf, barWidth, bridgeOf, changeTone, marginsCanOf, marginsCsv, marginsHref, marginsQueryOf, pointsBetween, showsMargin, waterfallOf } from './model'

/**
 * Finance › Costing › Margins (SCR-155), the sales order's Margin tab (SCR-039 w2a-margin cases) and the orders list's
 * Margin % column (SCR-038; B-W2a-72 on B-W2a-29's API): the lists equal factory-domain's, the pure rules (who sees what —
 * a margin amount only with the margin AND the cost grain, Owner answer S2 —, the address, the bridge and the waterfall
 * adding up, the bars, the CSV by grain), the calls, the record tabs in the design's order, and every design case drawn
 * in Italian and English with no key or placeholder left on screen — and no cost amount for sales.
 */

describe('the lists mirror factory-domain', () => {
  it('order statuses and the waterfall reasons', () => {
    expect(SALES_ORDER_STATUSES).toEqual(DOMAIN_STATUSES)
    expect(WATERFALL_REASONS).toEqual(DOMAIN_REASONS)
  })
})

describe('who sees what', () => {
  it('the page with costing.view; each figure by its grain; the Margin tab and column need the margin grain', () => {
    expect(marginsCanOf(['costing.view', 'money.price', 'money.margin'])).toEqual({ view: true, price: true, cost: false, margin: true, orders: false, costing: true })
    expect(showsMargin(marginsCanOf(['costing.view', 'money.margin']))).toBe(true)
    expect(showsMargin(marginsCanOf(['costing.view', 'money.cost']))).toBe(false)
    expect(showsMargin(marginsCanOf(['money.margin']))).toBe(false)
  })

  it('sales see margin %, never a cost or a margin amount (the API drops them; the fixtures do as the API)', () => {
    const sales = asSeenBy(DETAIL_1043, marginsCanOf(['costing.view', 'money.price', 'money.margin']))
    expect(sales.estimateMarginPct).toBe('40.1667')
    expect(sales.estimateCost).toBeUndefined()
    expect(sales.estimateMargin).toBeUndefined()
    expect(sales.marginChange).toBeUndefined()
    expect(sales.waterfall).toBeNull()
    expect(bridgeOf(sales, { cost: false, price: true })).toBeNull()
    expect(waterfallOf(sales)).toBeNull()
  })
})

describe('the address', () => {
  it('reads the dates, the customer, the style, the search and the open order; ignores what is not one', () => {
    const party = MARGINS.byCustomer[0]!.party.id
    expect(addressOf(new URLSearchParams(`from=2026-10-01&to=2026-10-31&party=${party}&q=SO&open=${ROWS[0]!.order.id}`))).toEqual({ from: '2026-10-01', to: '2026-10-31', party, style: null, q: 'SO', open: ROWS[0]!.order.id })
    expect(addressOf(new URLSearchParams('from=2026-13-01&party=x&style=y'))).toEqual({ from: null, to: null, party: null, style: null, q: null, open: null })
    expect(marginsHref('/w/DEMO', { ...addressOf(null), from: '2026-10-01', party })).toBe(`/w/DEMO/finance/margins?from=2026-10-01&party=${party}`)
    expect(marginsQueryOf({ ...addressOf(null), q: 'SO' }, 'c1')).toEqual({ companyId: 'c1', partyId: null, styleId: null, from: null, to: null, q: 'SO', cursor: null, limit: 50 })
  })
})

describe('the figures', () => {
  it('from price to margin: price − each cost = the margin now; freight is not recorded and is said so', () => {
    const rows = bridgeOf(DETAIL_1043, { cost: true, price: true })!
    expect(rows.map((row) => row.id)).toEqual(['price', 'MATERIAL', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD', 'freight', 'margin'])
    const costs = rows.filter((row) => row.kind === 'cost').reduce((sum, row) => sum + (row.amount ?? 0), 0)
    expect(rows[0]!.amount! - costs).toBe(rows.at(-1)!.amount)
    expect(rows.find((row) => row.id === 'freight')!.amount).toBeNull()
  })

  it('where the margin went: quoted + each change = now', () => {
    const steps = waterfallOf(DETAIL_1043)!
    expect(steps.map((step) => step.reason)).toEqual(['QUOTED', 'MATERIAL', 'SUBCONTRACT', 'OVERHEAD', 'NOW'])
    expect(steps[0]!.amount + steps.slice(1, -1).reduce((sum, step) => sum + step.amount, 0)).toBe(steps.at(-1)!.amount)
    expect(steps.at(-2)!.to).toBe(DETAIL_1043.estimateMargin)
  })

  it('bars by customer and style, widths to the widest; points and tones', () => {
    const bars = barsOf(MARGINS.byCustomer)
    expect(bars.map((bar) => bar.label)).toEqual(['Moto Demo S.r.l.', 'Pista Demo S.p.A.', 'Club Demo'])
    expect(barWidth('40.0000', bars)).toBe(100)
    expect(barWidth(null, bars)).toBe(0)
    expect(barWidth('-3.0000', bars)).toBe(0)
    expect(pointsBetween('43.0000', '40.1667')).toBe(-2.8)
    expect(changeTone(-34000)).toBe('danger')
    expect(changeTone(0)).toBe('neutral')
  })

  it('the CSV: each grain\'s columns only for its holder', () => {
    const words = { header: (column: string) => column, status: () => 'status', stage: () => 'stage' }
    const finance = marginsCsv(ROWS.slice(2, 3), { price: true, cost: true, margin: true }, words, 'it').split('\n')
    expect(finance[0]).toBe('order;customer;orderDate;status;value;quotedCost;estimateCost;actualCost;quotedMarginPct;estimateMarginPct;actualMarginPct;marginChange;currency;stage')
    expect(finance[1]).toBe('SO-2026-1043;Moto Demo S.r.l.;2026-10-06;status;12000,00;6840,00;7180,00;3950,00;43,0000;40,1667;67,0833;-340,00;EUR;stage')
    const sales = marginsCsv(ROWS.slice(2, 3), { price: true, cost: false, margin: true }, words, 'en').split('\n')
    expect(sales[0]).toBe('order,customer,orderDate,status,value,quotedMarginPct,estimateMarginPct,actualMarginPct,currency,stage')
  })
})

describe('the calls', () => {
  const recording = (answer: unknown) => {
    const calls: string[] = []
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: (async (url: string) => {
        calls.push(url)
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    })
    return { api, calls }
  }

  it('reads the margins with the API\'s own filters, and one order', async () => {
    const list = recording(MARGINS)
    await getMargins(list.api, { companyId: 'c1', from: '2026-10-01', q: 'SO', status: ['CONFIRMED', 'CANCELLED'], limit: 100 })
    expect(list.calls[0]).toBe('http://api.test/costing/margins?companyId=c1&status=CONFIRMED%2CCANCELLED&from=2026-10-01&q=SO&limit=100')
    const one = recording(DETAIL_1043)
    const detail = await getOrderMargin(one.api, DETAIL_1043.order.id)
    expect(one.calls[0]).toBe(`http://api.test/costing/margins/orders/${DETAIL_1043.order.id}`)
    expect(detail.lines).toHaveLength(2)
  })
})

describe('the record tabs in the design\'s order', () => {
  it('the order: … Documents, Margin, Activity; the work order: … Quality, Labour & cost, Activity', () => {
    expect(ORDER_TABS.slice(-3)).toEqual(['documents', 'margin', 'activity'])
    expect(WORK_ORDER_TABS.slice(-3)).toEqual(['quality', 'labour', 'activity'])
  })
})

const LEFT_KEY = /\b(?:noAccess|band|scope|live|tiles|list|bulk|col|row|stage|status|filter|by|detail|held|strip|meter|bridge|part|waterfall|lines|shares|plan|marginTab|problem|csv|keys|common)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:costing\.view|orders\.view|money\.margin|money\.cost)\b/g
/** A cost amount on screen would be a euro figure in a cost column; for sales the only euro figures are the value. */
const EURO = /€\s?\d|\d\s?€/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key or placeholder left on screen', () => {
  it(`SCR-155: ${marginsScreen.cases.length} cases × it, en`, () => {
    const screen = marginsScreen as unknown as DesignScreen<unknown>
    for (const item of screen.cases) {
      for (const locale of LOCALES) {
        const html = render(screen, item.model, locale).replace(SAID, '')
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('SCR-039 Margin tab and SCR-038 Margin % cases draw in both languages', () => {
    for (const [screen, prefix] of [
      [orderRecordCases, 'w2a-margin'],
      [ordersListCases, 'w2a-margin'],
    ] as const) {
      for (const item of (screen as unknown as DesignScreen<unknown>).cases.filter((entry) => entry.id.startsWith(prefix))) {
        for (const locale of LOCALES) {
          const html = render(screen as unknown as DesignScreen<unknown>, item.model, locale).replace(SAID, '')
          expect(html.match(/\b(?:marginTab|strip|waterfall|meter|lines)\.[a-zA-Z.]+/)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    }
  })

  it('sales: the Margin tab shows the margin % and the net (price), never a cost amount or the difference €', () => {
    const screen = orderRecordCases as unknown as DesignScreen<unknown>
    const html = render(screen, screen.cases.find((entry) => entry.id === 'w2a-margin-sales')!.model, 'en')
    const tab = html.slice(html.indexOf('fw-fmg-detail'))
    expect(tab).toContain('40.2 %')
    expect(tab).toContain('€9,600.00')
    for (const cost of ['Cost estimate', 'Cost actual', 'Difference', '€5,744.00', '−€340.00']) expect(tab, cost).not.toContain(cost)
    expect(tab).toContain('needs the margin and the cost grain')
    const finance = render(screen, screen.cases.find((entry) => entry.id === 'w2a-margin')!.model, 'en')
    const full = finance.slice(finance.indexOf('fw-fmg-detail'))
    for (const cost of ['Cost estimate', '€5,744.00', '−€340.00']) expect(full, cost).toContain(cost)
    expect(full).toMatch(EURO)
  })

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['finance-margins'])['finance-margins']!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const status of SALES_ORDER_STATUSES) has(`status.${status}`)
      for (const reason of WATERFALL_REASONS) has(`waterfall.reason.${reason}`)
      for (const part of ['MATERIAL', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD', 'ADJUSTMENT']) has(`part.${part}`)
      for (const plan of ['STANDARD', 'ESTIMATE', 'QUOTED', 'ACTUAL']) has(`plan.${plan}`)
      for (const stage of ['final', 'started', 'notStarted']) has(`stage.${stage}`)
      for (const kind of ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid', 'internal']) has(`problem.${kind}`)
      for (const column of ['order', 'customer', 'orderDate', 'status', 'value', 'quotedCost', 'estimateCost', 'actualCost', 'quotedMarginPct', 'estimateMarginPct', 'actualMarginPct', 'marginChange', 'currency', 'stage']) has(`csv.${column}`)
      has('tiles.unknown', { count: 2 })
      has('by.orders', { count: 1 })
    }
  })
})
