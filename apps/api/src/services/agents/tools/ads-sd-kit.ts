/**
 * Sponsored Display extras (P3c) — what Claude's SD rule, budget-insight, forecast and brand-safety tools share
 * (ads-sd-optimization-rules.tools.ts, ads-sd-budget-rules.tools.ts, ads-sd-forecast.tools.ts,
 * ads-sd-brand-safety.tools.ts): the market they name, where a change lands, and the sentences.
 *
 *   where       a market is served by this business's Amazon Ads profile (ads-profile-resolver.ts), or it is not found
 *               here; a campaign or ad group is this business's Sponsored Display one, with Amazon's id
 *               (advertising/sd/sd-entities.ts). Found first, so a request aimed at another business is "not found" before
 *               anything else is said.
 *   live only   Nexus keeps no copy of these (Amazon's rules and deny list are the record), so in sandbox mode nothing is
 *               asked and no change is queued: it would change nothing.
 *   reach       Amazon's write gate, as the approver's own click (4A): the connection, its writes switch, a halt; past his
 *               own value cap the card warns (pastOwnLimits). Stored with the preview; `execute` re-checks it (recheck).
 *   record      Amazon's answer is the record: no Nexus row is written, the change (before → after) is the AgentChange the
 *               approval gate stores, and undo reads Amazon again before it asks for the opposite change.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { adsMode, type ClientContext } from '../../advertising/ads-api-client.js'
import { checkAdsWriteGate } from '../../advertising/ads-write-gate.js'
import { SdAmazonError, SD_SANDBOX } from '../../advertising/sd/sd-answer.js'
import { logger } from '../../../utils/logger.js'
import { liveReachOf } from './ads-tool-guards.js'
import { canonical, reachRefusal, storedReach, type StoredReach } from './ads-change-kit.js'
import { currencyOfMarket } from './ads-portfolio.tools.js'
import type { ToolResult } from '../tool-types.js'

export const NOTHING_QUEUED = 'Nothing was queued.'
export const NOTHING_CHANGED = 'Nothing was changed.'

export const sdMarketArg = z.string().trim().toUpperCase().min(2).max(20)
export const sdIdArg = z.string().trim().min(1).max(64)
export const sdWhyArg = z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept with the change')

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
export const quote = (name: string | null | undefined) => `"${name ?? '?'}"`
export const basisOf = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)

/** Amazon's decimal amount in minor units of the market's currency, and back. */
export const centsOf = (amount: number | null | undefined): number | null => (amount == null || !Number.isFinite(amount) ? null : Math.round(amount * 100))
export const amountOf = (cents: number): number => Math.round(cents) / 100
export const money = (cents: number | null | undefined, currency: string | null) => (cents == null ? '?' : `${currency ?? ''} ${(cents / 100).toFixed(2)}`.trim())

/** Why a change is not queued in sandbox mode: there is nothing in Nexus it could change. */
export const SD_NOT_LIVE = 'Amazon Ads runs in sandbox mode on this server (NEXUS_AMAZON_ADS_MODE), and Nexus keeps no copy of Sponsored '
  + `Display rules or the deny list, so approving it would change nothing. ${NOTHING_QUEUED}`

// ── The market ────────────────────────────────────────────────────────────────────────────────────────────────

/** A market this business advertises in: its Amazon Ads profile as the client's context, and its currency. */
export interface SdMarket { market: string; ctx: ClientContext; profileId: string; currency: string | null }

/** The market's Amazon Ads profile in this business, or why not ("not found"). */
export async function sdMarketOf(market: string): Promise<SdMarket | { refusal: string }> {
  const { adsProfileFor } = await import('../../advertising/ads-profile-resolver.js')
  const ref = await adsProfileFor(market)
  if (!ref) return { refusal: `Amazon Ads market ${market} not found in this business: no advertising profile serves it (business-overview lists the markets).` }
  const region = ref.region === 'NA' || ref.region === 'FE' ? ref.region : 'EU'
  return { market, ctx: { profileId: ref.profileId, region }, profileId: ref.profileId, currency: await currencyOfMarket(market) }
}

// ── Where a change lands ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a change in this market lands, as the approver's own click (4A): live on its profile, or refused (not queued).
 * Sandbox mode refuses too (SD_NOT_LIVE). `valueCents`: the largest amount it sets (the value cap warns past it).
 */
export async function sdReach(market: string, valueCents = 0): Promise<{ reach: StoredReach } | { refusal: string }> {
  if (adsMode() === 'sandbox') return { refusal: SD_NOT_LIVE }
  const reach = liveReachOf(await checkAdsWriteGate({ marketplace: market, payloadValueCents: Math.max(0, Math.round(valueCents)), manual: true, confirmOwnLimits: true }))
  if (reach.reach === 'refused') return { refusal: `${reachRefusal(reach)} ${NOTHING_QUEUED}` }
  if (reach.reach === 'sandbox') return { refusal: SD_NOT_LIVE }
  return { reach: storedReach(reach) }
}

/** The sentence beside the change: where it lands, and that it is Amazon's direct answer, not a queued write. */
export function sdReachNote(reach: StoredReach): string {
  const base = reach.reach === 'live'
    ? `live: after approval it is sent to Amazon at once (Amazon Ads profile ${reach.profileId}) — one call, no 5-minute cancel window.`
    : 'sandbox: nothing is sent.'
  const over = reach.pastOwnLimits?.length ? ` Warning — this goes past your own limits: ${reach.pastOwnLimits.map((l) => l.reason).join('; ')}. Approving it sends it anyway.` : ''
  return `${base}${over}`
}

// ── Answers ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A handler or execute that never throws: Amazon's refusal (or no answer) is said in words. */
export async function sdAnswered(nothing: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof SdAmazonError) return { ok: false, error: `${error.message} ${nothing}`.trim() }
    // Every Amazon call is wrapped by sdCall: anything else failed inside Nexus.
    const said = String(error instanceof Error ? error.message : error).replace(/https?:\/\/\S+/g, '(a link)').slice(0, 200)
    logger.warn('[ads-sd-tools] unexpected failure', { error: said })
    return { ok: false, error: `Nexus could not do this: ${said}. ${nothing}`.trim() }
  }
}

/** A read in sandbox mode: nothing is asked. */
export const sandboxRead = (): ToolResult | null => (adsMode() === 'sandbox' ? { ok: false, error: SD_SANDBOX } : null)

/** A date as Amazon takes it (YYYYMMDD) from YYYY-MM-DD, and back. */
export const amazonDay = (iso: string) => iso.split('-').join('')
export const isoDay = (amazon: string | null | undefined) => (amazon && /^\d{8}$/.test(amazon) ? `${amazon.slice(0, 4)}-${amazon.slice(4, 6)}-${amazon.slice(6, 8)}` : amazon ?? null)
export const todayIso = () => new Date().toISOString().slice(0, 10)
export const isoDateArg = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD')
export const realDay = (d: string) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d
