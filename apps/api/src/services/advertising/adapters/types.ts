/**
 * Phase 3 — Unified adapter contract for every Amazon ad product.
 *
 * Each ad product (Sponsored Products, Sponsored Brands, Sponsored
 * Display, Sponsored TV) gets its own self-contained adapter file
 * implementing this interface. The sync orchestrator iterates a list of
 * adapters per profile and calls the same four methods regardless of
 * which product is being synced.
 *
 * When Amazon's unified `/amazon-ads/v1/*` endpoints unblock (currently
 * 403 with the same JWT-validator issue as `/sp/*`), the only change
 * required is in the adapter implementation — the orchestrator, DB
 * schema, automation rules, and UI all remain unchanged.
 *
 * Today's state:
 *   sd.adapter.ts  ✅ live — Amazon's /sd/* accepts our Atza| token
 *   sp.adapter.ts  ⛔ 403 from Amazon's side; ready to flip to working
 *                       the moment auth is unblocked
 *   sb.adapter.ts  ⛔ 403 from Amazon's side; same as SP
 *   stv.adapter.ts (deferred — requires separate enrollment with Amazon)
 */

import type {
  AdsCampaignDTO,
  AdsAdGroupDTO,
  AdsTargetDTO,
  AdsProductAdDTO,
  ClientContext,
} from '../ads-api-client.js'

export type AdProduct =
  | 'SPONSORED_PRODUCTS'
  | 'SPONSORED_BRANDS'
  | 'SPONSORED_DISPLAY'
  | 'SPONSORED_TELEVISION'

export interface AdsAdapter {
  /** Product discriminator written to Campaign.adProduct on upsert. */
  readonly adProduct: AdProduct

  /** Sponsored-Brands / SD use 'sponsoredBrands'/'sponsoredDisplay'
   *  in their DTO; the legacy CampaignType enum value (SP/SB/SD) is
   *  derived from the DTO downstream. */
  readonly campaignTypeDtoValue: AdsCampaignDTO['campaignType']

  /** True when this adapter is currently reachable. SD is true today; SP
   *  and SB are false until Amazon resolves the 403 auth issue. The
   *  orchestrator skips adapters with `live=false` and records a
   *  per-profile error reason so the UI can show why no data flowed.
   *
   *  Marked false rather than removed so the adapter still exists as a
   *  ready-to-flip target — only `live` flips when auth unblocks. */
  readonly live: boolean
  readonly liveBlockerReason?: string

  listCampaigns(ctx: ClientContext): Promise<AdsCampaignDTO[]>
  listAdGroups(ctx: ClientContext): Promise<AdsAdGroupDTO[]>
  listTargets(ctx: ClientContext): Promise<AdsTargetDTO[]>
  listProductAds(ctx: ClientContext): Promise<AdsProductAdDTO[]>
}
