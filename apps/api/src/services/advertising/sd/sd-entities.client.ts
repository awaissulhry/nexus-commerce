/**
 * SD-AUD (2026-10-20) — every Sponsored Display entity of some campaigns with ALL its settings: GET
 * /sd/{campaigns,adGroups,productAds,targets,negativeTargets}/extended (SD 3.0 openapi: CampaignResponseEx,
 * AdGroupResponseEx, ProductAdResponseEx, TargetingClauseEx, NegativeTargetingClauseEx).
 *
 * The plain `/sd/*` lists (ads-api-client.ts sdGet) carry a small set of fields; the `/extended` ones add what the v1
 * export never holds: servingStatus, bidOptimization, creativeType, landing pages, an audience target's nested expression
 * and the resolvedExpression that names its ids. Same GET style with comma-separated filters, through liveCall (the
 * channel gateway, the call ledger, the read quota). Every state is read (an archived target of a live campaign is still
 * a setting Claude may be asked about); pages of 100 by startIndex, chunks of 50 campaign ids.
 *
 * Read only. Sandbox answers nothing (no fixture is invented); an Amazon error propagates with its own text.
 */
import { adsMode, liveCall, type ClientContext } from '../ads-api-client.js'

/** Amazon's ids are JSON numbers here; Nexus keeps them as strings. */
type Id = number | string

export interface SdCampaignEx {
  campaignId: Id; name?: string; tactic?: string; budgetType?: string; budget?: number; startDate?: string; endDate?: string
  state?: string; portfolioId?: Id | null; servingStatus?: string; costType?: string
}
export interface SdAdGroupEx {
  adGroupId: Id; campaignId?: Id; name?: string; defaultBid?: number; state?: string; tactic?: string; creativeType?: string
  servingStatus?: string; bidOptimization?: string
}
export interface SdProductAdEx {
  adId: Id; adGroupId?: Id; campaignId?: Id; landingPageURL?: string; landingPageType?: string; adName?: string; asin?: string; sku?: string
  state?: string; servingStatus?: string
}
export type SdExpressionJson = Array<{ type?: string; value?: unknown; eventType?: string }>
export interface SdTargetEx {
  targetId: Id; adGroupId?: Id; campaignId?: Id; state?: string; expressionType?: string; bid?: number
  expression?: SdExpressionJson; resolvedExpression?: SdExpressionJson; servingStatus?: string
}
export interface SdNegativeTargetEx {
  targetId: Id; adGroupId?: Id; state?: string; expressionType?: string; expression?: SdExpressionJson; servingStatus?: string
}

const PAGE = 100
const MAX_PAGES = 100
const CHUNK = 50
const ALL_STATES = 'enabled,paused,archived'

async function extended<T>(ctx: ClientContext, resource: string, externalCampaignIds: readonly string[]): Promise<T[]> {
  if (adsMode() === 'sandbox' || !externalCampaignIds.length) return []
  const out: T[] = []
  for (let i = 0; i < externalCampaignIds.length; i += CHUNK) {
    const filter = encodeURIComponent(externalCampaignIds.slice(i, i + CHUNK).join(','))
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await liveCall<T[]>({
        profileId: ctx.profileId, region: ctx.region, method: 'GET',
        path: `/sd/${resource}/extended?campaignIdFilter=${filter}&stateFilter=${encodeURIComponent(ALL_STATES)}&startIndex=${page * PAGE}&count=${PAGE}`,
        contentType: 'application/json', acceptHeader: 'application/json',
      })
      const rows = Array.isArray(res) ? res : []
      out.push(...rows)
      if (rows.length < PAGE) break
    }
  }
  return out
}

export const listSdCampaignsEx = (ctx: ClientContext, ids: readonly string[]) => extended<SdCampaignEx>(ctx, 'campaigns', ids)
export const listSdAdGroupsEx = (ctx: ClientContext, ids: readonly string[]) => extended<SdAdGroupEx>(ctx, 'adGroups', ids)
export const listSdProductAdsEx = (ctx: ClientContext, ids: readonly string[]) => extended<SdProductAdEx>(ctx, 'productAds', ids)
export const listSdTargetsEx = (ctx: ClientContext, ids: readonly string[]) => extended<SdTargetEx>(ctx, 'targets', ids)
export const listSdNegativeTargetsEx = (ctx: ClientContext, ids: readonly string[]) => extended<SdNegativeTargetEx>(ctx, 'negativeTargets', ids)
