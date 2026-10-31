import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { getCapacity, getCellOrders } from './api'
import { CAPACITY, designScreen } from './fixtures'
import { boardHref, bucketLabel, calendarHref, cellAt, cellKeyOf, cellOrder, controlsOf, csvOfLanes, howWords, laneEnd, laneNotes, lanesOf, NAMESPACE, parseCellKey, periodProblem, queryOf, withFrom, type Words } from './model'

/**
 * Planning › Capacity & load (SCR-123; B-W2a-70 on the capacity API of B-W2a-16): the address, the tiles and the lanes
 * each one filters to, how a capacity is made said from its numbers, the cell order J / K walk, the links, the CSV, the
 * calls as the API takes them, and every design case drawn in Italian and English with no key or placeholder on screen.
 */

const words = (locale: 'it' | 'en' = 'en'): Words => ({ t: createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!), locale })
const [L1, L2, CUT, SEW] = CAPACITY.lanes

describe('capacity: the address and the period', () => {
  it('keeps site, period, bucket, tile and cell in the address (WEEK by default)', () => {
    const controls = controlsOf(new URLSearchParams('site=s1&from=2026-11-16&to=2026-12-20&bucket=DAY&tile=over&cell=LINE:a:2026-11-16'))
    expect(controls).toEqual({ site: 's1', from: '2026-11-16', to: '2026-12-20', bucket: 'DAY', tile: 'over', cell: 'LINE:a:2026-11-16' })
    expect(queryOf(controls)).toBe('site=s1&from=2026-11-16&to=2026-12-20&bucket=DAY&tile=over&cell=LINE%3Aa%3A2026-11-16')
    expect(controlsOf(new URLSearchParams('from=16/11&bucket=YEAR&tile=x'))).toMatchObject({ from: null, bucket: 'WEEK', tile: null })
  })

  it('refuses a period that ends before it starts or is longer than two years; a new start keeps the length', () => {
    expect(periodProblem({ from: '2026-12-01', to: '2026-11-20' })).toBe('period.backwards')
    expect(periodProblem({ from: '2026-01-01', to: '2028-01-10' })).toBe('period.tooLong')
    expect(periodProblem({ from: null, to: null })).toBeNull()
    expect(withFrom(controlsOf(null), '2026-12-07', { from: '2026-11-16', to: '2026-12-20' })).toEqual({ from: '2026-12-07', to: '2027-01-10' })
  })
})

