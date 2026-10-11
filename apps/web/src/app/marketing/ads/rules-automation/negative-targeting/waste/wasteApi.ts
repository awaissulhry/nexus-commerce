/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — every read and write the page makes, each through a route that
 * exists (the hrefs in the answers have no `/w/<id>` prefix: the workspace `Link` adds it).
 *
 *   GET  /api/advertising/waste/rows?<scope>&kind=&show=&q=&sort=&page=&pageSize=    the Wasting view
 *   GET  /api/advertising/waste/rows/ids?<same>                                       "select all N that match", Prev / Next
 *   GET  /api/advertising/waste/stopped?<scope>&kind=&show=&q=&page=&pageSize=        the Stopped view
 *   GET  /api/advertising/waste/row/:id                                               one row: where it runs, history
 *   POST /api/advertising/waste/preview { items }                                     the review (writes nothing)
 *   POST /api/advertising/waste/apply { planHash, items, code? }                      one change set, approved by the person
 *   POST /api/advertising/waste/skip { ids, days | until } · /unskip { ids }          Nexus only
 *   POST /api/advertising/waste/waiting/decide { decisions }                          Approve / Reject on the page
 *   POST /api/agent/fleet/approvals/:id/undo                                          Undo inside the 20 s window
 *   POST /api/claude/changes/:id/undo                                                 Undo of a change set that ran
 *   POST /api/advertising/changes/:id/undo                                            Undo of one history row
 */
import { getBackendUrl } from '@/lib/backend-url'
import { listSearch, type ListQuery } from './wasteModel'
import type { ApplyAnswer, DecideResult, IdsAnswer, PreviewAnswer, RowDetail, RowsAnswer, StoppedAnswer, StoppedRow, WaitingSteps, WasteItem, WasteRow } from './wasteTypes'

const WASTE = '/api/advertising/waste'

