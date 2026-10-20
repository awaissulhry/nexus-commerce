/**
 * P2b (2026-10-20, Owner: "control and manage it all") — the Sponsored Display updates W4-11 did not send: an ad group's
 * name, default bid and state, and a product ad's state, each archived too. Built apart from the call, as the W4-11
 * builders in ads-api-client.ts (`SbSdRequest`), and sent by the same `sendSbSdUpdate` — through `liveCall`, so through
 * the channel gateway like every call, and nothing in sandbox. A campaign's settings and a target's bid and state are
 * ads-api-client.ts's own (sdCampaignUpdateRequest, sdTargetUpdateRequest). Shapes are Amazon's SD 3.0 OpenAPI document:
 *
 *   updateAdGroups   PUT /sd/adGroups    `[{ adGroupId (int64), name?, defaultBid?, state?: enabled|paused|archived }]`
 *                    — "The mutable fields are 'name', 'defaultBid', and 'state'" (bidOptimization and creativeType are
 *                    fixed when the ad group is made)
 *   updateProductAds PUT /sd/productAds  `[{ adId (int64), state?: enabled|paused|archived }]` — "the only mutable field, state"
 *
 * Both answer 207 with `[{ code, description, <id> }]` (sbSdItemsResult reads it). An archive is the update to
 * `archived` — Amazon's DELETE of each "is equivalent to an update operation that sets the status field to 'archived'",
 * and "setting the status field to 'archived' is permanent and can't be undone".
 */
import { amazonIntId, type SbSdRequest } from '../ads-api-client.js'

/** What an SD ad group update changes. The default bid is in the currency's units (cents / 100), as every update. */
export interface SdAdGroupPatch {
  state?: 'enabled' | 'paused' | 'archived'
  name?: string
  defaultBid?: number
}

/** SD 3.0 `updateAdGroups` — one ad group. Pure, so the shape is testable without a network. */
export function sdAdGroupUpdateRequest(externalAdGroupId: string, patch: SdAdGroupPatch): SbSdRequest {
  const adGroup: Record<string, unknown> = { adGroupId: amazonIntId(externalAdGroupId) }
  if (patch.name != null) adGroup.name = patch.name
  if (patch.defaultBid != null) adGroup.defaultBid = patch.defaultBid
  if (patch.state) adGroup.state = patch.state
  return { method: 'PUT', path: '/sd/adGroups', body: [adGroup], contentType: 'application/json', acceptHeader: 'application/json', answer: 'items' }
}

/** SD 3.0 `updateProductAds` — one product ad's state. Pure. */
export function sdProductAdUpdateRequest(externalAdId: string, state: 'enabled' | 'paused' | 'archived'): SbSdRequest {
  return { method: 'PUT', path: '/sd/productAds', body: [{ adId: amazonIntId(externalAdId), state }], contentType: 'application/json', acceptHeader: 'application/json', answer: 'items' }
}
