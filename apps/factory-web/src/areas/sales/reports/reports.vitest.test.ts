import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// B-TH-235: the request figure (the domain's parts and prospects' key), its design cases and Incoming's own address.
import { PROSPECTS_KEY as DOMAIN_PROSPECTS, requestFiguresOf } from '@nexus/factory-domain/insights/sales-reports/rules'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { addressOf as incomingAddressOf, queryOf as incomingQueryOf } from '../inquiries/model'
import { PROSPECTS_KEY, REQUEST_FIGURES, type RequestFigures as RequestFiguresRow } from './api'
import { designScreen, REQUESTS } from './fixtures'
import { LIVE_TYPES, REQUEST_DOORS, requestGroupName, requestsCsvRows, requestsDoor } from './model'
import { BACKLOG_GROUPS as DOMAIN_BACKLOG, BACKLOG_HORIZONS as DOMAIN_HORIZONS, BACKLOG_WEEK_KINDS as DOMAIN_WEEKS, FEES_KEY as DOMAIN_FEES, INTAKE_BUCKETS as DOMAIN_BUCKETS, INTAKE_SPLITS as DOMAIN_SPLITS, NO_KEY as DOMAIN_NO_KEY, RETURN_GROUPS as DOMAIN_RETURNS } from '@nexus/factory-domain/insights/sales-reports/rules'
import en from '../../../../messages/en/sales-reports.json'
import it_ from '../../../../messages/it/sales-reports.json'
import { speedCan, speedTiles, tileHref } from '../quotes/speed/model'
import { BACKLOG_GROUPS, BACKLOG_HORIZONS, BACKLOG_WEEK_KINDS, FEES_KEY, INTAKE_BUCKETS, INTAKE_SPLITS, NO_KEY, RETURN_GROUPS } from './api'
import { BACKLOG, INTAKE, RETURNS, SALES } from './fixtures'
import {
  backlogChartRows,
  backlogRowsOf,
  elapsed,
  groupName,
  intakeChartRows,
  intakeMeasure,
  intakeRowsOf,
  listHref,
  neighbourOf,
  OTHERS,
  printAddress,
  reportsAddressOf,
  reportsAddressText,
  reportsCan,
  reportsHref,
  returnRowsOf,
  stackParts,
  valueText,
  workingTime,
} from './model'

const leaf = (tree: object, path: string): unknown => path.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree)

describe('Sales reports — the lists mirror the domain', () => {
  it('buckets, splits, backlog groups, horizons, week kinds, return groups and the keys that are no record', () => {
    expect([...INTAKE_BUCKETS]).toEqual([...DOMAIN_BUCKETS])
    expect([...INTAKE_SPLITS]).toEqual([...DOMAIN_SPLITS])
    expect([...BACKLOG_GROUPS]).toEqual([...DOMAIN_BACKLOG])
    expect([...BACKLOG_HORIZONS]).toEqual([...DOMAIN_HORIZONS])
    expect([...BACKLOG_WEEK_KINDS]).toEqual([...DOMAIN_WEEKS])
    expect([...RETURN_GROUPS]).toEqual([...DOMAIN_RETURNS])
    expect([NO_KEY, FEES_KEY]).toEqual([DOMAIN_NO_KEY, DOMAIN_FEES])
  })

  it('has the same words in Italian and English, a word for every code the page shows', () => {
    const keys = (tree: object, prefix = ''): string[] => Object.entries(tree).flatMap(([name, value]) => (typeof value === 'string' ? [`${prefix}${name}`] : keys(value as object, `${prefix}${name}.`)))
    expect(keys(it_).sort()).toEqual(keys(en).sort())
    for (const code of [...INTAKE_BUCKETS.map((by) => `intake.byOption.${by}`), ...INTAKE_SPLITS.map((split) => `intake.splitOption.${split}`), ...INTAKE_SPLITS.map((split) => `intake.none.${split}`), ...BACKLOG_HORIZONS.map((horizon) => `backlog.horizon.${horizon}`), ...BACKLOG_GROUPS.map((by) => `backlog.byOption.${by}`)]) {
      expect(typeof leaf(en, code), code).toBe('string')
    }
  })
})

