/**
 * P4.5b — Amazon Ads regions: ONE definition of the region → host fact.
 *
 * It was written out five times (`services/advertising/ads-api-client.ts:56`,
 * `services/advertising/ads-debug-probe.service.ts:24`,
 * `services/cx/connectors/amazon-ads/spec.ts:20`, plus `ADS_API_BASE` in
 * `routes/amazon-ads-auth.routes.ts:53` and a hard-coded URL in
 * `services/contract/channel-contracts.ts:91` that were EU-only). Four of them agreed;
 * the two EU-only ones were the whole reason NA and FE profiles were invisible.
 *
 * The measured cost of that (development database, 2026-09-21): the CX connector's
 * three-region sweep records **14 advertising profiles** — 9 EU, 3 NA (US, CA, MX),
 * 2 FE (AU, JP) — while `AmazonAdsConnection`, which every ads job reads, holds the
 * **9 EU ones only**. Five real advertising profiles are invisible to the money path.
 *
 * 🔴 And the region is not cosmetic. `ads-api-client.ts` picks the API host from the
 * row's `region`, and the connect callback wrote `region: 'EU'` for every profile.
 * The first NA row created under that rule would have called the EU host with a NA
 * profile id — an authorization failure, not a wrong number, which is the one mercy in
 * it.
 */

export type AdsRegion = 'EU' | 'NA' | 'FE'

/** Region → Amazon Ads API host. The one definition. */
export const ADS_REGION_HOSTS: Record<AdsRegion, string> = {
  EU: 'https://advertising-api-eu.amazon.com',
  NA: 'https://advertising-api.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
}

/** Every region, in the order discovery sweeps them. EU first: it is where the account lives. */
export const ADS_REGIONS: AdsRegion[] = ['EU', 'NA', 'FE']

/**
 * Amazon's LWA consent page for a region.
 *
 * Amazon serves consent from three hosts and the advertiser's own Amazon account
 * decides which one accepts their sign-in. `www.amazon.com/ap/oa` is the North
 * American page and was used for every region — see `build/P4.5c.md` for what that
 * does and does not break.
 */
export const ADS_CONSENT_HOSTS: Record<AdsRegion, string> = {
  NA: 'https://www.amazon.com/ap/oa',
  EU: 'https://eu.account.amazon.com/ap/oa',
  FE: 'https://apac.account.amazon.com/ap/oa',
}

/** A region string from a database row or an operator, or null when it names no region. */
export function asAdsRegion(value: string | null | undefined): AdsRegion | null {
  if (!value) return null
  const up = value.toUpperCase()
  return (ADS_REGIONS as string[]).includes(up) ? (up as AdsRegion) : null
}

/**
 * The host for a region, refusing an unknown one.
 *
 * P4.4a's rule, applied here: a fact that lives in data gets ONE accessor, and the
 * accessor refuses rather than guessing. Silently falling back to EU is what a NA
 * profile did for as long as this map had two shapes.
 */
export function adsHostFor(region: string | null | undefined): string {
  const r = asAdsRegion(region)
  if (!r) throw new Error(`[ads] "${region ?? 'null'}" is not an Amazon Ads region (EU, NA, FE) — nothing was sent`)
  return ADS_REGION_HOSTS[r]
}
