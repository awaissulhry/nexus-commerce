import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, listAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { CUT_STATES, CUT_VIEWS, getRecuts, listCuts, recutDone } from './api'
import { AVAILABILITY, canAs, CUT_LOG, CUTTING, EMPTY_LOG, HELD, RECUTS, TILES, WAITING, WORK_ORDER_YIELD, YIELD_TODAY } from './demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import {
  addressOf,
  addressText,
  allocateHeld,
  lotYields,
  piecesMatrix,
  recutEntries,
  recutHeld,
  romeDayStart,
  ticketsHeld,
  tileValue,
  usedText,
  writeProblem,
} from './model'
import { rightRef } from '../../../lib/i18n/rights'

/**
 * Production › Cutting (SCR-238; B-W2a-60): the pure rules (the address, the tiles, New cut order and Allocate hides held
 * with why, the pieces matrix with its recuts and a recut's entries — F-PR-06: drawn on the work order's Cutting & bundles
 * tab, where the Cut record merged —, the yield per lot summed before the percentage, refusals in our words), the calls as the API of B-W1-40 / B-W2a-13 / B-W2a-60 takes them, the page in the map, and every design case
 * drawn in Italian and English with no message key or placeholder left on screen.
 */

describe('the cutting office: address, tiles, states', () => {
  it('reads and writes its address (saved filter, search, New cut order, Allocate hides)', () => {
    expect(addressOf(new URLSearchParams('view=held&q= WO-1 &new=1&alloc=0190f0e2-3333-7000-8000-000000000002'))).toEqual({ view: 'held', q: 'WO-1', newCut: true, alloc: '0190f0e2-3333-7000-8000-000000000002' })
    expect(addressOf(new URLSearchParams('view=nonsense&alloc=x'))).toEqual({ view: 'open', q: '', newCut: false, alloc: null })
    expect(addressText({ view: 'open', q: '', newCut: false, alloc: null })).toBe('')
    expect(addressText({ view: 'cutting', q: 'jkt', newCut: true, alloc: null })).toBe('?view=cutting&q=jkt&new=1')
    expect(CUT_VIEWS).toEqual(['open', 'waiting', 'cutting', 'cut', 'held', 'all'])
  })

  it('says the tiles in figures, the area in m² beside the hides, and the yield against the plan', () => {
    expect(tileValue('waiting', TILES, null, 'en')).toBe('3')
    expect(tileValue('piecesToday', TILES, null, 'en')).toBe('31')
    expect(tileValue('areaToday', TILES, null, 'en')).toBe('3 · 13.42 m²')
    expect(tileValue('yieldToday', TILES, YIELD_TODAY, 'en')).toBe('74.2 % / 75.0 %')
    expect(tileValue('yieldToday', TILES, null, 'en')).toBe('—')
    expect(tileValue('waiting', null, null, 'en')).toBe('—')
    // B-W2b-129: the fabric cut orders added to Waiting to cut and Cutting now.
    expect(tileValue('waiting', TILES, null, 'en', { waiting: 2, cutting: 1 })).toBe('5')
    expect(tileValue('cutting', TILES, null, 'en', { waiting: 2, cutting: 1 })).toBe('2')
  })

  it('never adds areas of different units', () => {
    expect(usedText([{ uom: 'FT2', area: '48.1600' }, { uom: 'M2', area: '2.1000' }], 'en')).toBe('48.16 ft² · 2.10 m²')
    expect(usedText([], 'en')).toBe('—')
  })

  it('a cut stands where the API says (waiting, cutting, cut, held)', () => {
    expect(CUT_STATES).toEqual(['WAITING', 'CUTTING', 'CUT', 'HELD'])
  })

  it('the start of the day in Rome, summer and winter', () => {
    expect(romeDayStart(new Date('2026-10-30T09:00:00Z')).toISOString()).toBe('2026-10-29T23:00:00.000Z')
    // 23:30 on 15 July in Rome is still the 15th; 00:30 is the 16th.
    expect(romeDayStart(new Date('2026-07-15T21:30:00Z')).toISOString()).toBe('2026-07-14T22:00:00.000Z')
    expect(romeDayStart(new Date('2026-07-15T22:30:00Z')).toISOString()).toBe('2026-07-15T22:00:00.000Z')
  })
})

