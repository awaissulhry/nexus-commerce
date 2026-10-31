import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { REPORT_ROW_LIMIT, type ReportColumn } from '@nexus/factory-domain/insights/reports/definition'
import { HOME_REPORTS_VIEW } from '@nexus/factory-domain/insights/reports/permissions'
import { appliedFilters } from '@nexus/factory-domain/insights/reports/results'
import { hideSmallGroups, libraryState, type ReportRow } from '@nexus/factory-domain/insights/reports/rights'
import type { ExportCell, ExportLocale } from '@nexus/factory-domain/views/exports'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { processReports } from '../../../modules/insights/reports/registry'
import type { ReportDefinition } from '../../../modules/insights/reports/report'
import { sitesReached } from '../../../modules/insights/reports/run'
import { officeContextOf } from '../../../modules/insights/viewer'
import { defineExportSource, type AnyExportSource } from '../source'

/**
 * Home › Reports › a report (SCR-104-report, `/home/reports/<key>`): "XLSX of a report" (B-W2b-11; design home.reports
 * rec:Report/results "Export ▾ (CSV, XLSX, PDF)"). B-W2a-79 built the report's CSV in the browser because the engine's
 * sources were a fixed list; here every report of the pack is a DYNAMIC source, made from its definition when it is
 * asked for (the report registry is a folder: a new report file exports with no line here):
 *
 *   list key   `home.reports.<report key>` (the report page is a record page, so its list frame names it so)
 *   permission home.reports.view, and the report's own rights (`refusal`: the list it reads, the grain it is about —
 *              the library's states NO_ACCESS / NEEDS_GRAIN, in the run's words)
 *   query      the report's filters from the page's address (`?period=…&site=…`), applied as its run applies them (a
 *              filter it does not know is ignored, a bad value is refused in the run's words); `group` and `tab` are
 *              the page's, not the rows'
 *   read       ONE run as the person through the report's own read (the module lists it names), at most
 *              REPORT_ROW_LIMIT rows, with the small-group rule applied (people figures of groups under 5 blanked,
 *              Statuto dei Lavoratori art. 4) — the same rows the Results tab shows; columns of a grain the person lacks
 *              are left out and named by the engine, as on screen
 *   columns    the report's columns by key: text, codes in words (the web catalogue's `code.*`, copied below and held
 *              equal by reports-words.vitest.test.ts), numbers, days, money (minor units in the row's currency, the
 *              column's grain), percents (decimal)
 *
 * The rows are those of one moment (a report is read live): the count before the run is the run's own row count.
 */

export const REPORT_LIST_PREFIX = 'home.reports.'

export const reportListKey = (reportKey: string): string => `${REPORT_LIST_PREFIX}${reportKey}`

interface Query {
  readonly values: Readonly<Record<string, string | null>>
}

/** The web catalogue's code words (apps/factory-web messages {it,en}/home-reports.json `code.*`), held equal by a test. */
export const REPORT_CODE_WORDS: Readonly<Record<ExportLocale, Readonly<Record<string, string>>>> = Object.freeze({
  it: {
    'code.ASKED': 'Richiesta',
    'code.AUDIT': 'Audit',
    'code.BUNDLE': 'Mazzetto',
    'code.CLOSED': 'Chiuso',
    'code.COMPLAINT': 'Reclamo',
    'code.CONFIRMED': 'Confermato',
    'code.CONTAINED': 'Contenuto',
    'code.CRITICAL': 'Critico',
    'code.DECIDED': 'Deciso',
    'code.DELAYED': 'In ritardo',
    'code.DRAFT': 'Bozza',
    'code.FINAL': 'Definitivo',
    'code.FINISHED_GOODS': 'Prodotti finiti',
    'code.INSPECTION': 'Ispezione',
    'code.IN_PRODUCTION': 'In produzione',
    'code.IN_PROGRESS': 'In lavorazione',
    'code.LATE': 'In ritardo',
    'code.LATER': 'Più avanti',
    'code.LEATHER': 'Pelle',
    'code.LINE': 'Linea',
    'code.MAJOR': 'Maggiore',
    'code.MATERIALS': 'Materiali',
    'code.MINOR': 'Minore',
    'code.NOT_ENOUGH': 'Insufficiente',
    'code.NOT_STARTED': 'Non iniziato',
    'code.NO_PROMISE': 'Senza data promessa',
    'code.ON_HOLD': 'In sospeso',
    'code.ON_TIME': 'In tempo',
    'code.OPEN': 'Aperta',
    'code.OTHER': 'Altro',
    'code.OVERDUE': 'Scaduto',
    'code.PACKAGING': 'Imballaggi',
    'code.PARTLY_SHIPPED': 'Spedito in parte',
    'code.READY': 'Pronto da spedire',
    'code.RELEASED': 'Rilasciato',
    'code.RETURN': 'Reso',
    'code.REWORK': 'Rilavorazione',
    'code.SCRAP': 'Scarto',
    'code.SHIPPED': 'Spedito',
    'code.STARTED': 'Iniziato',
    'code.SUPPLIER': 'Fornitore',
    'code.THIS_WEEK': 'Questa settimana',
    'code.TRIMS': 'Accessori',
    'code.WIP': 'Semilavorati in corso',
    'code.WORK_CENTRE': 'Centro di lavoro',
  },
  en: {
    'code.ASKED': 'Asked',
    'code.AUDIT': 'Audit',
    'code.BUNDLE': 'Bundle',
    'code.CLOSED': 'Closed',
    'code.COMPLAINT': 'Complaint',
    'code.CONFIRMED': 'Confirmed',
    'code.CONTAINED': 'Contained',
    'code.CRITICAL': 'Critical',
    'code.DECIDED': 'Decided',
    'code.DELAYED': 'Delayed',
    'code.DRAFT': 'Draft',
    'code.FINAL': 'Final',
    'code.FINISHED_GOODS': 'Finished goods',
    'code.INSPECTION': 'Inspection',
    'code.IN_PRODUCTION': 'In production',
    'code.IN_PROGRESS': 'In progress',
    'code.LATE': 'Late',
    'code.LATER': 'Later',
    'code.LEATHER': 'Leather',
    'code.LINE': 'Line',
    'code.MAJOR': 'Major',
    'code.MATERIALS': 'Materials',
    'code.MINOR': 'Minor',
    'code.NOT_ENOUGH': 'Not enough',
    'code.NOT_STARTED': 'Not started',
    'code.NO_PROMISE': 'No promise date',
    'code.ON_HOLD': 'On hold',
    'code.ON_TIME': 'On time',
    'code.OPEN': 'Open',
    'code.OTHER': 'Other',
    'code.OVERDUE': 'Overdue',
    'code.PACKAGING': 'Packaging',
    'code.PARTLY_SHIPPED': 'Partly shipped',
    'code.READY': 'Ready to ship',
    'code.RELEASED': 'Released',
    'code.RETURN': 'Return',
    'code.REWORK': 'Rework',
    'code.SCRAP': 'Scrap',
    'code.SHIPPED': 'Shipped',
    'code.STARTED': 'Started',
    'code.SUPPLIER': 'Supplier',
    'code.THIS_WEEK': 'This week',
    'code.TRIMS': 'Trims',
    'code.WIP': 'Work in progress',
    'code.WORK_CENTRE': 'Work centre',
  },
})

