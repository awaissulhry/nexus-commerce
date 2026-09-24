/**
 * A-53 — can the studio open a market, and if not, why not?
 *
 * The Sheet, Matrix and Variants tabs need a market and a content language before they can read anything.
 * They used to render *"Waiting for the market…"* whenever either was missing — but the frame has already
 * answered by the time a tab mounts, so that line was a wait for a state that could never change. A business
 * with no `Marketplace` rows (Motovento, 2026-09-24) sat on it forever with no way out.
 *
 * Pure, so the three outcomes are testable without a browser:
 *  - `ready`  — a market and a language resolved.
 *  - `failed` — the market read failed (the frame says `marketplacesFailed`), OR markets exist and none
 *               resolved, which should not happen: offer a re-read rather than a wait.
 *  - `none`   — the read succeeded and this business has no markets at all.
 */
import { StudioReadError, studioReadMessage } from './studio-read'

export type MarketGate = 'ready' | 'failed' | 'none'

export function marketGate(input: { market: string | null; locale: string | null; marketCount: number; discoveryFailed: boolean }): MarketGate {
  if (input.market && input.locale) return 'ready'
  if (input.discoveryFailed) return 'failed'
  if (input.marketCount === 0) return 'none'
  return 'failed'
}

export const NO_MARKET_REASON = 'No market is set up for this business.'
export const MARKETS_UNREAD_REASON = 'Markets could not be loaded.'

/** The one-line reason a readiness chip gives when there is no market to score. `null` when ready. */
export function marketGateReason(gate: MarketGate): string | null {
  return gate === 'none' ? NO_MARKET_REASON : gate === 'failed' ? MARKETS_UNREAD_REASON : null
}

/** The permission `POST /api/marketplaces/seed` requires (API `permissions-manifest.ts`: writes under `/marketplaces`). */
export const SET_UP_MARKETS_PERMISSION = 'channels.sync'

export type SetUpResult = { ok: true } | { ok: false; message: string }

/**
 * Add the catalogue markets this business lacks (the API route is create-only), then re-read the frame's
 * markets so the page opens without a reload. A refusal returns a sentence and does NOT re-read.
 */
export async function setUpMarkets(post: () => Promise<Response>, retry: () => Promise<void>): Promise<SetUpResult> {
  let response: Response
  try {
    response = await post()
  } catch (error) {
    return { ok: false, message: studioReadMessage(error) }
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    return { ok: false, message: setUpRefusal(response.status, body) }
  }
  await retry()
  return { ok: true }
}

function setUpRefusal(status: number, body: unknown): string {
  if (status === 403) return 'You do not have permission to set up markets for this business.'
  if (status >= 500) return 'Nexus could not set up the markets. Try again in a moment.'
  // 401 (session), 429 (rate) and a server sentence keep the studio's one wording for them.
  return new StudioReadError(status, body).message
}
