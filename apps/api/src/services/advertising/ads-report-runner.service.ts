/**
 * RPT.3 — the report runner.
 *
 * Turns a ReportQuery into SQL against whichever table the spec names, and
 * returns rows plus the column metadata the client renders from. The client has
 * NO column definitions of its own: labels, formats and alignment all travel with
 * the response, so there is exactly one definition of every column in the system
 * and the grid cannot drift from the export.
 *
 * Injection safety: nothing from the request is ever interpolated into SQL.
 * Column and dimension ids are looked up in the spec and only the spec's own
 * expressions reach the query; every literal (dates, markets, search text,
 * limits) goes through a numbered parameter.
 *
 * `runReport` is deliberately the ONLY way to execute a report. RPT.4's CSV and
 * XLSX writers call it with `page: null` to stream the full result set — same
 * filters, same columns, same ordering, same code path. That is the plan's
 * "export equals what you see" guarantee enforced by construction rather than by
 * remembering to keep two paths in step.
 */
import prisma from '../../db.js'
import {
  REPORT_SPECS,
  specColumns,
  type ColumnMeta,
  type ReportSpec,
} from './ads-report-specs.js'

export interface ReportQuery {
  reportId: string
  /** Inclusive ISO dates (YYYY-MM-DD). */
  from?: string | null
  to?: string | null
  marketplaces?: string[]
  adProducts?: string[]
  search?: string | null
  /** Dimension ids to group by. Empty falls back to the spec's natural grain. */
  groupBy?: string[]
  /** Column ids to return. Empty falls back to the spec's defaults. */
  columns?: string[]
  sort?: { col: string; dir: 'asc' | 'desc' } | null
  /** 1-based. null = no pagination (export path). */
  page?: number | null
  pageSize?: number
}

export interface ReportResult {
  reportId: string
  title: string
  columns: ColumnMeta[]
  rows: Array<Record<string, unknown>>
  /** Same shape as one row, computed over the WHOLE filtered set. */
  totals: Record<string, unknown> | null
  /** Distinct groups matching the filter — the pagination denominator. */
  total: number
  page: number
  pageSize: number
  currency: string
  /** Everything the query actually applied, echoed back for the export manifest. */
  applied: {
    from: string | null
    to: string | null
    marketplaces: string[]
    adProducts: string[]
    search: string | null
    groupBy: string[]
    sort: { col: string; dir: 'asc' | 'desc' }
  }
  /** Available choices, so the client needs no second round trip. */
  options: {
    columns: ColumnMeta[]
    dimensions: Array<{ id: string; label: string }>
    marketplaces: string[]
    adProducts: string[]
  }
  elapsedMs: number
}

const MAX_PAGE_SIZE = 500
const EXPORT_ROW_CAP = 100_000

export class ReportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

/** Postgres identifier for an output column. Ids are spec-controlled, never raw input. */
const alias = (id: string) => `"${id}"`

export function getSpec(reportId: string): ReportSpec {
  const spec = REPORT_SPECS[reportId]
  if (!spec) throw new ReportError(`Unknown report "${reportId}"`, 404)
  return spec
}

