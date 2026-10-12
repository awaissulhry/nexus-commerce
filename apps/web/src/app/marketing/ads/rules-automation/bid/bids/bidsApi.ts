/**
 * Bid page, Bids view — the reads it makes, each through a route that already exists (the hrefs it gets have no
 * `/w/<id>` prefix: the workspace `Link` adds it). The writes go through the ads console's one write reader
 * (`_shared/adsWrite.ts`: the server's own reason, and "Send anyway" past a person's own limits).
 *
 *   GET  /api/advertising/bids?market=&productId=&campaignId=&adGroupId=           the rows, each with its one owner
 *        &portfolioIds=&campaignIds=&adGroupIds=&productIds=                       (the page's filter bar: lists, OR inside, AND across)
 *   GET  /api/advertising/automation/brain/bid-brain/why?targetId=                  the brain's newest decision
 *   GET  /api/advertising/automation/brain/bid-brain/what-if?targetId=&targetAcosPct=
 *   GET  /api/advertising/changes?entityType=AD_TARGET&entityId=&field=bid          one bid's history, with the undo handle
 *   GET  /api/advertising/control-room/guardrail-grid?search=&marketplace=          the campaign's lock (pins) and allowlist
 *   POST /api/advertising/changes/:actionLogId/undo                                 Undo one change
 *   PATCH /api/advertising/campaigns/:id/pins { pinBids }                           lock the campaign's bids / give them back
 *   GET  /api/advertising/bids/suggested?adGroupId=                                 Amazon's suggested bids, per ad group
 *   GET  /api/advertising/bids/cursor?<scope>                                       has anything moved (live)
 *   POST /api/advertising/ad-targets/bulk-bid { entries, reason }                   Change bid and Apply suggested (one or many), sent now
 *   POST /api/advertising/bids/:targetId/mode { mode }                              Auto / Manual for one keyword
 *   POST /api/advertising/automation/brain/control { op: 'set-value', … }           a keyword's goal and max (goalModel.ts)
 */
import { getBackendUrl } from '@/lib/backend-url'
import type { ScopeApi } from '../../_shared/scopeFilter/scopeFilterModel'
import { adsWrite, SEND_NOW, type WriteResult } from '../../../_shared/adsWrite'
import { askSendAnyway, notSentPastLimits } from '../../../_shared/sendAnyway'
import { bidsQuery, type BidRow, type BidsAnswer } from './bidsModel'
import { goalResult, type GoalBody } from './goalModel'
import { cursorOf, type BidsCursor } from './liveModel'
import { readBulkBid, type BulkWait, type SentBid, type SuggestedAnswer, type SuggestedState } from './suggestedModel'
import type { FeedRow } from './historyModel'
import { decisionFor, type BrainDecision, type WhatIfDecision } from './whyModel'

/**
 * A read. A refusal throws the server's own words, else "HTTP 500" — never a sentence that repeats the title the page
 * puts above it ("Bids not read").
 */
async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${getBackendUrl()}${path}`, { cache: 'no-store' })
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: unknown } | null
    const said = typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : null
    throw new Error(said ?? `HTTP ${r.status}`)
  }
  return (await r.json()) as T
}

/** The read's scope; `lists` = the page's filter bar (server params). */
export interface BidsScope { market?: string | null; productId?: string | null; campaignId?: string | null; adGroupId?: string | null; lists?: ScopeApi | null }

export const readBids = (scope: BidsScope): Promise<BidsAnswer> =>
  getJson<BidsAnswer>(`/api/advertising/bids${bidsQuery(scope)}`)

/** One bid again, as it is now (the review's "Now"): read in its own ad group, archived or paused too. */
export async function readOneBid(row: Pick<BidRow, 'targetId' | 'campaign' | 'adGroup'>): Promise<BidRow | null> {
  const qs = new URLSearchParams({ campaignId: row.campaign.id, adGroupId: row.adGroup.id, status: 'all' })
  const a = await getJson<BidsAnswer>(`/api/advertising/bids?${qs}`)
  return a.rows.find((r) => r.targetId === row.targetId) ?? null
}

export async function readWhy(targetId: string): Promise<BrainDecision | null> {
  const a = await getJson<unknown>(`/api/advertising/automation/brain/bid-brain/why?${new URLSearchParams({ targetId })}`)
  return decisionFor<BrainDecision>(a, targetId)
}

export async function readWhatIf(targetId: string, targetAcosPct: number): Promise<WhatIfDecision | null> {
  const qs = new URLSearchParams({ targetId, targetAcosPct: String(targetAcosPct) })
  const a = await getJson<unknown>(`/api/advertising/automation/brain/bid-brain/what-if?${qs}`)
  return decisionFor<WhatIfDecision>(a, targetId)
}

export async function readHistory(targetId: string): Promise<FeedRow[]> {
  const qs = new URLSearchParams({ entityType: 'AD_TARGET', entityId: targetId, field: 'bid', limit: '100' })
  const a = await getJson<{ items?: FeedRow[] }>(`/api/advertising/changes?${qs}`)
  return Array.isArray(a.items) ? a.items : []
}

/** The campaign's own lock on its bids, and whether automation may change it (the allowlist). */
export interface CampaignLock { bidsLocked: boolean; allowlisted: boolean }

export async function readCampaignLock(campaign: { id: string; name: string }, market: string | null): Promise<CampaignLock | null> {
  const qs = new URLSearchParams({ search: campaign.name, limit: '50' })
  if (market && market.toLowerCase() !== 'all') qs.set('marketplace', market.toUpperCase())
  const a = await getJson<{ rows?: Array<{ id: string; managed?: boolean; pins?: { bids?: boolean } }> }>(`/api/advertising/control-room/guardrail-grid?${qs}`)
  const hit = (a.rows ?? []).find((r) => r.id === campaign.id)
  return hit ? { bidsLocked: !!hit.pins?.bids, allowlisted: !!hit.managed } : null
}

export const undoChange = (actionLogId: string): Promise<WriteResult> =>
  adsWrite(`/api/advertising/changes/${encodeURIComponent(actionLogId)}/undo`, { reason: 'Bid page' }, 'POST')

export const setBidLock = (campaignId: string, locked: boolean): Promise<WriteResult> =>
  adsWrite(`/api/advertising/campaigns/${encodeURIComponent(campaignId)}/pins`, { pinBids: locked })

// ── keyword Auto, suggested bids, goal, live (KEYWORD-AUTO.md) ─────────────────────────────────────────────────────

/** One ad group's suggested bids, or why they could not be read. Never throws. */
export async function readSuggested(adGroupId: string): Promise<SuggestedState> {
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/bids/suggested?${new URLSearchParams({ adGroupId })}`, { cache: 'no-store' })
    if (!r.ok) {
      const body = (await r.json().catch(() => null)) as { error?: unknown } | null
      return { kind: 'failed', error: typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : `HTTP ${r.status}` }
    }
    const a = (await r.json()) as Partial<SuggestedAnswer>
    return { kind: 'ready', answer: { fetchedAt: a.fetchedAt ?? null, rows: Array.isArray(a.rows) ? a.rows : [], unavailable: a.unavailable ?? null } }
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}

