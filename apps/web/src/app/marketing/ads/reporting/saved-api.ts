/**
 * RPT.5 — client contract for saved report definitions.
 *
 * A saved report is a named ReportQuery. It carries no page number: "page 3" is
 * a scroll position, not part of what a report means.
 */
import { getBackendUrl } from '@/lib/backend-url'
import type { ReportParams } from './report-api'

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

export interface SavedReport {
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

export interface SavedVersion {
  id: string
  version: number
  name: string
  description: string | null
  query: SavedQuery
  changeNote: string | null
  createdAt: string
  isCurrent: boolean
}

const base = () => `${getBackendUrl()}/api/advertising/reporting/saved`

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed (${res.status})`)
  }
  return (await res.json()) as T
}

export const listSaved = (reportId?: string) =>
  call<{ items: SavedReport[] }>(`${base()}${reportId ? `?reportId=${encodeURIComponent(reportId)}` : ''}`)
    .then((r) => r.items)

export const listVersions = (id: string) =>
  call<{ items: SavedVersion[] }>(`${base()}/${id}/versions`).then((r) => r.items)

export const createSaved = (name: string, query: SavedQuery, description?: string) =>
  call<SavedReport>(base(), { method: 'POST', body: JSON.stringify({ name, description, query }) })

export const updateSaved = (id: string, patch: { name?: string; description?: string; query?: SavedQuery }) =>
  call<SavedReport>(`${base()}/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })

export const restoreVersion = (id: string, version: number) =>
  call<SavedReport>(`${base()}/${id}/restore`, { method: 'POST', body: JSON.stringify({ version }) })

export const archiveSaved = (id: string) =>
  call<{ ok: boolean }>(`${base()}/${id}`, { method: 'DELETE' })

/** The runner's live params reduced to what a saved report stores. */
export function paramsToQuery(p: ReportParams): SavedQuery {
  return {
    reportId: p.reportId,
    from: p.from || null,
    to: p.to || null,
    marketplaces: p.marketplaces,
    adProducts: p.adProducts,
    search: p.search.trim() || null,
    groupBy: p.groupBy,
    columns: p.columns,
    sort: p.sortCol ? { col: p.sortCol, dir: p.sortDir } : null,
  }
}

/** Apply a saved query back onto runner params, resetting pagination. */
export function queryToParams(q: SavedQuery, current: ReportParams): ReportParams {
  return {
    ...current,
    reportId: q.reportId,
    from: q.from ?? current.from,
    to: q.to ?? current.to,
    marketplaces: q.marketplaces,
    adProducts: q.adProducts,
    search: q.search ?? '',
    groupBy: q.groupBy,
    columns: q.columns,
    sortCol: q.sort?.col ?? null,
    sortDir: q.sort?.dir ?? 'desc',
    page: 1,
  }
}

/**
 * True when the live params differ from what was saved — drives "unsaved changes".
 *
 * Compared field by field into a fixed-order tuple, NOT by stringifying the
 * objects. Postgres JSONB does not preserve object key order: a query saved as
 * {reportId, from, to, …} comes back as {to, from, sort, …}, so a whole-object
 * JSON.stringify always differed and the badge was pinned to "Unsaved changes"
 * from the moment you loaded a report — which trains you to ignore it, exactly
 * when it is the one thing that must be believed.
 *
 * Set-like fields are sorted before comparison; ORDERED fields (groupBy, columns)
 * are not, because reordering those genuinely changes the output.
 */
export function queryDiffers(a: SavedQuery, b: SavedQuery): boolean {
  const canon = (q: SavedQuery) =>
    JSON.stringify([
      q.reportId,
      q.from ?? '',
      q.to ?? '',
      [...q.marketplaces].sort(),
      [...q.adProducts].sort(),
      q.search ?? '',
      q.groupBy,
      q.columns,
      q.sort ? `${q.sort.col}:${q.sort.dir}` : '',
    ])
  return canon(a) !== canon(b)
}
