/**
 * Sponsored Products adapter — ready but blocked.
 *
 * Today every /sp/* endpoint returns 403 with
 * "Invalid key=value pair (missing equal-sign) in Authorization header"
 * for our Atza| LWA token (Amazon's stricter SP v3 JWT validator). The
 * code path is wired and tested in sandbox; flipping `live=true` once
 * Amazon support resolves the auth issue (or once we successfully swap
 * to the `/amazon-ads/v1/*` unified endpoints) requires zero additional
 * code.
 *
 * The adapter is exposed so the orchestrator can still iterate over all
 * adapters consistently — it just records a `liveBlockerReason` on each
 * sync attempt rather than silently skipping.
 *
 * To activate later:
 *   - Confirm /sp/campaigns returns 200 (re-run debug endpoint)
 *   - Flip `live: true` below
 *   - (Optional) Repoint each list method at /amazon-ads/v1/* when v1
 *     unblocks — the response shape is identical via the existing
 *     toStrId() normalization.
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
  // Set to false today — every call returns 403 from Amazon. The
  // orchestrator surfaces this as `SP blocked: <reason>` per profile
  // rather than burning quota on every cycle.
  live: false,
  liveBlockerReason:
    'Amazon /sp/* endpoints reject Atza| LWA tokens with profile-scoped requests (support ticket pending)',

  listCampaigns: listSpCampaigns,
  listAdGroups: listSpAdGroups,
  listTargets: listSpTargets,
  listProductAds: listSpProductAds,
}
