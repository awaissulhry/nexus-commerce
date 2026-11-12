import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { designScreen as mpsScreen } from '../mps/fixtures'
import { getDemand, getDemandRows } from './api'
import { designScreen, FIXTURES } from './fixtures'
import {
  barOf,
  bucketLabel,
  bucketSpan,
  busiest,
  cellFilter,
  cellLabel,
  columnBuckets,
  controlsOf,
  csvOfGrid,
  DEFAULT_LAYERS,
  gridLines,
  kindsWords,
  listFilterOf,
  listOnCellOf,
  NAMESPACE,
  queryOf,
  readProblemOf,
  recordHref,
  shown,
  shownKinds,
  sizeLineId,
  statusWords,
  tilesInOrder,
  toggledLayers,
  type Words,
} from './model'

/**
 * Planning › Demand & forecast (SCR-374; B-W2b-339 on the demand API of B-W2b-319): the address, the layers and what a cell
 * adds up, the grid's lines and columns, the stacked mini bar, the popover's filter and words, where a source opens, the
 * calls as the API takes them, and every design case (and SCR-202's) drawn in Italian and English with no key left on screen.
 */

const words = (locale: 'it' | 'en' = 'en'): Words => ({ t: createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!), locale })
const { DEMAND, ROWS, SOURCES, POPOVER_ROWS, WEEK_HORIZON, rowsAnswer } = FIXTURES
const NERO = ROWS[0]!

describe('demand: the address', () => {
  it('keeps the grid’s and the list’s terms apart; the firm layers by default', () => {
    const controls = controlsOf(new URLSearchParams('site=s1&bucket=MONTH&weeks=13&layers=QUOTES,ORDERS,BRANDS&q=jkt&layer=REMAKES&rq=SO-1&style=st&colour=none&size=50&cell=2026-W47'))
    expect(controls).toEqual({ site: 's1', bucket: 'MONTH', weeks: 13, layers: ['ORDERS', 'QUOTES'], q: 'jkt', layer: 'REMAKES', rq: 'SO-1', style: 'st', colour: 'none', size: '50', mtm: false, cell: '2026-W47' })
    expect(queryOf(controls)).toBe('site=s1&bucket=MONTH&weeks=13&layers=ORDERS%2CQUOTES&q=jkt&layer=REMAKES&rq=SO-1&style=st&colour=none&size=50&cell=2026-W47')
    const plain = controlsOf(new URLSearchParams('bucket=YEAR&weeks=500&layer=X'))
    expect(plain).toMatchObject({ bucket: 'WEEK', weeks: null, layers: DEFAULT_LAYERS, layer: null })
    expect(queryOf(plain)).toBe('')
    expect(listFilterOf({ ...plain, mtm: true, size: '50', style: 'st', colour: 'c1', cell: 'PAST', rq: ' ' })).toEqual({ layer: null, styleId: 'st', colourwayId: 'c1', size: null, madeToMeasure: true, cell: 'PAST', q: ' ' })
  })

  it('a layer switches on and off in the design’s order; the last one stays on', () => {
    expect(toggledLayers(['ORDERS', 'MTM'], 'QUOTES')).toEqual(['ORDERS', 'MTM', 'QUOTES'])
    expect(toggledLayers(['ORDERS', 'MTM'], 'ORDERS')).toEqual(['MTM'])
    expect(toggledLayers(['REMAKES'], 'REMAKES')).toEqual(['REMAKES'])
  })
})