describe('capacity: tiles, cells and words', () => {
  it('each tile filters the lanes behind its number', () => {
    expect(lanesOf(CAPACITY, null)).toHaveLength(4)
    expect(lanesOf(CAPACITY, 'over').map((lane) => lane.code)).toEqual(['L2'])
    expect(lanesOf(CAPACITY, 'most').map((lane) => lane.code)).toEqual(['L2'])
    expect(lanesOf(CAPACITY, 'free').map((lane) => lane.code)).toEqual(['L1', 'L2', 'CUT', 'SEW'])
  })

  it('a cell key names a lane and a bucket; J / K walk lane by lane, bucket by bucket', () => {
    const key = cellKeyOf(L2!, '2026-W48')
    expect(parseCellKey(key)).toEqual({ kind: 'LINE', laneId: L2!.id, bucketKey: '2026-W48' })
    expect(parseCellKey('NOPE:x:y')).toBeNull()
    expect(cellAt(CAPACITY, key)?.cell.from).toBe('2026-11-23')
    const order = cellOrder(CAPACITY.lanes)
    expect(order).toHaveLength(20)
    expect(order.indexOf(key)).toBe(6)
  })

  it('says how a capacity is made from its numbers, the closed days and what is booked', () => {
    const en = words('en')
    const w47 = L1!.cells[0]!
    expect(howWords(L1!, w47, en)[0]).toBe('8 people × 450 min × 85% efficiency × 5 days = 15,300 min')
    const w50 = L1!.cells[3]!
    expect(howWords(L1!, w50, en)).toContain('Closed: 8 Dec (Immacolata Concezione).')
    expect(howWords(CUT!, CUT!.cells[0]!, en)[0]).toBe('3 stations × 450 min × 100% efficiency × 5 days = 6,750 min')
    expect(howWords(L1!, w47, en).at(-1)).toBe('Booked: 11,200 min — 8,960 min placed on the board, 2,240 min at their due date.')
    expect(howWords(L1!, w47, words('it'))[0]).toBe('8 persone × 450 min × efficienza 85% × 5 giorni = 15.300 min')
    expect(laneEnd(SEW!, en)).toEqual({ efficiency: '100% efficiency', people: '12 stations', pattern: 'Default shifts (no calendar)', full: '100% efficiency (the default) · 12 stations (its active stations) · Default shifts (no calendar)' })
    expect(laneNotes(L1!, en)).toEqual(['640 min past due, in no bucket'])
    expect(laneNotes(L2!, en)).toEqual(['1 work order on hold books nothing'])
    expect(bucketLabel(CAPACITY.buckets[0]!, en)).toBe('Wk 47 · 16–22 Nov')
    expect(bucketLabel(CAPACITY.buckets[2]!, words('it'))).toBe('Sett. 49 · 30 nov–6 dic')
    expect(bucketLabel({ key: '2026-11-16', kind: 'DAY', from: '2026-11-16', to: '2026-11-16' }, words('it'))).toBe('lun 16 nov')
  })

  it('links the board (a window of its own) and the lane’s calendar', () => {
    expect(boardHref('/w/DEMO', 's1', [L1!, L2!], '2026-11-16')).toBe(`/w/DEMO/planning/board?site=s1&lane=${encodeURIComponent(`LINE:${L1!.id},LINE:${L2!.id}`)}&from=2026-11-16`)
    expect(calendarHref('/w/DEMO', 's1', 'c1')).toBe('/w/DEMO/planning/settings?site=s1&tab=calendars&cal=c1')
  })

  it('the CSV has one row per lane and bucket', () => {
    const csv = csvOfLanes(CAPACITY, [L2!], words('en')).split('\r\n')
    expect(csv[0]).toBe('Lane;Kind;Bucket;From;To;Available (min);Booked (min);Load (%);Efficiency (%);People or stations')
    expect(csv).toHaveLength(6)
    expect(csv[1]).toBe('L2;Line;Wk 47 · 16–22 Nov;2026-11-16;2026-11-22;12150.0;13800.0;113.6;90.00;6')
  })
})

function mockApi(answers: Array<{ status: number; body: unknown }>): { api: ApiClient; calls: Array<{ method: string; url: string }> } {
  const calls: Array<{ method: string; url: string }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('capacity: the calls as the API takes them', () => {
  it('reads the period and a cell’s orders (read only: nothing is written here)', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: CAPACITY },
      { status: 200, body: { lane: { kind: 'LINE', id: L2!.id, code: 'L2', name: 'Linea 2' }, from: '2026-11-16', to: '2026-11-22', availableMinutes: '1', bookedMinutes: '1', loadPct: '100.0', words: 'x', orders: [] } },
    ])
    expect((await getCapacity(api, { siteId: 's1', from: '2026-11-16', to: null, bucket: 'MONTH' })).lanes).toHaveLength(4)
    expect(calls[0]!.url).toBe('/api/planning/capacity?siteId=s1&from=2026-11-16&bucket=MONTH')
    await getCellOrders(api, { siteId: 's1', laneKind: 'LINE', laneId: L2!.id, from: '2026-11-16', to: '2026-11-22' })
    expect(calls[1]!.url).toBe(`/api/planning/capacity/cell?siteId=s1&laneKind=LINE&laneId=${L2!.id}&from=2026-11-16&to=2026-11-22`)
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('the page is built and reached from the record links', () => {
    expect(OFFICE_PAGES.has('/planning/capacity')).toBe(true)
    expect(LIST_PAGES['/planning/capacity']).toBe('/planning/capacity')
  })
})

const LEFT_KEY = /\b(?:page|bucket|live|noAccess|keys|tile|col|kind|lane|cell|how|list|bulk|empty|common|error|period|csv|load|board)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:planning\.view)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  it(`${designScreen.screen}: ${designScreen.cases.length} cases × it, en`, () => {
    const screen = designScreen as unknown as DesignScreen<unknown>
    for (const item of screen.cases) {
      for (const locale of LOCALES) {
        const html = render(screen, item.model, locale).replace(SAID, '')
        expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })
})
