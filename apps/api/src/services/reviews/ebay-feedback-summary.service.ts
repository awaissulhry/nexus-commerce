/**
 * Reviews › eBay page (2026-10-26, B18) — eBay's feedback summary per seller account, asked of eBay AT MOST ONCE AN
 * HOUR per account: the answer (or eBay's refusal) is kept for an hour, and two pages opened at once share one call.
 * A read that never reached eBay (eBay reading off, no sign-in) is not kept, so reconnecting shows at once.
 *
 * The copy lives in this API process, per business (WorkspaceCache): a restart reads again once. The call itself is
 * `fetchEbayFeedbackSummary` (adapters/ebay-feedback.adapter.ts, Trading GetFeedback through the channel gateway).
 */
import { WorkspaceCache } from '../../lib/workspace-cache.js'
import type { EbayFeedbackSummary } from './adapters/ebay-feedback-summary.js'
import type { EbayFeedbackSummaryRead } from './adapters/ebay-feedback.adapter.js'

export const SUMMARY_TTL_MS = 60 * 60 * 1000

export type SummaryRead =
  | { ok: true; summary: EbayFeedbackSummary; readAt: string }
  | { ok: false; words: string; readAt: string | null }

interface Kept {
  at: number
  read: SummaryRead
}

export interface SummaryCache {
  get(key: string): Kept | undefined
  set(key: string, value: Kept): unknown
}

export interface SummaryDeps {
  now?: () => Date
  fetch?: (connectionId: string) => Promise<EbayFeedbackSummaryRead>
  cache?: SummaryCache
  inflight?: Map<string, Promise<SummaryRead>>
}

const kept = new WorkspaceCache<string, Kept>(100)
const running = new WorkspaceCache<string, Promise<SummaryRead>>(100)

async function defaultFetch(connectionId: string): Promise<EbayFeedbackSummaryRead> {
  const { fetchEbayFeedbackSummary } = await import('./adapters/ebay-feedback.adapter.js')
  return fetchEbayFeedbackSummary(connectionId)
}

/** One account's summary: the kept copy while it is younger than an hour, else one call to eBay. */
export async function readEbayFeedbackSummary(connectionId: string, deps: SummaryDeps = {}): Promise<SummaryRead> {
  const now = deps.now ?? (() => new Date())
  const cache = deps.cache ?? kept
  const inflight = (deps.inflight ?? running) as Map<string, Promise<SummaryRead>>
  const hit = cache.get(connectionId)
  if (hit && now().getTime() - hit.at < SUMMARY_TTL_MS) return hit.read
  const pending = inflight.get(connectionId)
  if (pending) return pending

  const run = (async (): Promise<SummaryRead> => {
    const at = now()
    const answer = await (deps.fetch ?? defaultFetch)(connectionId)
    if (answer.ok) {
      const read: SummaryRead = { ok: true, summary: answer.summary, readAt: at.toISOString() }
      cache.set(connectionId, { at: at.getTime(), read })
      return read
    }
    // eBay was asked and said no (or did not answer): kept for the hour too, so a page refresh does not ask again.
    const refused = answer as Extract<EbayFeedbackSummaryRead, { ok: false }>
    const read: SummaryRead = { ok: false, words: refused.words, readAt: refused.called ? at.toISOString() : null }
    if (refused.called) cache.set(connectionId, { at: at.getTime(), read })
    return read
  })()
  inflight.set(connectionId, run)
  try {
    return await run
  } finally {
    inflight.delete(connectionId)
  }
}
