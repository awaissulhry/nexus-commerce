import { isGrain, type Grain } from '../../auth/grains/grains'
import { isPermission, type Permission } from '../../core/permissions'
import { looksLikeMoney } from '../../money/marked'

/**
 * A standard report (B-W2a-79; ANA-029; design home.reports): what one report of the pack is, said as the question it
 * answers. The API keeps ONE definition file per report in its registry folder (apps/factory-api
 * modules/insights/reports/defs/<key>.ts: this meta and the read); these are the pure parts every definition shares:
 *
 *   key          `<area>.<name>` (`sales.late-orders`): the report's address (/home/reports/<key>) and its words' key
 *   area         the library's group (Sales, Planning, …)
 *   title        a short name ("Late orders")
 *   question     what it answers ("Which orders are late against their promise date?"), the library's line
 *   permission   the module list it reads (its view permission): a person without it sees the report listed, held
 *   needs        a grain the WHOLE report is about (Margin by order: margin) — without it the report stays listed and
 *                says "Needs margin rights" (design: reports needing a grain the person lacks stay listed)
 *   columns      what each row shows; a money or percent column of a grain the person lacks is LEFT OUT and named
 *                ("Left out because of your rights: Cost"); a `people` column (a figure made by a group of people's
 *                work, such as a line's efficiency) is hidden for a group of fewer than 5 people
 *   filters      what a run looks at (period, site, a choice); the server answers what it applied
 *   groupBy      the groupable column the rows are grouped by at first (WIP by stage: the status), or null
 *   sources      the records it reads, in words (About)
 *   definition   how it is made, in words (About)
 *   numbers      the key numbers of Today it lists the rows of (numbers.ts keys)
 *   mail         the e-mailed report it shares its rows with (production REPORT_KEYS), or null: not scheduled yet (W3)
 *
 * Every report is read at the moment it is opened (refresh LIVE): no stored projection exists in W2a.
 */

export const REPORT_AREAS = ['sales', 'planning', 'purchasing', 'production', 'quality', 'compliance', 'finance'] as const
export type ReportArea = (typeof REPORT_AREAS)[number]

export const COLUMN_KINDS = ['text', 'code', 'number', 'day', 'money', 'percent'] as const
export type ColumnKind = (typeof COLUMN_KINDS)[number]

export const FILTER_KINDS = ['period', 'site', 'choice'] as const
export type FilterKind = (typeof FILTER_KINDS)[number]

