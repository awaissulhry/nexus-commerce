import { NotFoundError } from '@nexus/factory-domain/core/errors'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { chooseNumbers, DEFAULT_DASHBOARD_PERIOD, mayReadKpi, SPARK_PERIODS, type Board, type DashboardPeriod } from '@nexus/factory-domain/insights/dashboards/boards'
import { measuresOfCalc } from '@nexus/factory-domain/insights/kpis/calc'
import type { KpiFile } from '@nexus/factory-domain/insights/kpis/catalogue'
import { measureOf, type MeasureSource } from '@nexus/factory-domain/insights/kpis/measures'
import { kpiFileOf } from '@nexus/factory-domain/insights/kpis/registry'
import { periodsBack, type Period } from '@nexus/factory-domain/insights/periods/periods'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import type { Place } from '../facts/reads'
import { inForce, versionsOf } from '../kpis/store'
import { kpiReading, markedValue, type KpiReading } from '../kpis/value'
import { boardFor, checkScope, dashboardActor, scopeCompanies } from './picker'

/**
 * The numbers of a dashboard (B-W2b-434; design home.dashboards `numbers` and `by-company`; ANA-002, ANA-003, ANA-004): five KPIs
 * of the metric layer, each read ONLY through its one calculation (kpis/value.ts kpiReading) over the dashboard's period and
 * the 11 before it (its line), in the scope asked (every company the person reaches, one company, or a site of it). Each says
 * where its facts come from, when they were rebuilt (stale after 3 hours) and why a value is missing; each opens the records
 * behind it (its drill). A KPI the person may not read gives its place to the next allowed one (factory-domain
 * insights/dashboards chooseNumbers). By company and site (the Owner's group view): the same numbers per company and, for the
 * numbers kept per site, per site, with how many sites a company's figure was read for ("3 of 4 sites"). Read only.
 */

/** The words of a KPI on a dashboard: the version in force (its name and definition are data), else the code's standard words. */
async function wordsOf(caller: CommandCaller, keys: readonly string[]) {
  const rows = keys.length ? await caller.withClient((db) => versionsOf(db, keys)) : []
  return (key: string) => {
    const shown = inForce(rows.filter((row) => row.kpiKey === key))
    const words = shown ?? kpiFileOf(key)!.words
    return {
      name: { it: words.nameIt, en: words.nameEn },
      definition: { it: words.definitionIt, en: words.definitionEn },
      formula: { it: words.formulaIt, en: words.formulaEn },
    }
  }
}

/** Is every fact this KPI reads kept per site (so a site's own figure exists)? */
export const perSite = (file: KpiFile): boolean => measuresOfCalc(file.calc).every((key) => measureOf(key)?.levels.includes('SITE') ?? false)

const sourcesOf = (file: KpiFile): MeasureSource[] => [...new Set(measuresOfCalc(file.calc).map((key) => measureOf(key)!.source))]

const freshnessOf = (reading: KpiReading) => ({
  currency: reading.currency,
  converted: reading.converted,
  asOf: reading.asOf ? toUtcIso(reading.asOf) : null,
  stale: reading.stale,
  live: reading.live,
  missingDays: reading.missingDays,
  problem: reading.problem,
})

const drillOf = (file: KpiFile) =>
  file.drill
    ? file.drill.kind === 'REPORT'
      ? { kind: file.drill.kind, key: file.drill.key, api: null, terms: { ...file.drill.filters } }
      : { kind: file.drill.kind, key: null, api: file.drill.api, terms: { ...file.drill.query } }
    : null

const periodView = (period: Period) => ({ kind: period.kind, key: period.key, from: period.from, to: period.to })

export interface NumbersQuery {
  readonly period?: DashboardPeriod | undefined
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
}

/** The five numbers a person sees on a board, in order (the stand-ins named). */
function shownOf(actor: Actor, entry: Board) {
  const chosen = chooseNumbers(entry, (key) => mayReadKpi(actor, key))
  return { ...chosen, files: chosen.shown.map((item) => ({ ...item, file: kpiFileOf(item.kpiKey)! })) }
}

