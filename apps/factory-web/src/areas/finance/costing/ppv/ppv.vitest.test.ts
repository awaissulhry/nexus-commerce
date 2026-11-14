import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PPV_AT as DOMAIN_AT } from '@nexus/factory-domain/costing/ppv/rules'
import { createApiClient } from '../../../../lib/api/client'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { CLOSE_NS } from '../../../production/work-orders/close/model'
import { designScreen as closedScreen } from '../closed/fixtures'
import { closedTouches, costStateOf } from '../closed/model'
import { ROWS } from '../demo/fixtures'
import { getPpv, PPV_AT } from './api'
import { designScreen as ppvScreen, PPV_ROWS } from './fixtures'
import { differenceTone, documentRef, ppvCsv, ppvStateOf, ppvTouches, type PpvCsvWords } from './model'

/**
 * B-W2b-424 — Finance › Costing › Purchase price variance (SCR-462) and the Status with the close (SCR-463) on B-W2b-407's
 * and B-W2b-411's API: the list equals factory-domain's, the rules (the difference's tone, a row's state, the document it
 * opens, the CSV by grain, the live events), the call as the API takes it, the Status (open · final · closed), and every
 * design case drawn in Italian and English with no key or placeholder left — and no amount without the cost grain.
 */

describe('purchase price variance', () => {
  it('PPV_AT mirrors factory-domain', () => {
    expect(PPV_AT).toEqual(DOMAIN_AT)
  })

  it('the difference’s tone, a row’s state, the document it opens', () => {
    expect(differenceTone(PPV_ROWS[0]!)).toBe('warning')
    expect(differenceTone(PPV_ROWS[1]!)).toBe('success')
    expect(differenceTone({})).toBe('neutral')
    expect(ppvStateOf(PPV_ROWS[0]!)).toBe('standing')
    expect(ppvStateOf(PPV_ROWS[3]!)).toBe('reversal')
    expect(ppvStateOf(PPV_ROWS[4]!)).toBe('reversed')
    expect(documentRef(PPV_ROWS[0]!)).toEqual({ type: 'SupplierInvoice', id: PPV_ROWS[0]!.source.documentId, label: 'FA-DEMO-0041' })
    expect(documentRef({ source: { ...PPV_ROWS[0]!.source, at: 'RECEIPT' } }).type).toBe('GoodsReceipt')
    expect(ppvTouches({ type: 'purchase_price_variance.posted' })).toBe(true)
    expect(ppvTouches({ type: 'actual_cost_settings.changed' })).toBe(true)
    expect(ppvTouches({ type: 'work_order_cost.posted' })).toBe(false)
  })

  it('the CSV: amounts only with the cost grain; the decimal comma in Italian', () => {
    const words: PpvCsvWords = { header: (column) => column, at: (row) => row.source.at, state: (row) => ppvStateOf(row) }
    const it = ppvCsv(PPV_ROWS.slice(0, 1), true, words, 'it')
    expect(it.split('\n')[0]).toBe('material;supplier;document;at;day;quantity;unit;standard;paid;difference;currency;state')
    expect(it.split('\n')[1]).toBe('DEMO-LTH-01 · Pelle bovina demo;Conceria Esempio S.r.l.;FA-DEMO-0041 / 1;INVOICE;2026-10-27;600,0000;FT2;3,900000;4,000000;60,00;EUR;standing')
    const none = ppvCsv(PPV_ROWS.slice(0, 1), false, words, 'en')
    expect(none.split('\n')[0]).toBe('material,supplier,document,at,day,quantity,unit,state')
    expect(none).not.toContain('60.00')
  })

  it('reads the period of the company', async () => {
    const calls: string[] = []
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: (async (url: string) => {
        calls.push(url)
        return new Response(JSON.stringify({ rows: PPV_ROWS, nextCursor: null, totals: [], waits: null }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
      csrfToken: () => 'csrf',
    })
    const answer = await getPpv(api, { companyId: 'c1', from: '2026-10-01', to: '2026-10-30', cursor: 'k' })
    expect(calls[0]).toBe('http://api.test/costing/ppv?from=2026-10-01&to=2026-10-30&limit=50&companyId=c1&cursor=k')
    expect(answer.rows).toHaveLength(5)
  })
})

describe('the Status with the close', () => {
  it('open, final (completed), closed; a close or a status change reads the list again', () => {
    expect(costStateOf(ROWS[0]!)).toBe('open')
    expect(costStateOf(ROWS[2]!)).toBe('final')
    expect(costStateOf({ ...ROWS[2]!, workOrder: { ...ROWS[2]!.workOrder, status: 'CLOSED' } })).toBe('closed')
    expect(closedTouches({ type: 'work_order_close.changed' })).toBe(true)
    expect(closedTouches({ type: 'workorder.status_changed' })).toBe(true)
    expect(closedTouches({ type: 'work_order_cost.posted' })).toBe(false)
  })
})

const LEFT_KEY = /\b(?:ppv|costState|waits|common|problem|state|list|rows|col|tiles|ledger|standards|method|band|scope|live)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:costing\.view|costing\.ledger\.manage|money\.cost|workorders\.view)\b/g
const AMOUNT = /€\s?\d|\d\s?€/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key or placeholder left on screen', () => {
  for (const screen of [ppvScreen, closedScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('money only by grain: no unit cost or difference for the production manager or sales', () => {
    for (const id of ['manager', 'sales']) {
      const item = ppvScreen.cases.find((entry) => entry.id === id)!
      for (const locale of LOCALES) expect(render(ppvScreen as unknown as DesignScreen<unknown>, item.model, locale).match(AMOUNT)?.[0] ?? null, `${id} (${locale})`).toBeNull()
    }
    const full = render(ppvScreen as unknown as DesignScreen<unknown>, ppvScreen.cases.find((entry) => entry.id === 'finance')!.model, 'en')
    // The grid's cells draw in the browser; the section's total draws on the server.
    expect(full).toContain('Total +€44.00 (5 lines)')
  })

  it('the closed Status reads Closed; the waits banner says so', () => {
    expect(render(closedScreen as unknown as DesignScreen<unknown>, closedScreen.cases[0]!.model, 'en')).toContain('Closed')
    expect(render(ppvScreen as unknown as DesignScreen<unknown>, ppvScreen.cases.find((entry) => entry.id === 'waits')!.model, 'en')).toContain('Waits for the accountant')
  })

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [CLOSE_NS])[CLOSE_NS]!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const at of PPV_AT) has(`ppv.at.${at}`)
      for (const state of ['standing', 'reversal', 'reversed']) has(`ppv.state.${state}`, { day: '1' })
      for (const column of ['material', 'supplier', 'document', 'at', 'day', 'quantity', 'unit', 'standard', 'paid', 'difference', 'currency', 'state']) has(`ppv.csv.${column}`)
      has('costState.closed')
    }
  })
})
