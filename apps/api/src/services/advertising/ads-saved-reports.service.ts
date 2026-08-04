/**
 * RPT.5 — saved report definitions.
 *
 * A saved report is a named ReportQuery. It is the unit RPT.6 (scheduled email)
 * and RPT.8 (live Google Sheet) will consume, so it is defined once here rather
 * than reinvented per delivery channel.
 *
 * Version history is append-only and every version carries a HUMAN change note —
 * "date range 2026-07-06→2026-08-04 became 2026-01-01→2026-08-04; added CPC" —
 * computed by diffing the queries. A version list that only says "v4, v3, v2" is
 * decoration; the point of history is being able to see what someone changed and
 * why a number moved.
 *
 * Restoring never rewrites: it appends a NEW version whose content equals the old
 * one. History you can edit is not history.
 */
import prisma from '../../db.js'
import { getSpec } from './ads-report-runner.service.js'
import type { ReportQuery } from './ads-report-runner.service.js'

/** The persisted half of a ReportQuery — pagination deliberately excluded. */
export interface SavedQuery {
  reportId: string
  from: string | null
  to: string | null
  marketplaces: string[]
  adProducts: string[]
  search: string | null
  groupBy: string[]
  columns: string[]
  sort: { col: string; dir: 'asc' | 'desc' } | null
}

export class SavedReportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

/**
 * Normalise anything query-shaped into the canonical stored form.
 *
 * Page and pageSize are dropped on purpose: "page 3" is a scroll position, not
 * part of what a report means, and storing it would make a scheduled email start
 * halfway down its own results.
 */
export function normalizeQuery(input: Partial<SavedQuery> & { reportId: string }): SavedQuery {
  getSpec(input.reportId) // throws 404 for an unknown report before anything is written
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : []
  const s = typeof input.search === 'string' ? input.search.trim() : ''
  return {
    reportId: input.reportId,
    from: input.from || null,
    to: input.to || null,
    marketplaces: arr(input.marketplaces),
    adProducts: arr(input.adProducts),
    search: s || null,
    groupBy: arr(input.groupBy),
    columns: arr(input.columns),
    sort: input.sort?.col ? { col: input.sort.col, dir: input.sort.dir === 'asc' ? 'asc' : 'desc' } : null,
  }
}

/** A saved query is directly runnable — the runner adds only pagination. */
export function toReportQuery(q: SavedQuery, page: number | null, pageSize?: number): ReportQuery {
  return { ...q, sort: q.sort, page, pageSize }
}

const listDiff = (label: string, before: string[], after: string[]): string | null => {
  const added = after.filter((x) => !before.includes(x))
  const removed = before.filter((x) => !after.includes(x))
  if (!added.length && !removed.length) return null
  const bits: string[] = []
  if (added.length) bits.push(`added ${added.join(', ')}`)
  if (removed.length) bits.push(`removed ${removed.join(', ')}`)
  return `${label}: ${bits.join('; ')}`
}

/** Plain-language summary of what changed between two saved queries. */
export function describeChange(
  before: SavedQuery | null,
  after: SavedQuery,
  nameBefore?: string,
  nameAfter?: string,
): string {
  if (!before) return 'Created'
  const parts: string[] = []
  if (nameBefore && nameAfter && nameBefore !== nameAfter) {
    parts.push(`renamed "${nameBefore}" → "${nameAfter}"`)
  }
  if (before.from !== after.from || before.to !== after.to) {
    parts.push(`window ${before.from ?? 'any'}→${before.to ?? 'any'} became ${after.from ?? 'any'}→${after.to ?? 'any'}`)
  }
  for (const [label, b, a] of [
    ['markets', before.marketplaces, after.marketplaces],
    ['ad products', before.adProducts, after.adProducts],
    ['grouping', before.groupBy, after.groupBy],
    ['columns', before.columns, after.columns],
  ] as const) {
    const d = listDiff(label, b, a)
    if (d) parts.push(d)
  }
  if ((before.search ?? '') !== (after.search ?? '')) {
    parts.push(after.search ? `search "${after.search}"` : 'search cleared')
  }
  const sortKey = (s: SavedQuery['sort']) => (s ? `${s.col} ${s.dir}` : 'default')
  if (sortKey(before.sort) !== sortKey(after.sort)) {
    parts.push(`sort ${sortKey(before.sort)} → ${sortKey(after.sort)}`)
  }
  return parts.length ? parts.join('; ') : 'Saved with no changes'
}

export interface SavedReportDto {
  id: string
  reportId: string
  name: string
  description: string | null
  query: SavedQuery
  version: number
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
}

const toDto = (r: {
  id: string; reportId: string; name: string; description: string | null; query: unknown
  version: number; lastRunAt: Date | null; createdAt: Date; updatedAt: Date
}): SavedReportDto => ({
  id: r.id,
  reportId: r.reportId,
  name: r.name,
  description: r.description,
  query: r.query as SavedQuery,
  version: r.version,
  lastRunAt: r.lastRunAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
})

