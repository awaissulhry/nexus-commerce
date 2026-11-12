import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HEAT_BANDS } from '@nexus/factory-domain/planning/heatmap/bands'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { CAPACITY, designScreen, HEATMAP, SUBCONTRACTORS } from '../fixtures'
import { csvOfLanes, NAMESPACE } from '../model'
import { getHeatmap, getSubcontractorCapacity, getWorkshopCell } from './api'
import {
  csvWorkshopRows,
  DEPTH_NAMESPACE,
  heatCellAt,
  heatCellKey,
  heatCellWords,
  heatLaneWords,
  heatOrder,
  heatStep,
  heatText,
  kindOfTag,
  legendOf,
  parseWorkshopKey,
  proposedWords,
  rowsOf,
  workshopCellAt,
  workshopCellKey,
  workshopCellOrder,
  workshopHowWords,
  workshopRowEnd,
  workshopRowKey,
  workshopRowWords,
  type Words,
} from './model'

/**
 * Capacity & load in depth (SCR-123; B-W2b-338 on B-W2b-321's API): the workshop rows (weekly minutes or garments, what
 * the plan proposes said apart, "—" when no capacity is set), the tile "Subcontractors over their capacity" and the rows it
 * filters to, the heatmap (the number in every cell, the band in words, the arrows' walk, the cell's key), the CSV, the
 * calls, and every design case drawn in both languages with no key or placeholder left.
 */

const words = (locale: 'it' | 'en' = 'en'): Words => ({ t: createTranslator(locale, messagesFor(locale, [DEPTH_NAMESPACE])[DEPTH_NAMESPACE]!), locale })
const capacityWords = (locale: 'it' | 'en' = 'en') => ({ t: createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!), locale })
const [BETA_SEW, BETA_ALL, GAMMA] = SUBCONTRACTORS.lanes

describe('capacity in depth: the workshop rows and their tile', () => {
  it('the table lists our lanes, then each workshop capacity line; the tile shows the workshops over this week', () => {
    expect(rowsOf(CAPACITY, SUBCONTRACTORS, null).map((row) => row.key)).toEqual([...CAPACITY.lanes.map((lane) => `${lane.kind}:${lane.id}`), workshopRowKey(BETA_SEW!), workshopRowKey(BETA_ALL!), workshopRowKey(GAMMA!)])
    expect(rowsOf(CAPACITY, SUBCONTRACTORS, 'subs').map((row) => (row.kind === 'workshop' ? `${row.line.code}:${row.line.workCentreKind}` : row.key))).toEqual(['LAB-B:SEWING'])
    expect(rowsOf(CAPACITY, SUBCONTRACTORS, 'over').every((row) => row.kind === 'lane')).toBe(true)
    expect(rowsOf(CAPACITY, null, null)).toHaveLength(CAPACITY.lanes.length)
  })

  it('a workshop cell key names the workshop, its line (kind, all or none) and the bucket', () => {
    const key = workshopCellKey(BETA_SEW!, '2026-W48')
    expect(parseWorkshopKey(key)).toEqual({ partyId: BETA_SEW!.id, tag: 'SEWING', bucketKey: '2026-W48' })
    expect(parseWorkshopKey(workshopCellKey(GAMMA!, '2026-W48'))?.tag).toBe('none')
    expect(kindOfTag('all')).toBeNull()
    expect(kindOfTag('SEWING')).toBe('SEWING')
    expect(parseWorkshopKey('LINE:a:2026-W48')).toBeNull()
    expect(workshopCellAt(SUBCONTRACTORS, key)?.cell.from).toBe('2026-11-23')
    expect(workshopCellAt(SUBCONTRACTORS, workshopCellKey(BETA_ALL!, '2026-W48'))?.line.unit).toBe('PIECES')
    expect(workshopCellOrder(SUBCONTRACTORS.lanes).indexOf(key)).toBe(1)
  })

  it('says a workshop line in words: its weekly minutes or garments, what the plan proposes apart, — when none is set', () => {
    expect(workshopRowWords(BETA_SEW!, words())).toBe('LAB-B · Workshop · sewing, minutes a week')
    expect(workshopRowWords(GAMMA!, words('it'))).toBe('LAB-G · Laboratorio · nessuna capacità settimanale')
    expect(workshopRowEnd(BETA_SEW!, '2026-11-16', words()).main).toBe('2,400 min a week')
    expect(workshopRowEnd(BETA_ALL!, '2026-11-16', words('it')).full).toMatch(/^60 capi a settimana per tutto il lavoro, 1 nov – 23 dic/)
    expect(workshopRowEnd(GAMMA!, '2026-11-16', words()).main).toBe('No weekly capacity')
    const w48 = BETA_SEW!.cells[1]!
    expect(proposedWords(BETA_SEW!, w48, words())).toBe('+772 min proposed by the plan')
    expect(proposedWords(BETA_SEW!, BETA_SEW!.cells[0]!, words())).toBeNull()
    const how = workshopHowWords(BETA_SEW!, w48, words())
    expect(how[0]).toMatch(/^2,400 min a week for sewing, 1 Nov – open-ended\.$/)
    expect(how).toContain('5 open weekdays, 0 closed in these days.')
    expect(how.at(-1)).toMatch(/^772 min more proposed by the plan/)
    expect(workshopHowWords(GAMMA!, GAMMA!.cells[0]!, words())[0]).toMatch(/has no weekly capacity set/)
  })

  it('the CSV adds the workshop rows after the lanes, in their unit', () => {
    const csv = csvOfLanes(CAPACITY, [], capacityWords(), csvWorkshopRows(SUBCONTRACTORS, [BETA_ALL!], words(), capacityWords())).split('\r\n')
    expect(csv).toHaveLength(1 + 5)
    expect(csv[1]).toMatch(/^LAB-B;Workshop · all work · garments;Wk 47/)
  })
})

