/**
 * Keyword Harvest page — every call to the harvest API, ONE client for the three lanes (2026-10-11, wave 2). Shapes:
 * `./types.ts`. Contract: `02-harvest/HCORE-API.md`. Every route is `/api/advertising/harvest/…`, never cached.
 *
 * A read throws the server's own words (`{ error }`), else "HTTP <status>" — never a sentence that repeats the title the
 * page puts above it. A write never throws: it answers `{ ok: true, data }` or `{ ok: false, status, words }` (409 =
 * the plan moved since the preview → preview again), so a review can show the refusal in its own row.
 *
 * Nothing here writes to Amazon: apply and undo are ONE approval request each; skip / unskip and the rules / sources
 * writes are Nexus settings.
 */
import { getBackendUrl } from '@/lib/backend-url'
import { addApiParams } from '../../_shared/scopeFilter/scopeFilterModel'
import type {
  ApplyAnswer, ApplyBody, CandidateQuery, CandidatesAnswer, DecideAnswer, HarvestDestinations, HarvestMatch,
  HarvestRulesAnswer, HarvestSourcesAnswer, HistoryAnswer, HistoryQuery, PreviewAnswer, PreviewBody,
  RuleArchiveAnswer, RuleHistoryAnswer, RulePreviewAnswer, RulePreviewBody, SkipAnswer, SkipDays,
  SourcesAssignAnswer, SourcesDetachAnswer, SourcesPauseAnswer, SourcesResumeAnswer, UndoAnswer, UndoBody, WaitingDecision,
} from './types'

const BASE = '/api/advertising/harvest'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** A write's answer: the body, or the refusal in the server's words with its status (409: the plan moved). */
export type Sent<T> = { ok: true; data: T } | { ok: false; status: number; words: string }

/** The server's own words from a refusal body, else "HTTP <status>". Pure. */
export function refusalOf(status: number, body: unknown): string {
  const said = body && typeof body === 'object' ? (body as { error?: unknown }).error : null
  if (typeof said === 'string' && said.trim()) return said.trim()
  return `HTTP ${status}`
}

