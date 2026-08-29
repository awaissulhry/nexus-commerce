/** CX.1 — Shopify catalogue entry (research R3). Connect lands in CX.5 (custom-distribution app, authorization-code grant). */
import { registerChannel, type ChannelSpec, type RateLimitReading } from '../../catalog.js'

export const SHOPIFY_REQUIRED_SCOPES = [
  'read_products', 'write_products', 'read_inventory', 'write_inventory', 'read_locations', 'write_locations',
  'read_orders', 'write_orders', 'read_all_orders', 'read_draft_orders', 'write_draft_orders',
  'read_fulfillments', 'write_fulfillments', 'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders',
  'read_assigned_fulfillment_orders', 'write_assigned_fulfillment_orders', 'read_third_party_fulfillment_orders', 'write_third_party_fulfillment_orders',
  'read_returns', 'write_returns', 'read_customers', 'write_customers', 'read_discounts', 'write_discounts',
  'read_markets', 'write_markets', 'read_publications', 'write_publications', 'read_translations', 'write_translations', 'read_locales', 'write_locales',
  'read_metaobject_definitions', 'write_metaobject_definitions', 'read_metaobjects', 'write_metaobjects', 'read_files', 'write_files',
  'read_shipping', 'write_shipping', 'read_shopify_payments_payouts', 'read_shopify_payments_disputes', 'read_price_rules', 'write_price_rules',
  'read_gift_cards', 'write_gift_cards', 'read_content', 'write_content', 'read_reports', 'read_marketing_events', 'write_marketing_events',
  'read_order_edits', 'write_order_edits', 'read_inventory_shipments', 'write_inventory_shipments', 'read_inventory_transfers', 'write_inventory_transfers',
  'read_legal_policies', 'read_privacy_settings', 'write_privacy_settings',
]

export const shopifySpec: ChannelSpec = {
  key: 'SHOPIFY',
  channelType: 'SHOPIFY',
  displayName: 'Shopify',
  available: false, // CX.5
  auth: {
    mode: 'oauth2_code',
    // `region` carries the shop domain for Shopify; validated by the anchored regex at connect time.
    authorizeUrl: ({ region }) => `https://${region}/admin/oauth/authorize`,
    tokenUrl: ({ region }) => `https://${region}/admin/oauth/access_token`,
    tokenRequestAuth: 'body',
    scopeSeparator: ',',
    codeParamInCallback: 'code',
    callbackMetadata: ['shop', 'hmac', 'timestamp'],
    tokenResponseMetadata: ['scope', 'associated_user_scope'],
    pkce: false,
    requiredScopes: SHOPIFY_REQUIRED_SCOPES,
    reviewGatedScopes: [
      { scope: 'read_all_orders', reason: 'Partner Dashboard request (orders older than 60 days)' },
      { scope: 'read_customer_payment_methods', reason: 'Subscription APIs approval' },
      { scope: 'read_users', reason: 'Shopify Plus only' },
    ],
    refreshTokenLifetimeSec: null, // custom apps: non-expiring offline token
    rotatesRefreshToken: false,
  },
  identity: async () => null,
  heartbeat: async () => ({ ok: false, latencyMs: 0, errorClass: 'unknown', message: 'Shopify connector lands in CX.5' }),
  rateLimit: {
    parse: (headers: Headers, status: number): RateLimitReading | null => {
      const call = headers.get('x-shopify-shop-api-call-limit')
      if (call) {
        const [used, max] = call.split('/').map(Number)
        return { model: 'leaky_bucket', remaining: max - used, limit: max, retryAfterSec: status === 429 ? Number(headers.get('retry-after') ?? 1) : undefined }
      }
      return status === 429 ? { model: 'points', retryAfterSec: 1 } : null
    },
    model: 'points',
  },
  webhooks: { scheme: 'shopify-hmac', subscriptionApi: true, lifecycleTopics: ['app/uninstalled', 'app/scopes_update', 'shop/redact', 'customers/data_request', 'customers/redact'] },
  apiVersion: '2026-07',
  sandbox: { available: true },
}

registerChannel(shopifySpec)
