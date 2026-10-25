/**
 * Meta ads step 4 — the fixed lists Meta's business-portfolio reads name, in ONE leaf module for the reads
 * (marketing/meta-ads/live-business.ts) and the gateway (gateway/meta-calls.ts ROUTE_KEYS), which lets each of these query
 * keys travel only with a value on these lists. No imports: both sides read it without an import cycle.
 *
 * Checked 2026-10-25 (curl ≥ 3 s apart, developers.facebook.com/documentation/ads-commerce/marketing-api/reference/<page>.md):
 *   - business-role-request/assigned_client_assets and …/assigned_owned_assets: `asset_type` (enum, REQUIRED)
 *   - business/client_objects: `type` (enum, REQUIRED; Meta spells its values with hyphens)
 *   - business/initiated_sharing_agreements: `request_status` (enum), `receiving_business_id`
 *   - business/partner_relationships: `exclude_declined_requests` (boolean)
 */

/** The asset types Nexus asks an invitation about (Meta's enum is far longer; these are the kinds an advertiser shares). */
export const META_INVITATION_ASSET_TYPES = [
  'AD_ACCOUNT', 'PAGE', 'INSTAGRAM_ACCOUNT_V2', 'INSTAGRAM_BUSINESS_ASSET', 'PRODUCT_CATALOG', 'PIXEL', 'APP', 'WHATSAPP_BUSINESS_ACCOUNT',
  'EVENTS_DATASET', 'CUSTOM_CONVERSION', 'BUSINESS_CREATIVE_FOLDER', 'OWNED_DOMAIN',
] as const
export type MetaInvitationAssetType = typeof META_INVITATION_ASSET_TYPES[number]
/** What an invitation is asked about when the caller names no type. */
export const META_INVITATION_DEFAULT_TYPES: readonly MetaInvitationAssetType[] = ['AD_ACCOUNT', 'PAGE', 'INSTAGRAM_ACCOUNT_V2', 'PRODUCT_CATALOG', 'PIXEL']

/** business/client_objects `type`: Nexus's plain word → Meta's value (exactly as Meta spells it). */
export const META_CLIENT_OBJECT_TYPES = {
  page: 'page', 'ad-account': 'ad-account', catalog: 'product-catalog', pixel: 'pixel', app: 'app', instagram: 'instagram-account-v2',
  'instagram-asset': 'instagram_business_asset', whatsapp: 'whatsapp-business-account', dataset: 'events-dataset', 'custom-conversion': 'custom-conversion',
  'creative-folder': 'business-creative-folder', domain: 'owned-domain',
} as const
export type MetaClientObjectKind = keyof typeof META_CLIENT_OBJECT_TYPES
export const META_CLIENT_OBJECT_VALUES: readonly string[] = Object.values(META_CLIENT_OBJECT_TYPES)

/** business/initiated_sharing_agreements `request_status` (v26 enum). */
export const META_SHARING_AGREEMENT_STATUSES = [
  'APPROVE', 'DECLINE', 'IN_PROGRESS', 'EXPIRED', 'PENDING', 'PENDING_INTEGRITY_REVIEW', 'PENDING_EMAIL_VERIFICATION', 'CANCELED',
  'MMA_DIRECT_ASSETS_PENDING', 'MMA_DIRECT_ASSETS_APPROVED', 'MMA_DIRECT_ASSETS_DECLINED', 'MMA_DIRECT_ASSETS_EXPIRED',
] as const