/** The query string of a candidates read (only what is set; `state` and comma lists joined). Pure, without '?'. */
export function candidateSearch(q: CandidateQuery): string {
  const out = new URLSearchParams()
  out.set('market', q.market && q.market.trim() ? q.market.trim() : 'all')
  const put = (k: string, v: string | number | null | undefined) => { if (v != null && String(v).trim() !== '') out.set(k, String(v).trim()) }
  put('productId', q.productId)
  put('portfolioId', q.portfolioId)
  put('campaignId', q.campaignId)
  put('adGroupId', q.adGroupId)
  addApiParams(out, q.lists)
  if (q.state?.length) out.set('state', q.state.join(','))
  put('owner', q.owner)
  put('kind', q.kind)
  put('q', q.q)
  put('page', q.page)
  put('pageSize', q.pageSize)
  put('sort', q.sort)
  return out.toString()
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${getBackendUrl()}${BASE}${path}`, { cache: 'no-store' })
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new Error(refusalOf(r.status, body))
  return body as T
}

async function send<T>(path: string, body: unknown): Promise<Sent<T>> {
  try {
    const r = await fetch(`${getBackendUrl()}${BASE}${path}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body ?? {}), cache: 'no-store' })
    const j = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, status: r.status, words: refusalOf(r.status, j) }
    return { ok: true, data: j as T }
  } catch (e) {
    return { ok: false, status: 0, words: `No answer: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ── terms ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** GET /candidates — one page of terms, the tiles' totals, the bar and the data day. */
export const readCandidates = (q: CandidateQuery): Promise<CandidatesAnswer> => getJson(`/candidates?${candidateSearch(q)}`)

/** GET /destinations — the product's portfolio → campaign → ad group tree, by a candidate or by market + product. */
export function readDestinations(by: { candidateId: string; match?: HarvestMatch } | { market: string; productId: string; match?: HarvestMatch }): Promise<HarvestDestinations> {
  const qs = new URLSearchParams()
  if ('candidateId' in by) qs.set('candidateId', by.candidateId)
  else { qs.set('market', by.market); qs.set('productId', by.productId) }
  if (by.match) qs.set('match', by.match)
  return getJson(`/destinations?${qs}`)
}

/** GET /history — harvest records (every actor), judged, with undo availability. */
export function readHistory(q: HistoryQuery): Promise<HistoryAnswer> {
  const qs = new URLSearchParams({ market: q.market && q.market.trim() ? q.market.trim() : 'all' })
  if (q.productId) qs.set('productId', q.productId)
  if (q.days) qs.set('days', String(q.days))
  if (q.actor) qs.set('actor', q.actor)
  if (q.verdict) qs.set('verdict', q.verdict)
  return getJson(`/history?${qs}`)
}

/** POST /preview — the change set step by step, with its planHash. Writes nothing. */
export const previewHarvest = (body: PreviewBody): Promise<Sent<PreviewAnswer>> => send('/preview', body)

/** POST /apply — ONE apply-harvest request (202). 409: the plan moved since the preview → preview again. */
export const applyHarvest = (body: ApplyBody): Promise<Sent<ApplyAnswer>> => send('/apply', body)

/** POST /undo — ONE request: lift the blocks each harvest added, then pause its keyword (never archive). */
export const undoHarvests = (body: UndoBody): Promise<Sent<UndoAnswer>> => send('/undo', body)

/** POST /skip — hide terms 7 d, 30 d or for good (Nexus only, at once; unskip is its undo). */
export const skipTerms = (ids: readonly string[], days: SkipDays): Promise<Sent<SkipAnswer>> => send('/skip', { ids, days })

/** POST /unskip — show skipped terms again. */
export const unskipTerms = (ids: readonly string[]): Promise<Sent<SkipAnswer>> => send('/unskip', { ids })

/** POST /waiting/decide — approve / reject harvest requests as the person on the page (the Approvals page's own path). */
export const decideWaiting = (decisions: readonly WaitingDecision[], reason?: string): Promise<Sent<DecideAnswer>> =>
  send('/waiting/decide', { decisions, ...(reason ? { reason } : {}) })

// ── rules ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const marketParam = (market: string | null | undefined) => (market && market !== 'all' ? `?market=${encodeURIComponent(market)}` : '')

export const readHarvestRules = (market: string | null): Promise<HarvestRulesAnswer> => getJson(`/rules${marketParam(market)}`)

export function readRuleHistory(id: string, opts: { market?: string | null; days?: number; limit?: number } = {}): Promise<RuleHistoryAnswer> {
  const qs = new URLSearchParams()
  if (opts.market && opts.market !== 'all') qs.set('market', opts.market)
  if (opts.days) qs.set('days', String(opts.days))
  if (opts.limit) qs.set('limit', String(opts.limit))
  const s = qs.toString()
  return getJson(`/rules/${encodeURIComponent(id)}/history${s ? `?${s}` : ''}`)
}

export const previewHarvestRule = (body: RulePreviewBody): Promise<Sent<RulePreviewAnswer>> => send('/rules/preview', body)
export const archiveHarvestRule = (id: string): Promise<Sent<RuleArchiveAnswer>> => send(`/rules/${encodeURIComponent(id)}/archive`, {})
export const unarchiveHarvestRule = (id: string): Promise<Sent<RuleArchiveAnswer>> => send(`/rules/${encodeURIComponent(id)}/unarchive`, {})

// ── sources ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const readHarvestSources = (market: string): Promise<HarvestSourcesAnswer> => getJson(`/sources?market=${encodeURIComponent(market)}`)
export const assignSources = (ruleId: string, adGroupIds: readonly string[]): Promise<Sent<SourcesAssignAnswer>> => send('/sources/assign', { ruleId, adGroupIds })
export const detachSources = (adGroupIds: readonly string[], ruleId?: string | null): Promise<Sent<SourcesDetachAnswer>> =>
  send('/sources/detach', { adGroupIds, ...(ruleId ? { ruleId } : {}) })
export const pauseSources = (adGroupIds: readonly string[], reason?: string): Promise<Sent<SourcesPauseAnswer>> =>
  send('/sources/pause', { adGroupIds, ...(reason ? { reason } : {}) })
export const resumeSources = (adGroupIds: readonly string[]): Promise<Sent<SourcesResumeAnswer>> => send('/sources/resume', { adGroupIds })

// ── an approval's undo window ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Take back an approve that has not run yet (the approvals' own undo window: POST /api/agent/fleet/approvals/:id/undo).
 * The Done screen's Undo after an Approve, a harvest or an undo of a harvest approved on this page.
 */
export async function takeBackApproval(approvalId: string): Promise<Sent<unknown>> {
  try {
    const r = await fetch(`${getBackendUrl()}/api/agent/fleet/approvals/${encodeURIComponent(approvalId)}/undo`, { method: 'POST', headers: JSON_HEADERS, body: '{}', cache: 'no-store' })
    const j = await r.json().catch(() => null)
    if (!r.ok || (j && typeof j === 'object' && (j as { ok?: unknown }).ok === false)) return { ok: false, status: r.status, words: refusalOf(r.status, j) }
    return { ok: true, data: j }
  } catch (e) {
    return { ok: false, status: 0, words: `No answer: ${e instanceof Error ? e.message : String(e)}` }
  }
}