/** Has anything moved in this scope? null when it did not answer (the next ask tries again). */
export async function readCursor(scope: BidsScope): Promise<BidsCursor | null> {
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/bids/cursor${bidsQuery(scope)}`, { cache: 'no-store' })
    return r.ok ? cursorOf(await r.json()) : null
  } catch {
    return null
  }
}

/** What a bulk send says it is, in the change feed: the page and which of its two bid actions sent it. */
export const BID_REASON = { suggested: 'Bid page: suggested bid', change: 'Bid page: change bid' } as const
export type BidReason = (typeof BID_REASON)[keyof typeof BID_REASON]

async function postBulk(entries: ReadonlyArray<{ targetId: string; bidCents: number }>, confirm: boolean, reason: BidReason): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${getBackendUrl()}/api/advertising/ad-targets/bulk-bid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: entries.map((e) => ({ adTargetId: e.targetId, bidCents: e.bidCents })), reason, ...SEND_NOW, ...(confirm ? { confirmOwnLimits: true } : {}) }),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

/**
 * Send many bids now (Change bid, Apply suggested) in one call, and read each row's answer with its change's Undo handle.
 * Past his own limits (3A) it asks "Send anyway" once for every row that waits, and sends those again with his yes.
 * Never throws.
 */
export async function sendBids(entries: ReadonlyArray<{ targetId: string; bidCents: number }>, reason: BidReason): Promise<SentBid[]> {
  const out = new Map<string, SentBid>()
  const run = async (list: ReadonlyArray<{ targetId: string; bidCents: number }>, confirm: boolean): Promise<BulkWait[]> => {
    try {
      const { status, body } = await postBulk(list, confirm, reason)
      const read = readBulkBid(list, status, body)
      for (const r of read.results) out.set(r.targetId, r)
      return read.waits
    } catch (e) {
      for (const x of list) out.set(x.targetId, { targetId: x.targetId, ok: false, words: e instanceof Error ? e.message : 'No answer from the server.', actionLogId: null })
      return []
    }
  }
  const waits = await run(entries, false)
  if (waits.length) {
    const limits = waits.flatMap((w) => w.limits)
    const again = entries.filter((e) => waits.some((w) => w.adTargetId === e.targetId))
    if (await askSendAnyway(limits, again.length)) await run(again, true)
    else for (const e of again) out.set(e.targetId, { targetId: e.targetId, ok: false, words: notSentPastLimits(limits), actionLogId: null })
  }
  return entries.map((e) => out.get(e.targetId) ?? { targetId: e.targetId, ok: false, words: 'No answer from the server.', actionLogId: null })
}

/** Auto / Manual for one keyword (a person's hold with no end, or handed back). */
export const setKeywordMode = (targetId: string, mode: 'AUTO' | 'MANUAL'): Promise<WriteResult> =>
  adsWrite(`/api/advertising/bids/${encodeURIComponent(targetId)}/mode`, { mode }, 'POST')

/** One goal setting through the brain's control route (approved in the same click). Never throws. */
export async function saveGoalSetting(body: GoalBody): Promise<{ ok: boolean; words: string; warnings: string[] }> {
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/automation/brain/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return goalResult(r.status, await r.json().catch(() => null))
  } catch (e) {
    return { ok: false, words: e instanceof Error ? e.message : 'No answer from the server.', warnings: [] }
  }
}
