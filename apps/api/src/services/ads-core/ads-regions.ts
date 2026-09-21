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
 * Amazon's LWA consent page per region.
 *
 * Source: FINAL-PLAN.md §4.1 — *"Amazon Ads uses the North America consent page for
 * every region … Research says the EU page is `eu.account.amazon.com`."* These three
 * values come from that research; they have **not** been re-verified against Amazon's
 * own pages in this session.
 *
 * The token endpoint is NOT regional — `api.amazon.com/auth/o2/token` serves all three,
 * which is why only this map is per region.
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

/**
 * P4.5c — the consent page to send an operator to.
 *
 * 🔴 **Deliberately NOT regional by default, and that is the whole decision.**
 *
 * The plan calls the North-America-for-everything consent page a gap, and as a
 * capability it is. But the evidence says it is not a live breakage: the EU grant this
 * account runs on **was obtained through `www.amazon.com/ap/oa`** and works — nine EU
 * profiles, 469k logged calls. `services/cx/connectors/amazon-ads/spec.ts` records the
 * same thing in its header, from a session that had already tried the regional hosts:
 * *"the regional consent hosts this file guessed as a stub are not what the account was
 * granted through."*
 *
 * So moving the default would risk a live, working sign-in to close a gap nobody has
 * hit. Instead the capability is real and explicit: `NEXUS_ADS_CONSENT_REGIONAL=1`
 * uses each region's own page, and `/connect?region=…` names the region. With the
 * variable unset every consent URL is byte-identical to today's.
 *
 * Flip it when an advertiser whose Amazon account is EU-only or FE-only cannot sign in
 * at the North American page — which is the symptom this gap actually produces.
 */
export function adsConsentUrl(region: string | null | undefined): string {
  if (process.env.NEXUS_ADS_CONSENT_REGIONAL !== '1') return ADS_CONSENT_HOSTS.NA
  return ADS_CONSENT_HOSTS[asAdsRegion(region) ?? 'NA']
}
