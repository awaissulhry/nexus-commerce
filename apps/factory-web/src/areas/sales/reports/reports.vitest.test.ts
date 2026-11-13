import { describe, expect, it } from 'vitest'
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
  })

  it('J / K step through buckets and weeks; the list a dialog opens says what it can', () => {
    const keys = INTAKE.buckets.map((bucket) => bucket.key)
    expect(neighbourOf({ section: 'intake', bucket: '2026-W45', group: null }, keys, 1)).toEqual({ section: 'intake', bucket: '2026-W46', group: null })
    expect(neighbourOf({ section: 'intake', bucket: '2026-W46', group: null }, keys, 1)).toBeNull()
    expect(neighbourOf({ section: 'intake', bucket: null, group: 'x' }, keys, 1)).toBeNull()
    expect(neighbourOf({ section: 'returns', by: 'reason', key: 'DEFECT' }, [], 1)).toBeNull()
    expect(listHref('/w/DEMO', { section: 'intake', bucket: null, group: 'c' }, 'DEMO-C1')).toBe('/w/DEMO/sales/orders?rows=all&q=DEMO-C1')
    expect(listHref('/w/DEMO', { section: 'backlog', week: null, group: null, horizon: null }, null)).toBe('/w/DEMO/sales/orders')
    expect(listHref('/w/DEMO', { section: 'returns', by: null, key: null }, null)).toBe('/w/DEMO/sales/returns?view=all')
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