describe('Sales reports — rights and the address', () => {
  it('reads the rights from the session; the address round-trips and drops unknown values', () => {
    expect(reportsCan(SALES)).toEqual({ view: true, orders: true, quotes: true, returns: true, price: true })
    expect(reportsCan(['sales.reports.view'])).toMatchObject({ view: true, orders: false, price: false })
    const address = reportsAddressOf(new URLSearchParams('from=2026-10-01&to=2026-10-31&by=month&split=style&backlog=style&also=size'))
    expect(address).toEqual({ from: '2026-10-01', to: '2026-10-31', by: 'month', split: 'style', backlog: 'style', also: 'size' })
    expect(reportsAddressText(address)).toBe('?from=2026-10-01&to=2026-10-31&by=month&split=style&backlog=style&also=size')
    expect(reportsAddressOf(new URLSearchParams('by=year&split=colour&from=11/2026'))).toEqual({ from: null, to: null, by: 'week', split: 'none', backlog: 'customer', also: 'style' })
    expect(printAddress('/w/DEMO', address, { from: '2026-10-01', to: '2026-10-31' })).toBe('/w/DEMO/sales/reports/print?from=2026-10-01&to=2026-10-31&by=month&split=style&backlog=style&also=size')
    expect(reportsHref('/w/DEMO', { from: '2026-11-01', to: '2026-11-12' })).toBe('/w/DEMO/sales/reports?from=2026-11-01&to=2026-11-12')
  })
})

describe('Sales reports — words and charts', () => {
  it('amounts per currency, never added; working time and elapsed time', () => {
    expect(valueText({ byCurrency: [{ currency: 'EUR', value: 123_450 }], value: 123_450, currency: 'EUR', mixedCurrencies: false }, 'en')).toBe('€1,234.50')
    expect(valueText({ byCurrency: [{ currency: 'EUR', value: 100 }, { currency: 'CHF', value: 200 }], value: null, currency: null, mixedCurrencies: true }, 'en')).toContain(' · ')
    expect(valueText({ byCurrency: [], currency: 'EUR', mixedCurrencies: false }, 'en')).toBe('—')
    expect(workingTime(45, 'en')).toEqual({ unit: 'minutes', value: '45' })
    expect(workingTime(380, 'it')).toEqual({ unit: 'hours', value: '6,3' })
    expect(workingTime(1440, 'en')).toEqual({ unit: 'days', value: '3.0' })
    expect(elapsed(20, 'en')).toEqual({ unit: 'hours', value: '20' })
    expect(elapsed(70, 'en')).toEqual({ unit: 'days', value: '2.9' })
    expect(groupName({ key: 'fees', code: null, name: null }, { none: 'None', fees: 'Fees' })).toBe('Fees')
    expect(groupName({ key: 'x', code: 'C1', name: 'Demo' }, { none: 'None', fees: 'Fees' })).toBe('C1 · Demo')
  })

  it('the intake chart: the value with the price grain, pieces without; a stack of the largest groups and Others', () => {
    expect(intakeMeasure(INTAKE)).toBe('value')
    expect(intakeMeasure({ ...INTAKE, sight: { ...INTAKE.sight, values: false } })).toBe('pieces')
    const rows = intakeChartRows(INTAKE, [], 'pieces', 'en')
    expect(rows.map((row) => [row.bucket, row.total, row.orders])).toEqual([
      ['W44', 40, 1],
      ['W45', 302, 3],
      ['W46', 224, 3],
    ])
    const many = { ...INTAKE, split: 'customer' as const, groups: Array.from({ length: 7 }, (_, index) => ({ key: `g${index}`, code: `G${index}`, name: null, figures: INTAKE.all, buckets: INTAKE.buckets.map((bucket) => ({ key: bucket.key, figures: { ...bucket.figures, pieces: 1 } })) })) }
    const parts = stackParts(many, (group) => group.code ?? '', 'Others')
    expect(parts.map((part) => part.key)).toEqual(['g0', 'g1', 'g2', 'g3', 'g4', OTHERS])
    const stacked = intakeChartRows(many, parts, 'pieces', 'en')
    expect(stacked[1]).toMatchObject({ g0: 1, g4: 1, [OTHERS]: 302 - 5 })
  })

  it('the backlog chart: late and due pieces per week', () => {
    const rows = backlogChartRows(BACKLOG, { earlier: 'E', later: 'L', none: 'N' })
    expect(rows[0]).toMatchObject({ week: 'W44', late: 30, due: 0 })
    expect(rows.find((row) => row.week === 'W46')).toMatchObject({ late: 25, due: 60 })
    expect(rows.at(-1)).toMatchObject({ week: 'N', late: 0, due: 1 })
  })
})

