/**
 * Publish without surprises (2026-10-01, audit P1/P9) — eBay's own check, run DURING the review.
 *
 * `VerifyAddFixedPriceItem` takes the exact XML a new listing would send and answers with the errors the real Add would
 * raise, without creating anything. It ran only at the final send, so the last problems arrived after the user pressed
 * Publish, raw and two at most. The review now runs it for a NEW listing once Nexus's own checks pass, and turns each
 * eBay error or warning into a review issue (`ebayCheckIssue`). The send still runs it again before the Add.
 *
 * Never in dry-run, gated or sandbox mode, and never without a real eBay API: nothing here may reach eBay unless this
 * server really sends to eBay.
 */
import type { StudioPublishIssue } from '@nexus/shared/studio-publication'
import { getEbayPublishMode } from '../ebay-publish-gate.service.js'
import { ebayCheckIssue, tradingErrors, type TradingError } from './studio-publication-ebay-problems.js'

/** Whether this server really sends to eBay: live mode, the real eBay API, not the sandbox. */
export function ebaySendsLive(): boolean {
  return getEbayPublishMode() === 'live' && process.env.NEXUS_EBAY_REAL_API === 'true' && process.env.EBAY_SANDBOX !== 'true'
}

const textOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** eBay's check of a new listing as review issues: its errors block, its warnings inform. [] when there is nothing to check. */
export async function verifyNewEbayListing(plan: { xml: string; itemId: string | null; marketplace: string }, accountId: string): Promise<StudioPublishIssue[]> {
  if (plan.itemId || !plan.xml || !ebaySendsLive()) return []
  // Loaded here, not at the top: the review module stays free of the Trading client until a check really runs.
  const { callTradingApi, siteIdForMarket, TradingApiFailure } = await import('../ebay-trading-api.service.js')
  const { ebayAuthService } = await import('../ebay-auth.service.js')
  const refused: StudioPublishIssue = { severity: 'error', message: 'eBay refused this listing in its check without saying why. Nothing was sent.' }
  try {
    const oauthToken = await ebayAuthService.getValidToken(accountId)
    const check = await callTradingApi('VerifyAddFixedPriceItem', plan.xml.replace(/AddFixedPriceItemRequest/g, 'VerifyAddFixedPriceItemRequest'),
      { oauthToken, siteId: siteIdForMarket(plan.marketplace), connectionId: accountId, market: plan.marketplace })
    if (check.itemId?.startsWith('DRYRUN-')) return []
    if (!check.raw) return [{ severity: 'warning', message: 'eBay did not answer its check of this listing. eBay checks it again when you publish.' }]
    const issues = tradingErrors(check.raw).map(ebayCheckIssue)
    // Only Success and Warning let the Add go ahead (`sendEbayPublication`); any other answer is a refusal here too.
    return ['Success', 'Warning'].includes(check.ack) || issues.some(issue => issue.severity === 'error') ? issues : [...issues, refused]
  } catch (error) {
    if (error instanceof TradingApiFailure && !error.duplicateSubmission) {
      const found: TradingError[] = error.raw ? tradingErrors(error.raw)
        : error.channelErrors.map(e => ({ code: e.code, severity: 'error' as const, short: '', long: e.message, parameters: [] }))
      const issues = found.map(ebayCheckIssue)
      return issues.some(issue => issue.severity === 'error') ? issues : [...issues, refused]
    }
    // No answer (a timeout, a login problem): nothing is known about the listing, and the send checks again before the Add.
    return [{ severity: 'warning', message: `Nexus could not ask eBay to check this listing now (${textOf(error)}). eBay checks it again when you publish.` }]
  }
}
