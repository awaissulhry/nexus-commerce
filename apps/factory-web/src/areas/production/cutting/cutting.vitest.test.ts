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
import { CUT_STATES, CUT_VIEWS, getRecuts, listCuts, recutDone, voidBundle } from './api'
import { AVAILABILITY, BUNDLES, canAs, CUT_LOG, CUTTING, EMPTY_LOG, EMPTY_YIELD, HELD, HELD_WORK_ORDER, RECUTS, TILES, WAITING, WAITING_PNT, WAITING_TMO, WORK_ORDER, WORK_ORDER_YIELD, YIELD_TODAY } from './demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import {
  addressOf,
  addressText,
  allocateHeld,
  csvOf,
  cutOf,
  cutStateOf,
  lotYields,
  newCutChoices,
  newCutHeld,
  newCutRowHeld,
  piecesMatrix,
  recutEntries,
  recutHeld,
  reprintHeld,
  romeDayStart,
  tabOf,
  ticketLines,
  ticketsHeld,
  tileValue,
  usedText,
  voidHeld,
  writeProblem,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'

/**
 * Production › Cutting (SCR-238 and the Cut record; B-W2a-60): the pure rules (the address, the tiles, a cut's state,
 * New cut order and Allocate hides held with why, the pieces matrix with its recuts, a recut's entries, the yield per
 * lot summed before the percentage, the tickets' print state and what holds a reprint or a void, refusals in our
 * words), the calls as the API of B-W1-40 / B-W2a-13 / B-W2a-60 takes them, the page in the map, and every design case
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
  })

  it('never adds areas of different units', () => {
    expect(usedText([{ uom: 'FT2', area: '48.1600' }, { uom: 'M2', area: '2.1000' }], 'en')).toBe('48.16 ft² · 2.10 m²')
    expect(usedText([], 'en')).toBe('—')
  })

  it('a cut stands where the API says (held, cut, waiting, cutting)', () => {
    expect(cutStateOf('ON_HOLD', [{ toCut: 0 }], 3)).toBe('HELD')
    expect(cutStateOf('COMPLETED', [{ toCut: 4 }], 0)).toBe('CUT')
    expect(cutStateOf('IN_PROGRESS', [{ toCut: 0 }, { toCut: null }], 2)).toBe('CUT')
    expect(cutStateOf('RELEASED', [{ toCut: 2 }], 0)).toBe('WAITING')
    expect(cutStateOf('IN_PROGRESS', [{ toCut: 2 }], 1)).toBe('CUTTING')
    expect(CUT_STATES).toEqual(['WAITING', 'CUTTING', 'CUT', 'HELD'])
  })

  it('the start of the day in Rome, summer and winter', () => {
    expect(romeDayStart(new Date('2026-10-30T09:00:00Z')).toISOString()).toBe('2026-10-29T23:00:00.000Z')
    // 23:30 on 15 July in Rome is still the 15th; 00:30 is the 16th.
    expect(romeDayStart(new Date('2026-07-15T21:30:00Z')).toISOString()).toBe('2026-07-14T22:00:00.000Z')
    expect(romeDayStart(new Date('2026-07-15T22:30:00Z')).toISOString()).toBe('2026-07-15T22:00:00.000Z')
  })
})

describe('New cut order and Allocate hides', () => {
  it('offers the work orders waiting with no hide allocated; one leather and colour; one work order a cut (W2a)', () => {
    expect(newCutChoices([CUTTING, WAITING, WAITING_TMO, HELD]).map((row) => row.workOrder.number)).toEqual([WAITING.workOrder.number, WAITING_TMO.workOrder.number])
    expect(newCutRowHeld(WAITING_TMO, [WAITING])).toEqual({ key: 'newCut.why.material', params: { material: 'DEMO-LEA-100 · NER' } })
    expect(newCutRowHeld(WAITING_PNT, [WAITING])).toBeNull()
    expect(newCutRowHeld(WAITING, [])).toBeNull()
    const can = canAs('manager')
    expect(newCutHeld([], can, false)).toEqual({ key: 'newCut.held.none' })
    expect(newCutHeld([WAITING, WAITING_PNT], can, false)).toEqual({ key: 'newCut.held.many' })
    expect(newCutHeld([WAITING], can, false)).toBeNull()
    expect(newCutHeld([WAITING], canAs('supervisor'), false)).toEqual({ key: 'held.permission', params: { permission: 'inventory.reserve' } })
  })

  it('Allocate hides is held without the rights, for a cut done, and named otherwise; a held work order may still be allocated', () => {
    expect(allocateHeld(WAITING, canAs('manager'))).toBeNull()
    expect(allocateHeld(HELD, canAs('manager'))).toBeNull()
    expect(allocateHeld({ ...CUTTING, state: 'CUT' }, canAs('manager'))).toEqual({ key: 'alloc.held.cut' })
    expect(allocateHeld(WAITING, canAs('buyer'))).toEqual({ key: 'held.permission', params: { permission: 'inventory.reserve' } })
    expect(allocateHeld(null, canAs('manager'))).toEqual({ key: 'held.loading' })
    expect(AVAILABILITY.hides.some((hide) => hide.held)).toBe(true)
  })

  it('Print tickets opens the tickets of exactly one cut', () => {
    expect(ticketsHeld(1, canAs('manager'))).toBeNull()
    expect(ticketsHeld(2, canAs('manager'))).toEqual({ key: 'held.tickets.one' })
    expect(ticketsHeld(1, canAs('buyer'))).toEqual({ key: 'held.permission', params: { permission: 'workorders.view' } })
  })
})

describe('the cut record', () => {
  it('builds the cut from its work order, cut log and yield', () => {
    const cut = cutOf(WORK_ORDER, CUT_LOG, WORK_ORDER_YIELD, 2)
    expect(cut).toMatchObject({ state: 'CUTTING', garments: { planned: 24, cut: 10, toCut: 14 }, pieces: { planned: 72, cut: 31 }, allocated: 2, hides: { count: 4 }, stations: [{ code: 'TAV-01' }] })
    expect(cut.materials).toEqual([expect.objectContaining({ code: 'DEMO-LEA-100', colourCode: 'NER', baseUom: 'FT2' })])
    expect(cutOf(HELD_WORK_ORDER, CUT_LOG, WORK_ORDER_YIELD, 0)).toMatchObject({ state: 'HELD', workOrder: { holdReason: 'Shade differs from the approved sample' } })
    expect(cutOf(WORK_ORDER, EMPTY_LOG, EMPTY_YIELD, 0).state).toBe('WAITING')
    expect(tabOf('yield')).toBe('yield')
    expect(tabOf('nonsense')).toBe('lay')
  })

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
    expect(recutHeld(open, CUT_LOG, canAs('supervisor'), false)).toEqual({ key: 'held.permission', params: { permission: 'production.scrap' } })
  })

  it('the yield per lot adds the areas first (never an average of percentages)', () => {
    const [lot] = lotYields(WORK_ORDER_YIELD.hides)
    // Used 192.64, single parts 5.20 left out: 139.08 / 187.44 = 74.20 %.
    expect(lot).toMatchObject({ lotCode: 'DEMO-LOT-0101', supplier: 'Conceria Demo S.r.l.', hides: 4, yieldPct: '74.20' })
    expect(lotYields([])).toEqual([])
  })

  it('tickets: the last print state; a reprint and a void held with why', () => {
    const lines = ticketLines(BUNDLES)
    expect(lines.map((line) => line.print)).toEqual(['PRINTED', 'PRINTED', 'FAILED', 'PRINTED'])
    expect(lines[1]!.reprints).toBe(1)
    const can = canAs('manager')
    expect(voidHeld(BUNDLES.bundles[0]!, can, false)).toEqual({ key: 'held.ticket.scanned', params: { count: 2 } })
    expect(voidHeld(BUNDLES.bundles[2]!, can, false)).toBeNull()
    expect(voidHeld(BUNDLES.bundles[3]!, can, false)).toEqual({ key: 'held.ticket.voided' })
    expect(reprintHeld(BUNDLES.bundles[0]!, canAs('supervisor'), false)).toEqual({ key: 'held.permission', params: { permission: 'production.bundles' } })
    expect(ticketLines({ ...BUNDLES, bundles: [{ ...BUNDLES.bundles[0]!, tickets: null }] })[0]!.print).toBe('UNKNOWN')
    expect(ticketLines({ ...BUNDLES, bundles: [{ ...BUNDLES.bundles[0]!, tickets: [] }] })[0]!.print).toBe('PDF')
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

  it('Export N never names who cut', () => {
    const text = csvOf([CUTTING], ['a'], 'en')
    expect(text).toContain('WO-26-0031')
    expect(text).toContain('TAV-01')
    expect(text).not.toMatch(/Esempio|Prova/)
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

  it('lists the cuts of a view, reads the recuts, marks one cut and voids a bundle with their keys', async () => {
    const { api, calls } = recorder({
      '/production/cutting/cuts': { cuts: [CUTTING], more: false, tiles: TILES, asOf: '2026-10-30T08:40:00.000Z' },
      '/production/replacements': { replacements: RECUTS, nextCursor: null },
      '/done': { replacement: { ...RECUTS[0]!, status: 'DONE' } },
      '/void': { bundle: { id: 'b1' } },
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
    await voidBundle(api, 'b1', 'Made by mistake', 'key-2')
    expect(calls[3]).toMatchObject({ method: 'POST', key: 'key-2', body: { reason: 'Made by mistake' } })
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

const LEFT_KEY = /\b(?:state|kind|view|tile|tiles|col|list|page|common|live|held|newCut|alloc|notice|problem|record|tab|part|lay|pieces|recuts|yield|tickets|hideState|bulk|csv)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs inventory.reserve"). */
const SAID = /\b(?:production\.[a-z.]+|inventory\.[a-z.]+|workorders\.[a-z.]+|money\.cost)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'cutting']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as unknown as DesignScreen<unknown>[]) {
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

  it('has words for every state, view, tile, hide state, print state and tab in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['cutting']).cutting ?? {})
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const state of CUT_STATES) has(`state.${state}`)
      for (const view of CUT_VIEWS) has(`view.${view}`)
      for (const tile of ['waiting', 'cutting', 'piecesToday', 'areaToday', 'yieldToday']) has(`tile.${tile}`)
      for (const state of ['FULL', 'PARTLY_CUT', 'REMNANT', 'CONSUMED', 'SCRAPPED']) has(`hideState.${state}`)
      for (const state of ['QUEUED', 'SENT', 'PRINTED', 'FAILED', 'PDF', 'UNKNOWN']) has(`tickets.print.${state}`)
      for (const tab of ['lay', 'pieces', 'yield', 'tickets']) has(`tab.${tab}`)
      for (const why of ['held', 'mine', 'other', 'empty']) has(`alloc.reserve.why.${why}`)
      for (const status of ['forbidden', 'missing', 'error']) has(`record.state.${status}.title`)
      has('common.count', 2)
      has('common.countMore', 2)
    }
  })
})
