import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { approveReduction, askReplacement, getScrap, refuseReduction } from './api'
import { canAs, ME, REDUCTIONS, ROWS, TODAY_START } from './demo/fixtures'
import { designScreen } from './fixtures'
import {
  addressOf,
  addressText,
  approvable,
  csvOf,
  decideHeld,
  filterRows,
  leftToReplace,
  materialsText,
  moneyText,
  pareto,
  periodFrom,
  reductionOf,
  replaceBody,
  replaceHeld,
  SCRAP_VIEWS,
  TILES,
  tileValue,
  writeProblem,
} from './model'

/**
 * Production › Scrap & rework (SCR-140; B-W2a-60): the pure rules (the address, the saved views over the rows read, the
 * pareto with its cumulative share, what Approve N reaches and why a decision is held — never one's own request —, what
 * is left to replace and why Replace is held, the request it sends, refusals in our words, money only with the cost
 * grain), the calls as the API of B-W2a-13 takes them, the page in the map, and every design case drawn in Italian and
 * English with no message key or placeholder left on screen.
 */

const address = (query = '') => addressOf(new URLSearchParams(query))

describe('scrap & rework: address and saved views', () => {
  it('reads and writes its address', () => {
    expect(address('view=approve&period=7&kind=SCRAP&by=style&group=STAIN&q=wo&open=rework:0190f0e2-2727-7000-8000-000000000001')).toEqual({
      view: 'approve',
      period: '7',
      kind: 'SCRAP',
      by: 'style',
      group: 'STAIN',
      q: 'wo',
      open: 'rework:0190f0e2-2727-7000-8000-000000000001',
      replace: null,
    })
    expect(address('view=x&period=1&kind=y&by=z&open=nonsense')).toMatchObject({ view: 'all', period: '30', kind: null, by: 'reason', open: null })
    expect(addressText(address())).toBe('')
    expect(addressText({ ...address(), view: 'today', group: 'STAIN' })).toBe('?view=today&group=STAIN')
    expect(periodFrom('all', 0)).toBeNull()
    expect(periodFrom('7', Date.parse('2026-10-30T00:00:00Z'))).toBe('2026-10-23T00:00:00.000Z')
    expect(SCRAP_VIEWS).toEqual(['all', 'today', 'rework', 'approve', 'recuts'])
  })

  it('the saved views pick their rows: today’s scrap, open rework, waiting approval, recuts to cut', () => {
    const ids = (query: string) => filterRows(ROWS, address(query), TODAY_START, 'en').map((row) => ROWS.indexOf(row))
    expect(ids('')).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(ids('view=today')).toEqual([0, 1])
    expect(ids('view=rework')).toEqual([5])
    expect(ids('view=approve')).toEqual([1, 2])
    expect(ids('view=recuts')).toEqual([0])
    expect(ids('kind=REWORK')).toEqual([5])
    expect(ids('group=STAIN')).toEqual([0, 2, 4])
    expect(ids('by=operation&group=CQ')).toEqual([3, 6])
    expect(ids('q=hole')).toEqual([3])
    expect(ids('q=DEMO-HD-0001')).toEqual([0, 1, 2, 3, 6])
  })

  it('the tiles in figures; second quality is W2b (—)', () => {
    expect(TILES.map((tile) => tileValue(tile.id, { scrapToday: 3, reworkOpen: 1, recutsToCut: 1, reductionsToApprove: 2 }))).toEqual(['3', '1', '2', '1', '—'])
    expect(tileValue('scrapToday', null)).toBe('—')
  })
})

describe('the pareto', () => {
  it('sums pieces per reason, largest first, with the cumulative share', () => {
    const bars = pareto(ROWS, 'reason', 'en')
    // Stain 2 + 1 + 1 = 4, Open seam 3 + 1 = 4, Wrong cut 1, Hole 1 → 10 pieces.
    expect(bars.map((bar) => [bar.label, bar.pieces, bar.cumulative])).toEqual([
      ['Open seam', 4, 40],
      ['Stain', 4, 80],
      ['Hole in the leather', 1, 90],
      ['Wrong cut', 1, 100],
    ])
    expect(pareto(ROWS, 'reason', 'it')[1]!.label).toBe('Macchia')
    expect(pareto(ROWS, 'style', 'en').map((bar) => bar.label)).toEqual(['DEMO-JKT-01', 'DEMO-PNT-02'])
    // More groups than the top: the rest together.
    expect(pareto(ROWS, 'reason', 'en', 2).map((bar) => [bar.key, bar.pieces])).toEqual([
      ['SEAM_OPEN', 4],
      ['STAIN', 4],
      ['', 2],
    ])
  })
})