describe('demand: the tiles and the grid', () => {
  it('tiles in the design’s order; the W3 layers are never 0', () => {
    const tiles = tilesInOrder(DEMAND.tiles)
    expect(tiles.map((tile) => tile.layer)).toEqual(['ORDERS', 'MTM', 'SAMPLES', 'REMAKES', 'QUOTES', 'BRANDS', 'FORECAST'])
    expect(tiles.find((tile) => tile.layer === 'FORECAST')).toMatchObject({ known: false, pieces: null })
    expect(tilesInOrder([]).every((tile) => tile.pieces === null)).toBe(true)
  })

  it('a cell adds up the layers shown; quotes only when switched on', () => {
    const cell = NERO.cells.find((entry) => entry.bucket === WEEK_HORIZON.buckets[8]!.key)
    expect(shown(cell, DEFAULT_LAYERS)).toBe(0)
    expect(shown(cell, [...DEFAULT_LAYERS, 'QUOTES'])).toBe(12)
    expect(shown(NERO.totals, DEFAULT_LAYERS)).toBe(NERO.totals.firm)
  })

  it('lines open to their sizes (made to measure last); the late and undated columns only when something is there', () => {
    expect(gridLines(ROWS, []).map((line) => line.kind)).toEqual(ROWS.map(() => 'row'))
    const open = gridLines(ROWS, [NERO.key]).filter((line) => line.row.key === NERO.key)
    expect(open.map((line) => (line.kind === 'row' ? 'row' : line.size))).toEqual(['row', '46', '48', '50', '52', '54', null])
    expect(open[open.length - 1]!.id).toBe(sizeLineId(NERO.key, null))
    const columns = columnBuckets(DEMAND, DEFAULT_LAYERS)
    expect(columns[0]).toBe('PAST')
    expect(columns[columns.length - 1]).toBe('NONE')
    expect(columns).toHaveLength(WEEK_HORIZON.buckets.length + 2)
    expect(columnBuckets(DEMAND, ['MTM'])).toEqual(WEEK_HORIZON.buckets.map((bucket) => bucket.key))
  })

  it('the stacked mini bar: its length against the busiest cell, one part per layer shown', () => {
    const max = busiest(ROWS, DEFAULT_LAYERS)
    expect(max).toBe(40)
    const bar = barOf({ ORDERS: 12, QUOTES: 5, MTM: 0, SAMPLES: 0, REMAKES: 4 }, DEFAULT_LAYERS, max)
    expect(bar.length).toBe(40)
    expect(bar.parts.map((part) => [part.layer, Math.round(part.pct)])).toEqual([
      ['ORDERS', 75],
      ['REMAKES', 25],
    ])
    expect(barOf(undefined, DEFAULT_LAYERS, max)).toEqual({ length: 0, parts: [] })
    expect(barOf({ ORDERS: 1, QUOTES: 0, MTM: 0, SAMPLES: 0, REMAKES: 0 }, DEFAULT_LAYERS, 400).length).toBe(8)
  })

  it('bucket heads and cell names in both languages', () => {
    const week = WEEK_HORIZON.buckets[0]!
    expect(bucketLabel(week.key, WEEK_HORIZON, words('en'))).toBe('Wk 46')
    expect(bucketLabel(week.key, WEEK_HORIZON, words('it'))).toBe('Sett. 46')
    expect(bucketSpan(week.key, WEEK_HORIZON, words('en'))).toBe('9 Nov to 15 Nov 2026')
    expect(bucketLabel('PAST', WEEK_HORIZON, words('it'))).toBe('In ritardo')
    expect(bucketLabel('2026-12', FIXTURES.MONTH_HORIZON, words('en'))).toBe('Dec 2026')
    const [line] = gridLines(ROWS, [])
    expect(cellLabel(line!, 'Wk 46', line!.cells.find((cell) => cell.bucket === week.key), DEFAULT_LAYERS, words('en'))).toBe('JKT-DEMO-07 · Nero, Wk 46: 12 pieces — 12 on orders. What makes this number')
    expect(cellLabel(line!, 'Sett. 47', { ORDERS: 0, QUOTES: 0, MTM: 0, SAMPLES: 1, REMAKES: 0 }, DEFAULT_LAYERS, words('it'))).toBe('JKT-DEMO-07 · Nero, Sett. 47: 1 pezzo — 1 campione. Da cosa nasce questo numero')
  })
})

