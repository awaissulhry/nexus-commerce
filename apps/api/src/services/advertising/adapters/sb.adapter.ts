/**
 * Sponsored Brands adapter — LIVE on v4 (Phase B).
 *
 * Phase A probes confirmed POST /sb/v4/campaigns/list (with the
 * vnd.sbcampaignresource.v4+json Accept header) returns 200 for our
 * Atza| LWA token where the legacy GET /sb/v4/campaigns returned 404.
 *
 * SB v4 uses similar paginated POST /list pattern to SP v3 — the
 * listV3Paginated helper in ads-api-client.ts is reused. SB has no
 * "product ads" concept (it has creative-bearing ads attached to ad
 * groups instead); listProductAds returns an empty array. SB creative
 * ingestion (headline, brand logo, video) can land as a follow-up
 * that writes to Campaign.creativeAssetJson.
 */

import {
  listSbCampaigns,
  listSbAdGroups,
  listSbTargets,
} from '../ads-api-client.js'
import type {
  AdsProductAdDTO,
  ClientContext,
} from '../ads-api-client.js'
import type { AdsAdapter } from './types.js'

export const sbAdapter: AdsAdapter = {
  adProduct: 'SPONSORED_BRANDS',
  campaignTypeDtoValue: 'sponsoredBrands',
  live: true,

  listCampaigns: listSbCampaigns,
  listAdGroups: listSbAdGroups,
  listTargets: listSbTargets,
  // SB has no SP-style product ads; creatives are attached directly to
  // ad groups. Returns empty until SB creative ingestion lands.
  listProductAds: async (_ctx: ClientContext): Promise<AdsProductAdDTO[]> => [],
}