describe('approve and replace', () => {
  it('Approve reaches only open lower quantities someone else asked; my own is held with why', () => {
    const planner = canAs('planner')
    expect(reductionOf(ROWS[1]!, REDUCTIONS)?.id).toBe(REDUCTIONS[0]!.id)
    expect(decideHeld(REDUCTIONS[0]!, planner, ME, false)).toEqual({ key: 'held.ownAsk' })
    expect(decideHeld(REDUCTIONS[1]!, planner, ME, false)).toBeNull()
    expect(decideHeld(REDUCTIONS[1]!, canAs('inspector'), ME, false)).toEqual({ key: 'held.permission', params: { permission: 'production.scrap.approve' } })
    expect(decideHeld(null, planner, ME, false)).toEqual({ key: 'held.noReduction' })
    expect(approvable(ROWS, REDUCTIONS, planner, ME).map((row) => row.id)).toEqual([REDUCTIONS[1]!.id])
  })

  it('what is left to replace, why Replace is held, and the request it sends', () => {
    const manager = canAs('manager')
    expect(leftToReplace(ROWS[0]!)).toBe(1)
    expect(leftToReplace(ROWS[3]!)).toBe(0)
    const draft = { kind: 'RECUT' as const, quantity: '1', reason: 'Stained beyond cleaning' }
    expect(replaceHeld(ROWS[0]!, draft, manager, false)).toBeNull()
    expect(replaceHeld(ROWS[0]!, { ...draft, quantity: '2' }, manager, false)).toEqual({ key: 'replace.held.quantity', params: { max: 1 } })
    expect(replaceHeld(ROWS[0]!, { ...draft, reason: 'x' }, manager, false)).toEqual({ key: 'held.reason' })
    expect(replaceHeld(ROWS[3]!, draft, manager, false)).toEqual({ key: 'replace.held.covered' })
    expect(replaceHeld(ROWS[4]!, draft, manager, false)).toEqual({ key: 'replace.held.notOpen', params: { number: 'WO-26-0036', status: 'COMPLETED' } })
    expect(replaceHeld(ROWS[5]!, draft, manager, false)).toEqual({ key: 'replace.held.rework' })
    expect(replaceHeld(ROWS[0]!, draft, canAs('inspector'), false)).toEqual({ key: 'held.permission', params: { permission: 'production.scrap' } })
    expect(replaceBody(ROWS[0]!, draft)).toEqual({ kind: 'RECUT', quantity: 1, reason: 'Stained beyond cleaning', part: null, sourceScanId: ROWS[0]!.source.id })
    expect(replaceBody(ROWS[1]!, draft)).toMatchObject({ part: 'sleeve' })
    expect(replaceBody(ROWS[6]!, { ...draft, kind: 'REDUCE' })).toEqual({ kind: 'REDUCE', quantity: 1, reason: 'Stained beyond cleaning', part: null, reworkOrderId: ROWS[6]!.source.id })
  })

  it('refusals in our words', () => {
    const refused = (path: string) => new ApiError('conflict', 409, 'refused', 'English', null, [{ path, message: 'English' }])
    expect(writeProblem(refused('refusal/MORE_THAN_SCRAPPED'))).toEqual({ key: 'problem.moreThanScrapped' })
    expect(writeProblem(refused('refusal/SELF_DECISION'))).toEqual({ key: 'problem.selfDecision' })
    expect(writeProblem(refused('refusal/WORK_ORDER_NOT_OPEN'))).toEqual({ key: 'problem.notOpen' })
    expect(writeProblem(refused('version'))).toEqual({ key: 'problem.changed' })
  })

  it('money only by the cost grain; leather per lot and hide; the CSV names no person', () => {
    expect(moneyText(18060, 'EUR', 'it')).toMatch(/180,60/)
    expect(moneyText(undefined, 'EUR', 'it')).toBe('—')
    expect(materialsText(ROWS[0]!, 'en')).toBe('DEMO-LOT-0101 / DEMO-HD-0001 86 ft²')
    const without = csvOf(ROWS, ['h'], 'en', false)
    expect(without).not.toMatch(/361\.20|EUR/)
    expect(csvOf(ROWS, ['h'], 'en', true)).toMatch(/361\.20,EUR/)
    expect(without).not.toMatch(/Esempio|Prova/)
  })
})