describe('capacity in depth: the load heatmap', () => {
  it('writes the whole percent in every cell, — when nothing is available (never 0 %), and says the band in words', () => {
    const l2 = HEATMAP.lanes[1]!
    expect(heatText(l2.cells[0]!, 'en')).toBe('114%')
    const gamma = HEATMAP.lanes[6]!
    expect(heatText(gamma.cells[0]!, 'it')).toBe('—')
    expect(heatCellWords(l2, l2.cells[0]!, words())).toMatch(/^Linea 2, week of 16–22 Nov: 114% — 11,360 of 10,000 min booked \(over capacity\)\. Opens the orders\.$/)
    expect(heatCellWords(gamma, gamma.cells[0]!, words('it'))).toMatch(/— nulla di disponibile/)
    expect(heatLaneWords(HEATMAP.lanes[4]!, words())).toEqual({ name: 'Laboratorio Beta', sub: 'Workshop · sewing, minutes' })
    for (const locale of LOCALES) expect(legendOf(words(locale)).map((entry) => entry.band)).toEqual([...HEAT_BANDS])
  })

  it('a heat cell key opens the right lane and week; the arrows and J / K walk it', () => {
    const key = heatCellKey(HEATMAP.lanes[4]!, '2026-W48')
    expect(heatCellAt(HEATMAP, key)).toMatchObject({ row: 4, col: 1 })
    expect(heatCellAt(HEATMAP, heatCellKey(HEATMAP.lanes[5]!, '2026-W48'))?.lane.unit).toBe('PIECES')
    expect(heatCellAt(HEATMAP, 'LINE:nope:2026-W48')).toBeNull()
    expect(heatOrder(HEATMAP)).toHaveLength(HEATMAP.lanes.length * HEATMAP.weeks.length)
    expect(heatStep(HEATMAP, 0, 0, 'ArrowRight')).toEqual({ row: 0, col: 1 })
    expect(heatStep(HEATMAP, 0, 0, 'ArrowUp')).toBeNull()
    expect(heatStep(HEATMAP, 6, 7, 'ArrowDown')).toBeNull()
    expect(heatStep(HEATMAP, 2, 3, 'End')).toEqual({ row: 2, col: 7 })
    expect(heatStep(HEATMAP, 2, 3, 'x')).toBeNull()
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

describe('capacity in depth: the calls as the API takes them (read only)', () => {
  it('reads the workshops over the same period, a workshop cell and the heatmap', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: SUBCONTRACTORS },
      { status: 200, body: { workshop: { id: 'p', code: 'B', name: 'Beta' }, workCentreKind: 'SEWING', unit: 'MINUTES', from: '2026-11-16', to: '2026-11-22', available: '1', booked: '1', proposed: '0', loadPct: '100.0', words: 'x', jobs: [] } },
      { status: 200, body: HEATMAP },
    ])
    expect((await getSubcontractorCapacity(api, { siteId: 's1', from: '2026-11-16', to: null, bucket: 'WEEK' })).lanes).toHaveLength(3)
    expect(calls[0]!.url).toBe('/api/planning/capacity/subcontractors?siteId=s1&from=2026-11-16&bucket=WEEK')
    await getWorkshopCell(api, { siteId: 's1', partyId: 'p', workCentreKind: null, from: '2026-11-16', to: '2026-11-22' })
    expect(calls[1]!.url).toBe('/api/planning/capacity/subcontractors/cell?siteId=s1&partyId=p&from=2026-11-16&to=2026-11-22')
    expect((await getHeatmap(api, { siteId: 's1', from: null, weeks: 8 })).lanes).toHaveLength(7)
    expect(calls[2]!.url).toBe('/api/planning/heatmap?siteId=s1&weeks=8')
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })
})

const LEFT_KEY = /\b(?:cp|al)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/

describe('every capacity design case draws in both languages with no depth key left on screen', () => {
  it(`${designScreen.screen}: ${designScreen.cases.length} cases × it, en`, () => {
    const screen = designScreen as unknown as DesignScreen<unknown>
    const View = screen.view as ComponentType<{ model: unknown }>
    for (const item of screen.cases) {
      for (const locale of LOCALES) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model: item.model })))
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })
})