describe('Allocate hides and Print tickets', () => {
  it('Allocate hides is held without the rights, for a cut done, and named otherwise; a held work order may still be allocated', () => {
    expect(allocateHeld(WAITING, canAs('manager'))).toBeNull()
    expect(allocateHeld(HELD, canAs('manager'))).toBeNull()
    expect(allocateHeld({ ...CUTTING, state: 'CUT' }, canAs('manager'))).toEqual({ key: 'alloc.held.cut' })
    expect(allocateHeld(WAITING, canAs('buyer'))).toEqual({ key: 'held.permission', params: { right: rightRef('inventory.reserve') } })
    expect(allocateHeld(null, canAs('manager'))).toEqual({ key: 'held.loading' })
    expect(AVAILABILITY.hides.some((hide) => hide.held)).toBe(true)
  })

  it('Print tickets opens the tickets of exactly one cut', () => {
    expect(ticketsHeld(1, canAs('manager'))).toBeNull()
    expect(ticketsHeld(2, canAs('manager'))).toEqual({ key: 'held.tickets.one' })
    expect(ticketsHeld(1, canAs('buyer'))).toEqual({ key: 'held.permission', params: { right: rightRef('workorders.view') } })
  })
})

describe('a work order\'s cut (F-PR-06: its Cutting & bundles tab)', () => {
  it('pieces by part and size: cut / planned, short, and the open recuts of a part', () => {
    const matrix = piecesMatrix(CUT_LOG, RECUTS)
    expect(matrix.map((row) => row.part)).toEqual(['back', 'front', 'sleeve'])
    const sleeve = matrix.find((row) => row.part === 'sleeve')!
    expect(sleeve.cells.map((cell) => [cell.cut, cell.planned, cell.short, cell.recut])).toEqual([
      [3, 8, 5, 0],
      [8, 10, 2, 1],
      [0, 6, 6, 0],
    ])
    // The done recut (front, size 48) counts no more.
    expect(matrix.find((row) => row.part === 'front')!.cells[0]!.recut).toBe(0)
  })

  it('a recut is marked cut by a live entry of its cell with pieces of its part', () => {
    const open = RECUTS[0]!
    expect(recutEntries(CUT_LOG, open).map((entry) => entry.hideCode)).toEqual(['DEMO-HD-0004', 'DEMO-HD-0003', 'DEMO-HD-0002'])
    expect(recutHeld(open, CUT_LOG, canAs('manager'), false)).toBeNull()
    expect(recutHeld(open, EMPTY_LOG, canAs('manager'), false)).toEqual({ key: 'held.recut.noEntry', params: { cell: 'NER 50', part: 'sleeve' } })
    expect(recutHeld(RECUTS[1]!, CUT_LOG, canAs('manager'), false)).toEqual({ key: 'held.recut.done' })
    expect(recutHeld(open, CUT_LOG, canAs('supervisor'), false)).toEqual({ key: 'held.permission', params: { right: rightRef('production.scrap') } })
  })

  it('the yield per lot adds the areas first (never an average of percentages)', () => {
    const [lot] = lotYields(WORK_ORDER_YIELD.hides)
    // Used 192.64, single parts 5.20 left out: 139.08 / 187.44 = 74.20 %.
    expect(lot).toMatchObject({ lotCode: 'DEMO-LOT-0101', supplier: 'Conceria Demo S.r.l.', hides: 4, yieldPct: '74.20' })
    expect(lotYields([])).toEqual([])
  })

  it('a refused write in our words', () => {
    const refused = (path: string) => new ApiError('conflict', 409, 'refused', 'x', null, [{ path, message: 'English words' }])
    expect(writeProblem(refused('refusal/CUT_NOT_OF_CELL'))).toEqual({ key: 'problem.recut.notOfCell' })
    expect(writeProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'lines.0.hideId', message: 'taken' }]))).toEqual({ key: 'problem.alloc.hide' })
    expect(writeProblem(refused('body/lines/0/refusal/HIDE_RESERVED'))).toEqual({ key: 'problem.alloc.reserved' })
    expect(writeProblem(refused('body/lines/1/refusal/LOT_HELD'))).toEqual({ key: 'problem.alloc.lotHeld' })
    expect(writeProblem(refused('version'))).toEqual({ key: 'problem.changed' })
    expect(writeProblem(new Error('x'))).toEqual({ key: 'problem.write' })
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

  it('lists the cuts of a view, reads the recuts and marks one cut with its key', async () => {
    const { api, calls } = recorder({
      '/production/cutting/cuts': { cuts: [CUTTING], more: false, tiles: TILES, asOf: '2026-10-30T08:40:00.000Z' },
      '/production/replacements': { replacements: RECUTS, nextCursor: null },
      '/done': { replacement: { ...RECUTS[0]!, status: 'DONE' } },
    })
    expect((await listCuts(api, { view: 'held', q: ' 0031 ', limit: 50 })).cuts).toHaveLength(1)
    expect(calls[0]!.url).toContain('/production/cutting/cuts?')
    expect(calls[0]!.url).toContain('view=held')
    expect(calls[0]!.url).toContain('q=0031')
    expect(await getRecuts(api, 'w1')).toHaveLength(2)
    expect(calls[1]!.url).toContain('kind=RECUT')
    expect(calls[1]!.url).toContain('status=OPEN%2CDONE')
    await recutDone(api, 'r1', { version: 1, cutLogId: 'c1' }, 'key-1')
    expect(calls[2]).toMatchObject({ method: 'POST', key: 'key-1', body: { version: 1, cutLogId: 'c1' } })
  })
})