export async function listSavedReports(reportId?: string): Promise<SavedReportDto[]> {
  const rows = await prisma.savedReport.findMany({
    where: { isArchived: false, ...(reportId ? { reportId } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })
  return rows.map(toDto)
}

export async function getSavedReport(id: string): Promise<SavedReportDto> {
  const row = await prisma.savedReport.findUnique({ where: { id } })
  if (!row || row.isArchived) throw new SavedReportError('Saved report not found', 404)
  return toDto(row)
}

export async function createSavedReport(input: {
  name: string
  description?: string | null
  query: Partial<SavedQuery> & { reportId: string }
}): Promise<SavedReportDto> {
  const name = input.name?.trim()
  if (!name) throw new SavedReportError('A name is required')
  const query = normalizeQuery(input.query)

  // The first version is written in the same transaction as the report itself —
  // a saved report with no version row would be history with a hole at the start.
  const created = await prisma.$transaction(async (tx) => {
    const report = await tx.savedReport.create({
      data: {
        reportId: query.reportId,
        name,
        description: input.description?.trim() || null,
        query: query as unknown as object,
        version: 1,
      },
    })
    await tx.savedReportVersion.create({
      data: {
        savedReportId: report.id,
        version: 1,
        name: report.name,
        description: report.description,
        query: query as unknown as object,
        changeNote: describeChange(null, query),
      },
    })
    return report
  })
  return toDto(created)
}

export async function updateSavedReport(id: string, input: {
  name?: string
  description?: string | null
  query?: Partial<SavedQuery> & { reportId: string }
}): Promise<SavedReportDto> {
  const existing = await prisma.savedReport.findUnique({ where: { id } })
  if (!existing || existing.isArchived) throw new SavedReportError('Saved report not found', 404)

  const before = existing.query as unknown as SavedQuery
  const query = input.query ? normalizeQuery(input.query) : before
  if (query.reportId !== existing.reportId) {
    // Changing which report a definition points at would silently invalidate its
    // whole history — the versions would describe a different dataset.
    throw new SavedReportError('A saved report cannot be pointed at a different report')
  }
  const name = input.name?.trim() || existing.name
  const description = input.description === undefined
    ? existing.description
    : (input.description?.trim() || null)
  const nextVersion = existing.version + 1

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.savedReport.update({
      where: { id },
      data: { name, description, query: query as unknown as object, version: nextVersion },
    })
    await tx.savedReportVersion.create({
      data: {
        savedReportId: id,
        version: nextVersion,
        name,
        description,
        query: query as unknown as object,
        changeNote: describeChange(before, query, existing.name, name),
      },
    })
    return row
  })
  return toDto(updated)
}

export interface SavedVersionDto {
  id: string
  version: number
  name: string
  description: string | null
  query: SavedQuery
  changeNote: string | null
  createdAt: string
  isCurrent: boolean
}

export async function listVersions(id: string): Promise<SavedVersionDto[]> {
  const report = await prisma.savedReport.findUnique({ where: { id }, select: { version: true } })
  if (!report) throw new SavedReportError('Saved report not found', 404)
  const rows = await prisma.savedReportVersion.findMany({
    where: { savedReportId: id },
    orderBy: { version: 'desc' },
    take: 100,
  })
  return rows.map((v) => ({
    id: v.id,
    version: v.version,
    name: v.name,
    description: v.description,
    query: v.query as unknown as SavedQuery,
    changeNote: v.changeNote,
    createdAt: v.createdAt.toISOString(),
    isCurrent: v.version === report.version,
  }))
}

/** Restore by APPENDING the old content as a new version — never by deleting. */
export async function restoreVersion(id: string, version: number): Promise<SavedReportDto> {
  const old = await prisma.savedReportVersion.findUnique({
    where: { savedReportId_version: { savedReportId: id, version } },
  })
  if (!old) throw new SavedReportError('Version not found', 404)
  const existing = await prisma.savedReport.findUnique({ where: { id } })
  if (!existing) throw new SavedReportError('Saved report not found', 404)

  const query = old.query as unknown as SavedQuery
  const nextVersion = existing.version + 1
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.savedReport.update({
      where: { id },
      data: { name: old.name, description: old.description, query: query as unknown as object, version: nextVersion },
    })
    await tx.savedReportVersion.create({
      data: {
        savedReportId: id,
        version: nextVersion,
        name: old.name,
        description: old.description,
        query: query as unknown as object,
        changeNote: `Restored from v${version}`,
      },
    })
    return row
  })
  return toDto(updated)
}

/**
 * Archive rather than delete. A scheduled email (RPT.6) will reference a saved
 * report by id; hard-deleting one would leave a schedule pointing at nothing,
 * and the operator would get silence instead of an error.
 */
export async function archiveSavedReport(id: string): Promise<void> {
  const existing = await prisma.savedReport.findUnique({ where: { id } })
  if (!existing) throw new SavedReportError('Saved report not found', 404)
  await prisma.savedReport.update({ where: { id }, data: { isArchived: true } })
}

export async function markRun(id: string): Promise<void> {
  await prisma.savedReport.update({ where: { id }, data: { lastRunAt: new Date() } }).catch(() => {
    /* a missing report must never fail the run that triggered this */
  })
}
