/**
 * AX2.10 — Data-grounded keyword bid suggestions.
 *
 * Amazon's keyword bid recommendation API returns a generic marketplace
 * suggestion. We do something more useful: suggest bids from the operator's
 * OWN observed CPCs, so the recommendation reflects what they actually pay to
 * win the click on similar terms. For each requested keyword we take the
 * median observed CPC of existing keyword targets that share a word, falling
 * back to the account-wide median. Honest in sandbox (real account data, not
 * a synthetic number).
 */

import prisma from '../../db.js'

const FLOOR_CENTS = 5
const TOKEN_STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'di', 'da', 'per', 'con', 'il', 'la', 'le', 'lo', 'gli'])

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9àèéìòù]+/i).filter((t) => t.length > 1 && !TOKEN_STOP.has(t))
}
function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

export interface BidSuggestion {
  keyword: string
  suggestedBidCents: number
  lowCents: number
  highCents: number
  basis: 'token-match' | 'account-median' | 'default'
  samples: number
  // Apex C.1 — Amazon's own theme-based recommendation for this keyword, when
  // the ad-group context resolves and the call succeeds. Absent = own-CPC only.
  amazon?: { suggestedBidCents: number; theme: string; rangeLowCents: number | null; rangeHighCents: number | null }
}
export interface BidSuggestResult { suggestions: BidSuggestion[]; accountMedianCpcCents: number | null; defaultBidCents: number }

export async function suggestBids(opts: { keywords: string[]; matchType?: string; marketplace?: string }): Promise<BidSuggestResult> {
  const keywords = [...new Set(opts.keywords.map((k) => k.trim()).filter(Boolean))]
  // Observed CPCs from our own keyword targets with traffic.
  const targets = await prisma.adTarget.findMany({
    where: { kind: 'KEYWORD', clicks: { gt: 0 }, spendCents: { gt: 0 }, ...(opts.matchType ? { expressionType: opts.matchType } : {}) },
    take: 5000,
    select: { expressionValue: true, clicks: true, spendCents: true },
  })
  const corpus = targets.map((t) => ({ tokens: new Set(tokens(t.expressionValue)), cpc: t.spendCents / t.clicks }))
  const allCpcs = corpus.map((c) => c.cpc)
  const accountMedian = median(allCpcs)
  const defaultBidCents = accountMedian != null ? Math.max(FLOOR_CENTS, Math.round(accountMedian)) : 50

  const suggestions: BidSuggestion[] = keywords.map((kw) => {
    const kt = new Set(tokens(kw))
    const matches = corpus.filter((c) => [...kt].some((t) => c.tokens.has(t))).map((c) => c.cpc)
    let basis: BidSuggestion['basis'], chosen: number | null
    if (matches.length >= 2) { chosen = median(matches); basis = 'token-match' }
    else if (accountMedian != null) { chosen = accountMedian; basis = 'account-median' }
    else { chosen = 50; basis = 'default' }
    const mid = Math.max(FLOOR_CENTS, Math.round(chosen ?? 50))
    return { keyword: kw, suggestedBidCents: mid, lowCents: Math.max(FLOOR_CENTS, Math.round(mid * 0.6)), highCents: Math.round(mid * 1.5), basis, samples: matches.length }
  })

  return { suggestions, accountMedianCpcCents: accountMedian != null ? Math.round(accountMedian) : null, defaultBidCents }
}
