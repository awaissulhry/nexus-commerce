/**
 * Negative Targeting page, Rules view (2026-10-11) — every call the view makes. Reads: the stop-waste rules (list,
 * preview, history), the rows waiting for a person. Writes, each only after the person saved it in a review: a rule's
 * mode, archive / unarchive, an Undo of one change, approve / reject of waiting asks. Rules are made and edited in the
 * rule builder (wave 4). Every refusal comes back in the server's own words (`refusalWords`, the Bid page's one helper).
 * The stored rule and the undo preview are the Bid page's own reads (`bid/rules/ruleApi.ts`).
 *
 * All under /api/advertising/waste (routes/advertising-waste.routes.ts), except the undo route every page shares
 * (POST /advertising/changes/:id/undo) and a rule card's restore (POST /advertising/suggestions/:id/restore).
 */
import { getBackendUrl } from '@/lib/backend-url'
import { refusalWords } from '../../bid/rules/ruleChanges'
import type { BidMode } from '../../bid/rules/bidRulesModel'
import type { ArchiveAnswer, WaitingRow, WasteHistory, WastePreview, WasteRulesAnswer } from './wasteRulesModel'

const api = (path: string) => `${getBackendUrl()}/api/advertising${path}`
const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(refusalWords(res.status, body))
  return body as T
}

export type Outcome<T = unknown> = { ok: true; body: T } | { ok: false; words: string }

async function send<T = unknown>(path: string, method: 'POST' | 'PATCH', body?: unknown): Promise<Outcome<T>> {
  try {
    const res = await fetch(api(path), { method, headers: JSON_HEADERS, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const j = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, words: refusalWords(res.status, j) }
    return { ok: true, body: j as T }
  } catch (e) {
    return { ok: false, words: `No answer: ${(e as Error).message}` }
  }
}

export const marketQuery = (market: string) => (market && market !== 'all' ? `market=${encodeURIComponent(market)}` : '')

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function fetchWasteRules(market: string): Promise<WasteRulesAnswer> {
  const q = ['channel=AMAZON', marketQuery(market)].filter(Boolean).join('&')
  return readJson(await fetch(api(`/waste/rules?${q}`), { cache: 'no-store' }))
}

/** A saved rule's preview: what it would stop now. Writes nothing. */
export async function fetchWastePreview(body: { ruleId: string }, limit = 50, signal?: AbortSignal): Promise<WastePreview> {
  return readJson(await fetch(api('/waste/rules/preview'), { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ...body, limit }), cache: 'no-store', signal }))
}

export async function fetchWasteHistory(id: string, days: number, market: string): Promise<WasteHistory> {
  const q = [`days=${days}`, marketQuery(market)].filter(Boolean).join('&')
  return readJson(await fetch(api(`/waste/rules/${encodeURIComponent(id)}/history?${q}`), { cache: 'no-store' }))
}

/** The rows waiting for a person in this market (every owner); the view keeps a rule's own. */
export const WAITING_PAGE = 200
export async function fetchWaitingRows(market: string): Promise<{ rows: WaitingRow[]; total: number }> {
  const q = ['show=waiting', `pageSize=${WAITING_PAGE}`, marketQuery(market)].filter(Boolean).join('&')
  const j = await readJson<{ rows?: WaitingRow[]; total?: number }>(await fetch(api(`/waste/rows?${q}`), { cache: 'no-store' }))
  const rows = Array.isArray(j.rows) ? j.rows : []
  return { rows, total: typeof j.total === 'number' ? j.total : rows.length }
}

// ── writes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ModeResult { id: string; ok: boolean; level?: string; error?: string }
/** Off · Watch · Ask me · Auto for many rules: a result per rule (one refusal never stops the others). */
export async function saveModes(ids: readonly string[], mode: BidMode): Promise<{ ok: true; results: ModeResult[] } | { ok: false; words: string }> {
  const out = await send<{ results?: ModeResult[] }>('/waste/rules/mode', 'POST', { ids, mode })
  if (!out.ok) return out
  return { ok: true, results: Array.isArray(out.body?.results) ? out.body.results : [] }
}

export const archiveRule = (id: string) => send<ArchiveAnswer>(`/waste/rules/${encodeURIComponent(id)}/archive`, 'POST', {})
export const unarchiveRule = (id: string) => send<ArchiveAnswer>(`/waste/rules/${encodeURIComponent(id)}/unarchive`, 'POST', {})

/** POST /changes/:id/undo — the server re-checks the window, whether it already went and whether it reached Amazon. */
export async function undoChange(changeId: string): Promise<Outcome> {
  const out = await send<{ reversed?: number; reason?: string }>(`/changes/${encodeURIComponent(changeId)}/undo`, 'POST', { reason: 'undone from the Negative Targeting page' })
  if (!out.ok) return out
  if (!out.body?.reversed) return { ok: false, words: out.body?.reason ?? 'Nothing was reversed.' }
  return out
}

/** An expired (or dismissed) rule card waits again — the Undo of an archive brings its asks back (audit S7). */
export const restoreSuggestion = (id: string) => send(`/suggestions/${encodeURIComponent(id)}/restore`, 'POST', {})
