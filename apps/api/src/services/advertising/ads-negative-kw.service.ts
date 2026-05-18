/**
 * Phase J — Create negative keywords on Amazon SP campaigns.
 *
 * Phase J.1 probes confirmed:
 *   - v1 unified /negativeTargets is gateway-blocked (Atza| JWT issue)
 *   - SP v3 /sp/negativeKeywords + /sp/campaignNegativeKeywords accept
 *     our LWA token (same gateway as the working /sp/campaigns/list)
 *   - SB v4 negativeKeywords is also blocked; SD has no concept
 *
 * Scope of this service: SP only, covering ~89% of campaigns in the
 * IT account. SB negatives need Amazon to unblock the v1 gateway
 * (separate concern, deferred).
 *
 * Idempotency: before submitting a create, check AdTarget for an
 * existing negative with the same (campaign/adGroup, keywordText,
 * matchType) and short-circuit if found. The v1 export cron picks
 * up new negatives on the next 6h tick and writes them back into
 * AdTarget, so subsequent operator clicks see "already exists" and
 * skip the API call.
 *
 * Write gate: every create call goes through ads-write-gate.ts so
 * the Phase 9 graduation rules apply (NEXUS_AMAZON_ADS_MODE=live +
 * mode=production + writesEnabledAt + value cap).
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { liveCall, adsMode, type AdsRegion } from './ads-api-client.js'
import { checkAdsWriteGate } from './ads-write-gate.js'

export type NegativeMatchType = 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE'
export type NegativeScope = 'AD_GROUP' | 'CAMPAIGN'

export interface CreateNegativeArgs {
  profileId: string
  region?: AdsRegion
  /** Required for AD_GROUP scope; ignored for CAMPAIGN scope. */
  externalAdGroupId?: string
  externalCampaignId: string
  keywordText: string
  matchType: NegativeMatchType
  scope: NegativeScope
  /** Marketplace code (e.g. APJ6JRA9NG5V4) — needed by the write gate. */
  marketplace: string
}

export interface CreateNegativeResult {
  ok: boolean
  mode: 'sandbox' | 'live'
  /** Set when Amazon returns a new keywordId for the created negative. */
  externalNegativeKeywordId: string | null
  /** Set when the negative already existed locally (idempotent skip). */
  alreadyExisted: boolean
  /** Set when the write gate denied the call. */
  denied: { reason: string; deniedAt: string } | null
  rawResponse: unknown
}

// ── Endpoint constants (legacy SP v3) ─────────────────────────────────

const SP_NEGATIVE_KW_PATH = '/sp/negativeKeywords'
const SP_NEGATIVE_KW_MIME = 'application/vnd.spNegativeKeyword.v3+json'

const SP_CAMPAIGN_NEGATIVE_KW_PATH = '/sp/campaignNegativeKeywords'
const SP_CAMPAIGN_NEGATIVE_KW_MIME = 'application/vnd.spCampaignNegativeKeyword.v3+json'

// ── Idempotency probe ────────────────────────────────────────────────

