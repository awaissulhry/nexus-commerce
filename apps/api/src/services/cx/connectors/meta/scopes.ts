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
  pages_manage_ads: 'pages_manage_ads',
  instagram_shopping_tag_products: 'instagram_shopping_tag_products',
  // Step 38 (review B-F3) — messages, inbox labels, templates and the messaging setup.
  pages_messaging: 'pages_messaging',
  pages_manage_metadata: 'pages_manage_metadata',
  instagram_manage_messages: 'instagram_manage_messages',
  instagram_manage_comments: 'instagram_manage_comments',
  page_utility_messaging: 'page_utility_messaging',
  whatsapp_business_management: 'whatsapp_business_management',
  instagram_creator_marketplace_messaging: 'instagram_creator_marketplace_messaging',
  pages_read_user_content: 'pages_read_user_content',
} as const

export const META_REQUIRED_SCOPES: string[] = [META_SCOPE.ads_read]

export const META_OPTIONAL_SCOPES: string[] = [
  META_SCOPE.ads_management,
  META_SCOPE.business_management,
  META_SCOPE.pages_show_list,
  META_SCOPE.pages_read_engagement,
  META_SCOPE.instagram_basic,
  META_SCOPE.catalog_management,
  // Step 22 (review B2) — Instant Experience parts: guides/instant-experiences.md "Before you start" names it.
  META_SCOPE.pages_manage_ads,
  // Step 35 (review B-F8) — ig-media/product_tags and ig-user/product_appeal "Requirements" name it beside catalog_management.
  META_SCOPE.instagram_shopping_tag_products,
  // Step 38 (review B-F3) — named by Meta's messaging pages (send-messages.md, personas.md, custom-labels.md, built-in-nlp.md,
  // utility-messages.md, Instagram send-message.md and private-replies.md, template-management.md, creator-marketplace-messaging.md).
  // Reported only, as every optional scope here: Meta has no consent screen in Nexus, so nothing a person is asked changes.
  META_SCOPE.pages_messaging,
  META_SCOPE.pages_manage_metadata,
  META_SCOPE.instagram_manage_messages,
  META_SCOPE.instagram_manage_comments,
  META_SCOPE.page_utility_messaging,
  META_SCOPE.whatsapp_business_management,
  META_SCOPE.instagram_creator_marketplace_messaging,
  META_SCOPE.pages_read_user_content,
]

/** What each permission lets Nexus do, for the sentence a missing one gets. */
const NEEDED_FOR: Readonly<Record<string, string>> = {
  ads_read: 'read the ad account, its campaigns and its numbers',
  ads_management: 'change ads (set-meta-status pauses, switches on and archives campaigns, ad sets and ads; set-meta-campaign, set-meta-ad-set and set-meta-budget-schedule change their settings, budgets and bids; create-meta-campaign, create-meta-ad-set and copy-meta-ads make new ones, paused; remove-meta-ads-items deletes on a person\'s explicit ask; apply-meta-recommendations, create-meta-experiment, set-meta-experiment and end-meta-experiment apply the recommendations of Meta and make, change and end its tests)',
  business_management: "read the business portfolio's assets, make a catalog or catalog segment in it (create-meta-catalog) and share a catalog with a partner (set-meta-catalog-access)",
  pages_show_list: 'list the Facebook Pages',
  pages_read_engagement: "read the Pages' Instagram accounts",
  instagram_basic: 'read the Instagram accounts (with pages_show_list)',
  catalog_management: 'read the catalogs, and change them with create-meta-catalog, set-meta-catalog, set-meta-catalog-access, set-meta-product-set and remove-meta-catalog-items, their items and feeds with set-meta-catalog-items and set-meta-catalog-feed, and product tags on Instagram posts with set-meta-instagram-product-tags (with instagram_shopping_tag_products)',
  instagram_shopping_tag_products: 'tag products on the chosen Instagram account\'s posts and appeal a product Meta rejected for tagging (set-meta-instagram-product-tags), tag products on a new post (create-meta-instagram-post productTags), and read its product tags (meta-instagram-product-tags); Meta also asks catalog_management, instagram_basic and ads_read',
  pages_manage_ads: 'delete parts of an Instant Experience of the chosen Page with remove-meta-ads-items (Meta also asks pages_read_engagement, pages_show_list and the Page\'s ADVERTISE task)',
  pages_messaging: 'send messages as the chosen Page (create-meta-message), make personas and welcome flows and change the messaging setup (set-meta-messaging-setup), with the Page\'s MESSAGING task; with Standard access Meta delivers only to people with a role on the business\'s Meta app — real customers need Advanced Access (App Review)',
  pages_manage_metadata: 'make, put on and take off inbox labels (set-meta-conversation-labels) and switch Built-In NLP (set-meta-messaging-setup), with pages_messaging',
  instagram_manage_messages: 'send Instagram Direct messages through the chosen Page (create-meta-message platform instagram) and set the Instagram profile (set-meta-messaging-setup), with instagram_basic; real customers need Advanced Access (App Review)',
  instagram_manage_comments: 'send a private reply to a comment on the chosen Instagram account\'s media (create-meta-message private-reply), with pages_messaging and Advanced Access',
  page_utility_messaging: 'make Messenger utility templates and send them outside the 24-hour window (set-meta-message-templates, create-meta-message mode utility). Nexus could not check that Meta lets a system user be given it',
  whatsapp_business_management: 'make and delete WhatsApp templates and template groups of the business\'s own WhatsApp account (set-meta-message-templates; whatsapp_business_messaging alone is refused)',
  instagram_creator_marketplace_messaging: 'write to a creator in Instagram\'s Partnership folder (create-meta-message creator-message; App Review). Nexus could not check that Meta lets a system user be given it',
  pages_read_user_content: 'look up a creator\'s messaging id for a creator message (create-meta-message creator-message), as Meta\'s creator marketplace messaging guide asks',
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