describe('Sales reports — what a number counts', () => {
  it('the orders of a bucket or a group; the open sizes of a week, a group, a horizon; the return lines of a reason or a cell', () => {
    expect(intakeRowsOf(INTAKE, { section: 'intake', bucket: '2026-W46', group: null }).map((order) => order.number)).toEqual(['DEMO-SO-0409', 'DEMO-SO-0408', 'DEMO-SO-0407'])
    const byStyle = { ...INTAKE, split: 'style' as const }
    expect(intakeRowsOf(byStyle, { section: 'intake', bucket: null, group: INTAKE.orders[0]!.styles[0]!.key })).toHaveLength(3)
    expect(backlogRowsOf(BACKLOG, { section: 'backlog', week: '2026-W46', group: null, horizon: null }).map((line) => line.open)).toEqual([25, 60])
    const c1 = BACKLOG.groups.find((group) => group.code === 'DEMO-C1')!
    expect(backlogRowsOf(BACKLOG, { section: 'backlog', week: null, group: c1.key, horizon: 'late' }).map((line) => line.open)).toEqual([40])
    expect(returnRowsOf(RETURNS, { section: 'returns', by: 'reason', key: 'WRONG_SIZE' }).map((line) => line.pieces)).toEqual([3, 2, 5])
    const style = RETURNS.heatmap.styles[0]!
    expect(returnRowsOf(RETURNS, { section: 'returns', by: 'style', key: style.key, size: '54' }).map((line) => line.pieces)).toEqual([5])
    const colour = RETURNS.colours.find((group) => group.key !== 'none')!
    expect(returnRowsOf(RETURNS, { section: 'returns', by: 'colour', key: colour.key }).length).toBe(colour.figures.lines)
    // B-W2b-380 (XF6:06): a reason group opens the lines of its reasons; the reasons without a group are `none`.
    for (const group of RETURNS.reasonGroups) expect(returnRowsOf(RETURNS, { section: 'returns', by: 'group', key: group.key }).length, group.key).toBe(group.figures.lines)
    expect(returnRowsOf(RETURNS, { section: 'returns', by: 'group', key: 'Taglia' }).every((line) => line.reason === 'WRONG_SIZE')).toBe(true)
    expect(RETURNS.reasonGroups.find((group) => group.key === 'none')?.reasons).toEqual(['DAMAGED_IN_TRANSIT'])
  })

  it('J / K step through buckets and weeks; the list a dialog opens says what it can', () => {
    const keys = INTAKE.buckets.map((bucket) => bucket.key)
    expect(neighbourOf({ section: 'intake', bucket: '2026-W45', group: null }, keys, 1)).toEqual({ section: 'intake', bucket: '2026-W46', group: null })
    expect(neighbourOf({ section: 'intake', bucket: '2026-W46', group: null }, keys, 1)).toBeNull()
    expect(neighbourOf({ section: 'intake', bucket: null, group: 'x' }, keys, 1)).toBeNull()
    expect(neighbourOf({ section: 'returns', by: 'reason', key: 'DEFECT' }, [], 1)).toBeNull()
    expect(listHref('/w/DEMO', { section: 'backlog', week: null, group: null, horizon: null }, null)).toBe('/w/DEMO/sales/orders')
    expect(listHref('/w/DEMO', { section: 'returns', by: null, key: null }, null)).toBe('/w/DEMO/sales/returns?view=all')
  })

  // B-TH-201 (SHEET-G11): "Open the list" opens that customer's orders — the customer's id as `?party=`, never its code as a
  // search (the lists search numbers and PO numbers only: a code found nothing).
  it('opens one customer’s Orders and Returns by ?party=<id>, never q=<code>; "no customer" narrows nothing', () => {
    const id = '0190a1b2-0000-7000-8000-00000000000a'
    expect(listHref('/w/DEMO', { section: 'intake', bucket: null, group: id }, id)).toBe(`/w/DEMO/sales/orders?rows=all&party=${id}`)
    expect(listHref('/w/DEMO', { section: 'backlog', week: null, group: id, horizon: null }, id)).toBe(`/w/DEMO/sales/orders?party=${id}`)
    expect(listHref('/w/DEMO', { section: 'returns', by: 'customer', key: id }, id)).toBe(`/w/DEMO/sales/returns?view=all&party=${id}`)
    expect(listHref('/w/DEMO', { section: 'intake', bucket: null, group: 'none' }, 'none')).toBe('/w/DEMO/sales/orders?rows=all')
    for (const target of [{ section: 'intake', bucket: null, group: id }, { section: 'backlog', week: null, group: id, horizon: null }, { section: 'returns', by: 'customer', key: id }] as const) expect(listHref('/w/DEMO', target, id)).not.toMatch(/[?&]q=/)
  })
})

