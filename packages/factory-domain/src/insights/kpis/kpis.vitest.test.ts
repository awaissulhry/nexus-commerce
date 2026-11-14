import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { templateOf } from '../../auth/roles/templates'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { Dec } from '../../tax/decimal'
import { applyCalc, measuresOfCalc } from './calc'
import { defineKpi, grainsOfKpi, kpiFileProblems, permissionsOfKpi, type KpiFile } from './catalogue'
import { activationProblems, draftProblems, kpiUseKey } from './checks'
import { MEASURES, measureOf } from './measures'
import { dailyReport, type DailyFacts } from '../../production/reports/daily'
import { factsOfHour } from './hours'
import { databaseKpiRefusal } from './refusals'
import { kpiReaders, usesPlan } from './readers'
import { catalogueProblems, KPI_CATALOGUE, kpiFileOf } from './registry'

const DEFS = fileURLToPath(new URL('./defs', import.meta.url))
const sums = (entries: Record<string, string | null>) => new Map(Object.entries(entries).map(([key, value]) => [key, value === null ? null : new Dec(value)]))

describe('the KPI catalogue in code (ANA-012, ANA-070)', () => {
  it('is sound: one file per KPI named by its key, every measure built, unit and grain as the calculation reads', () => {
    expect(catalogueProblems()).toEqual([])
    const files = readdirSync(DEFS).filter((name) => name.endsWith('.ts') && name !== 'index.ts' && !name.includes('.vitest.'))
    expect(files.map((name) => name.replace(/\.ts$/, '')).sort()).toEqual(KPI_CATALOGUE.map((file) => file.key).sort())
    for (const file of KPI_CATALOGUE) for (const key of measuresOfCalc(file.calc)) expect(measureOf(key), `${file.key} reads ${key}`).not.toBeNull()
    for (const file of KPI_CATALOGUE) expect(templateOf(file.ownerRole)?.audience, `${file.key} owner ${file.ownerRole}`).toBe('office')
  })

  it('never measures a person, and money stays marked by grain', () => {
    for (const measure of MEASURES) {
      expect(measure.key).not.toMatch(/worker|operator|person|employee|user/)
      expect(measure.unit === 'MONEY').toBe(measure.grain !== null)
    }
    expect(grainsOfKpi(kpiFileOf('sales.order_margin')!)).toEqual(['margin', 'price'])
    expect(permissionsOfKpi(kpiFileOf('sales.order_margin')!)).toEqual(['costing.view'])
    expect(grainsOfKpi(kpiFileOf('production.scrap_rate')!)).toEqual([])
  })

  it('refuses a bad file at import', () => {
    const base = kpiFileOf('sales.orders_in')!
    expect(() => defineKpi({ ...base, grain: null })).toThrow(/MONEY KPI names its grain/)
    expect(kpiFileProblems({ ...base, calc: { kind: 'SUM', measure: 'orders.nope' } } as KpiFile)).toContain('sales.orders_in: measure orders.nope is not in the measure registry')
    expect(kpiFileProblems({ ...kpiFileOf('production.scrap_rate')!, unit: 'COUNT' })).toContain('production.scrap_rate: a RATIO is a PERCENT, a RATIO or an average in DAYS, HOURS or MINUTES')
    expect(kpiFileProblems({ ...kpiFileOf('sales.order_margin')!, grain: null })).toContain('sales.order_margin: a KPI that reads margin names the MARGIN grain')
    expect(catalogueProblems([base, base])).toContain('sales.orders_in: two files')
  })
})

describe('one calculation (ANA-070)', () => {
  it('sums, reads a balance and makes a ratio rounded half up; unknown sums and a zero denominator give no value', () => {
    expect(applyCalc({ kind: 'SUM', measure: 'orders.value' }, sums({ 'orders.value': '1250000' }))).toBe('1250000')
    expect(applyCalc({ kind: 'BALANCE', measure: 'wip.cost' }, sums({ 'wip.cost': '2400000' }))).toBe('2400000')
    const scrap = kpiFileOf('production.scrap_rate')!.calc
    expect(applyCalc(scrap, sums({ 'production.scrap_pieces': '3', 'production.output_pieces': '397' }))).toBe('0.8')
    expect(applyCalc(scrap, sums({ 'production.scrap_pieces': '1', 'production.output_pieces': '7' }))).toBe('12.5')
    expect(applyCalc(scrap, sums({ 'production.scrap_pieces': '0', 'production.output_pieces': '0' }))).toBeNull()
    expect(applyCalc({ kind: 'SUM', measure: 'orders.value' }, sums({ 'orders.value': null }))).toBeNull()
    expect(applyCalc(kpiFileOf('delivery.shipped_on_time')!.calc, sums({ 'shipments.on_time': '2', 'shipments.shipped': '3' }))).toBe('66.7')
  })
})

