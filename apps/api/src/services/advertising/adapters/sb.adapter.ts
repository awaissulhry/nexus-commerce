/**
 * Sponsored Brands adapter — ready but blocked.
 *
 * Like SP, /hsa/* (Amazon's path for SB campaign endpoints) returns 403
 * with the JWT-validator error on profile-scoped requests. The list
 * methods below stub return empty arrays — flipping `live=true` plus
 * implementing the four list methods against /sb/* or the unified
 * /amazon-ads/v1/* endpoints (when they unblock) activates the adapter.
 *
 * SB-specific shape considerations when wiring:
 *   - SB campaigns carry creative assets (headline, brand logo URL,
 *     landing page URL, optional video) → Campaign.creativeAssetJson
 *   - SB uses a different default-bid model on ad groups → AdGroup.bidStrategyJson
 *   - SB keywords use the same v3 path as SP keywords
 *   - SB has a separate negative-keywords endpoint
 */

import type {
  AdsCampaignDTO,
  AdsAdGroupDTO,
  AdsTargetDTO,
  AdsProductAdDTO,
  ClientContext,
} from '../ads-api-client.js'
import type { AdsAdapter } from './types.js'

export const sbAdapter: AdsAdapter = {
  adProduct: 'SPONSORED_BRANDS',
  campaignTypeDtoValue: 'sponsoredBrands',
  live: false,
  liveBlockerReason:
    'Amazon /hsa/* (Sponsored Brands) endpoints reject Atza| LWA tokens with the same JWT-validator error as /sp/*',

  // Stubs return empty so an accidental call doesn't 403; the orchestrator
  // checks `live` first and skips entirely.
  listCampaigns: async (_ctx: ClientContext): Promise<AdsCampaignDTO[]> => [],
  listAdGroups: async (_ctx: ClientContext): Promise<AdsAdGroupDTO[]> => [],
  listTargets: async (_ctx: ClientContext): Promise<AdsTargetDTO[]> => [],
  listProductAds: async (_ctx: ClientContext): Promise<AdsProductAdDTO[]> => [],
}
