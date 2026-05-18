/**
 * Sponsored Display adapter — currently the only live ad-product adapter.
 * Amazon's /sd/* endpoints accept the Atza| LWA opaque token while
 * /sp/* and /sb/* reject it with a 403 JWT-validator mismatch.
 *
 * Each method delegates to the SD-specific list functions in
 * ads-api-client.ts, which already do String() normalization of Amazon's
 * numeric IDs at the API boundary (fixed in Phase 1A).
 */

import {
  listSdCampaigns,
  listSdAdGroups,
  listSdProductAds,
  listSdTargets,
} from '../ads-api-client.js'
import type { AdsAdapter } from './types.js'

export const sdAdapter: AdsAdapter = {
  adProduct: 'SPONSORED_DISPLAY',
  campaignTypeDtoValue: 'sponsoredDisplay',
  live: true,

  listCampaigns: listSdCampaigns,
  listAdGroups: listSdAdGroups,
  listTargets: listSdTargets,
  listProductAds: listSdProductAds,
}