describe('Quote speed', () => {
  const answer = { company: null, from: '2026-11-01', to: '2026-11-12', today: '2026-11-12', asOf: '2026-11-12T08:00:00.000Z', sight: { orders: true, quotes: true, returns: true, values: true }, companyCurrency: 'EUR', answered: 9, medianAnswerMinutes: 380, fromInquiries: 4, accepted: 5, declined: 3, expired: 1, winRatePct: '62.5', medianDecisionHours: 70, won: { byCurrency: [{ currency: 'EUR', value: 100_000 }], value: 100_000, currency: 'EUR', mixedCurrencies: false }, complete: true }

  it('four tiles with the price grain, three without; each opens Sales reports only with that right', () => {
    const can = speedCan(SALES)
    expect(can).toEqual({ quotes: true, reports: true, price: true })
    const tiles = speedTiles(answer, can, 'en')
    expect(tiles.map((tile) => tile.key)).toEqual(['answer', 'decision', 'winRate', 'won'])
    expect(tiles[0]!.value).toEqual({ key: 'time.hours', params: { value: '6.3' } })
    expect(tiles[1]!.value).toEqual({ key: 'time.daysElapsed', params: { value: '2.9' } })
    expect(tiles[2]!.hint).toEqual({ key: 'speed.winHint', params: { accepted: 5, decided: 8, expired: 1 } })
    expect(speedTiles({ ...answer, sight: { ...answer.sight, values: false } }, can, 'en').map((tile) => tile.key)).not.toContain('won')
    expect(tileHref('/w/DEMO', can, answer)).toBe('/w/DEMO/sales/reports?from=2026-11-01&to=2026-11-12')
    expect(tileHref('/w/DEMO', speedCan(['quotes.view']), answer)).toBeNull()
    for (const tile of tiles) expect(typeof leaf(en, `speed.tile.${tile.key}`), tile.key).toBe('string')
  })
})

