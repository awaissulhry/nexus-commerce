import { describe, expect, it } from 'vitest'
import { HEAT_BANDS as DOMAIN_BANDS } from '@nexus/factory-domain/planning/heatmap/bands'
import { ADHERENCE_STATES as DOMAIN_STATES, COVER_STATES as DOMAIN_COVER, LANE_KINDS as DOMAIN_LANES } from '@nexus/factory-domain/planning/reports/rules'
import en from '../../../../messages/en/planning-reports.json'
import it_ from '../../../../messages/it/planning-reports.json'
import { ADHERENCE_STATES, COVER_STATES, HEAT_BANDS, LANE_KINDS } from './api'
import { ADHERENCE, COVER, COVER_ROWS, PLANNER, PLANNER_NO_BUY, UTILISATION } from './fixtures'
import {
  adherenceChartRows,
  adherenceCsvRows,
  cellWords,
  chosenLane,
  coverCsvRows,
  draftOf,
  figuresOf,
  laneKeyOf,
  laneLabel,
  neighbourOf,
  pctText,
  pointOf,
  printAddress,
  reportsAddressOf,
  reportsAddressText,
  reportsCan,
  signedDays,
  utilisationChartRows,
  weekLabel,
} from './model'

describe('Planning reports — the lists mirror the domain', () => {
  it('adherence states, lane kinds, cover states and heat bands', () => {
    expect([...ADHERENCE_STATES]).toEqual([...DOMAIN_STATES])
    expect([...LANE_KINDS]).toEqual([...DOMAIN_LANES])
    expect([...COVER_STATES]).toEqual([...DOMAIN_COVER])
    expect([...HEAT_BANDS]).toEqual([...DOMAIN_BANDS])
  })

  it('has the same words in Italian and English', () => {
    const keys = (tree: object, prefix = ''): string[] => Object.entries(tree).flatMap(([name, value]) => (typeof value === 'string' ? [`${prefix}${name}`] : keys(value as object, `${prefix}${name}.`)))
    expect(keys(it_).sort()).toEqual(keys(en).sort())
  })
})

describe('rights and the address', () => {
  it('reads the page, the plan and Draft PO from the session', () => {
    expect(reportsCan(PLANNER)).toEqual({ view: true, plans: true, draft: true })
    expect(reportsCan(PLANNER_NO_BUY)).toMatchObject({ view: true, plans: true, draft: false })
    expect(reportsCan(['home.view'])).toMatchObject({ view: false })
  })

  it('keeps the period, the lane, the weeks ahead and the horizon in the address; unknown words fall back', () => {
    const lane = 'LINE:0190f0e2-3491-7000-8000-000000000001'
    expect(reportsAddressOf(new URLSearchParams(`from=2026-10-01&to=2026-10-31&lane=${lane}&ahead=8&weeks=26`))).toEqual({ from: '2026-10-01', to: '2026-10-31', lane, ahead: 8, weeks: 26 })
    expect(reportsAddressOf(new URLSearchParams('from=yesterday&lane=BOARD&ahead=5&weeks=99'))).toEqual({ from: null, to: null, lane: null, ahead: 4, weeks: 13 })
    expect(reportsAddressText({ from: '2026-10-01', to: null, lane: 'PLANT', ahead: 4, weeks: 13 })).toBe('?from=2026-10-01')
    expect(printAddress('/w/DEMO', reportsAddressOf(new URLSearchParams('ahead=0')), { from: '2026-11-01', to: '2026-11-12' })).toBe('/w/DEMO/planning/reports/print?from=2026-11-01&to=2026-11-12&ahead=0')
  })
})

describe('schedule adherence', () => {
  it('picks a line and a week, and draws % on time only for weeks with something measured', () => {
    expect(figuresOf(ADHERENCE, null, null)).toBe(ADHERENCE.all)
    expect(figuresOf(ADHERENCE, ADHERENCE.lines[1]!.line!.id, '2026-W46')).toMatchObject({ onTime: 1, late: 1 })
    expect(figuresOf(ADHERENCE, 'none', null)).toMatchObject({ notPlanned: 1, planned: 0 })
    const rows = adherenceChartRows(ADHERENCE, null)
    expect(rows.map((row) => [row.week, row.finished, row.onTime])).toEqual([
      ['W44', 0, undefined],
      ['W45', 8, 71.4],
      ['W46', 4, 75],
    ])
    const words = { cell: (onTime: number, planned: number) => `${onTime}/${planned}`, none: '—', unplanned: (count: number) => `${count} none` }
    expect(cellWords(ADHERENCE.all, words)).toBe('8/11')
    expect(cellWords(figuresOf(ADHERENCE, 'none', null), words)).toBe('1 none')
    expect(cellWords(figuresOf(ADHERENCE, null, '2026-W44'), words)).toBe('—')
  })

  it('writes the lines’ week cells, each line and the total to a file', () => {
    const rows = adherenceCsvRows(ADHERENCE, { line: (line) => line?.code ?? 'none', all: 'All' })
    expect(rows.at(-1)).toEqual(['All', '', 12, 11, 8, 3, 1, '72.7', '0.5', '0.5'])
    expect(rows[0]).toEqual(['L1', '2026-W45', 4, 4, 3, 1, 0, '75.0', '0.3', '0.5'])
  })
})