/** A report cell as a file cell, by the column's kind. */
export function reportCell(column: ReportColumn, row: ReportRow, words: (code: string) => string): ExportCell {
  const value = row.cells[column.key] ?? null
  if (value === null || value === undefined || value === '') return null
  switch (column.kind) {
    case 'code':
      return words(`code.${String(value)}`)
    case 'number':
    case 'percent':
      return typeof value === 'number' ? value : /^-?\d+(\.\d+)?$/.test(value) ? { decimal: value } : value
    case 'day':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? { day: String(value) } : String(value)
    case 'money':
      return typeof value === 'number' ? { minor: value, currency: row.currency } : /^-?\d+$/.test(value) ? { minor: Number(value), currency: row.currency } : value
    default:
      return String(value)
  }
}

/** Why the person may not export this report (the library's held states), or null. */
function refusalOf(report: ReportDefinition, actor: Actor): string | null {
  const { state, grain } = libraryState(actor, report)
  if (state === 'NO_ACCESS') return 'This report reads a list you cannot read.'
  if (state === 'NEEDS_GRAIN') return `This report needs ${grain} rights.`
  return null
}

/** The export source of one report. */
export function reportSource(report: ReportDefinition): AnyExportSource {
  return defineExportSource<Query, ReportRow>({
    listKey: reportListKey(report.key),
    permission: HOME_REPORTS_VIEW,
    page: `/home/reports/${report.key}`,
    refusal: (actor) => refusalOf(report, actor),
    query(address) {
      const terms: Record<string, string> = {}
      for (const filter of report.filters) {
        const value = address.get(filter.key)
        if (value !== null) terms[filter.key] = value
      }
      const applied = appliedFilters(report, terms)
      if (applied.problems.length > 0) throw new ValidationError(applied.problems[0]!.message, [...applied.problems])
      return { values: applied.values }
    },
    async read(caller, query, cursor, _limit, options) {
      if (cursor !== null) return { rows: [], next: null }
      const actor = actorOf(officeContextOf(caller))
      const siteFilter = report.filters.find((filter) => filter.kind === 'site')
      const siteId = siteFilter ? query.values[siteFilter.key] : null
      if (siteFilter && siteId && !(await sitesReached(caller, actor, report.permission)).some((site) => site.id === siteId)) throw new NotFoundError('Site not found.')
      const now = serverClock.now()
      const read = await report.read({ caller, filters: query.values, today: businessDate(now), now, limit: REPORT_ROW_LIMIT, locale: options?.locale === 'it' ? 'it' : 'en' })
      const small = hideSmallGroups(read.rows.slice(0, REPORT_ROW_LIMIT), report.columns)
      return { rows: small.rows, next: null }
    },
    columns: Object.fromEntries(report.columns.map((column) => [column.key, { ...(column.grain ? { grain: column.grain } : {}), value: (row: ReportRow, words: (code: string) => string) => reportCell(column, row, words) }])),
    words: REPORT_CODE_WORDS,
  })
}

const made = new WeakMap<ReportDefinition, AnyExportSource>()

/** The source of a report's list key, when the key names a report of this process (reports loaded), else undefined. */
export function reportSourceOf(listKey: string): AnyExportSource | undefined {
  if (!listKey.startsWith(REPORT_LIST_PREFIX)) return undefined
  let reports: readonly ReportDefinition[]
  try {
    reports = processReports()
  } catch {
    // The reports are not loaded in this process (a test without them): no report exports here.
    return undefined
  }
  const report = reports.find((entry) => entry.key === listKey.slice(REPORT_LIST_PREFIX.length))
  if (!report) return undefined
  let source = made.get(report)
  if (!source) {
    source = reportSource(report)
    made.set(report, source)
  }
  return source
}