export async function runReport(q: ReportQuery): Promise<ReportResult> {
  const started = Date.now()
  const spec = getSpec(q.reportId)

  const dimById = new Map(spec.dimensions.map((d) => [d.id, d]))
  // RPT.12 — operator-defined metrics join the registry as ordinary members
  // rather than getting their own evaluation path, which is what keeps them
  // consistent across the grid, the totals row, the export and the email.
  const { resolveCustomMetrics } = await import('./ads-custom-metrics.service.js')
  const custom = await resolveCustomMetrics(spec.id)
  const allMetrics = [
    ...spec.metrics,
    ...custom.map((c) => ({
      id: c.id, label: c.label, kind: 'metric' as const,
      format: c.format, align: 'right' as const, sql: c.sql,
      help: 'Custom metric.',
    })),
  ]
  const metricById = new Map(allMetrics.map((m) => [m.id, m]))

  // ── grouping ────────────────────────────────────────────────────────────
  const requestedGroup = (q.groupBy ?? []).filter((id) => dimById.has(id))
  const groupBy = requestedGroup.length ? requestedGroup : spec.defaultGroupBy.filter((id) => dimById.has(id))
  if (!groupBy.length) throw new ReportError('At least one grouping dimension is required')

  // ── columns ─────────────────────────────────────────────────────────────
  // A grouped query can only return grouped dimensions, so silently drop any
  // selected dimension that is not in the grouping rather than emitting SQL that
  // Postgres would reject with an opaque "must appear in GROUP BY".
  const requested = (q.columns ?? []).filter((id) => dimById.has(id) || metricById.has(id))
  const wanted = requested.length ? requested : spec.defaultColumns
  const outCols: ColumnMeta[] = []
  const selects: string[] = []
  const seen = new Set<string>()
  for (const id of groupBy) {
    const d = dimById.get(id)!
    seen.add(id)
    selects.push(`${d.sql} AS ${alias(id)}`)
    outCols.push({ id: d.id, label: d.label, kind: 'dimension', format: d.format, align: d.align, help: d.help })
  }
  for (const id of wanted) {
    if (seen.has(id)) continue
    const m = metricById.get(id)
    if (!m) continue // a dimension outside the grouping
    seen.add(id)
    selects.push(`${m.sql} AS ${alias(id)}`)
    outCols.push({ id: m.id, label: m.label, kind: 'metric', format: m.format, align: m.align, help: m.help })
  }
  if (!outCols.some((c) => c.kind === 'metric')) {
    for (const m of allMetrics.slice(0, 5)) {
      selects.push(`${m.sql} AS ${alias(m.id)}`)
      outCols.push({ id: m.id, label: m.label, kind: 'metric', format: m.format, align: m.align, help: m.help })
    }
  }

  // ── filters ─────────────────────────────────────────────────────────────
  // Built once here and reused by the rows, count, totals and freshness queries —
  // and by the export, which calls reportFreshness with the same ReportQuery. A
  // second copy of this logic is exactly how an export starts disagreeing with
  // the grid it claims to mirror.
  const { whereSql, params, markets, adProducts, search } = buildFilters(spec, q)
  const p = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }
  const groupSql = groupBy.map((id) => dimById.get(id)!.sql).join(', ')

  // ── sort ────────────────────────────────────────────────────────────────
  const sortCol = q.sort?.col && seen.has(q.sort.col) ? q.sort.col : spec.defaultSort.col
  const sortDir = q.sort?.dir === 'asc' ? 'ASC' : q.sort?.dir === 'desc' ? 'DESC' : spec.defaultSort.dir.toUpperCase()
  // NULLS LAST in both directions: an undefined ACOS is an absence of data, and
  // parking it at the top of a "worst first" sort would be actively misleading.
  const orderSql = seen.has(sortCol)
    ? `ORDER BY ${alias(sortCol)} ${sortDir} NULLS LAST`
    : `ORDER BY 1 ${sortDir}`

  // ── pagination ──────────────────────────────────────────────────────────
  const isExport = q.page == null
  const pageSize = isExport
    ? EXPORT_ROW_CAP
    : Math.max(1, Math.min(MAX_PAGE_SIZE, q.pageSize ?? 50))
  const page = isExport ? 1 : Math.max(1, q.page ?? 1)
  const offset = isExport ? 0 : (page - 1) * pageSize

  const baseSql = `SELECT ${selects.join(', ')} FROM ${spec.from} ${whereSql} GROUP BY ${groupSql}`
  const rowsSql = `${baseSql} ${orderSql} LIMIT ${p(pageSize)} OFFSET ${p(offset)}`

  // Count of GROUPS, not of underlying rows — it is the pagination denominator.
  const countParams = params.slice(0, params.length - 2)
  const countSql = `SELECT COUNT(*)::int AS n FROM (${baseSql}) g`

  // Totals run the SAME metric expressions over the whole filtered set. They are
  // NOT a fold of the returned page: ACOS across 50 rows is not the average of
  // 50 ACOS values, and a page total would silently answer a different question.
  const totalSelects = outCols
    .filter((c) => c.kind === 'metric')
    .map((c) => `${metricById.get(c.id)!.sql} AS ${alias(c.id)}`)
  const totalsSql = totalSelects.length
    ? `SELECT ${totalSelects.join(', ')} FROM ${spec.from} ${whereSql}`
    : null

  const [rows, countRows, totalsRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(rowsSql, ...params),
    prisma.$queryRawUnsafe<Array<{ n: number }>>(countSql, ...countParams),
    totalsSql
      ? prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(totalsSql, ...countParams)
      : Promise.resolve([]),
  ])

  const [optMarkets, optAdProducts] = await Promise.all([
    spec.marketCol ? distinctValues(spec, spec.marketCol) : Promise.resolve([]),
    spec.adProductCol ? distinctValues(spec, spec.adProductCol) : Promise.resolve([]),
  ])

  return {
    reportId: spec.id,
    title: spec.title,
    columns: outCols,
    rows: rows.map(normalizeRow),
    totals: totalsRows[0] ? normalizeRow(totalsRows[0]) : null,
    total: Number(countRows[0]?.n ?? 0),
    page,
    pageSize,
    currency: spec.currency,
    applied: {
      from: q.from ?? null,
      to: q.to ?? null,
      marketplaces: markets,
      adProducts,
      search: search || null,
      groupBy,
      sort: { col: sortCol, dir: sortDir === 'ASC' ? 'asc' : 'desc' },
    },
    options: {
      columns: [
        ...specColumns(spec),
        ...custom.map((c) => ({
          id: c.id, label: c.label, kind: 'metric' as const,
          format: c.format, align: 'right' as const, help: 'Custom metric.',
        })),
      ],
      dimensions: spec.dimensions.map((d) => ({ id: d.id, label: d.label })),
      marketplaces: optMarkets,
      adProducts: optAdProducts,
    },
    elapsedMs: Date.now() - started,
  }
}