// ---- B-TH-235 (threads plan X-SAL-REPORTS.drill, L2-G10; Owner rule "every total opens its rows"): the request figure ----------
describe('B-TH-235 requests received, quoted and ordered — every number a door to Sales › Incoming', () => {
  const render = (id: string, locale: 'it' | 'en' = 'en') => {
    const entry = (designScreen as unknown as DesignScreen<unknown>).cases.find((item) => item.id === id)!
    return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'sales-reports', 'warehouse-reports']) }, createElement((designScreen as unknown as DesignScreen<unknown>).view, { model: entry.model })))
  }
  // The figure's doors only (the shell's navigation may link Incoming too): each names requests.
  const doors = (html: string): string[] => [...html.matchAll(/href="([^"]*\/sales\/incoming[^"]*)"/g)].map((match) => match[1]!.replace(/&amp;/g, '&')).filter((href) => href.includes('kind=REQUEST'))

  it('its parts are the API’s, in the funnel’s order; the prospects’ key is the domain’s', () => {
    expect([...REQUEST_FIGURES].sort()).toEqual(Object.keys(requestFiguresOf([])).filter((key) => !key.endsWith('Pct')).sort())
    expect(PROSPECTS_KEY).toBe(DOMAIN_PROSPECTS)
    expect(REQUEST_FIGURES[0]).toBe('received')
  })

  it('each figure opens Incoming with its tile or what the request became, the days and the customer — and Incoming reads exactly that', () => {
    const company = 'c0c0c0c0-0000-4000-8000-000000000001'
    const period = { company, from: '2026-11-01', to: '2026-11-12', group: null }
    expect(requestsDoor('/w/DEMO', 'received', period)).toBe(`/w/DEMO/sales/incoming?tile=ALL&company=${company}&from=2026-11-01&to=2026-11-12&kind=REQUEST`)
    expect(requestsDoor('/w/DEMO', 'open', { ...period, company: null })).toBe('/w/DEMO/sales/incoming?from=2026-11-01&to=2026-11-12&kind=REQUEST')
    expect(requestsDoor('/w/DEMO', 'ordered', { ...period, group: 'c1c1c1c1-0000-4000-8000-000000000001' })).toBe(`/w/DEMO/sales/incoming?tile=ALL&company=${company}&party=c1c1c1c1-0000-4000-8000-000000000001&from=2026-11-01&to=2026-11-12&outcome=ORDERED&kind=REQUEST`)
    expect(requestsDoor('/w/DEMO', 'notAnOrder', { ...period, group: PROSPECTS_KEY })).toBe(`/w/DEMO/sales/incoming?tile=ALL&company=${company}&prospect=1&from=2026-11-01&to=2026-11-12&outcome=NOT_AN_ORDER&kind=REQUEST`)
    for (const figure of REQUEST_FIGURES) {
      const href = requestsDoor('/w/DEMO', figure, { company, from: '2026-11-09', to: '2026-11-15', group: 'c1c1c1c1-0000-4000-8000-000000000001' })
      const address = incomingAddressOf(new URLSearchParams(href.split('?')[1]))
      // The list's own reading of the address: the door's tile, outcome, company, days and customer — the query the figure counts.
      expect(incomingQueryOf(address), figure).toMatchObject({ tile: REQUEST_DOORS[figure].tile, outcome: REQUEST_DOORS[figure].outcome, companyId: company, receivedFrom: '2026-11-09', receivedTo: '2026-11-15', partyId: 'c1c1c1c1-0000-4000-8000-000000000001', prospect: false })
    }
    // The doors' table is the one the API test holds equal to the figure (request-funnel.pg: the same seven doors).
    expect(Object.fromEntries(REQUEST_FIGURES.map((figure) => [figure, [REQUEST_DOORS[figure].tile, REQUEST_DOORS[figure].outcome]]))).toEqual({
      received: ['ALL', null],
      quoted: ['QUOTED', null],
      ordered: ['ALL', 'ORDERED'],
      declined: ['ALL', 'DECLINED'],
      lost: ['LOST', null],
      notAnOrder: ['ALL', 'NOT_AN_ORDER'],
      open: ['OPEN', null],
    })
  })

  it('on screen every number above 0 is a real link into Incoming (tiles, weeks, customers); a 0 opens nothing', () => {
    const html = render('th-235-requests')
    const links = doors(html)
    const nonZero = (figures: RequestFiguresRow) => REQUEST_FIGURES.filter((figure) => figures[figure] > 0).length
    const tiles = nonZero(REQUESTS.all!)
    const weeks = REQUESTS.buckets.reduce((sum, bucket) => sum + (['received', 'quoted', 'ordered'] as const).filter((figure) => bucket.figures[figure] > 0).length, 0)
    const customers = REQUESTS.groups.reduce((sum, group) => sum + nonZero(group.figures), 0)
    expect(links).toHaveLength(tiles + weeks + customers)
    expect(links.every((href) => href.startsWith('/w/') && href.endsWith('kind=REQUEST'))).toBe(true)
    expect(links).toContain(requestsDoor(links[0]!.split('/sales/')[0]!, 'ordered', { company: REQUESTS.company?.id ?? null, from: REQUESTS.from, to: REQUESTS.to, group: null }))
    // Every door names the company the figure was counted for (Incoming lists every company the person reaches).
    expect(links.every((href) => href.includes(`company=${REQUESTS.company!.id}`))).toBe(true)
    expect(links.filter((href) => href.includes('prospect=1')).length).toBe(nonZero(REQUESTS.groups.find((group) => group.key === PROSPECTS_KEY)!.figures))
    for (const words of ['Requests received, quoted and ordered', 'Not an order', 'Prospects (not customers yet)', 'Order rate']) expect(html).toContain(words)
    expect(render('th-235-requests', 'it')).toContain('Richieste arrivate, preventivate e ordinate')
  })

  it('W27/W30: a person limited to one customer sees that customer and the prospects only; without the requests’ right it says so, never 0', () => {
    // The request figure's own block (the backlog panel beside it names every customer the backlog holds).
    const block = (html: string) => {
      const start = html.indexOf('class="fw-slr-requests"')
      return start < 0 ? '' : html.slice(start, html.indexOf('</section>', start))
    }
    const limited = block(render('th-235-limited'))
    const [first, second, third] = REQUESTS.groups
    expect(limited).toContain(first!.name!)
    expect(limited).toContain('Prospects (not customers yet)')
    for (const other of [second!, third!]) {
      expect(limited).not.toContain(other.name!)
      expect(limited).not.toContain(other.code!)
      expect(limited).not.toContain(other.key)
    }
    const outside = render('th-235-outside')
    expect(outside).toContain('Requests are not in your role')
    expect(doors(outside)).toEqual([])
    expect(render('th-235-empty')).toContain('No request came in this period')
    expect(render('th-235-failed')).toContain('The request figure could not be read.')
    // Orders outside the role: the intake says so, the request figure still opens Incoming.
    const ordersOutside = render('th-235-orders-outside')
    expect(ordersOutside).toContain('Orders are not in your role')
    expect(doors(ordersOutside).length).toBeGreaterThan(0)
  })

  it('the file holds the buckets then the customers, as on screen; requests refresh live', () => {
    const rows = requestsCsvRows(REQUESTS, { bucket: (bucket) => bucket.key, group: (group) => requestGroupName(group, 'Prospects') })
    expect(rows).toHaveLength(REQUESTS.buckets.length + REQUESTS.groups.length)
    expect(rows[REQUESTS.buckets.length]).toEqual(['', `${REQUESTS.groups[0]!.code} · ${REQUESTS.groups[0]!.name}`, ...REQUEST_FIGURES.map((figure) => REQUESTS.groups[0]!.figures[figure]), REQUESTS.groups[0]!.figures.quotedPct, REQUESTS.groups[0]!.figures.orderedPct])
    expect(requestGroupName(REQUESTS.groups.at(-1)!, 'Prospects')).toBe('Prospects')
    expect(LIVE_TYPES).toContain('inquiry.')
  })
})
// ---- end B-TH-235