describe('the calls', () => {
  function recorder(answers: Record<string, unknown>) {
    const calls: Array<{ method: string; url: string; body: unknown; key: string | null }> = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: headers.get('idempotency-key') })
      const path = new URL(url, 'http://x').pathname
      const answer = Object.entries(answers).find(([prefix]) => path.endsWith(prefix))?.[1] ?? {}
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetchFn, csrfToken: () => 'csrf' })
    return { api, calls }
  }

  it('reads the period, asks a recut, approves and refuses with their keys', async () => {
    const reduction = REDUCTIONS[1]!
    const { api, calls } = recorder({
      '/production/scrap': { rows: ROWS, tiles: { scrapToday: 3, reworkOpen: 1, recutsToCut: 1, reductionsToApprove: 2 } },
      '/production/replacements': { replacement: { ...reduction, kind: 'RECUT' } },
      '/approve': { replacement: { ...reduction, status: 'APPROVED' } },
      '/refuse': { replacement: { ...reduction, status: 'REFUSED' } },
    })
    expect((await getScrap(api, { from: '2026-10-01T00:00:00.000Z' })).rows).toHaveLength(7)
    expect(calls[0]!.url).toContain('limit=500')
    expect(calls[0]!.url).toContain('from=2026-10-01')
    await askReplacement(api, replaceBody(ROWS[1]!, { kind: 'RECUT', quantity: '1', reason: 'Wrong cut' }), 'key-1')
    expect(calls[1]).toMatchObject({ method: 'POST', key: 'key-1', body: { kind: 'RECUT', quantity: 1, reason: 'Wrong cut', part: 'sleeve', sourceScanId: ROWS[1]!.source.id } })
    await askReplacement(api, replaceBody(ROWS[1]!, { kind: 'REDUCE', quantity: '1', reason: 'Accepted short' }), 'key-2')
    expect(calls[2]!.body).toEqual({ kind: 'REDUCE', quantity: 1, reason: 'Accepted short', sourceScanId: ROWS[1]!.source.id })
    await approveReduction(api, reduction.id, { version: 1 }, 'key-3')
    expect(calls[3]).toMatchObject({ method: 'POST', key: 'key-3', body: { version: 1 } })
    await refuseReduction(api, reduction.id, { version: 1, note: 'The customer wants all of them' }, 'key-4')
    expect(calls[4]).toMatchObject({ body: { version: 1, note: 'The customer wants all of them' } })
  })
})

describe('the page in the map', () => {
  it('is built; a rework order opens in its row', () => {
    expect(OFFICE_PAGES.has('/production/scrap')).toBe(true)
    expect(LIST_PAGES['/production/scrap']).toBe('/production/scrap')
    expect(recordAddress({ type: 'ReworkOrder', id: 'r1' }, OFFICE_PAGES)).toBe('/production/scrap?open=rework:r1')
  })
})

const LEFT_KEY = /\b(?:kind|view|tile|tiles|col|list|page|common|live|held|notice|problem|item|replace|replacement|approval|pareto|period|rework|bulk|csv)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:production\.[a-z.]+|workorders\.[a-z.]+|money\.cost)\b/g

function render(model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = designScreen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'scrap']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  it(`${designScreen.screen}: ${designScreen.cases.length} cases × it, en`, () => {
    for (const item of designScreen.cases as unknown as DesignScreen<unknown>['cases']) {
      for (const locale of LOCALES) {
        const html = render(item.model, locale).replace(SAID, '')
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('has words for every view, period, tile, kind, rework and replacement state in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['scrap']).scrap ?? {})
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const view of SCRAP_VIEWS) has(`view.${view}`)
      for (const period of ['7', '30', '90', 'all']) has(`period.${period}`)
      for (const tile of TILES) has(`tile.${tile.id}`)
      for (const kind of ['SCRAP', 'REWORK']) {
        has(`kind.${kind}`)
        has(`item.title.${kind}`, 2)
      }
      for (const status of ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']) has(`rework.${status}`)
      for (const status of ['OPEN', 'APPROVED', 'REFUSED', 'DONE', 'CANCELLED']) {
        has(`replacement.status.${status}`)
        has(`approval.${status}`)
      }
      for (const kind of ['RECUT', 'REDUCE']) {
        has(`replacement.kind.${kind}`)
        has(`replace.go.${kind}`)
        has(`notice.asked.${kind}`, 1)
      }
      for (const dimension of ['reason', 'operation', 'style']) has(`pareto.by.${dimension}`)
    }
  })
})