/** GET /insights/dashboards/:board/numbers */
export async function numbersAnswer(caller: CommandCaller, boardKey: string, query: NumbersQuery) {
  const entry = boardFor(boardKey)
  const actor = dashboardActor(caller)
  const scope = await checkScope(caller, actor, query)
  const kind = query.period ?? DEFAULT_DASHBOARD_PERIOD
  const periods = periodsBack(kind, businessDate(serverClock.now()), SPARK_PERIODS)
  const shown = shownOf(actor, entry)
  const words = await wordsOf(caller, [...shown.files.map((item) => item.kpiKey), ...shown.withheld])
  const numbers = []
  for (const { kpiKey, standsFor, file } of shown.files) {
    const site = scope.siteId && perSite(file) ? scope.siteId : undefined
    const place: Place = { companyId: scope.companyId, siteId: site }
    const reading = await kpiReading(caller, actor, file, periods, place)
    const said = words(kpiKey)
    numbers.push({
      kpiKey,
      unit: file.unit,
      grain: file.grain,
      ...said,
      standsFor: standsFor ? { kpiKey: standsFor, name: words(standsFor).name } : null,
      sources: sourcesOf(file),
      wholeCompany: scope.siteId !== undefined && site === undefined,
      period: periodView(periods.at(-1)!),
      value: markedValue(file, reading.values.at(-1) ?? null),
      ...freshnessOf(reading),
      periods: periods.map((period, index) => ({ ...periodView(period), value: markedValue(file, reading.values[index] ?? null) })),
      drill: drillOf(file),
    })
  }
  return { board: entry.key, asOf: toUtcIso(serverClock.now()), period: kind, numbers, withheld: [...shown.withheld] }
}

/** GET /insights/dashboards/:board/by-company (the Owner's group view only). */
export async function byCompanyAnswer(caller: CommandCaller, boardKey: string, query: { readonly period?: DashboardPeriod | undefined }) {
  const entry = boardFor(boardKey)
  if (!entry.group) throw new NotFoundError('This dashboard has no view by company and site.')
  const actor = dashboardActor(caller)
  const kind = query.period ?? DEFAULT_DASHBOARD_PERIOD
  const period = periodsBack(kind, businessDate(serverClock.now()), 1)
  const shown = shownOf(actor, entry)
  const words = await wordsOf(caller, shown.files.map((item) => item.kpiKey))
  const { companies, siteCounts } = await caller.withClient(async (db) => {
    const reached = await scopeCompanies(db, actor)
    const counts = await db.site.groupBy({ by: ['companyId'], where: { companyId: { in: reached.map((company) => company.id) }, status: 'ACTIVE' }, _count: { _all: true } })
    return { companies: reached, siteCounts: new Map(counts.map((row) => [row.companyId, row._count._all])) }
  })
  // "3 of 4 sites" means something only when a number is kept per site.
  const anyPerSite = shown.files.some(({ file }) => perSite(file))
  const rows = []
  for (const company of companies) {
    const cells = []
    for (const { kpiKey, file } of shown.files) {
      const reading = await kpiReading(caller, actor, file, period, { companyId: company.id })
      cells.push({ kpiKey, value: markedValue(file, reading.values[0] ?? null), perCompanyOnly: false, ...freshnessOf(reading) })
    }
    const siteRows = []
    let read = 0
    for (const site of company.sites) {
      const siteCells = []
      let readable = false
      for (const { kpiKey, file } of shown.files) {
        if (!perSite(file)) {
          siteCells.push({ kpiKey, value: null, perCompanyOnly: true, currency: null, converted: [], asOf: null, stale: false, live: false, missingDays: 0, problem: null })
          continue
        }
        const reading = await kpiReading(caller, actor, file, period, { companyId: company.id, siteId: site.id })
        if (reading.values[0] !== null && reading.values[0] !== undefined) readable = true
        siteCells.push({ kpiKey, value: markedValue(file, reading.values[0] ?? null), perCompanyOnly: false, ...freshnessOf(reading) })
      }
      if (readable) read += 1
      siteRows.push({ company: { id: company.id, code: company.code, name: company.name }, site: { ...site }, cells: siteCells, sites: null })
    }
    rows.push({ company: { id: company.id, code: company.code, name: company.name }, site: null, cells, sites: anyPerSite ? { read, of: siteCounts.get(company.id) ?? 0 } : null }, ...siteRows)
  }
  return {
    board: entry.key,
    asOf: toUtcIso(serverClock.now()),
    period: periodView(period[0]!),
    columns: shown.files.map(({ kpiKey, file }) => ({ kpiKey, unit: file.unit, grain: file.grain, name: words(kpiKey).name, perSite: perSite(file) })),
    rows,
  }
}