/** A refusal's own words, else "HTTP 500" — never a sentence that repeats the title the page puts above it. */
async function said(r: Response): Promise<string> {
  const body = (await r.json().catch(() => null)) as { error?: unknown; reason?: unknown } | null
  const w = typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : null
  return w ?? `HTTP ${r.status}`
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${getBackendUrl()}${path}`, { cache: 'no-store', signal })
  if (!r.ok) throw new Error(await said(r))
  return (await r.json()) as T
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${getBackendUrl()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  return { status: r.status, body: ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown> }
}

const errorOf = (b: Record<string, unknown>, status: number) => (typeof b.error === 'string' && b.error.trim() ? b.error.trim() : `HTTP ${status}`)

export const readRows = (q: ListQuery, signal?: AbortSignal) => getJson<RowsAnswer>(`${WASTE}/rows${listSearch(q)}`, signal)
export const readRowIds = (q: ListQuery, signal?: AbortSignal) => getJson<IdsAnswer>(`${WASTE}/rows/ids${listSearch({ ...q, page: undefined, pageSize: undefined })}`, signal)
export const readStopped = (q: ListQuery, signal?: AbortSignal) => getJson<StoppedAnswer>(`${WASTE}/stopped${listSearch(q)}`, signal)
export const readRow = (id: string, signal?: AbortSignal) => getJson<RowDetail>(`${WASTE}/row/${encodeURIComponent(id)}`, signal)

/** The server's largest page. */
const MAX_PAGE = 200

/** Every row the list matches, page by page (export, select all, Prev / Next across pages), at most `cap`. */
export async function readAllRows(q: ListQuery, cap = 5000): Promise<WasteRow[]> {
  const out: WasteRow[] = []
  for (let page = 1; out.length < cap; page++) {
    const a = await readRows({ ...q, page, pageSize: MAX_PAGE })
    out.push(...a.rows)
    if (!a.rows.length || out.length >= a.total) break
  }
  return out.slice(0, cap)
}
export async function readAllStopped(q: ListQuery, cap = 5000): Promise<StoppedRow[]> {
  const out: StoppedRow[] = []
  for (let page = 1; out.length < cap; page++) {
    const a = await readStopped({ ...q, page, pageSize: MAX_PAGE })
    out.push(...a.rows)
    if (!a.rows.length || out.length >= a.total) break
  }
  return out.slice(0, cap)
}

/** The preview of the rows' changes (writes nothing). Throws the server's own words. */
export async function previewWaste(items: readonly WasteItem[]): Promise<PreviewAnswer> {
  const r = await post(`${WASTE}/preview`, { items })
  if (r.status !== 200) throw new Error(errorOf(r.body, r.status))
  return r.body as unknown as PreviewAnswer
}

/** Apply what was previewed: 200 applied · 202 queued / waiting · 409 the preview moved · 400 refused. Never throws. */
export async function applyWaste(planHash: string, items: readonly WasteItem[], code?: string): Promise<{ status: number; body: ApplyAnswer }> {
  try {
    const r = await post(`${WASTE}/apply`, { planHash, items, ...(code ? { code } : {}) })
    return { status: r.status, body: r.body as ApplyAnswer }
  } catch (e) {
    return { status: 0, body: { error: e instanceof Error ? e.message : 'No answer from the server.' } }
  }
}

export interface SkipAnswer { ok: boolean; error?: string; skipped?: Array<{ rowId: string; until: string }>; undo?: unknown }

/** Skip rows for 7 or 30 d; or reopen the very skips an Unskip ended (its Undo: the same start, person, end and reason). */
export async function skipRows(ids: readonly string[], args: { days: 7 | 30 } | { until: string } | { reopen: string[] }): Promise<SkipAnswer> {
  try {
    const r = await post(`${WASTE}/skip`, 'reopen' in args ? { reopen: args.reopen } : { ids, ...args })
    return r.status === 200 ? { ok: true, ...(r.body as object) } : { ok: false, error: errorOf(r.body, r.status) }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'No answer from the server.' } }
}

export interface UnskipAnswer { ok: boolean; error?: string; unskipped?: number; undo?: { body: { reopen?: string[]; ids?: string[]; until?: string } } | Array<{ body: { ids: string[]; until: string } }> | null }

export async function unskipRows(ids: readonly string[]): Promise<UnskipAnswer> {
  try {
    const r = await post(`${WASTE}/unskip`, { ids })
    return r.status === 200 ? { ok: true, ...(r.body as object) } : { ok: false, error: errorOf(r.body, r.status) }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'No answer from the server.' } }
}

/** NFIX — every step of a waiting request (a change plan is decided whole): what, where, from → to. */
export function readWaitingSteps(approvalId: string, signal?: AbortSignal): Promise<WaitingSteps> {
  return getJson<WaitingSteps>(`${WASTE}/waiting/${encodeURIComponent(approvalId)}`, signal)
}

/** Approve or reject waiting requests, each through the Approvals page's path. Never throws: a result per request. */
export async function decideWaiting(decisions: ReadonlyArray<{ approvalId: string; decide: 'approve' | 'reject'; code?: string }>): Promise<DecideResult[]> {
  try {
    const r = await post(`${WASTE}/waiting/decide`, { decisions })
    const results = (r.body as { results?: DecideResult[] }).results
    if (Array.isArray(results)) return results
    return decisions.map((d) => ({ approvalId: d.approvalId, decide: d.decide, ok: false, error: errorOf(r.body, r.status) }))
  } catch (e) {
    return decisions.map((d) => ({ approvalId: d.approvalId, decide: d.decide, ok: false, error: e instanceof Error ? e.message : 'No answer from the server.' }))
  }
}

/** Take back an approve inside its 20 s window: the request goes back to waiting. */
export async function takeBackApproval(approvalId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await post(`/api/agent/fleet/approvals/${encodeURIComponent(approvalId)}/undo`, {})
    return r.status === 200 ? { ok: true } : { ok: false, error: errorOf(r.body, r.status) }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'No answer from the server.' } }
}

/** A rejected rule card back to waiting (the Suggestions page's own restore). */
export async function restoreCard(suggestionId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await post(`/api/advertising/suggestions/${encodeURIComponent(suggestionId)}/restore`, {})
    return r.status === 200 && r.body.ok !== false ? { ok: true } : { ok: false, error: errorOf(r.body, r.status) }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'No answer from the server.' } }
}

/** Undo a change set (or one step) that ran: the inverse, approved by this click (Claude's activity page path). */
export async function undoChangeSet(changeId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await post(`/api/claude/changes/${encodeURIComponent(changeId)}/undo`, {})
    return r.status === 200 ? { ok: true } : { ok: false, error: errorOf(r.body, r.status) }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'No answer from the server.' } }
}

/** Undo one recorded change (a history row's `changeId`). */
export async function undoActionLog(changeId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await post(`/api/advertising/changes/${encodeURIComponent(changeId)}/undo`, { reason: 'Negative Targeting page' })
    return r.status === 200 && r.body.ok !== false ? { ok: true } : { ok: false, error: typeof r.body.reason === 'string' ? r.body.reason : errorOf(r.body, r.status) }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'No answer from the server.' } }
}