describe('the floor per hour (ANA-069)', () => {
  it('counts each hour with the daily report’s calculation: a correction with its report, a rework in its hour; the hours add up to the day', () => {
    const at = (iso: string) => new Date(iso)
    const facts: DailyFacts = {
      day: '2026-11-12',
      timeZone: 'Europe/Rome',
      scans: [
        { id: 's1', kind: 'REPORT', correctsId: null, bundleId: 'b1', workOrderId: 'w1', operationId: 'o2', good: 5, scrap: 0, rework: 0, stationId: 'st1', at: at('2026-11-12T07:10:00Z') },
        { id: 's2', kind: 'REPORT', correctsId: null, bundleId: 'b1', workOrderId: 'w1', operationId: 'o2', good: 3, scrap: 1, rework: 0, stationId: 'st1', at: at('2026-11-12T09:20:00Z') },
        // A correction at 11:05 of the 08:10 report: it counts in the report's hour.
        { id: 's3', kind: 'CORRECTION', correctsId: 's1', bundleId: 'b1', workOrderId: 'w1', operationId: 'o2', good: 4, scrap: 0, rework: 0, stationId: 'st1', at: at('2026-11-12T10:05:00Z') },
        // An earlier operation: scrap only counts there.
        { id: 's4', kind: 'REPORT', correctsId: null, bundleId: 'b1', workOrderId: 'w1', operationId: 'o1', good: 9, scrap: 2, rework: 0, stationId: 'st1', at: at('2026-11-12T07:40:00Z') },
      ],
      bundles: new Map([['b1', { part: null, status: 'ACTIVE', workOrderSizeId: 'c1' }]]),
      operations: new Map([
        ['o1', { workOrderId: 'w1', seq: 10, scanRequired: true, workCentreId: 'wc1', standardMinutes: '1.0' }],
        ['o2', { workOrderId: 'w1', seq: 20, scanRequired: true, workCentreId: 'wc1', standardMinutes: '2.0' }],
      ]),
      workOrders: new Map([['w1', { styleId: 'y1' }]]),
      sizes: new Map([['c1', 'M']]),
      stationLanes: new Map([['st1', { kind: 'LINE', id: 'l1' }]]),
      laneCentres: new Map([['LINE:l1', new Set(['wc1'])]]),
      extras: [{ lane: { kind: 'LINE', id: 'l1' }, workOrderId: 'w1', workOrderSizeId: 'c1', scrap: 2, rework: 0, at: at('2026-11-12T13:30:00Z') }],
      available: new Map([['l1', { people: 4, workingMinutes: 480 }]]),
    }
    const day = dailyReport(facts)
    expect(day.totals).toMatchObject({ good: 7, scrap: 5 })
    const hours = Array.from({ length: 24 }, (_, index) => new Date(Date.parse('2026-11-11T23:00:00Z') + index * 3_600_000))
    const reports = hours.map((start) => ({ start: start.toISOString(), totals: dailyReport(factsOfHour(facts, start, new Date(start.getTime() + 3_600_000))).totals }))
    expect(reports.filter((hour) => hour.totals.good + hour.totals.scrap > 0).map((hour) => [hour.start.slice(11, 16), hour.totals.good, hour.totals.scrap])).toEqual([
      ['07:00', 4, 2],
      ['09:00', 3, 1],
      ['13:00', 0, 2],
    ])
    expect(reports.reduce((total, hour) => total + hour.totals.good, 0)).toBe(day.totals.good)
    expect(reports.reduce((total, hour) => total + hour.totals.scrap, 0)).toBe(day.totals.scrap)
    // No empty hour for a line with people planned.
    expect(dailyReport(factsOfHour(facts, hours[2]!, hours[3]!)).lanes).toEqual([])
  })
})

