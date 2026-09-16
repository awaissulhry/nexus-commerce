/**
 * The eBay consent scopes — a module with NO imports, so the deploy check
 * (`apps/api/scripts/check-ebay-consent-scopes.mts`) reads the exact list the
 * Connect button sends without loading the database, the token service or crypto.
 */

export const EBAY_SCOPE_BASE = 'https://api.ebay.com/oauth/api_scope'
const S = EBAY_SCOPE_BASE

/**
 * Every scope an EU seller connector needs (research B1.3 / R2 §B) that the production app may
 * request. `sell.logistics` and `commerce.catalog.readonly` are NOT here: eBay refused them for
 * this app on 2026-09-16, and one refused scope makes eBay refuse the whole Connect request.
 * Add a scope only after the deploy check passes with it.
 */
export const EBAY_REQUIRED_SCOPES: string[] = [
  S,
  `${S}/sell.inventory`,
  `${S}/sell.inventory.readonly`,
  `${S}/sell.account`,
  `${S}/sell.account.readonly`,
  `${S}/sell.marketing`,
  `${S}/sell.marketing.readonly`,
  `${S}/sell.fulfillment`,
  `${S}/sell.fulfillment.readonly`,
  `${S}/sell.finances`,
  `${S}/sell.payment.dispute`,
  `${S}/sell.analytics.readonly`,
  `${S}/sell.stores`,
  `${S}/sell.stores.readonly`,
  `${S}/commerce.identity.readonly`,
  `${S}/commerce.notification.subscription`,
  `${S}/commerce.notification.subscription.readonly`,
  `${S}/commerce.message`,
  `${S}/commerce.feedback`,
  `${S}/commerce.shipping`,
]
