/**
 * Bid page, Rules view — every call the view makes (2026-10-10). Reads: the bid-rules API (list, history, preview), the
 * stored rule, its runs, the brain's clash view, a rule's waiting asks. Writes, each only after the person saved it in the
 * review dialog: the one level route, a builder rule's belt, archive / unarchive, undo of one change, roll back of one
 * run, approve / reject of asks, the Brain's Stop / Start again (after its own confirm). A rule is made and edited in the
 * bid builder (its own calls). Every refusal comes back in the server's own words.
 */
import { getBackendUrl } from '@/lib/backend-url'
import type { BidMode, BidRulesAnswer, PreviewResult, RuleHistory } from './bidRulesModel'
import { LEVEL_OF_MODE } from './bidRulesModel'
import { modeSteps, refusalWords, withBelt } from './ruleChanges'
import type { RunRow, StoredRule } from './ruleSettings'
import type { KillAnswer, KillBody } from './brainStop'
import { askUndoResults, chunks, routeMissing, type BidOwnerInfo, type BulkResult, type WaitingSuggestion } from './waitingModel'
import { addApiParams, type ScopeApi } from '../../_shared/scopeFilter/scopeFilterModel'
import type { ReviewResult } from '@/design-system/patterns'

const api = (path: string) => `${getBackendUrl()}/api/advertising${path}`
const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(refusalWords(res.status, body))
  return body as T
}

export type Outcome = { ok: true; body: unknown } | { ok: false; words: string }

