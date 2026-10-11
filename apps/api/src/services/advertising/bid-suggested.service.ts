/**
 * Bid page (KAPI-S, 2026-10-10) — GET /api/advertising/bids/suggested?adGroupId= (or campaignId=): Amazon's own
 * suggested bid for each keyword and target of an ad group (or of every ad group of a campaign), as its Targeting tab
 * shows it: low, middle and high, and the theme it was made for.
 *
 *   { fetchedAt, rows: [{ targetId, low, mid, high, theme }], unavailable }
 *
 *   rows         every keyword and target of the scope that is not negative and not archived; low / mid / high in cents of
 *                the market's money, null where Amazon gave nothing (never Nexus's own median: ads-bid-suggest.service.ts
 *                is another number and is not mixed in). Amazon is asked about keywords, ASIN targets and the four auto
 *                groups (ads-api-client.ts themeExpressionOf); a category, refinement or audience target stays null.
 *   fetchedAt    when Amazon answered (the oldest answer across a campaign's ad groups); null when it was not asked.
 *   unavailable  null, or why there is no suggestion, in plain words: no Ads connection serves the market, sandbox, the ad
 *                group is not on Amazon yet, not Sponsored Products, or Amazon's own error. A partial answer (one call of
 *                several failed, or one ad group of several) keeps its numbers and says what is missing.
 *
 * Cache: in this process, per business and ad group, for 6 hours (SUGGESTED_CACHE_MS) — Amazon's suggestion moves slowly,
 * and the page may ask on every visit. A target the cached answer did not ask about (a new keyword) asks again. An answer
 * with a failure is kept 5 minutes only, so a busy Amazon is not asked again on every reload; a reason found before
 * asking (no connection, sandbox) is not kept at all. Two reads of one ad group at once share one call.
 *
 * Amazon is asked through ads-api-client.ts fetchThemeBidRecommendations (liveCall → the channel gateway, hard rule 4).
 * The money keys (SUGGESTED_MONEY) are stripped by the route for a person without financials.adspend.view.
 */
import { FIELDS } from '@nexus/shared/permissions'
import prisma from '../../db.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import {
  adsMode, fetchThemeBidRecommendations, themeExpressionKey, themeExpressionOf, type ThemeBidSuggestion, type ThemeExpression,
} from './ads-api-client.js'
import { adsProfileFor } from './ads-profile-resolver.js'

export interface SuggestedBidRow {
  targetId: string
  low: number | null
  mid: number | null
  high: number | null
  /** Amazon's theme for this suggestion (CONVERSION_OPPORTUNITIES, or an event's); null with no suggestion. */
  theme: string | null
}

export interface SuggestedBids {
  fetchedAt: string | null
  rows: SuggestedBidRow[]
  unavailable: string | null
}

export type SuggestedBidsAnswer = { ok: true; answer: SuggestedBids } | { ok: false; status: 404; error: string }

/** The money keys of this answer: stripped for a person without financials.adspend.view (the route). */
export const SUGGESTED_MONEY: Readonly<Record<string, string>> = Object.fromEntries(['low', 'mid', 'high'].map((k) => [k, FIELDS.financialsAdspendView]))

export const SUGGESTED_CACHE_MS = 6 * 3_600_000
const FAILURE_CACHE_MS = 5 * 60_000
const CACHE_MAX_ENTRIES = 2000

interface AdGroupAnswer {
  /** When Amazon answered (ms); null when it was not asked. */
  at: number | null
  /** The expressions Amazon was asked about. */
  asked: Set<string>
  byKey: Map<string, ThemeBidSuggestion>
  unavailable: string | null
}

interface CacheEntry { answer: AdGroupAnswer; expiresAt: number }

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<AdGroupAnswer>>()

/** Tests only: forget every cached answer. */
export function __resetSuggestedBidsCache(): void {
  cache.clear()
  inFlight.clear()
}

interface ScopeGroup {
  id: string
  externalAdGroupId: string | null
  campaign: { externalCampaignId: string | null; marketplace: string | null; adProduct: string | null; type: string }
  targets: Array<{ id: string; kind: string; expressionType: string; expressionValue: string }>
}

const notFound = (error: string): SuggestedBidsAnswer => ({ ok: false, status: 404, error })
const NOT_ARCHIVED = { not: 'ARCHIVED' as const }

