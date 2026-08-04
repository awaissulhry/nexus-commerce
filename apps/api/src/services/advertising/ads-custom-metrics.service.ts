/**
 * RPT.12 — operator-defined metrics.
 *
 * A custom metric is compiled once, here, and then handed to the runner as an
 * ordinary metric. That is the whole design: it does not get a parallel
 * evaluation path, so it cannot drift from the built-ins. It aggregates in SQL,
 * stays correct at every grouping and in the totals row, and appears identically
 * in the grid, the export, the KPI tiles and the scheduled email.
 *
 * Formulas are validated at WRITE time, not read time. A formula that no longer
 * compiles — because the report's metric set changed under it — is reported as
 * broken rather than silently dropped, so a column that vanishes always has a
 * stated reason.
 */
import prisma from '../../db.js'
import { compileFormula } from './ads-metric-formula.js'
import { REPORT_SPECS, type ColumnFormat, type ReportSpec } from './ads-report-specs.js'

export class CustomMetricError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

const FORMATS: ColumnFormat[] = ['money', 'pct', 'ratio', 'int']
const DIRECTIONS = ['higher', 'lower'] as const

export interface CustomMetricDto {
  id: string
  reportId: string
  name: string
  formula: string
  format: ColumnFormat
  betterWhen: 'higher' | 'lower' | null
  description: string | null
  /** Set when the stored formula no longer compiles against the report. */
  brokenReason: string | null
  usedMetrics: string[]
  createdAt: string
  updatedAt: string
}

/** Metric id → aggregate SQL, for a report's BUILT-IN metrics only. */
function builtinSqlMap(spec: ReportSpec): Map<string, string> {
  return new Map(spec.metrics.map((m) => [m.id, m.sql]))
}

/**
 * A stable, collision-proof column id derived from the name.
 *
 * Prefixed because a custom metric called "cost" must not shadow the built-in
 * one — the formula compiler resolves identifiers against built-ins, so a
 * shadowing id would make `cost` mean different things in different places.
 */
export function customMetricId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `cm_${slug || 'metric'}`
}

function validate(input: { name?: string; formula?: string; format?: string; betterWhen?: string | null }, spec: ReportSpec) {
  const name = (input.name ?? '').trim()
  if (!name) throw new CustomMetricError('A name is required')
  if (name.length > 60) throw new CustomMetricError('The name is too long (60 characters max)')

  const format = (input.format ?? 'ratio') as ColumnFormat
  if (!FORMATS.includes(format)) throw new CustomMetricError(`format must be one of ${FORMATS.join(', ')}`)

  const betterWhen = input.betterWhen ?? null
  if (betterWhen !== null && !DIRECTIONS.includes(betterWhen as never)) {
    throw new CustomMetricError("betterWhen must be 'higher', 'lower', or omitted")
  }

  const { error, usedMetrics } = compileFormula(input.formula ?? '', builtinSqlMap(spec))
  if (error) {
    throw new CustomMetricError(
      error.position != null ? `${error.message} (at position ${error.position + 1})` : error.message,
    )
  }
  return { name, format, betterWhen: betterWhen as 'higher' | 'lower' | null, usedMetrics }
}

function getSpec(reportId: string): ReportSpec {
  const spec = REPORT_SPECS[reportId]
  if (!spec) throw new CustomMetricError(`Unknown report "${reportId}"`, 404)
  return spec
}