async function send(path: string, method: 'POST' | 'PATCH', body?: unknown): Promise<Outcome> {
  try {
    const res = await fetch(api(path), { method, headers: JSON_HEADERS, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const j = await res.json().catch(() => null)
    if (!res.ok || (j && typeof j === 'object' && (j as { ok?: unknown }).ok === false && !('reversed' in (j as object)))) return { ok: false, words: refusalWords(res.status, j) }
    return { ok: true, body: j }
  } catch (e) {
    return { ok: false, words: `No answer: ${(e as Error).message}` }
  }
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const marketQuery = (market: string) => (market && market !== 'all' ? `market=${encodeURIComponent(market)}` : '')

/** The rules of the market; the filter bar's lists narrow the clash count only (the page narrows the rules itself). */
export async function fetchRules(market: string, lists?: ScopeApi | null): Promise<BidRulesAnswer> {
  const q = addApiParams(new URLSearchParams(marketQuery(market)), lists).toString()
  return readJson(await fetch(api(`/bid-rules${q ? `?${q}` : ''}`), { cache: 'no-store' }))
}

export async function fetchHistory(id: string, days: number, market: string): Promise<RuleHistory> {
  const q = [`days=${days}`, marketQuery(market)].filter(Boolean).join('&')
  return readJson(await fetch(api(`/bid-rules/${encodeURIComponent(id)}/history?${q}`), { cache: 'no-store' }))
}

export async function fetchPreview(body: Record<string, unknown>): Promise<PreviewResult> {
  return readJson(await fetch(api('/bid-rules/preview'), { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body), cache: 'no-store' }))
}

export async function fetchStoredRule(id: string): Promise<StoredRule> {
  const j = await readJson<{ rule: StoredRule }>(await fetch(api(`/automation-rules/${encodeURIComponent(id)}`), { cache: 'no-store' }))
  return j.rule
}

export async function fetchRuns(id: string): Promise<RunRow[]> {
  const j = await readJson<{ items?: RunRow[] }>(await fetch(api(`/automation-rule-executions?ruleId=${encodeURIComponent(id)}&limit=30`), { cache: 'no-store' }))
  return Array.isArray(j.items) ? j.items : []
}

export interface BrainDiffDay { day: string; decided: number; agree: number; higher: number; lower: number; hold: number; conflicts: number; writes: number; brainWrites: number }
/** The brain's diff view: its server switch, the campaigns it owns now (LIVE or HELD) and its days. */
export async function fetchBrainDiff(market: string, lists?: ScopeApi | null): Promise<{ mode: string; owned: string[]; days: BrainDiffDay[] }> {
  const q = addApiParams(new URLSearchParams(['days=7', marketQuery(market)].filter(Boolean).join('&')), lists).toString()
  const j = await readJson<{ mode?: string; owned?: string[]; days?: BrainDiffDay[] }>(await fetch(api(`/automation/brain/bid-brain/diff?${q}`), { cache: 'no-store' }))
  return { mode: j.mode ?? '', owned: Array.isArray(j.owned) ? j.owned : [], days: Array.isArray(j.days) ? j.days : [] }
}

/** The answer of a brain request asked and approved in one click (advertising-brain.routes.ts `ask`). */
export interface BrainAsk {
  approvalId: string
  status: string
  executeAfter?: string
  needsCode?: boolean
  approve?: { ok: boolean; code?: string; error?: string }
}

/**
 * POST /automation/brain/bid-brain/enrollment — one campaign to Auto (`live`: the brain becomes its one bid writer) or
 * back to Watch (`shadow`). Asked and approved by this person in one click (no code since 2026-10-12); when the approve
 * is refused the request waits (its id comes back): approved with a code when the API asks one (`needsCode`), or rejected.
 */
export async function askEnrollment(campaignId: string, op: 'live' | 'shadow'): Promise<{ ok: true; body: BrainAsk } | { ok: false; words: string }> {
  const out = await send('/automation/brain/bid-brain/enrollment', 'POST', { campaignId, op, approve: true, why: 'set on the Bid page' })
  if (!out.ok) return out
  const body = out.body as BrainAsk | null
  return body && typeof body.approvalId === 'string' ? { ok: true, body } : { ok: false, words: 'No request came back' }
}

/**
 * POST /automation/brain/kill — the Brain's Stop (op kill: runs at once on this click, recorded and undoable) or its Start
 * again (op end, approved in the same click; a refused approve leaves the request waiting, its id comes back).
 * The body is `brainStop.ts` stopBody / startBody.
 */
export async function askBrainKill(body: KillBody): Promise<{ ok: true; body: KillAnswer } | { ok: false; words: string }> {
  const out = await send('/automation/brain/kill', 'POST', body)
  if (!out.ok) return out
  const answer = out.body as KillAnswer | null
  return answer && typeof answer.approvalId === 'string' ? { ok: true, body: answer } : { ok: false, words: 'No request came back' }
}

/** POST /automation/brain/requests/:id/decide — approve a waiting brain request (with the code when it raises) or reject it. */
export async function decideBrainRequest(approvalId: string, decision: 'approve' | 'reject', code?: string): Promise<{ ok: true; executeAfter?: string } | { ok: false; words: string }> {
  const out = await send(`/automation/brain/requests/${encodeURIComponent(approvalId)}/decide`, 'POST', { decision, ...(code ? { code } : {}) })
  if (!out.ok) return out
  const body = out.body as { executeAfter?: string } | null
  return { ok: true, ...(body?.executeAfter ? { executeAfter: body.executeAfter } : {}) }
}

export interface UndoPreview { found: boolean; eligible: boolean; reason?: string; groupedWith?: number }
export async function fetchUndoPreview(changeId: string): Promise<UndoPreview> {
  return readJson(await fetch(api(`/changes/${encodeURIComponent(changeId)}/undo-preview`), { cache: 'no-store' }))
}

// ── a rule's waiting asks (the Suggestions page's own endpoints) ──────────────────────────────────────────────────

/** The server's cap on one read of the suggestions list (advertising.routes.ts GET /suggestions). */
export const SUGGESTIONS_LIMIT = 1000

export async function fetchSuggestions(status: 'pending' | 'applied', market: string): Promise<{ items: WaitingSuggestion[]; capped: boolean }> {
  const q = [`status=${status}`, `limit=${SUGGESTIONS_LIMIT}`, marketQuery(market)].filter(Boolean).join('&')
  const j = await readJson<{ items?: WaitingSuggestion[]; total?: number }>(await fetch(api(`/suggestions?${q}`), { cache: 'no-store' }))
  const items = Array.isArray(j.items) ? j.items : []
  return { items, capped: typeof j.total === 'number' && j.total > SUGGESTIONS_LIMIT }
}

/** Who sets each bid of these campaigns now (GET /bids?campaignId=), by target id. A campaign that cannot be read is left out. */
export async function fetchOwners(market: string, campaignIds: readonly string[]): Promise<Map<string, BidOwnerInfo>> {
  const out = new Map<string, BidOwnerInfo>()
  await Promise.all([...new Set(campaignIds)].map(async (id) => {
    try {
      const q = [marketQuery(market), `campaignId=${encodeURIComponent(id)}`].filter(Boolean).join('&')
      const j = await readJson<{ rows?: Array<{ targetId: string; owner?: BidOwnerInfo }> }>(await fetch(api(`/bids?${q}`), { cache: 'no-store' }))
      for (const r of j.rows ?? []) if (r.owner) out.set(r.targetId, { kind: r.owner.kind, name: r.owner.name })
    } catch { /* unknown owner: the ask shows no Brain mark, and the server still decides at approval */ }
  }))
  return out
}

/**
 * POST /suggestions/bulk — a result per ask (apply / dismiss / restore), in calls of at most 200 (the route's limit). A
 * call that fails names its own asks; the ones decided before it keep their results.
 */
export async function decideAsks(ops: ReadonlyArray<{ id: string; kind: 'apply' | 'dismiss' | 'restore' }>): Promise<{ ok: true; results: BulkResult[] } | { ok: false; words: string }> {
  const results: BulkResult[] = []
  for (const part of chunks(ops)) {
    const out = await send('/suggestions/bulk', 'POST', { ops: part })
    const got = out.ok ? (out.body as { results?: BulkResult[] } | null)?.results : null
    if (Array.isArray(got)) { results.push(...got); continue }
    const words = out.ok ? 'No results came back' : out.words
    if (!results.length) return { ok: false, words }
    results.push(...part.map((o) => ({ id: o.id, kind: o.kind, ok: false, error: words })))
  }
  return { ok: true, results }
}

// ── writes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One rule to `next`: its belt (builder rules) and its level, in the order `modeSteps` gives; a refused level rolls the belt back. */
export async function saveMode(id: string, next: BidMode): Promise<Outcome> {
  let stored: StoredRule
  try { stored = await fetchStoredRule(id) } catch (e) { return { ok: false, words: (e as Error).message } }
  let actions: unknown = stored.actions
  let rollback: { control: 'manual' | 'automate' } | null = null
  for (const step of modeSteps(next, actions)) {
    if (step.kind === 'belt') {
      const nextActions = withBelt(actions, step.control)
      const out = await send(`/automation-rules/${encodeURIComponent(id)}`, 'PATCH', { actions: nextActions })
      if (!out.ok) return out
      if (step.rollbackOnFail) rollback = { control: step.rollbackOnFail }
      actions = nextActions
    } else {
      const out = await send(`/autonomy/rules/${encodeURIComponent(id)}`, 'PATCH', { level: step.level })
      if (!out.ok) {
        if (rollback) await send(`/automation-rules/${encodeURIComponent(id)}`, 'PATCH', { actions: withBelt(actions, rollback.control) })
        return out
      }
    }
  }
  return { ok: true, body: { level: LEVEL_OF_MODE[next] } }
}

/** Archive: the answer says what went with it (asks expired, Brain inputs ended, queued writes cancelled). */
export const archiveRule = (id: string) => send(`/bid-rules/${encodeURIComponent(id)}/archive`, 'POST', {})
export const unarchiveRule = (id: string) => send(`/bid-rules/${encodeURIComponent(id)}/unarchive`, 'POST', {})

/** Restore = unarchive (back at Off) and, when it had another mode, that mode again. */
export async function restoreRule(id: string, mode: BidMode): Promise<Outcome> {
  const out = await unarchiveRule(id)
  if (!out.ok || mode === 'OFF') return out
  const level = await saveMode(id, mode)
  return level.ok ? level : { ok: false, words: `Restored at Off: ${level.words}` }
}

/** POST /changes/:id/undo — the server re-checks the window, whether it already went and whether it reached Amazon. */
export async function undoChange(changeId: string): Promise<Outcome> {
  const out = await send(`/changes/${encodeURIComponent(changeId)}/undo`, 'POST', { reason: 'undone from the Bid page' })
  if (!out.ok) return out
  const b = (out.body ?? {}) as { ok?: boolean; reversed?: number; reason?: string; failed?: number }
  if (!b.reversed) return { ok: false, words: b.reason ?? 'Nothing was reversed.' }
  return out
}

/** POST /actions/:executionId/rollback — the whole run, inside its 24 h. */
export async function rollbackRun(execId: string): Promise<Outcome> {
  const out = await send(`/actions/${encodeURIComponent(execId)}/rollback`, 'POST', { reason: 'operator rollback from the Bid page' })
  if (!out.ok) return out.words.includes('rollback_window_expired') ? { ok: false, words: 'Older than 24 h: undo its changes one by one.' } : out
  const b = (out.body ?? {}) as { reversed?: number; skipped?: number; failed?: number }
  return { ok: true, body: `${b.reversed ?? 0} reversed${b.skipped ? ` · ${b.skipped} skipped` : ''}${b.failed ? ` · ${b.failed} failed` : ''}` }
}

// ── undo of approved asks (audit R4) ────────────────────────────────────────────────────────────────────────────────

let askUndoRoute: boolean | null = null

/**
 * Does the server have POST /bid-rules/:id/asks/undo? Asked once (an empty list changes nothing): until it does, an
 * approval offers no Undo — never the old one, which wrote the old bid as a person's bid.
 */
export async function askUndoSupported(ruleId: string): Promise<boolean> {
  if (askUndoRoute !== null) return askUndoRoute
  try {
    const res = await fetch(api(`/bid-rules/${encodeURIComponent(ruleId)}/asks/undo`), { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ suggestionIds: [] }) })
    const body = await res.json().catch(() => null)
    askUndoRoute = !routeMissing(res.status, body)
  } catch {
    return false
  }
  return askUndoRoute
}

/** POST /bid-rules/:id/asks/undo — the old bids back as the rule's undo, and the asks wait again; a result per ask. */
export async function undoAsks(ruleId: string, suggestionIds: readonly string[]): Promise<Record<string, ReviewResult>> {
  const out = await send(`/bid-rules/${encodeURIComponent(ruleId)}/asks/undo`, 'POST', { suggestionIds })
  if (!out.ok) return Object.fromEntries(suggestionIds.map((id) => [id, { ok: false, words: out.words, verb: 'undone' }]))
  return askUndoResults(suggestionIds, out.body)
}