describe('a version a person writes (ANA-012)', () => {
  const file = kpiFileOf('production.scrap_rate')!
  const fields = { ...file.words, sourceRecords: [...file.sourceRecords], measureKeys: measuresOfCalc(file.calc), unit: file.unit, grain: file.grain }

  it('needs its words in Italian and English, its records, known measures, and the margin grain for margin', () => {
    expect(draftProblems(fields)).toEqual([])
    const paths = (issues: { path: string }[]) => issues.map((issue) => issue.path)
    expect(paths(draftProblems({ ...fields, nameIt: 'two\nlines', formulaEn: ' ' }))).toEqual(['body/nameIt', 'body/formulaEn'])
    expect(paths(draftProblems({ ...fields, sourceRecords: ['sales_order'] }))).toEqual(['body/sourceRecords'])
    expect(paths(draftProblems({ ...fields, measureKeys: ['quotes.sent'] }))).toEqual(['body/measureKeys'])
    // An unknown measure kept from the version it was made from is not a reason to refuse an edit of its words.
    expect(draftProblems({ ...fields, measureKeys: ['quotes.sent'] }, new Set(['nameEn']))).toEqual([])
    expect(paths(draftProblems({ ...fields, unit: 'MONEY', grain: null }))).toEqual(['body/grain'])
    expect(paths(draftProblems({ ...fields, measureKeys: ['orders.margin', 'orders.value_costed'], grain: 'PRICE' }))).toEqual(['body/grain'])
    expect(paths(draftProblems({ ...fields, changeNote: '' }))).toEqual(['body/changeNote'])
  })

  it('is put in force only with the measures, unit and grain of its calculation', () => {
    expect(activationProblems(fields, file)).toEqual([])
    expect(activationProblems({ ...fields, measureKeys: ['production.scrap_pieces'] }, file).map((issue) => issue.path)).toEqual(['refusal/MEASURES_DIFFER'])
    expect(activationProblems({ ...fields, unit: 'RATIO', grain: 'COST' }, file).map((issue) => issue.path)).toEqual(['refusal/UNIT_DIFFERS', 'refusal/GRAIN_DIFFERS'])
    expect(activationProblems({ ...fields, measureKeys: ['quotes.sent'] }, null).map((issue) => issue.path)).toEqual(['refusal/UNKNOWN_MEASURE'])
    expect(activationProblems({ measureKeys: [], unit: 'COUNT', grain: null }, null)).toEqual([])
  })
})

describe('where KPIs are used (ANA-070)', () => {
  it('comes from the readers’ registries: Today’s numbers that read a KPI (and the dashboards, B-W2b-434)', () => {
    const readers = kpiReaders()
    expect(readers.filter((reader) => reader.useKey === 'today').map((reader) => reader.kpiKey)).toEqual(['delivery.shipped_on_time', 'production.output', 'sales.orders_in'])
    expect(readers.every((reader) => reader.usedIn === 'DASHBOARD')).toBe(true)
    for (const reader of readers) expect(kpiFileOf(reader.kpiKey), reader.kpiKey).not.toBeNull()
    expect(kpiUseKey('sales.orders_in', 'DASHBOARD', 'today')).toBe('kpiuse:sales.orders_in:DASHBOARD:today')
  })

  it('adds the uses of KPIs in force, removes only the owned readers’ stale uses', () => {
    const stored = [
      { id: 'a', kpiKey: 'delivery.otif', usedIn: 'DASHBOARD' as const, useKey: 'owner-group' },
      { id: 'b', kpiKey: 'production.scrap_rate', usedIn: 'DASHBOARD' as const, useKey: 'today' },
      { id: 'c', kpiKey: 'sales.orders_in', usedIn: 'DASHBOARD' as const, useKey: 'today' },
    ]
    const plan = usesPlan(stored, kpiReaders(), new Set(['sales.orders_in', 'production.output']))
    expect(plan.add.filter((use) => use.useKey === 'today').map((use) => use.kpiKey)).toEqual(['production.output'])
    // B-W2b-434: the dashboards that read them are added too; the seeded owner-group use of OTIF is a dashboard's and stays.
    expect(plan.add.filter((use) => use.useKey !== 'today').map((use) => `${use.kpiKey}:${use.useKey}`)).toContain('sales.orders_in:owner-group')
    expect(plan.remove.map((use) => use.id)).toEqual(['b'])
  })
})

describe('the database’s refusals in words', () => {
  it('maps the guards’ messages to a path and words, and leaves others alone', () => {
    expect(databaseKpiRefusal('kpis: version 2 of KPI delivery.otif is in force: it is never edited (a change is a new version); it only ends, SUPERSEDED or RETIRED')?.path).toBe('refusal/IN_FORCE')
    expect(databaseKpiRefusal('kpis: version 1 of KPI delivery.otif was in force (SUPERSEDED): it explains old numbers and is never deleted; only a DRAFT is')?.path).toBe('refusal/KEPT')
    expect(databaseKpiRefusal('kpis: a reader reads a KPI that is in force (an ACTIVE version of x.y)')?.path).toBe('refusal/NOT_IN_FORCE')
    expect(databaseKpiRefusal('facts: fact 1 is of a day that has begun (today at the latest on the clock of Europe/Rome)')?.path).toBe('refusal/FACTS')
    expect(databaseKpiRefusal('inventory: something else')).toBeNull()
  })

  it('declares its permissions and gives the library to the office templates that work with numbers', () => {
    expect(FACTORY_PERMISSIONS.isDeclared('home.kpis.view')).toBe(true)
    expect(FACTORY_PERMISSIONS.isDeclared('home.kpis.manage')).toBe(true)
    expect(templateOf('planner')!.permissions).toContain('home.kpis.view')
    expect(templateOf('planner')!.permissions).not.toContain('home.kpis.manage')
    expect(templateOf('owner')!.permissions).toContain('home.kpis.manage')
    expect(templateOf('admin')!.permissions).not.toContain('home.kpis.view')
  })
})
