import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Home › Reports (SCR-104; B-W2a-79), with the answer's shape checked (zod; unknown fields dropped). The
 * shapes mirror apps/factory-api modules/insights/reports/contract.ts; the enum lists mirror factory-domain
 * insights/reports (reports.vitest.test.ts holds them equal). A cell of money or margin arrives only for a person with
 * its grain: the API leaves out those columns and drops the values again.
 */

export const REPORT_AREAS = ['sales', 'planning', 'purchasing', 'production', 'quality', 'compliance', 'finance'] as const
export type ReportArea = (typeof REPORT_AREAS)[number]
export const LIBRARY_STATES = ['READY', 'NO_ACCESS', 'NEEDS_GRAIN'] as const
export type LibraryState = (typeof LIBRARY_STATES)[number]
export const COLUMN_KINDS = ['text', 'code', 'number', 'day', 'money', 'percent'] as const
export type ColumnKind = (typeof COLUMN_KINDS)[number]
export const FILTER_KINDS = ['period', 'site', 'choice'] as const
export const GRAINS = ['price', 'cost', 'margin', 'wages', 'pay'] as const
export type Grain = (typeof GRAINS)[number]
export const REPORT_FORMATS = ['CSV', 'PDF'] as const

const grain = z.enum(GRAINS)

export const librarySchema = z.object({
  asOf: z.string(),
  areas: z.array(z.object({ area: z.enum(REPORT_AREAS), label: z.string() })),
  reports: z.array(
    z.object({
      key: z.string(),
      area: z.enum(REPORT_AREAS),
      title: z.string(),
      question: z.string(),
      state: z.enum(LIBRARY_STATES),
      grain: grain.nullable(),
      permission: z.string(),
      formats: z.array(z.enum(REPORT_FORMATS)),
      mail: z.string().nullable(),
      mailed: z.boolean(),
      /** B-W2b-24: when the person last ran it (their own run log on the server), or null. */
      lastRunByMe: z.string().nullable(),
    }),
  ),
})
export type Library = z.infer<typeof librarySchema>
export type LibraryReport = Library['reports'][number]

export const columnSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(COLUMN_KINDS),
  grain: grain.nullable(),
  people: z.boolean(),
  sum: z.boolean(),
  group: z.boolean(),
})
export type ReportColumn = z.infer<typeof columnSchema>

export const aboutSchema = z.object({
  key: z.string(),
  area: z.enum(REPORT_AREAS),
  title: z.string(),
  question: z.string(),
  state: z.enum(LIBRARY_STATES),
  grain: grain.nullable(),
  permission: z.string(),
  columns: z.array(columnSchema),
  leftOut: z.object({ grains: z.array(grain), columns: z.array(z.object({ key: z.string(), label: z.string(), grain: grain.nullable() })) }),
  filters: z.array(z.object({ key: z.string(), label: z.string(), kind: z.enum(FILTER_KINDS), default: z.string().nullable(), choices: z.array(z.object({ value: z.string(), label: z.string() })) })),
  groupBy: z.string().nullable(),
  sources: z.string(),
  definition: z.string(),
  refresh: z.enum(['LIVE']),
  numbers: z.array(z.object({ key: z.string(), label: z.string() })),
  mail: z.string().nullable(),
  formats: z.array(z.enum(REPORT_FORMATS)),
  /** B-W2b-24: when the person last ran this report (their own run log), or null. */
  lastRunByMe: z.string().nullable(),
})
export type ReportAbout = z.infer<typeof aboutSchema>
export type ReportFilter = ReportAbout['filters'][number]

const cellValue = z.union([z.string(), z.number(), z.null()])
const cells = z.record(z.string(), cellValue.optional())

export const resultsSchema = z.object({
  key: z.string(),
  asOf: z.string(),
  today: z.string(),
  applied: z.array(z.object({ key: z.string(), value: z.string().nullable(), label: z.string().nullable() })),
  range: z.object({ from: z.string(), to: z.string() }).nullable(),
  columns: z.array(columnSchema),
  rows: z.array(z.object({ id: z.string(), record: z.object({ type: z.string(), id: z.string(), label: z.string() }).nullable(), currency: z.string().nullable(), cells })),
  totals: z.object({ rows: z.number(), sums: cells, currency: z.string().nullable(), mixedCurrencies: z.boolean() }),
  groupBy: z.string().nullable(),
  groups: z.array(z.object({ value: z.union([z.string(), z.number()]).nullable(), rows: z.number(), sums: cells, currency: z.string().nullable() })).nullable(),
  rights: z.object({ leftOut: z.array(grain), hiddenGroups: z.number() }).nullable(),
  complete: z.boolean(),
  limit: z.number(),
})
export type ReportResults = z.infer<typeof resultsSchema>
export type ResultRow = ReportResults['rows'][number]
export type ResultGroup = NonNullable<ReportResults['groups']>[number]

export const scheduleSchema = z.object({
  key: z.string(),
  mail: z.string().nullable(),
  schedulable: z.boolean(),
  subscriptions: z.array(
    z.object({
      id: z.string(),
      user: z.object({ id: z.string(), name: z.string() }),
      mine: z.boolean(),
      site: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
      sendTime: z.string(),
      weekdays: z.array(z.number()),
      locale: z.enum(['it', 'en']),
      active: z.boolean(),
      lastSentAt: z.string().nullable(),
    }),
  ),
  manage: z.string().nullable(),
})
export type ReportSchedule = z.infer<typeof scheduleSchema>

export function getLibrary(api: ApiClient, signal?: AbortSignal): Promise<Library> {
  return api.get('/reports', { schema: librarySchema, signal })
}

export function getAbout(api: ApiClient, key: string, signal?: AbortSignal): Promise<ReportAbout> {
  return api.get(`/reports/${encodeURIComponent(key)}`, { schema: aboutSchema, signal })
}

/** One run: the report's own filters by key (null: the default), the grouping (`none`: not grouped), the language. */
export function getResults(api: ApiClient, key: string, query: { filters: Readonly<Record<string, string | null>>; group: string | null; lang: 'it' | 'en' }, signal?: AbortSignal): Promise<ReportResults> {
  const filters = Object.fromEntries(Object.entries(query.filters).filter(([, value]) => value !== null)) as Record<string, string>
  return api.get(`/reports/${encodeURIComponent(key)}/results`, { query: { ...filters, ...(query.group ? { group: query.group } : {}), lang: query.lang }, schema: resultsSchema, signal })
}

export function getSchedule(api: ApiClient, key: string, signal?: AbortSignal): Promise<ReportSchedule> {
  return api.get(`/reports/${encodeURIComponent(key)}/schedule`, { schema: scheduleSchema, signal })
}