export async function readSuggestedBids(q: { adGroupId?: string | null; campaignId?: string | null }, now: () => number = Date.now): Promise<SuggestedBidsAnswer> {
  // Scope: another business's ids read as not found (the workspace's own rows only), as GET /advertising/bids says it.
  if (q.campaignId && !(await prisma.campaign.findUnique({ where: { id: q.campaignId }, select: { id: true } }))) return notFound(`No campaign ${q.campaignId} in this business.`)
  if (q.adGroupId) {
    const g = await prisma.adGroup.findUnique({ where: { id: q.adGroupId }, select: { campaignId: true } })
    if (!g || (q.campaignId && g.campaignId !== q.campaignId)) return notFound(`No ad group ${q.adGroupId} in this business${q.campaignId ? ' and campaign' : ''}.`)
  }
  const groups: ScopeGroup[] = await prisma.adGroup.findMany({
    where: q.adGroupId ? { id: q.adGroupId } : { campaignId: q.campaignId!, status: NOT_ARCHIVED },
    select: {
      id: true, externalAdGroupId: true,
      campaign: { select: { externalCampaignId: true, marketplace: true, adProduct: true, type: true } },
      targets: { where: { isNegative: false, status: NOT_ARCHIVED }, select: { id: true, kind: true, expressionType: true, expressionValue: true }, orderBy: { id: 'asc' } },
    },
    orderBy: { id: 'asc' },
  })
  const workspace = workspaceIdForQuery()
  const answers: Array<{ group: ScopeGroup; answer: AdGroupAnswer }> = []
  for (const group of groups) answers.push({ group, answer: await answerFor(workspace, group, now) })

  const rows: SuggestedBidRow[] = []
  for (const { group, answer } of answers) {
    for (const t of group.targets) {
      const e = themeExpressionOf({ expression: t.expressionValue, matchType: t.expressionType, kind: t.kind })
      const s = e ? answer.byKey.get(themeExpressionKey(e)) : undefined
      rows.push({ targetId: t.id, low: s?.lowCents ?? null, mid: s?.midCents ?? null, high: s?.highCents ?? null, theme: s ? s.theme : null })
    }
  }
  const asked = answers.filter((a) => a.answer.at != null).map((a) => a.answer.at!)
  return {
    ok: true,
    answer: { fetchedAt: asked.length ? new Date(Math.min(...asked)).toISOString() : null, rows, unavailable: unavailableOf(answers.map((a) => a.answer)) },
  }
}

/** One reason for the scope: the ad group's own, or, across a campaign's ad groups, the first with how many it covers. */
function unavailableOf(answers: readonly AdGroupAnswer[]): string | null {
  const reasons = answers.map((a) => a.unavailable).filter((r): r is string => !!r)
  if (!reasons.length) return null
  if (answers.length === 1) return reasons[0]
  const first = reasons[0]
  const same = reasons.filter((r) => r === first).length
  if (same === answers.length) return first
  return `${reasons.length} of ${answers.length} ad groups have no suggestion. ${first}`
}

/** The ad group's answer: the cached one while it is fresh and asked about every target now, else Amazon's (one call at a time). */
async function answerFor(workspace: string, group: ScopeGroup, now: () => number): Promise<AdGroupAnswer> {
  const expressions = group.targets.flatMap((t) => {
    const e = themeExpressionOf({ expression: t.expressionValue, matchType: t.expressionType, kind: t.kind })
    return e ? [e] : []
  })
  const key = `${workspace}:${group.id}`
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now() && expressions.every((e) => cached.answer.asked.has(themeExpressionKey(e)))) return cached.answer
  const running = inFlight.get(key)
  if (running) return running
  const work = ask(group, expressions, now).then((answer) => {
    if (answer.at != null) {
      if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!)
      cache.set(key, { answer, expiresAt: answer.at + (answer.unavailable ? FAILURE_CACHE_MS : SUGGESTED_CACHE_MS) })
    }
    return answer
  }).finally(() => inFlight.delete(key))
  inFlight.set(key, work)
  return work
}

const notAsked = (unavailable: string | null): AdGroupAnswer => ({ at: null, asked: new Set(), byKey: new Map(), unavailable })

async function ask(group: ScopeGroup, expressions: readonly ThemeExpression[], now: () => number): Promise<AdGroupAnswer> {
  const c = group.campaign
  // adProduct is the v1 discriminator; an older row without it says it by the legacy type.
  if (c.adProduct ? c.adProduct !== 'SPONSORED_PRODUCTS' : c.type !== 'SP') return notAsked('Amazon gives suggested bids here for Sponsored Products only.')
  if (!group.externalAdGroupId || !c.externalCampaignId) return notAsked('This ad group is not on Amazon yet (it has no Amazon id), so Amazon has no suggestion for it.')
  if (!expressions.length) return notAsked(null)
  if (adsMode() === 'sandbox') return notAsked('Nexus runs Amazon Ads in test mode (sandbox) here, so Amazon is not asked and there is no suggested bid.')
  const market = c.marketplace?.trim().toUpperCase() || null
  if (!market) return notAsked('This campaign names no market, so Nexus cannot tell which Amazon Ads account to ask.')
  const profile = await adsProfileFor(market)
  if (!profile) return notAsked(`No Amazon Ads connection serves ${market}, so Amazon cannot be asked for a suggested bid.`)
  if (profile.mode !== 'production') return notAsked(`The Amazon Ads account for ${market} is a test (sandbox) account, so Amazon gives no suggested bid.`)
  const region = profile.region === 'NA' || profile.region === 'FE' ? profile.region : 'EU'
  const got = await fetchThemeBidRecommendations({ profileId: profile.profileId, region }, {
    externalCampaignId: c.externalCampaignId, externalAdGroupId: group.externalAdGroupId, expressions,
  })
  if (got.sandbox) return notAsked('Nexus runs Amazon Ads in test mode (sandbox) here, so Amazon is not asked and there is no suggested bid.')
  const missing = got.failures.reduce((n, f) => n + f.expressions, 0)
  const unavailable = !got.failures.length ? null
    : missing >= got.asked ? got.failures[0].reason
      : `Amazon answered for ${got.asked - missing} of ${got.asked} keywords and targets. ${got.failures[0].reason}`
  return { at: now(), asked: new Set(expressions.map(themeExpressionKey)), byKey: got.suggestions, unavailable }
}
