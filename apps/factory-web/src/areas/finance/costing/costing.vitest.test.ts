import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { COST_ENTRY_KINDS as DOMAIN_KINDS, COSTING_METHODS as DOMAIN_METHODS } from '@nexus/factory-domain/costing/ledger/entries'
import { DOCUMENT_TYPES as DOMAIN_DOCUMENTS, ENTRY_EVENTS as DOMAIN_EVENTS, WAITING_CODES as DOMAIN_WAITING } from '@nexus/factory-domain/costing/ledger/contracts'
import { BRIDGE_REASONS as DOMAIN_REASONS, COST_PARTS as DOMAIN_PARTS } from '@nexus/factory-domain/costing/ledger/variance'
import { STANDARD_COST_SOURCES as DOMAIN_SOURCES, STANDARD_COST_STATUSES as DOMAIN_STATUSES } from '@nexus/factory-domain/costing/standards/rules'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES } from '../../../lib/records/record-links'
import { OFFICE_NAV, OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { designScreen as labourCases } from '../../production/work-orders/record/fixtures'
import { BRIDGE_REASONS, COST_ENTRY_KINDS, COST_PARTS, COSTING_METHODS, DOCUMENT_TYPES, ENTRY_EVENTS, getLedger, getStandards, getWorkOrderCost, getWorkOrderCosts, reverseEntry, STANDARD_COST_SOURCES, STANDARD_COST_STATUSES, WAITING_CODES } from './api'
import { DETAIL_221, LEDGER, ROWS, STANDARDS, TILES, withoutCost } from './demo/fixtures'
import { designScreen as costingScreen } from './fixtures'
import {
  addressOf,
  bridgeSteps,
  closedIn,
  costingCanOf,
  costingHref,
  liveTouches,
  methodPhrase,
  movesHref,
  pctText,
  periodOf,
  printHref,
  readProblem,
  reasonHeld,
  recentMonths,
  reverseHeld,
  rowsQuery,
  signedMoney,
  varianceTone,
  workOrdersCsv,
} from './model'
import { designScreen as printScreen } from './print/fixtures'
import { CostBridge, CostLabour, CostMaterials, CostSummary } from './view/CostParts'

/**
 * Finance › Costing › Standard vs actual (SCR-154, SCR-154-print) and the work order's Labour & cost tab (SCR-070 w2a-
 * labour cases; B-W2a-72 on B-W2a-21's API): the lists equal factory-domain's, the pure rules (who sees what, the
 * address and period, the method never picked, the bridge adding up, why a reversal is held, the CSV by grain), the calls
 * as the API takes them, the navigation rows, and every design case drawn in Italian and English with no message key or
 * placeholder left on screen — and no amount for a person without the cost grain.
 */

describe('the lists mirror factory-domain', () => {
  it('kinds, events, methods, waiting codes, documents, bridge reasons, parts, standards', () => {
    expect(COST_ENTRY_KINDS).toEqual(DOMAIN_KINDS)
    expect(COSTING_METHODS).toEqual(DOMAIN_METHODS)
    expect(ENTRY_EVENTS).toEqual(DOMAIN_EVENTS)
    expect(WAITING_CODES).toEqual(DOMAIN_WAITING)
    expect(DOCUMENT_TYPES).toEqual(DOMAIN_DOCUMENTS)
    expect(BRIDGE_REASONS).toEqual(DOMAIN_REASONS)
    expect(COST_PARTS).toEqual(DOMAIN_PARTS)
    expect(STANDARD_COST_STATUSES).toEqual(DOMAIN_STATUSES)
    expect(STANDARD_COST_SOURCES).toEqual(DOMAIN_SOURCES)
  })
})

describe('who sees what', () => {
  it('the page with costing.view, amounts with the cost grain, a reversal with costing.ledger.manage', () => {
    expect(costingCanOf(['costing.view'])).toEqual({ view: true, cost: false, reverse: false, workOrders: false, styles: false, moves: false, sites: false })
    expect(costingCanOf(['costing.view', 'money.cost', 'costing.ledger.manage', 'workorders.view', 'product.styles.view', 'inventory.stock.view', 'inventory.locations.view'])).toEqual({ view: true, cost: true, reverse: true, workOrders: true, styles: true, moves: true, sites: true })
    expect(costingCanOf(['money.cost']).view).toBe(false)
  })

  it('a reversal is held without the permission, on a reversal, on an entry reversed already; the reason needs 3 characters', () => {
    const can = { reverse: true }
    expect(reverseHeld(LEDGER[0]!, can)).toBeNull()
    expect(reverseHeld(LEDGER[0]!, { reverse: false })).toEqual({ key: 'held.noReverse', params: { permission: 'costing.ledger.manage' } })
    expect(reverseHeld(LEDGER[1]!, can)?.key).toBe('held.isReversal')
    expect(reverseHeld(LEDGER[2]!, can)?.key).toBe('held.reversed')
    expect(reasonHeld('ok')?.key).toBe('reverse.reasonShort')
    expect(reasonHeld('Counted twice')).toBeNull()
    expect(reasonHeld('x'.repeat(501))?.key).toBe('reverse.reasonLong')
  })
})

describe('the address and the period', () => {
  it('reads site, rows, search, month and the open work order; ignores what is not one', () => {
    const site = '0190f0e2-2222-7000-8000-000000000001'
    expect(addressOf(new URLSearchParams(`site=${site}&rows=over&q=WO-22&month=2026-09&open=${ROWS[0]!.workOrder.id}`))).toEqual({ site, rows: 'over', q: 'WO-22', month: '2026-09', open: ROWS[0]!.workOrder.id })
    expect(addressOf(new URLSearchParams('site=nope&rows=gold&month=2026-13&open=x'))).toEqual({ site: null, rows: 'all', q: null, month: null, open: null })
    const address = addressOf(new URLSearchParams('rows=closed&month=2026-09'))
    expect(costingHref('/w/DEMO', address)).toBe('/w/DEMO/finance/costing?rows=closed&month=2026-09')
    expect(printHref('/w/DEMO', { ...address, open: ROWS[0]!.workOrder.id })).toBe('/w/DEMO/finance/costing/print?rows=closed&month=2026-09')
  })

  it('a month ends on its last day, this month today; the choice is the twelve months to this one', () => {
    expect(periodOf('2026-02', '2026-10-30')).toEqual({ month: '2026-02', from: '2026-02-01', to: '2026-02-28' })
    expect(periodOf(null, '2026-10-30')).toEqual({ month: '2026-10', from: '2026-10-01', to: '2026-10-30' })
    expect(recentMonths('2026-10-30')).toHaveLength(12)
    expect(recentMonths('2026-10-30').slice(0, 3)).toEqual(['2026-10', '2026-09', '2026-08'])
    expect(recentMonths('2026-01-15')[1]).toBe('2025-12')
  })

  it('rows views are the API\'s own filters; "closed this month" is the period\'s completions', () => {
    expect(rowsQuery(addressOf(new URLSearchParams('rows=over&q=22')), 'c1')).toEqual({ companyId: 'c1', siteId: null, status: null, over: true, q: '22', cursor: null, limit: 50 })
    expect(rowsQuery(addressOf(new URLSearchParams('rows=closed')), null, 'cur').status).toEqual(['COMPLETED', 'CLOSED'])
    const period = periodOf(null, '2026-10-30')
    expect(ROWS.filter((row) => closedIn(row, period)).map((row) => row.workOrder.number)).toEqual(['WO-2026-0198'])
  })

  it('a material line opens its issues and returns at the site', () => {
    expect(movesHref('/w/DEMO', 's1', 'i1')).toBe('/w/DEMO/warehouse/moves?site=s1&item=i1&reasons=ISSUE%2CRETURN')
  })
})

describe('the figures', () => {
  it('the method is named in words and never picked: not decided yet while UNDECIDED', () => {
    expect(methodPhrase({ method: 'UNDECIDED', locked: false })).toEqual({ key: 'method.undecided' })
    expect(methodPhrase({ method: 'STANDARD', locked: true })).toEqual({ key: 'method.locked', params: { method: 'STANDARD' } })
    expect(methodPhrase(null)).toEqual({ key: 'method.unknown' })
  })

  it('the bridge runs from the basis through each reason to the actual, and adds up to the variance', () => {
    const steps = bridgeSteps(DETAIL_221)!
    expect(steps.map((step) => step.reason)).toEqual(['BASIS', 'MATERIAL_PRICE', 'MATERIAL_USAGE', 'LABOUR', 'ACTUAL'])
    const between = steps.slice(1, -1).reduce((sum, step) => sum + (step.amount ?? 0), 0)
    expect(steps[0]!.amount! + between).toBe(steps.at(-1)!.amount)
    expect(between).toBe(DETAIL_221.variance)
    expect(bridgeSteps({ ...DETAIL_221, bridge: null })).toBeNull()
  })

  it('tones, signs and percents', () => {
    expect(varianceTone(ROWS[0]!)).toBe('danger')
    expect(varianceTone(ROWS[2]!)).toBe('success')
    expect(signedMoney(42800, 'EUR', 'en')).toBe('+€428.00')
    expect(signedMoney(-4800, 'EUR', 'en')).toBe('−€48.00')
    expect(pctText('9.3043', 'it', true)).toBe('+9,3 %')
    expect(pctText(null, 'en')).toBe('—')
  })

  it('the CSV has the amount columns only with the cost grain', () => {
    const words = { header: (column: string) => column, basis: () => 'basis', reason: (reason: string | null) => reason ?? '', state: () => 'state' }
    const full = workOrdersCsv(ROWS.slice(0, 1), { cost: true }, words, 'it')
    expect(full.split('\n')[0]).toBe('workOrder;style;pieces;basis;standard;estimate;actual;variance;variancePct;currency;reason;state')
    expect(full.split('\n')[1]).toBe('WO-2026-0221;DEMO-JKT-01 · Giacca pelle demo;40;basis;4600,00;4550,00;5028,00;428,00;9,3043;EUR;MATERIAL_USAGE;state')
    const none = workOrdersCsv(ROWS.slice(0, 1).map((row) => withoutCost(row)), { cost: false }, words, 'en')
    expect(none.split('\n')[0]).toBe('workOrder,style,pieces,basis,reason,state')
  })

  it('a person without the cost grain gets minutes and quantities, never an amount', () => {
    const seen = withoutCost(DETAIL_221)
    expect(seen.actualTotal).toBeUndefined()
    expect(seen.labour[0]!.earnedMinutes).toBe('800.0000')
    expect(seen.labour[0]!.amount).toBeUndefined()
    expect(seen.materials[0]!.issuedQuantity).toBe('980.0000')
  })

  it('the API in words; cost events, standards, the method, stock and scans move the page', () => {
    expect(readProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toBe('problem.conflict')
    expect(readProblem(new Error('x'))).toBe('problem.internal')
    expect(liveTouches({ type: 'work_order_cost.posted' })).toBe(true)
    expect(liveTouches({ type: 'standard_cost.changed' })).toBe(true)
    expect(liveTouches({ type: 'production.scan_recorded' })).toBe(true)
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

  it('reads the work orders, one work order, the ledger and the standards with the API\'s own filters', async () => {
    const list = recording({ rows: ROWS, nextCursor: null, tiles: TILES })
    await getWorkOrderCosts(list.api, { companyId: 'c1', status: ['COMPLETED', 'CLOSED'], over: true, q: 'WO' })
    expect(list.calls[0]!.url).toBe('http://api.test/costing/work-orders?companyId=c1&status=COMPLETED%2CCLOSED&over=true&q=WO&limit=50')
    const one = recording({ detail: DETAIL_221 })
    const detail = await getWorkOrderCost(one.api, DETAIL_221.workOrder.id)
    expect(one.calls[0]!.url).toBe(`http://api.test/costing/work-orders/${DETAIL_221.workOrder.id}`)
    expect(detail.bridge).toHaveLength(7)
    const ledger = recording({ entries: LEDGER, nextCursor: null })
    await getLedger(ledger.api, { companyId: 'c1', kinds: ['LABOUR'], from: '2026-10-01', to: '2026-10-30' })
    expect(ledger.calls[0]!.url).toBe('http://api.test/costing/ledger?companyId=c1&kind=LABOUR&from=2026-10-01&to=2026-10-30&limit=50')
    const standards = recording({ standards: STANDARDS, nextCursor: null })
    await getStandards(standards.api, { companyId: 'c1', on: '2026-10-30' })
    expect(standards.calls[0]!.url).toBe('http://api.test/costing/standards?companyId=c1&on=2026-10-30&limit=50')
  })

  it('reverses an entry with its reason and one Idempotency-Key', async () => {
    const write = recording({ entry: LEDGER[2]!, reversals: [LEDGER[1]!] })
    await reverseEntry(write.api, LEDGER[2]!.id, 'Issued to the wrong work order', 'key-1')
    const call = write.calls[0]!
    expect(call.url).toBe(`http://api.test/costing/entries/${LEDGER[2]!.id}/reverse`)
    expect(call.init.method).toBe('POST')
    expect(JSON.parse(String(call.init.body))).toEqual({ reason: 'Issued to the wrong work order' })
    expect(new Headers(call.init.headers).get('idempotency-key')).toBe('key-1')
  })
})

describe('navigation', () => {
  it('Finance › Costing › Standard vs actual and Margins with costing.view; the pages are built; the list addresses map', () => {
    const finance = OFFICE_NAV.areas.find((area) => area.id === 'finance')!
    const costing = (finance.sections ?? []).find((section) => section.id === 'finance-costing')!
    expect(costing.items.map((item) => [item.href, item.permission])).toEqual([
      ['/finance/costing', 'costing.view'],
      ['/finance/margins', 'costing.view'],
    ])
    for (const page of ['/finance/costing', '/finance/costing/print', '/finance/margins']) expect(OFFICE_PAGES.has(page), page).toBe(true)
    expect(LIST_PAGES['/costing/work-orders']).toBe('/finance/costing')
    expect(LIST_PAGES['/costing/margins']).toBe('/finance/margins')
  })
})

const LEFT_KEY = /\b(?:noAccess|band|scope|live|method|tiles|noCost|list|rows|bulk|col|row|basis|state|reason|part|centre|kind|event|detail|bridge|parts|materials|labour|scrap|waiting|standards|itemKind|source|ledger|held|reverse|notice|problem|csv|keys|print|labourTab|common)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission and grain names are said on purpose ("needs costing.view", "the cost grain (money.cost)"). */
const SAID = /\b(?:costing\.view|costing\.ledger\.manage|money\.cost|workorders\.view)\b/g
/** An amount on screen: a figure with the euro sign (the made-up data is in EUR). */
const AMOUNT = /€\s?\d|\d\s?€/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key or placeholder left on screen', () => {
  for (const screen of [costingScreen, printScreen] as unknown as DesignScreen<unknown>[]) {
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

  it('SCR-070 Labour & cost cases draw in both languages', () => {
    const screen = labourCases as unknown as DesignScreen<unknown>
    for (const item of screen.cases.filter((entry) => entry.id.startsWith('w2a-labour'))) {
      for (const locale of LOCALES) {
        const html = render(screen, item.model, locale).replace(SAID, '')
        expect(html.match(/\blabourTab\.[a-zA-Z.]+/)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('money only by grain: no amount for the production manager or sales; the Labour & cost tab without the grain shows none', () => {
    for (const id of ['manager', 'sales', 'detail-manager']) {
      const item = costingScreen.cases.find((entry) => entry.id === id)!
      for (const locale of LOCALES) expect(render(costingScreen as unknown as DesignScreen<unknown>, item.model, locale).match(AMOUNT)?.[0] ?? null, `${id} (${locale})`).toBeNull()
    }
    const noCost = labourCases.cases.find((entry) => entry.id === 'w2a-labour-no-cost')!
    expect(render(labourCases as unknown as DesignScreen<unknown>, noCost.model, 'en').match(AMOUNT)?.[0] ?? null).toBeNull()
    const full = costingScreen.cases.find((entry) => entry.id === 'detail')!
    expect(render(costingScreen as unknown as DesignScreen<unknown>, full.model, 'en')).toMatch(AMOUNT)
  })

  it('never a person: labour per operation, said so; no worker name in the Labour & cost tab', () => {
    const item = labourCases.cases.find((entry) => entry.id === 'w2a-labour')!
    const html = render(labourCases as unknown as DesignScreen<unknown>, item.model, 'en')
    expect(html).toContain('never per person')
    expect(html).toContain('Labour per operation')
    expect(html).not.toMatch(/\b(?:operator|worker)\s*:/i)
  })

  it('the cost parts without the cost grain: minutes and quantities, no amount', () => {
    const parts = (can: { cost: boolean; moves: boolean }, detail: typeof DETAIL_221) =>
      renderToString(
        createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['finance-costing']) }, createElement('div', null, createElement(CostMaterials, { detail, can, prefix: '/w/DEMO' }), createElement(CostLabour, { detail, can }), createElement(CostSummary, { detail, can }), createElement(CostBridge, { detail, can }))),
      )
    const none = parts({ cost: false, moves: true }, withoutCost(DETAIL_221))
    expect(none).toContain('2,280 min')
    expect(none).toContain('980 ft²')
    expect(none.match(AMOUNT)?.[0] ?? null).toBeNull()
    const full = parts({ cost: true, moves: true }, DETAIL_221)
    expect(full).toContain('+€312.00')
    expect(full).toContain('€4,018.00')
  })

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['finance-costing'])['finance-costing']!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const kind of COST_ENTRY_KINDS) has(`kind.${kind}`)
      for (const event of ENTRY_EVENTS) has(`event.${event}`)
      for (const reason of BRIDGE_REASONS) has(`reason.${reason}`)
      for (const part of COST_PARTS) has(`part.${part}`)
      for (const centre of WORK_CENTRE_KINDS) has(`centre.${centre}`)
      for (const source of STANDARD_COST_SOURCES) has(`source.${source}`)
      for (const code of WAITING_CODES) has(`waiting.${code}`, { count: 2 })
      for (const method of COSTING_METHODS.filter((entry) => entry !== 'UNDECIDED')) has(`method.name.${method}`)
      for (const view of ['all', 'over', 'closed']) has(`rows.${view}`, { month: 'October' })
      for (const kind of ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid', 'conflict', 'step_up', 'internal']) has(`problem.${kind}`)
      for (const column of ['workOrder', 'style', 'pieces', 'basis', 'standard', 'estimate', 'actual', 'variance', 'variancePct', 'currency', 'reason', 'state']) has(`csv.${column}`)
      for (const state of ['connecting', 'live', 'offline']) has(`live.${state}`)
      has('tiles.unvalued', { count: 1 })
    }
  })
})