describe('demand: what makes this number', () => {
  it('a cell’s read names its style, colourway (or none), size (or made to measure) and bucket', () => {
    const lines = gridLines(ROWS, [NERO.key])
    expect(cellFilter(lines[0]!, '2026-W46')).toEqual({ styleId: NERO.style.id, colourwayId: NERO.colourway!.id, cell: '2026-W46' })
    const mtm = lines.find((line) => line.id === sizeLineId(NERO.key, null))!
    expect(cellFilter(mtm, null)).toEqual({ styleId: NERO.style.id, colourwayId: NERO.colourway!.id, madeToMeasure: true, cell: null })
    const sample = gridLines(ROWS, []).find((line) => line.row.colourway === null)!
    expect(cellFilter(sample, 'NONE').colourwayId).toBe('none')
    expect(queryOf(listOnCellOf(controlsOf(new URLSearchParams('q=jkt&rq=x')), lines.find((line) => line.size === '50')!, '2026-W47'))).toBe(`q=jkt&style=${NERO.style.id}&colour=${NERO.colourway!.id}&size=50&cell=2026-W47`)
  })

  it('says the kinds in our words, those of the layers shown', () => {
    const answer = rowsAnswer(SOURCES)
    expect(kindsWords(shownKinds(answer.kinds, ['ORDERS', 'REMAKES']), words('en').t)).toBe('4 orders, 1 recut, 1 rework, 1 replacement for a return')
    expect(kindsWords(shownKinds(rowsAnswer(POPOVER_ROWS).kinds, DEFAULT_LAYERS), words('it').t)).toBe('1 ordine')
    expect(statusWords('IN_MAKING', words('it').t)).toBe('In lavorazione')
    expect(statusWords('SOMETHING_NEW', words('en').t)).toBe('Open')
  })

  it('a source opens its own page once built (record-links), else its panels; a real link for ⌘-click', () => {
    expect(recordHref('/w/DEMO', OFFICE_PAGES, { recordType: 'SalesOrder', recordId: 'o1', number: 'SO-1' })).toBe('/w/DEMO/sales/orders/o1')
    expect(recordHref('/w/DEMO', new Set(), { recordType: 'SalesOrder', recordId: 'o1', number: 'SO-1' })).toBe('/w/DEMO/records/SalesOrder/o1?label=SO-1')
    expect(recordHref('/w/DEMO', OFFICE_PAGES, { recordType: 'ReworkOrder', recordId: 'r1', number: 'WO-1' })).toBe('/w/DEMO/production/scrap?open=rework:r1')
  })

  it('the grid as a file: the layers shown, the open sizes', () => {
    const csv = csvOfGrid(DEMAND, gridLines([NERO], [NERO.key]), DEFAULT_LAYERS, words('en'))
    const lines = csv.split('\r\n')
    expect(lines[0]!.split(';').slice(0, 6)).toEqual(['Style', 'Colourway', 'Size', 'Strategy', 'Total', 'Late'])
    expect(lines[1]!.split(';').slice(0, 7)).toEqual(['JKT-DEMO-07 Giacca Demo Strada', 'NER Nero', '', 'Make to order', String(NERO.totals.firm), '4', '12'])
    expect(lines).toHaveLength(1 + 1 + NERO.sizes.length)
  })

  it('a moved cursor is said as such; other failures in words', () => {
    expect(readProblemOf(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'querystring/cursor' }]))).toBe('error.moved')
    expect(readProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('error.forbidden')
    expect(readProblemOf(new Error('x'))).toBe('error.failed')
  })
})

function mockApi(answers: unknown[]) {
  const calls: { method: string; url: string }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url })
    return new Response(JSON.stringify(answers.shift() ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('demand: the calls as the API takes them', () => {
  it('reads the view and the rows (read only: nothing is written here)', async () => {
    const { api, calls } = mockApi([DEMAND, rowsAnswer(POPOVER_ROWS)])
    expect((await getDemand(api, { siteId: 's1', bucket: 'MONTH', weeks: 13, q: 'jkt' })).rows).toHaveLength(ROWS.length)
    expect(calls[0]!.url).toBe('/api/planning/demand?siteId=s1&bucket=MONTH&weeks=13&q=jkt')
    await getDemandRows(api, { siteId: 's1', bucket: 'WEEK', weeks: null }, { styleId: 'st', colourwayId: 'none', madeToMeasure: true, cell: 'PAST' }, { limit: 200 })
    expect(calls[1]!.url).toBe('/api/planning/demand/rows?siteId=s1&bucket=WEEK&styleId=st&colourwayId=none&madeToMeasure=true&cell=PAST&limit=200')
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('the pages are built and reached from the record links', () => {
    expect(OFFICE_PAGES.has('/planning/demand')).toBe(true)
    expect(OFFICE_PAGES.has('/planning/mps')).toBe(true)
    expect(LIST_PAGES['/planning/demand/rows']).toBe('/planning/demand')
    expect(LIST_PAGES['/planning/strategy']).toBe('/planning/mps')
  })
})

const LEFT_KEY = /\b(?:page|bucket|live|noAccess|keys|tile|tiles|grid|layer|layers|layerCount|strategy|bulk|popover|kindCount|kind|sampleKind|status|rows|csv|error|common|mps|list|col|filter|cell|held|refusal|notice)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:planning\.view|planning\.strategy\.manage)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [designScreen, mpsScreen] as unknown as DesignScreen<unknown>[]) {
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
})