/** The periods a report may offer, in the site's days (Europe/Rome, midnight to midnight). */
export const PERIODS = ['THIS_WEEK', 'LAST_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'LAST_8_WEEKS', 'NEXT_7_DAYS', 'NEXT_30_DAYS', 'NEXT_90_DAYS'] as const
export type Period = (typeof PERIODS)[number]

export const REPORT_FORMATS = ['CSV', 'PDF'] as const
export type ReportFormat = (typeof REPORT_FORMATS)[number]

export interface ReportColumn {
  readonly key: string
  readonly label: string
  readonly kind: ColumnKind
  /** money and percent columns: the grain that shows them. */
  readonly grain?: Grain
  /** A figure made by a group of people's work: hidden for a group of fewer than MIN_GROUP_PEOPLE people. */
  readonly people?: boolean
  /** Summed in the totals and the groups (number and money columns). */
  readonly sum?: boolean
  /** The rows can be grouped by it. */
  readonly group?: boolean
  /** code columns: every code a cell may hold (the web says each in words). */
  readonly codes?: readonly string[]
}

export interface FilterChoice {
  readonly value: string
  readonly label: string
}

export interface ReportFilter {
  readonly key: string
  readonly label: string
  readonly kind: FilterKind
  /** period: the periods offered; choice: the values. */
  readonly choices: readonly FilterChoice[]
  /** The value when the address names none (null: every value). */
  readonly default: string | null
}

export interface ReportMeta {
  readonly key: string
  readonly area: ReportArea
  readonly title: string
  readonly question: string
  readonly permission: Permission
  readonly needs: Grain | null
  readonly columns: readonly ReportColumn[]
  readonly filters: readonly ReportFilter[]
  /** The column the rows are grouped by when the address names none (null: not grouped). */
  readonly groupBy: string | null
  readonly sources: string
  readonly definition: string
  readonly numbers: readonly string[]
  readonly mail: string | null
  readonly formats: readonly ReportFormat[]
}

/** Fewer people than this in a group and its people figures are hidden (Statuto dei Lavoratori art. 4; design home.reports). */
export const MIN_GROUP_PEOPLE = 5

/** The most rows one run returns (the answer says when it stopped there). */
export const REPORT_ROW_LIMIT = 2000

export const PERIOD_LABELS: Readonly<Record<Period, string>> = Object.freeze({
  THIS_WEEK: 'This week',
  LAST_WEEK: 'Last week',
  THIS_MONTH: 'This month',
  LAST_MONTH: 'Last month',
  LAST_8_WEEKS: 'Last 8 weeks',
  NEXT_7_DAYS: 'Next 7 days',
  NEXT_30_DAYS: 'Next 30 days',
  NEXT_90_DAYS: 'Next 90 days',
})

export const AREA_LABELS: Readonly<Record<ReportArea, string>> = Object.freeze({
  sales: 'Sales',
  planning: 'Planning',
  purchasing: 'Purchasing',
  production: 'Production',
  quality: 'Quality',
  compliance: 'Compliance',
  finance: 'Finance',
})

const KEY = /^[a-z]+\.[a-z][a-z0-9-]*$/
const PART = /^[a-z][a-zA-Z0-9]*$/

export class ReportDefinitionError extends Error {
  override name = 'ReportDefinitionError'
}

/** A period filter of a report: these periods, this default (null: any time). */
export function periodFilter(periods: readonly Period[], fallback: Period | null, label = 'Period', key = 'period'): ReportFilter {
  return Object.freeze({ key, label, kind: 'period', choices: Object.freeze(periods.map((value) => Object.freeze({ value, label: PERIOD_LABELS[value] }))), default: fallback })
}

/** A choice filter: these codes with their words, this default (null: every value). */
export function choiceFilter(key: string, label: string, choices: Readonly<Record<string, string>>, fallback: string | null = null): ReportFilter {
  return Object.freeze({ key, label, kind: 'choice', choices: Object.freeze(Object.entries(choices).map(([value, words]) => Object.freeze({ value, label: words }))), default: fallback })
}

/** The site filter: every site of the person's companies by default. */
export const SITE_FILTER: ReportFilter = Object.freeze({ key: 'site', label: 'Site', kind: 'site', choices: Object.freeze([]), default: null })

/** Every problem of a definition, in words (empty: a good one). */
export function reportProblems(meta: ReportMeta): string[] {
  const problems: string[] = []
  const at = (message: string) => problems.push(`${meta.key}: ${message}`)
  if (!KEY.test(meta.key)) at('the key is `<area>.<name>`')
  if (!(REPORT_AREAS as readonly string[]).includes(meta.area)) at(`unknown area ${meta.area}`)
  if (meta.key.split('.')[0] !== meta.area) at('the key starts with its area')
  if (!meta.title.trim() || !meta.question.trim().endsWith('?')) at('a title and a question that ends with "?"')
  if (!isPermission(meta.permission)) at('the permission of the list it reads')
  if (meta.needs !== null && !isGrain(meta.needs)) at(`unknown grain ${String(meta.needs)}`)
  if (meta.columns.length === 0) at('a report shows at least one column')
  const keys = new Set<string>()
  for (const column of meta.columns) {
    if (!PART.test(column.key)) at(`column "${column.key}" is not a key`)
    if (keys.has(column.key)) at(`two columns "${column.key}"`)
    keys.add(column.key)
    if (!(COLUMN_KINDS as readonly string[]).includes(column.kind)) at(`column ${column.key}: unknown kind`)
    if (column.kind === 'money' && !column.grain) at(`column ${column.key}: money says its grain`)
    if (column.grain && column.kind !== 'money' && column.kind !== 'percent') at(`column ${column.key}: only money and percent columns have a grain`)
    // The API's grain filter drops an unmarked field whose name looks like money: such a key must be money.
    if (!column.grain && looksLikeMoney(column.key)) at(`column ${column.key}: a key that looks like money is a money column`)
    if (column.sum && column.kind !== 'number' && column.kind !== 'money') at(`column ${column.key}: only numbers and money are summed`)
    if (column.kind === 'code' && (!column.codes || column.codes.length === 0)) at(`column ${column.key}: a code column lists its codes`)
    if (column.people && column.kind !== 'percent' && column.kind !== 'number') at(`column ${column.key}: a people figure is a number or a percent`)
  }
  if (meta.groupBy !== null && !meta.columns.some((column) => column.key === meta.groupBy && column.group)) at(`groupBy ${meta.groupBy} is a groupable column`)
  const filterKeys = new Set<string>()
  for (const filter of meta.filters) {
    if (!PART.test(filter.key)) at(`filter "${filter.key}" is not a key`)
    if (filterKeys.has(filter.key)) at(`two filters "${filter.key}"`)
    filterKeys.add(filter.key)
    if (filter.kind === 'period' && filter.choices.some((choice) => !(PERIODS as readonly string[]).includes(choice.value))) at(`filter ${filter.key}: unknown period`)
    if (filter.default !== null && filter.kind !== 'site' && !filter.choices.some((choice) => choice.value === filter.default)) at(`filter ${filter.key}: the default is one of its choices`)
  }
  if (!meta.sources.trim() || !meta.definition.trim()) at('sources and definition in words')
  if (meta.formats.length === 0) at('at least one format')
  return problems
}

/** Checks a report's meta (a bad one throws at import: the registry never holds it). */
export function defineReportMeta(meta: ReportMeta): ReportMeta {
  const problems = reportProblems(meta)
  if (problems.length > 0) throw new ReportDefinitionError(problems.join('; '))
  return Object.freeze({ ...meta })
}

/** Checks a whole pack: one definition per key. */
export function packProblems(metas: readonly ReportMeta[]): string[] {
  const problems = metas.flatMap(reportProblems)
  const seen = new Set<string>()
  for (const meta of metas) {
    if (seen.has(meta.key)) problems.push(`${meta.key}: two definitions`)
    seen.add(meta.key)
  }
  return problems
}