/** Exported so the summary surface builds byte-identical filters. */
export function buildFiltersFor(spec: ReportSpec, q: ReportQuery): BuiltFilters {
  return buildFilters(spec, q)
}

interface BuiltFilters {
  whereSql: string
  params: unknown[]
  markets: string[]
  adProducts: string[]
  search: string
}

/** The WHERE clause for a query, with every literal parameterised. */
function buildFilters(spec: ReportSpec, q: ReportQuery): BuiltFilters {
  const where: string[] = [...spec.fixedWhere]
  const params: unknown[] = []
  const p = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }
  if (q.from) where.push(`${spec.dateCol} >= ${p(q.from)}::date`)
  if (q.to) where.push(`${spec.dateCol} <= ${p(q.to)}::date`)
  const markets = (q.marketplaces ?? []).filter(Boolean)
  if (markets.length && spec.marketCol) where.push(`${spec.marketCol} = ANY(${p(markets)}::text[])`)
  const adProducts = (q.adProducts ?? []).filter(Boolean)
  if (adProducts.length && spec.adProductCol) where.push(`${spec.adProductCol} = ANY(${p(adProducts)}::text[])`)
  const search = (q.search ?? '').trim()
  if (search && spec.searchCols.length) {
    const needle = p(`%${search}%`)
    where.push(`(${spec.searchCols.map((c) => `${c} ILIKE ${needle}`).join(' OR ')})`)
  }
  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
    markets,
    adProducts,
    search,
  }
}

export interface ReportFreshness {
  /** Actual first/last day present in THIS result — not the table's overall span. */
  firstDay: string | null
  lastDay: string | null
  /** Per-market last day and row count, for the export manifest. */
  byMarket: Array<{ marketplace: string; lastDay: string | null; rows: number }>
}

/**
 * How fresh the data behind a specific query is, per market.
 *
 * Exists for the export manifest. A downloaded file outlives the screen it came
 * from, so it has to carry its own answer to "how current was this?" — and per
 * market, because RPT.0 measured Italy running a week behind Germany while the
 * overall figure looked fine. A spreadsheet that hides that is how a stale
 * number becomes a decision.
 */
export async function reportFreshness(q: ReportQuery): Promise<ReportFreshness> {
  const spec = getSpec(q.reportId)
  const { whereSql, params } = buildFilters(spec, q)
  const span = await prisma.$queryRawUnsafe<Array<{ first_day: string | null; last_day: string | null }>>(
    `SELECT TO_CHAR(MIN(${spec.dateCol}), 'YYYY-MM-DD') AS first_day,
            TO_CHAR(MAX(${spec.dateCol}), 'YYYY-MM-DD') AS last_day
     FROM ${spec.from} ${whereSql}`,
    ...params,
  )
  let byMarket: ReportFreshness['byMarket'] = []
  if (spec.marketCol) {
    const rows = await prisma.$queryRawUnsafe<Array<{ mkt: string | null; last_day: string | null; n: number }>>(
      `SELECT ${spec.marketCol} AS mkt,
              TO_CHAR(MAX(${spec.dateCol}), 'YYYY-MM-DD') AS last_day,
              COUNT(*)::int AS n
       FROM ${spec.from} ${whereSql} GROUP BY 1 ORDER BY 3 DESC`,
      ...params,
    )
    byMarket = rows.map((r) => ({
      marketplace: r.mkt ?? 'UNKNOWN',
      lastDay: r.last_day,
      rows: Number(r.n) || 0,
    }))
  }
  return { firstDay: span[0]?.first_day ?? null, lastDay: span[0]?.last_day ?? null, byMarket }
}

/** Distinct filter choices, straight from the data rather than a hard-coded list. */
async function distinctValues(spec: ReportSpec, col: string): Promise<string[]> {
  const fixed = spec.fixedWhere.length ? `WHERE ${spec.fixedWhere.join(' AND ')}` : ''
  const rows = await prisma.$queryRawUnsafe<Array<{ v: string | null }>>(
    `SELECT DISTINCT ${col} AS v FROM ${spec.from} ${fixed} ORDER BY 1`,
  )
  return rows.map((r) => r.v).filter((v): v is string => !!v)
}

/**
 * Postgres numerics arrive as strings and BIGINTs as BigInt — both of which
 * JSON.stringify either mangles or throws on. Convert to plain numbers so the
 * client receives numbers and never has to guess. Dates become YYYY-MM-DD.
 *
 * This is the same family as the ads-console trap where metrics arrive as
 * strings and `Number(null) === 0` silently invents a zero: null stays null here
 * so an undefined ACOS renders as "—" rather than 0%.
 */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v == null) out[k] = null
    else if (typeof v === 'bigint') out[k] = Number(v)
    else if (v instanceof Date) out[k] = v.toISOString().slice(0, 10)
    else if (typeof v === 'object' && v !== null && typeof (v as { toNumber?: () => number }).toNumber === 'function') {
      out[k] = (v as { toNumber: () => number }).toNumber()
    } else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v)
    else out[k] = v
  }
  return out
}