const toDto = (
  r: { id: string; reportId: string; name: string; formula: string; format: string; betterWhen: string | null; description: string | null; createdAt: Date; updatedAt: Date },
): CustomMetricDto => {
  const spec = REPORT_SPECS[r.reportId]
  const compiled = spec
    ? compileFormula(r.formula, builtinSqlMap(spec))
    : { error: { message: 'Its report no longer exists' }, usedMetrics: [] as string[], sql: null }
  return {
    id: r.id,
    reportId: r.reportId,
    name: r.name,
    formula: r.formula,
    format: r.format as ColumnFormat,
    betterWhen: (r.betterWhen as 'higher' | 'lower' | null) ?? null,
    description: r.description,
    brokenReason: compiled.error ? compiled.error.message : null,
    usedMetrics: compiled.usedMetrics,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function listCustomMetrics(reportId?: string): Promise<CustomMetricDto[]> {
  const rows = await prisma.customMetric.findMany({
    where: reportId ? { reportId } : {},
    orderBy: { name: 'asc' },
    take: 200,
  })
  return rows.map(toDto)
}

export async function createCustomMetric(input: {
  reportId: string
  name: string
  formula: string
  format?: string
  betterWhen?: string | null
  description?: string | null
}): Promise<CustomMetricDto> {
  const spec = getSpec(input.reportId)
  const { name, format, betterWhen } = validate(input, spec)
  // A custom metric must not shadow a built-in: same name, different meaning.
  if (spec.metrics.some((m) => m.label.toLowerCase() === name.toLowerCase())) {
    throw new CustomMetricError(`"${name}" is already a built-in metric on this report`)
  }
  const created = await prisma.customMetric
    .create({
      data: {
        reportId: input.reportId, name, formula: input.formula.trim(),
        format, betterWhen, description: input.description?.trim() || null,
      },
    })
    .catch((e: unknown) => {
      if (String(e).includes('Unique constraint')) {
        throw new CustomMetricError(`A metric called "${name}" already exists on this report`)
      }
      throw e
    })
  return toDto(created)
}

export async function updateCustomMetric(id: string, input: {
  name?: string; formula?: string; format?: string; betterWhen?: string | null; description?: string | null
}): Promise<CustomMetricDto> {
  const existing = await prisma.customMetric.findUnique({ where: { id } })
  if (!existing) throw new CustomMetricError('Custom metric not found', 404)
  const spec = getSpec(existing.reportId)
  const merged = {
    name: input.name ?? existing.name,
    formula: input.formula ?? existing.formula,
    format: input.format ?? existing.format,
    betterWhen: input.betterWhen === undefined ? existing.betterWhen : input.betterWhen,
  }
  const { name, format, betterWhen } = validate(merged, spec)
  const updated = await prisma.customMetric.update({
    where: { id },
    data: {
      name, formula: merged.formula.trim(), format, betterWhen,
      description: input.description === undefined ? existing.description : (input.description?.trim() || null),
    },
  })
  return toDto(updated)
}

export async function deleteCustomMetric(id: string): Promise<void> {
  const existing = await prisma.customMetric.findUnique({ where: { id } })
  if (!existing) throw new CustomMetricError('Custom metric not found', 404)
  await prisma.customMetric.delete({ where: { id } })
}

/** Compile a formula without saving — powers the live preview while typing. */
export function previewFormula(reportId: string, formula: string): { ok: boolean; error: string | null; usedMetrics: string[] } {
  const spec = getSpec(reportId)
  const { error, usedMetrics } = compileFormula(formula, builtinSqlMap(spec))
  return {
    ok: !error,
    error: error ? (error.position != null ? `${error.message} (at position ${error.position + 1})` : error.message) : null,
    usedMetrics,
  }
}

export interface ResolvedCustomMetric {
  id: string
  label: string
  format: ColumnFormat
  betterWhen: 'higher' | 'lower' | null
  sql: string
}

/**
 * Custom metrics for a report, compiled and ready to hand to the runner as
 * ordinary metrics. Broken formulas are omitted here — they are surfaced on the
 * management surface instead, so a report never fails to run because a metric
 * someone saved months ago no longer compiles.
 */
export async function resolveCustomMetrics(reportId: string): Promise<ResolvedCustomMetric[]> {
  const spec = REPORT_SPECS[reportId]
  if (!spec) return []
  const rows = await prisma.customMetric.findMany({ where: { reportId } }).catch(() => [])
  const builtins = builtinSqlMap(spec)
  const out: ResolvedCustomMetric[] = []
  for (const r of rows) {
    const { sql, error } = compileFormula(r.formula, builtins)
    if (error || !sql) continue
    out.push({
      id: customMetricId(r.name),
      label: r.name,
      format: r.format as ColumnFormat,
      betterWhen: (r.betterWhen as 'higher' | 'lower' | null) ?? null,
      sql,
    })
  }
  return out
}
