import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NO_REASON as DOMAIN_NO_REASON } from '@nexus/factory-domain/costing/variances/scrap-rework'
import { createApiClient } from '../../../../../lib/api/client'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { CLOSE_NS } from '../../close/model'
import { getScrapRework } from './api'
import { designScreen as scrapScreen } from './fixtures'
import { costUnknown, NO_REASON, reasonWords, scrapReworkState } from './model'

/**
 * B-W2b-GB02 (G053; B-W2b-424's gap 5) — the scrap and rework cost on the work order's Labour & cost tab (SCR-461-scrap) on
 * B-W2b-411's GET /costing/work-orders/:id/scrap-rework: the reason without a code equals factory-domain's, what the card
 * shows, a reason in words (never its code while a list knows it), an unknown rework cost, the call, and every design case
 * drawn in Italian and English with no key or placeholder left; a closed work order's cost facts say Closed.
 */

const RECORD = { workOrder: { id: 'w1', number: 'WO-1', status: 'IN_PROGRESS' }, currency: 'EUR', totals: { scrappedGarments: 0, scrapValue: 0, stockScrapValue: 0, reworkGarments: 0, reworkMinutes: '0', reworkCost: 0, total: 0 } }

describe('the scrap and rework cost', () => {
  it('NO_REASON mirrors factory-domain; the card’s state; a reason in words', () => {
    expect(NO_REASON).toBe(DOMAIN_NO_REASON)
    const reasons = new Map([['STITCH_FAULT', { it: 'Difetto di cucitura', en: 'Stitching fault' }]])
    expect(scrapReworkState({ part: null, reasons })).toBe('loading')
    expect(scrapReworkState({ part: { value: null, problem: 'problem.unavailable' }, reasons })).toBe('failed')
    expect(scrapReworkState({ part: { value: { ...RECORD, rows: [] }, problem: null }, reasons })).toBe('none')
    expect(scrapReworkState({ part: { value: { ...RECORD, rows: [{ reasonCode: 'X', scrappedGarments: 1, reworkGarments: 0, reworkMinutes: '0' }] }, problem: null }, reasons })).toBe('rows')
    expect(reasonWords('STITCH_FAULT', reasons, 'it', 'none')).toBe('Difetto di cucitura')
    expect(reasonWords('STITCH_FAULT', reasons, 'en', 'none')).toBe('Stitching fault')
    expect(reasonWords(NO_REASON, reasons, 'en', 'No reason given')).toBe('No reason given')
    // A code no list keeps any more: the code itself (the only words there are).
    expect(reasonWords('OLD_CODE', reasons, 'en', 'none')).toBe('OLD_CODE')
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

const LEFT_KEY = /\b(?:scrapRework|figure|common|problem|state|labourTab)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
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

  it('the reasons in words, the totals, an unknown rework cost; a closed work order’s facts say Closed', () => {
    const rows = render(screen, scrapScreen.cases.find((entry) => entry.id === 'rows')!.model, 'en')
    expect(rows).toContain('Scrap and rework cost')
    expect(rows).toContain('Stitching fault')
    expect(rows).toContain('No reason given')
    expect(rows).not.toContain('STITCH_FAULT')
    expect(rows).toContain('€153.90')
    expect(render(screen, scrapScreen.cases.find((entry) => entry.id === 'rows')!.model, 'it')).toContain('Difetto di cucitura')
    expect(render(screen, scrapScreen.cases.find((entry) => entry.id === 'no-rate')!.model, 'en')).toContain('No cost per minute in force')
    expect(render(screen, scrapScreen.cases.find((entry) => entry.id === 'closed')!.model, 'en')).toContain('>Closed<')
    expect(render(screen, scrapScreen.cases.find((entry) => entry.id === 'no-cost')!.model, 'en')).not.toContain('Scrap and rework cost')
  })

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [CLOSE_NS])[CLOSE_NS]!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const key of ['title', 'hint', 'loading', 'failed', 'none', 'noReason', 'noRate', 'totalUnknown', 'total', 'never']) has(`scrapRework.${key}`)
      for (const column of ['reason', 'scrapped', 'stock', 'rework', 'total']) has(`scrapRework.col.${column}`)
      has('scrapRework.reworked', { count: 2, minutes: '24' })
    }
  })
})
