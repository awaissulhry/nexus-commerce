'use client'

/**
 * Amazon Advertising Console deep-link helpers.
 * profileId = the Amazon Advertising API entity ID (stored on AmazonAdsConnection).
 * All EU marketplaces use advertising.amazon.com.
 * UK uses advertising.amazon.co.uk.
 * These links open the operator's real Amazon Ads account in a new tab.
 */

const BASE: Record<string, string> = {
  UK: 'https://advertising.amazon.co.uk',
  JP: 'https://advertising.amazon.co.jp',
  AU: 'https://advertising.amazon.com.au',
  IN: 'https://advertising.amazon.in',
  BR: 'https://advertising.amazon.com.br',
  MX: 'https://advertising.amazon.com.mx',
  CA: 'https://advertising.amazon.ca',
  SG: 'https://advertising.amazon.sg',
  AE: 'https://advertising.amazon.ae',
}
const DEFAULT_BASE = 'https://advertising.amazon.com'

export function amazonBase(marketplace: string | null | undefined): string {
  return BASE[(marketplace ?? '').toUpperCase()] ?? DEFAULT_BASE
}

/** Deep link to the campaigns list for a specific marketplace profile. */
export function amazonCampaignsHref(profileId: string, marketplace: string | null | undefined): string {
  return `${amazonBase(marketplace)}/cm/campaigns?entityId=${profileId}`
}

/** Deep link directly to a specific campaign in the Amazon console. */
export function amazonCampaignHref(externalCampaignId: string, profileId: string, marketplace: string | null | undefined): string {
  return `${amazonBase(marketplace)}/cm/campaigns/${externalCampaignId}?entityId=${profileId}`
}

/** Deep link to a specific ad group within a campaign. */
export function amazonAdGroupHref(externalCampaignId: string, externalAdGroupId: string, profileId: string, marketplace: string | null | undefined): string {
  return `${amazonBase(marketplace)}/cm/adgroups/${externalAdGroupId}?entityId=${profileId}&campaignId=${externalCampaignId}`
}

/** Short display label for a marketplace code. */
export const MARKET_LABEL: Record<string, string> = {
  IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', NL: 'Netherlands',
  BE: 'Belgium', SE: 'Sweden', PL: 'Poland', IE: 'Ireland', UK: 'United Kingdom',
  US: 'United States', CA: 'Canada', MX: 'Mexico', JP: 'Japan', AU: 'Australia',
  IN: 'India', BR: 'Brazil', AE: 'UAE', SG: 'Singapore',
}

export function marketLabel(code: string): string {
  return MARKET_LABEL[code.toUpperCase()] ?? code
}
