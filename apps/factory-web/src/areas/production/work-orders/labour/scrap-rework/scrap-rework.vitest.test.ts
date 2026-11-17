import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../../../../lib/api/client'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { getScrapRework } from './api'
import { designScreen as scrapScreen } from './fixtures'
import { costUnknown, scrapValueOf } from './model'

/**
 * B-W2b-GB02 (G053; B-W2b-424's gap 5) — the scrap and rework cost on the work order's Labour & cost tab (SCR-461-scrap) on
 * B-W2b-411's GET /costing/work-orders/:id/scrap-rework. F-PR-06: ONE scrap value line (Quality is the scrap home): what the
 * line says (reading, failed, nothing, not known, the amount), an unknown rework cost, the call, and every design case drawn in
 * Italian and English with no key or placeholder left; the line's door to Quality; a closed work order's facts say Closed.
 */

const RECORD = { workOrder: { id: 'w1', number: 'WO-1', status: 'IN_PROGRESS' }, currency: 'EUR', totals: { scrappedGarments: 0, scrapValue: 0, stockScrapValue: 0, reworkGarments: 0, reworkMinutes: '0', reworkCost: 0, total: 0 } }

describe('the scrap and rework cost', () => {
  it('the one scrap value line: reading, failed, nothing, not known (never 0), the amount', () => {
    const row = { reasonCode: 'X', scrappedGarments: 1, reworkGarments: 0, reworkMinutes: '0' }
    expect(scrapValueOf({ part: null })).toEqual({ state: 'loading' })
    expect(scrapValueOf({ part: { value: null, problem: null } })).toEqual({ state: 'loading' })
    expect(scrapValueOf({ part: { value: null, problem: 'problem.unavailable' } })).toEqual({ state: 'failed' })
    expect(scrapValueOf({ part: { value: { ...RECORD, rows: [] }, problem: null } })).toEqual({ state: 'none' })
    expect(scrapValueOf({ part: { value: { ...RECORD, rows: [row], totals: { ...RECORD.totals, total: 15390 } }, problem: null } })).toEqual({ state: 'amount', amount: 15390, currency: 'EUR' })
    expect(scrapValueOf({ part: { value: { ...RECORD, rows: [row], totals: { ...RECORD.totals, reworkCost: null, total: null } }, problem: null } })).toEqual({ state: 'unknown' })
    // Without the cost grain the API sends no amount: never drawn as 0.
    expect(scrapValueOf({ part: { value: { ...RECORD, rows: [row], totals: { scrappedGarments: 1, reworkGarments: 0, reworkMinutes: '0' } }, problem: null } })).toEqual({ state: 'unknown' })
    expect(costUnknown({ reworkCost: null })).toBe(true)
    expect(costUnknown({ reworkCost: 0 })).toBe(false)
    expect(costUnknown({})).toBe(false)
  })

  it('reads the work order’s scrap and rework', async () => {
    const calls: string[] = []
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: (async (url: string) => {
        calls.push(url)
        return new Response(JSON.stringify({ ...RECORD, rows: [], words: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
      csrfToken: () => 'csrf',
    })
    expect((await getScrapRework(api, 'w 1')).rows).toEqual([])
    expect(calls[0]).toBe('http://api.test/costing/work-orders/w%201/scrap-rework')
  })
})

const LEFT_KEY = /\b(?:scrapValue|scrapRework|figure|common|problem|state|labourTab)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:costing\.view|costing\.ledger\.manage|money\.cost|workorders\.view|production\.[a-z.]+)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key or placeholder left on screen', () => {
  const screen = scrapScreen as unknown as DesignScreen<unknown>
  it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
    for (const item of screen.cases) {
      for (const locale of LOCALES) {
        const html = render(screen, item.model, locale).replace(SAID, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('one line: the total, its door to Quality, an unknown value; no reason listed here; a closed work order’s facts say Closed', () => {
    const rows = render(screen, scrapScreen.cases.find((entry) => entry.id === 'rows')!.model, 'en')
    expect(rows).toContain('Scrap value')
    expect(rows).toContain('€153.90')
    expect(rows).toContain('?tab=quality')
    // The reasons live on Quality (the one scrap home), not here.
    expect(rows).not.toContain('Stitching fault')
    expect(rows).not.toContain('Scrap and rework cost')
    expect(render(screen, scrapScreen.cases.find((entry) => entry.id === 'rows')!.model, 'it')).toContain('Valore degli scarti')
    expect(render(screen, scrapScreen.cases.find((entry) => entry.id === 'no-rate')!.model, 'en')).toContain('no cost per minute in force')
    expect(render(screen, scrapScreen.cases.find((entry) => entry.id === 'closed')!.model, 'en')).toContain('>Closed<')
    expect(render(screen, scrapScreen.cases.find((entry) => entry.id === 'no-cost')!.model, 'en')).not.toContain('Scrap value')
  })

  it('the line’s words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['production']).production!)
      for (const key of ['title', 'loading', 'failed', 'none', 'unknown', 'toQuality']) expect(t(`scrapValue.${key}`), `${locale}: scrapValue.${key}`).not.toBe(`scrapValue.${key}`)
    }
  })
})
