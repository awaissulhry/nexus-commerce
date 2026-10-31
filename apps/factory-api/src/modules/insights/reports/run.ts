import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { holds, scopeWhere, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { AREA_LABELS, REPORT_AREAS, REPORT_ROW_LIMIT, type ReportColumn } from '@nexus/factory-domain/insights/reports/definition'
import { NUMBER_RULES } from '@nexus/factory-domain/insights/reports/numbers'
import { appliedFilters, groupsOf, totalsOf } from '@nexus/factory-domain/insights/reports/results'
import { columnsFor, hideSmallGroups, libraryState, onlyShown, rightsNoteOf, type CellValue, type ReportRow } from '@nexus/factory-domain/insights/reports/rights'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { PRODUCTION_REPORTS_VIEW } from '@nexus/factory-domain/production/reports/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { listSubscriptions } from '../../production/reports/subscriptions'
import { officeContextOf } from '../viewer'
import { processReports, reportOf } from './registry'
import type { ReportDefinition } from './report'
// B-W2b-24 (Z12:06): every run logged; "last run by me" from the person's own runs.
import { lastRunByMe, lastRunsByMe, recordRun, runParamsOf } from './runs/runs'

/**
 * Home › Reports (B-W2a-79; ANA-029, ANA-034; design home.reports, SCR-104): the library, a report's About, its results
 * and its schedule. Read only. Every answer is the person's: the library says which reports they may run and why not;
 * a run reads the module's list as them (./report.ts), leaves out the columns of grains they lack and blanks the people
 * figures of groups under 5 people, and says both ("What you see").
 */

const areaOrder = (report: ReportDefinition) => REPORT_AREAS.indexOf(report.area)

function sorted(reports: readonly ReportDefinition[]): ReportDefinition[] {
  return [...reports].sort((a, b) => areaOrder(a) - areaOrder(b) || a.title.localeCompare(b.title))
}

function reportFor(key: string): ReportDefinition {
  const report = reportOf(key)
  if (!report) throw new NotFoundError('There is no such report.')
  return report
}

export interface ReachedSite {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly companyId: string
}

/** The sites whose records the person reaches with a permission (every company they work in), by code. */
export async function sitesReached(caller: CommandCaller, actor: Actor, permission: Permission): Promise<ReachedSite[]> {
  if (!holds(actor, permission)) return []
  return caller.withClient((db) =>
    db.site.findMany({
      where: scopeWhere(actor, permission, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput,
      select: { id: true, code: true, name: true, companyId: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    }),
  )
}

const columnView = (column: ReportColumn) => ({
  key: column.key,
  label: column.label,
  kind: column.kind,
  grain: column.grain ?? null,
  people: column.people === true,
  sum: column.sum === true,
  group: column.group === true,
})

/** The reports whose mail a person receives now (the library's schedule badge). */
async function mailedToMe(caller: CommandCaller, me: string, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set()
  const rows = await caller.withClient((db) => db.reportSubscription.findMany({ where: { userId: me, active: true, reportKey: { in: [...keys] } }, select: { reportKey: true } }))
  return new Set(rows.map((row) => row.reportKey))
}

/** GET /reports: every report of the pack, grouped by area, each with what the person may do with it. */
export async function library(caller: CommandCaller) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const reports = sorted(processReports())
  const mails = [...new Set(reports.map((report) => report.mail).filter((mail): mail is string => mail !== null))]
  const mailed = await mailedToMe(caller, context.actorId, mails)
  const lastRuns = await lastRunsByMe(caller, context.actorId, reports.map((report) => report.key))
  return {
    asOf: toUtcIso(serverClock.now()),
    areas: REPORT_AREAS.filter((area) => reports.some((report) => report.area === area)).map((area) => ({ area, label: AREA_LABELS[area] })),
    reports: reports.map((report) => {
      const { state, grain } = libraryState(actor, report)
      return {
        key: report.key,
        area: report.area,
        title: report.title,
        question: report.question,
        state,
        grain,
        permission: report.permission,
        formats: [...report.formats],
        mail: report.mail,
        mailed: report.mail !== null && mailed.has(report.mail),
        lastRunByMe: lastRuns.get(report.key) ?? null,
      }
    }),
  }
}

/** GET /reports/:key: what the report counts (About), its filters with the person's sites, its columns as they see them. */
export async function reportAbout(caller: CommandCaller, key: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const report = reportFor(key)
  const { state, grain } = libraryState(actor, report)
  const sight = columnsFor(actor, report.columns)
  const sites = report.filters.some((filter) => filter.kind === 'site') && state === 'READY' ? await sitesReached(caller, actor, report.permission) : []
  return {
    key: report.key,
    area: report.area,
    title: report.title,
    question: report.question,
    state,
    grain,
    permission: report.permission,
    columns: sight.shown.map(columnView),
    leftOut: { grains: [...sight.leftOut], columns: report.columns.filter((column) => sight.leftOutColumns.includes(column.key)).map((column) => ({ key: column.key, label: column.label, grain: column.grain ?? null })) },
    filters: report.filters.map((filter) => ({
      key: filter.key,
      label: filter.label,
      kind: filter.kind,
      default: filter.default,
      choices: filter.kind === 'site' ? sites.map((site) => ({ value: site.id, label: `${site.code} · ${site.name}` })) : filter.choices.map((choice) => ({ ...choice })),
    })),
    groupBy: report.groupBy !== null && sight.shown.some((column) => column.key === report.groupBy) ? report.groupBy : null,
    sources: report.sources,
    definition: report.definition,
    refresh: 'LIVE' as const,
    numbers: report.numbers.map((number) => ({ key: number, label: NUMBER_RULES.find((entry) => entry.key === number)?.label ?? number })),
    mail: report.mail,
    formats: [...report.formats],
    lastRunByMe: await lastRunByMe(caller, context.actorId, report.key),
  }
}

/** A cell for the answer: money and percent of a grain are marked (the grain filter drops them again for anyone without it). */
function cellOut(column: ReportColumn, value: CellValue): unknown {
  if (value === null || value === undefined) return null
  return column.grain ? markMoney(column.grain, value) : value
}

function sumsOut(columns: readonly ReportColumn[], sums: Readonly<Record<string, number | null>>): Record<string, unknown> {
  return Object.fromEntries(columns.filter((column) => column.key in sums).map((column) => [column.key, cellOut(column, sums[column.key] ?? null)]))
}

export interface ResultsQuery {
  readonly group?: string | undefined
  readonly lang?: string | undefined
  readonly [filter: string]: string | undefined
}

/** Refuses a run the person may not make, in words (the library lists it all the same). */
function assertRunnable(actor: Actor, report: ReportDefinition): void {
  const { state, grain } = libraryState(actor, report)
  if (state === 'NO_ACCESS') throw new DomainError('forbidden', 'This report reads a list you cannot read.', [{ path: `permission/${report.permission}`, message: 'You cannot read the list this report reads.' }])
  if (state === 'NEEDS_GRAIN') throw new DomainError('forbidden', `This report needs ${grain} rights.`, [{ path: `grain/${grain}`, message: `This report needs ${grain} rights.` }])
}

/** GET /reports/:key/results: one run under the filters of the address. */
export async function reportResults(caller: CommandCaller, key: string, query: ResultsQuery) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const report = reportFor(key)
  assertRunnable(actor, report)
  const applied = appliedFilters(report, query)
  if (applied.problems.length > 0) throw new ValidationError(applied.problems[0]!.message, [...applied.problems])
  const siteFilter = report.filters.find((filter) => filter.kind === 'site')
  const sites = siteFilter ? await sitesReached(caller, actor, report.permission) : []
  const siteId = siteFilter ? applied.values[siteFilter.key] : null
  if (siteFilter && siteId && !sites.some((site) => site.id === siteId)) throw new NotFoundError('Site not found.')
  const sight = columnsFor(actor, report.columns)
  const wanted = query.group === 'none' ? null : (query.group ?? report.groupBy)
  const groupColumn = wanted ? (sight.shown.find((column) => column.key === wanted && column.group) ?? null) : null
  if (query.group && query.group !== 'none' && !groupColumn) throw new ValidationError('The rows cannot be grouped by that.', [{ path: 'querystring/group', message: `Group by one of ${sight.shown.filter((column) => column.group).map((column) => column.key).join(', ') || 'nothing'}.` }])
  const now = serverClock.now()
  const read = await report.read({ caller, filters: applied.values, today: businessDate(now), now, limit: REPORT_ROW_LIMIT, locale: query.lang === 'it' ? 'it' : 'en' })
  const small = hideSmallGroups(read.rows.slice(0, REPORT_ROW_LIMIT), report.columns)
  const rows: ReportRow[] = onlyShown(small.rows, sight.shown)
  const totals = totalsOf(rows, sight.shown)
  const groups = groupColumn ? groupsOf(rows, groupColumn, sight.shown) : null
  const labelOf = (filterKey: string, value: string | null) => {
    if (value === null) return null
    const filter = report.filters.find((entry) => entry.key === filterKey)
    if (filter?.kind === 'site') {
      const site = sites.find((entry) => entry.id === value)
      return site ? `${site.code} · ${site.name}` : value
    }
    return filter?.choices.find((choice) => choice.value === value)?.label ?? value
  }
  await recordRun(caller, { userId: context.actorId, reportKey: report.key, params: runParamsOf(applied.values, groupColumn?.key ?? (query.group === 'none' ? 'none' : null)), at: now })
  return {
    key: report.key,
    asOf: toUtcIso(read.asOf ?? now),
    today: businessDate(now),
    applied: report.filters.map((filter) => {
      const settled = read.applied?.[filter.key]
      return settled ? { key: filter.key, value: settled.value, label: settled.label } : { key: filter.key, value: applied.values[filter.key] ?? null, label: labelOf(filter.key, applied.values[filter.key] ?? null) }
    }),
    range: read.range ? { from: read.range.from, to: read.range.to } : null,
    columns: sight.shown.map(columnView),
    rows: rows.map((row) => ({
      id: row.id,
      record: row.record,
      currency: row.currency,
      cells: Object.fromEntries(sight.shown.map((column) => [column.key, cellOut(column, row.cells[column.key] ?? null)])),
    })),
    totals: { rows: totals.rows, sums: sumsOut(sight.shown, totals.sums), currency: totals.currency, mixedCurrencies: totals.mixedCurrencies },
    groupBy: groupColumn?.key ?? null,
    groups: groups?.map((group) => ({ value: group.value, rows: group.rows, sums: sumsOut(sight.shown, group.sums), currency: group.currency })) ?? null,
    rights: ((note) => (note ? { leftOut: [...note.leftOut], hiddenGroups: note.hiddenGroups } : null))(rightsNoteOf(sight, small.hidden)),
    complete: read.complete && read.rows.length <= REPORT_ROW_LIMIT,
    limit: REPORT_ROW_LIMIT,
  }
}

/**
 * GET /reports/:key/schedule (design rec:Report/schedule, W2a tab; its "Who gets it" list is W3): a report that shares
 * its rows with an e-mailed report (production.daily) lists the person's subscriptions of it and where they are changed;
 * any other report says it is not scheduled (schedules of any report come in W3).
 */
export async function reportSchedule(caller: CommandCaller, key: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const report = reportFor(key)
  assertRunnable(actor, report)
  if (report.mail === null) return { key: report.key, mail: null, schedulable: false, subscriptions: [], manage: null }
  // production.daily is the one mail of W2a (production REPORT_KEYS); its subscriptions are its module's.
  const subscriptions = holds(actor, PRODUCTION_REPORTS_VIEW) ? (await listSubscriptions(caller, {})).subscriptions : []
  return {
    key: report.key,
    mail: report.mail,
    schedulable: true,
    subscriptions: subscriptions.map((row) => ({
      id: row.id,
      user: row.user,
      mine: row.mine,
      site: row.site,
      sendTime: row.sendTime,
      weekdays: row.weekdays,
      locale: row.locale,
      active: row.active,
      lastSentAt: row.lastSentAt,
    })),
    manage: '/production/reports',
  }
}