async function existsLocally(args: {
  externalCampaignId: string
  externalAdGroupId?: string
  keywordText: string
  matchType: NegativeMatchType
  scope: NegativeScope
}): Promise<boolean> {
  // Resolve local IDs from the external ones
  const campaign = await prisma.campaign.findFirst({
    where: { externalCampaignId: args.externalCampaignId },
    select: { id: true },
  })
  if (!campaign) return false

  // Match type stored on AdTarget.expressionType is uppercase like
  // 'NEGATIVE_EXACT' or 'NEGATIVE_PHRASE' (Amazon's v3 vocab) — keep
  // case consistent.
  if (args.scope === 'AD_GROUP') {
    if (!args.externalAdGroupId) return false
    const adGroup = await prisma.adGroup.findFirst({
      where: { externalAdGroupId: args.externalAdGroupId, campaignId: campaign.id },
      select: { id: true },
    })
    if (!adGroup) return false
    const existing = await prisma.adTarget.findFirst({
      where: {
        adGroupId: adGroup.id,
        isNegative: true,
        negativeLevel: 'AD_GROUP',
        expressionValue: args.keywordText,
        expressionType: args.matchType,
      },
      select: { id: true },
    })
    return existing != null
  }

  // CAMPAIGN scope — campaign-level negatives. AdTarget stores them
  // attached to an ad group in our schema (legacy structure). v1 export
  // sets negativeLevel='CAMPAIGN' so we filter on that.
  const existing = await prisma.adTarget.findFirst({
    where: {
      adGroup: { campaignId: campaign.id },
      isNegative: true,
      negativeLevel: 'CAMPAIGN',
      expressionValue: args.keywordText,
      expressionType: args.matchType,
    },
    select: { id: true },
  })
  return existing != null
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Create a negative keyword in Amazon at the given scope. Idempotent:
 * existing negatives short-circuit without hitting Amazon.
 *
 * Goes through the Phase 9 write gate — if the gate denies, returns
 * `denied: { reason, deniedAt }` and no API call is made.
 *
 * Amazon SP v3 returns 207 Multi-Status with a per-item array:
 *   { negativeKeywords: { success: [{ keywordId, ... }], error: [...] } }
 * We extract the first success record's keywordId.
 */
export async function createNegative(
  args: CreateNegativeArgs,
): Promise<CreateNegativeResult> {
  const mode = adsMode()
  const region: AdsRegion = args.region ?? 'EU'

  // 1. Idempotency check
  if (await existsLocally(args)) {
    logger.info('[ads-negative-kw] already exists locally — skipping create', {
      profileId: args.profileId,
      keywordText: args.keywordText,
      matchType: args.matchType,
      scope: args.scope,
    })
    return {
      ok: true,
      mode,
      externalNegativeKeywordId: null,
      alreadyExisted: true,
      denied: null,
      rawResponse: { localDedup: true },
    }
  }

  // 2. Write gate. Even sandbox calls go through so the same audit
  // trail applies; gate returns mode=sandbox for env=sandbox.
  const gate = await checkAdsWriteGate({
    marketplace: args.marketplace,
    payloadValueCents: 0, // negative-keyword creation is a structural
                          // change with no monetary value
  })
  if (gate.allowed === false) {
    logger.warn('[ads-negative-kw] write gate denied', {
      profileId: args.profileId, reason: gate.reason, deniedAt: gate.deniedAt,
    })
    return {
      ok: false,
      mode,
      externalNegativeKeywordId: null,
      alreadyExisted: false,
      denied: { reason: gate.reason, deniedAt: gate.deniedAt },
      rawResponse: null,
    }
  }

  // 3. Sandbox short-circuit: don't call Amazon, just log + return ok
  if (mode === 'sandbox') {
    logger.info('[ADS-SANDBOX] createNegative', {
      profileId: args.profileId,
      scope: args.scope,
      campaignId: args.externalCampaignId,
      adGroupId: args.externalAdGroupId,
      keywordText: args.keywordText,
      matchType: args.matchType,
    })
    return {
      ok: true,
      mode,
      externalNegativeKeywordId: null,
      alreadyExisted: false,
      denied: null,
      rawResponse: { sandbox: true },
    }
  }

  // 4. Live create
  const path = args.scope === 'AD_GROUP'
    ? SP_NEGATIVE_KW_PATH : SP_CAMPAIGN_NEGATIVE_KW_PATH
  const mime = args.scope === 'AD_GROUP'
    ? SP_NEGATIVE_KW_MIME : SP_CAMPAIGN_NEGATIVE_KW_MIME

  const item: Record<string, unknown> = {
    campaignId: args.externalCampaignId,
    keywordText: args.keywordText,
    matchType: args.matchType,
    state: 'ENABLED',
  }
  if (args.scope === 'AD_GROUP') {
    if (!args.externalAdGroupId) {
      return {
        ok: false, mode,
        externalNegativeKeywordId: null, alreadyExisted: false,
        denied: null,
        rawResponse: { error: 'externalAdGroupId required for AD_GROUP scope' },
      }
    }
    item.adGroupId = args.externalAdGroupId
  }

  const bodyKey = args.scope === 'AD_GROUP' ? 'negativeKeywords' : 'campaignNegativeKeywords'
  const response = await liveCall<{
    negativeKeywords?: { success?: Array<{ keywordId: string; index: number }>; error?: Array<{ errors: unknown; index: number }> }
    campaignNegativeKeywords?: { success?: Array<{ keywordId: string; index: number }>; error?: Array<{ errors: unknown; index: number }> }
  }>({
    profileId: args.profileId,
    region,
    method: 'POST',
    path,
    body: { [bodyKey]: [item] },
    contentType: mime,
    acceptHeader: mime,
  })

  const block = (response as Record<string, unknown>)[bodyKey] as
    | { success?: Array<{ keywordId: string }>; error?: Array<{ errors: unknown }> }
    | undefined
  const successList = block?.success ?? []
  const errorList = block?.error ?? []

  if (errorList.length > 0) {
    logger.warn('[ads-negative-kw] Amazon returned per-item errors', {
      profileId: args.profileId,
      errors: errorList,
    })
    return {
      ok: false,
      mode: 'live',
      externalNegativeKeywordId: null,
      alreadyExisted: false,
      denied: null,
      rawResponse: response,
    }
  }

  const externalId = successList[0]?.keywordId ?? null
  logger.info('[ADS-LIVE] createNegative success', {
    profileId: args.profileId,
    scope: args.scope,
    externalId,
    keywordText: args.keywordText,
  })

  return {
    ok: true,
    mode: 'live',
    externalNegativeKeywordId: externalId,
    alreadyExisted: false,
    denied: null,
    rawResponse: response,
  }
}