describe('the utilisation trend', () => {
  it('shows the plant by default, a lane by its key; utilisation as a line, load as bars', () => {
    expect(chosenLane(UTILISATION, null)!.kind).toBe('PLANT')
    const line = UTILISATION.lanes[1]!
    expect(chosenLane(UTILISATION, laneKeyOf(line))).toBe(line)
    expect(laneKeyOf(UTILISATION.lanes[4]!)).toBe(`WORKSHOP:${UTILISATION.lanes[4]!.id}:SEWING`)
    const rows = utilisationChartRows(UTILISATION, line)
    expect(rows[1]).toEqual({ week: 'W45', utilisation: 70.8 })
    expect(rows[2]).toEqual({ week: 'W46', utilisation: 60.6, load: 94.4 })
    expect(rows[3]).toEqual({ week: 'W47', load: 111.3 })
    expect(laneLabel(UTILISATION.lanes[0]!, { plant: 'Plant', kind: (kind) => kind })).toBe('Plant')
    expect(laneLabel(UTILISATION.lanes[4]!, { plant: 'Plant', kind: (kind) => kind.toLowerCase() })).toBe('DEMO-TER-01 · Laboratorio Demo Esterno (sewing)')
  })

  it('steps the drill week by week (J / K) and names its lane in the API’s terms', () => {
    const weeks = UTILISATION.weeks.map((week) => week.key)
    expect(neighbourOf({ section: 'utilisation', laneKey: 'PLANT', week: '2026-W46' }, weeks, 1)).toEqual({ section: 'utilisation', laneKey: 'PLANT', week: '2026-W47' })
    expect(neighbourOf({ section: 'utilisation', laneKey: 'PLANT', week: '2026-W44' }, weeks, -1)).toBeNull()
    expect(neighbourOf({ section: 'adherence', lineKey: null, week: null }, weeks, 1)).toBeNull()
    expect(pointOf('PLANT')).toEqual({ laneKind: 'PLANT', laneId: null })
    expect(pointOf('LINE:abc')).toEqual({ laneKind: 'LINE', laneId: 'abc' })
    expect(pointOf('WORKSHOP:abc:SEWING')).toBeNull()
  })
})

describe('material cover', () => {
  it('drafts a PO on What to buy & make, held with its reason', () => {
    const can = { draft: true }
    expect(draftOf('/w/DEMO', 'site-1', COVER_ROWS[0]!, can)).toEqual({ href: '/w/DEMO/planning/mrp?view=toBuy&q=DEMO-PEL-NERO&site=site-1', held: null })
    expect(draftOf('/w/DEMO', 'site-1', COVER_ROWS[0]!, { draft: false }).held).toBe('draft.heldRight')
    expect(draftOf('/w/DEMO', 'site-1', COVER_ROWS[2]!, can).held).toBe('draft.heldMake')
    expect(draftOf('/w/DEMO', 'site-1', COVER_ROWS[3]!, can).held).toBe('draft.heldNothing')
  })

  it('writes the materials to a file', () => {
    expect(coverCsvRows(COVER.rows, { state: (state) => state })[0]).toEqual(['DEMO-PEL-NERO', 'Pelle bovina Demo nera', 'Nero', 'FT2', '51.8000', null, '553.2800', '315.0000', 0, '2026-11-12', null, 'SHORT_NOW', 1, '315.0000', '2026-11-24'])
  })
})

describe('words', () => {
  it('says percents, signed days and weeks in the page’s language', () => {
    expect(pctText('87.5', 'it')).toBe('87,5 %')
    expect(pctText(null, 'en')).toBe('—')
    expect(signedDays('1.5', 'it')).toBe('+1,5')
    expect(signedDays(-2, 'en')).toBe('−2')
    expect(signedDays('0.0', 'en')).toBe('0')
    expect(weekLabel({ key: '2026-W47', from: '2026-11-16', to: '2026-11-22' }, 'en')).toBe('W47 · 16 Nov – 22 Nov')
  })
})