describe('the pages in the map', () => {
  it('are built and take the list route', () => {
    expect(OFFICE_PAGES.has('/production/cutting')).toBe(true)
    expect(OFFICE_PAGES.has('/production/cutting/[id]')).toBe(true)
    expect(LIST_PAGES['/production/cutting/cuts']).toBe('/production/cutting')
    expect(listAddress('/production/cutting/cuts', { view: 'held' }, OFFICE_PAGES)).toBe('/production/cutting?view=held')
  })
})

const LEFT_KEY = /\b(?:state|kind|view|tile|tiles|col|list|page|common|live|held|alloc|notice|problem|record|tab|part|lay|pieces|recuts|yield|tickets|hideState|bulk|csv|newOrder|shadeLot|ofWorkOrder|balance|feedback|status|plan|refusal|warning)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are stripped before the key check, though no screen says one since B-W2b-F51. */
const SAID = /\b(?:production\.[a-z.]+|inventory\.[a-z.]+|workorders\.[a-z.]+|purchasing\.[a-z.]+|money\.cost)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'cutting', 'cutting-orders']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen] as unknown as DesignScreen<unknown>[]) {
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

  it('has words for every state, view, tile and hide state in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['cutting']).cutting ?? {})
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const state of CUT_STATES) has(`state.${state}`)
      for (const view of CUT_VIEWS) has(`view.${view}`)
      for (const tile of ['waiting', 'cutting', 'piecesToday', 'areaToday', 'yieldToday']) has(`tile.${tile}`)
      for (const state of ['FULL', 'PARTLY_CUT', 'REMNANT', 'CONSUMED', 'SCRAPPED']) has(`hideState.${state}`)
      for (const why of ['held', 'mine', 'other', 'empty']) has(`alloc.reserve.why.${why}`)
      has('common.count', 2)
      has('common.countMore', 2)
    }
  })
})
