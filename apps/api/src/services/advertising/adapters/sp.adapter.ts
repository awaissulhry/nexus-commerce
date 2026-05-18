/**
 * Sponsored Products adapter — LIVE on v3 (Phase B).
 *
 * Phase A probes confirmed POST /sp/campaigns/list (with the
 * vnd.spCampaign.v3+json Accept header) returns 200 for our Atza| LWA
 * token where the legacy GET /sp/campaigns path returned 403.
 *
 * The list functions in ads-api-client.ts now drive the v3 endpoints
 * directly — same DTO shape comes out the other side (state lowercased,
 * dailyBudget extracted from budget.budget, dynamicBidding.strategy
 * normalized to camelCase) so the sync service is unchanged.
 */

import {
  listCampaigns as listSpCampaigns,
  listAdGroups as listSpAdGroups,
  listProductAds as listSpProductAds,
  listTargets as listSpTargets,
} from '../ads-api-client.js'
import type { AdsAdapter } from './types.js'

export const spAdapter: AdsAdapter = {
  adProduct: 'SPONSORED_PRODUCTS',
  campaignTypeDtoValue: 'sponsoredProducts',
  live: true,

  listCampaigns: listSpCampaigns,
  listAdGroups: listSpAdGroups,
  listTargets: listSpTargets,
  listProductAds: listSpProductAds,
}
