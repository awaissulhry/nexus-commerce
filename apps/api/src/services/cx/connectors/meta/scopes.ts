/**
 * The Meta permissions a business's system-user token carries (Meta ads M1, 2026-10-20). A system-user token is made
 * by a person in Meta Business settings → System users → Generate token, ticking permissions; Nexus reads what was
 * ticked from `debug_token` (`scopes`), never asks for them (no Facebook Login screen in Nexus).
 *
 * Checked 2026-10-20: developers.facebook.com/docs/marketing-api/businessmanager/systemuser/
 * install-apps-and-generate-tokens ("Supported scopes for system users") and
 * /documentation/ads-commerce/marketing-api/get-started/authorization (ads_read reads ads and insights; ads_management
 * changes them; business_management reads the business's assets).
 *
 * M1 reads only: `ads_read` is required — `ads_management` covers it too (it grants reading the ads it manages). The
 * others are optional: a token without one is complete, and what needs it says so in words (`metaPermissionGaps`).
 * Instagram accounts need instagram_basic AND pages_show_list (they are read through the Pages).
 */
export const META_SCOPE = {
  ads_read: 'ads_read',
  ads_management: 'ads_management',
  business_management: 'business_management',
  pages_show_list: 'pages_show_list',
  pages_read_engagement: 'pages_read_engagement',
  instagram_basic: 'instagram_basic',
  catalog_management: 'catalog_management',
} as const

export const META_REQUIRED_SCOPES: string[] = [META_SCOPE.ads_read]

export const META_OPTIONAL_SCOPES: string[] = [
  META_SCOPE.ads_management,
  META_SCOPE.business_management,
  META_SCOPE.pages_show_list,
  META_SCOPE.pages_read_engagement,
  META_SCOPE.instagram_basic,
  META_SCOPE.catalog_management,
]

/** What each permission lets Nexus do, for the sentence a missing one gets. */
const NEEDED_FOR: Readonly<Record<string, string>> = {
  ads_read: 'read the ad account, its campaigns and its numbers',
  ads_management: 'change ads (set-meta-status pauses, switches on and archives campaigns, ad sets and ads; set-meta-campaign, set-meta-ad-set and set-meta-budget-schedule change their settings, budgets and bids; apply-meta-recommendations, create-meta-experiment, set-meta-experiment and end-meta-experiment apply the recommendations of Meta and make, change and end its tests)',
  business_management: "read the business portfolio's assets",
  pages_show_list: 'list the Facebook Pages',
  pages_read_engagement: "read the Pages' Instagram accounts",
  instagram_basic: 'read the Instagram accounts (with pages_show_list)',
  catalog_management: 'read the catalogs (later Nexus versions)',
}

export interface MetaPermissionGap { scope: string; required: boolean; neededFor: string }

/** The permissions the token does not carry, required first, each with what it is needed for. */
export function metaPermissionGaps(grantedScopes: readonly string[]): MetaPermissionGap[] {
  const granted = new Set(grantedScopes)
  if (granted.has(META_SCOPE.ads_management)) granted.add(META_SCOPE.ads_read)
  return [...META_REQUIRED_SCOPES, ...META_OPTIONAL_SCOPES]
    .filter((scope) => !granted.has(scope))
    .map((scope) => ({ scope, required: META_REQUIRED_SCOPES.includes(scope), neededFor: NEEDED_FOR[scope] ?? 'a later Nexus feature' }))
}
