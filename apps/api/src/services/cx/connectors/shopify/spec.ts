/** Shopify custom-distribution connector: authorization-code grant + Admin GraphQL heartbeat. */
import { CredentialsDecryptError } from '../../../../lib/crypto.js'
import { ChannelAppConfigurationError } from '../../app-configuration-error.js'
import { RefreshFailed } from '../../token.service.js'
import {
  classifyAuthError,
  registerChannel,
  type ChannelSpec,
  type ConnectionHandle,
  type ConnectionIdentity,
  type HeartbeatResult,
  type RateLimitReading,
} from '../../catalog.js'
import { shopifyShopDomain } from './auth.js'

export const SHOPIFY_REQUIRED_SCOPES = [
  'read_products', 'write_products', 'read_inventory', 'write_inventory', 'read_locations', 'write_locations',
  'read_orders', 'write_orders', 'read_draft_orders', 'write_draft_orders',
  'read_fulfillments', 'write_fulfillments', 'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders',
  'read_assigned_fulfillment_orders', 'write_assigned_fulfillment_orders', 'read_third_party_fulfillment_orders', 'write_third_party_fulfillment_orders',
  'read_returns', 'write_returns', 'read_customers', 'write_customers', 'read_discounts', 'write_discounts',
  'read_markets', 'write_markets', 'read_publications', 'write_publications', 'read_translations', 'write_translations', 'read_locales', 'write_locales',
  'read_metaobject_definitions', 'write_metaobject_definitions', 'read_metaobjects', 'write_metaobjects', 'read_files', 'write_files',
  'read_shipping', 'write_shipping', 'read_shopify_payments_payouts', 'read_shopify_payments_disputes', 'read_price_rules', 'write_price_rules',
  'read_gift_cards', 'write_gift_cards', 'read_content', 'write_content', 'read_reports', 'read_marketing_events', 'write_marketing_events',
  'read_order_edits', 'write_order_edits', 'read_inventory_shipments', 'write_inventory_shipments', 'read_inventory_transfers', 'write_inventory_transfers',
  'read_legal_policies', 'read_privacy_settings', 'write_privacy_settings',
  'write_app_proxy', 'read_cart_transforms', 'write_cart_transforms',
  'read_checkout_branding_settings', 'write_checkout_branding_settings',
  'read_checkout_and_accounts_configurations', 'write_checkout_and_accounts_configurations',
  'read_online_store_pages', 'read_customer_events', 'write_pixels', 'read_customer_merge', 'write_customer_merge',
  'read_delivery_customizations', 'write_delivery_customizations',
  'read_inventory_shipments_received_items', 'write_inventory_shipments_received_items',
  'read_online_store_navigation', 'write_online_store_navigation',
  'read_payment_customizations', 'write_payment_customizations', 'read_payment_mandate', 'write_payment_mandate',
  'read_payment_terms', 'write_payment_terms', 'read_script_tags', 'write_script_tags',
  'read_store_credit_accounts', 'read_store_credit_account_transactions', 'write_store_credit_account_transactions',
  'read_themes', 'write_themes', 'read_validations', 'write_validations',
]

interface ShopifyConnectionData {
  shop?: {
    id?: string
    name?: string
    myshopifyDomain?: string
    primaryDomain?: { host?: string } | null
  } | null
  currentAppInstallation?: { accessScopes?: Array<{ handle?: string }> } | null
}

async function connectionData(handle: ConnectionHandle): Promise<{
  response: Response
  body: string
  data: ShopifyConnectionData | null
}> {
  const domain = shopifyShopDomain(handle.region)
  if (!domain) throw new Error('The Shopify connection has no valid myshopify.com domain.')
  const token = await handle.token()
  const response = await fetch(`https://${domain}/admin/api/2026-07/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({
      query: `query NexusConnectionHeartbeat {
        shop { id name myshopifyDomain primaryDomain { host } }
        currentAppInstallation { accessScopes { handle } }
      }`,
    }),
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  })
  const body = await response.text()
  let parsed: { data?: ShopifyConnectionData; errors?: Array<{ message?: string }> } | null = null
  try { parsed = JSON.parse(body) as typeof parsed } catch { /* handled by the caller */ }
  // HTTP 200 is not GraphQL success: partial data can accompany authorization errors.
  return { response, body, data: parsed?.errors?.length ? null : parsed?.data ?? null }
}

function scopesOf(data: ShopifyConnectionData | null): string[] | null {
  const scopes = data?.currentAppInstallation?.accessScopes
  if (!Array.isArray(scopes) || !scopes.every(scope => scope && typeof scope.handle === 'string' && scope.handle.trim())) return null
  return scopes.map(scope => scope.handle!.trim())
}

function identityOf(data: ShopifyConnectionData | null, expectedDomain: string | null): ConnectionIdentity | null {
  const shop = data?.shop
  if (typeof shop?.id !== 'string' || !/^gid:\/\/shopify\/Shop\/\d+$/.test(shop.id) || typeof shop.myshopifyDomain !== 'string' || scopesOf(data) === null) return null
  const domain = shopifyShopDomain(shop.myshopifyDomain)
  if (!domain || domain !== shopifyShopDomain(expectedDomain)) return null
  const reportedHost = typeof shop.primaryDomain?.host === 'string' ? shop.primaryDomain.host.trim() : ''
  const primaryHost = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(reportedHost) ? reportedHost : domain
  return {
    userId: shop.id,
    username: domain,
    storeName: typeof shop.name === 'string' && shop.name.trim() ? shop.name.trim() : domain,
    storeUrl: `https://${primaryHost}`,
    extra: { myshopifyDomain: domain, primaryDomain: primaryHost },
  }
}

async function identity(handle: ConnectionHandle): Promise<ConnectionIdentity | null> {
  const result = await connectionData(handle)
  return result.response.ok ? identityOf(result.data, handle.region) : null
}

async function heartbeat(handle: ConnectionHandle): Promise<HeartbeatResult> {
  const started = Date.now()
  try {
    const result = await connectionData(handle)
    const latencyMs = Date.now() - started
    const identity = identityOf(result.data, handle.region)
    if (result.response.ok && identity) {
      return { ok: true, latencyMs, identity, scopes: scopesOf(result.data)! }
    }
    const errorClass = result.response.ok
      ? (/THROTTLED/i.test(result.body) ? 'rate_limited' : /access denied|permission/i.test(result.body) ? 'forbidden' : 'unknown')
      : classifyAuthError(result.response.status, result.body)
    return {
      ok: false,
      latencyMs,
      status: result.response.status,
      errorClass,
      message: `Shopify account check ${result.response.status}: ${result.body.slice(0, 200)}`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof RefreshFailed) return { ok: false, latencyMs: Date.now() - started, errorClass: err.errorClass, message }
    if (err instanceof ChannelAppConfigurationError || err instanceof CredentialsDecryptError || /NEXUS_CREDENTIAL_ENC_KEY|No ChannelApp row/i.test(message)) {
      return { ok: false, latencyMs: Date.now() - started, errorClass: 'configuration', message: 'The server cannot read this account’s credentials. Check the deployment encryption key and Shopify app configuration.' }
    }
    const errorClass = /needs_reauth|no credentials/i.test(message)
      ? 'auth_expired'
      : /valid myshopify\.com domain/i.test(message)
        ? 'configuration'
        : 'network'
    return { ok: false, latencyMs: Date.now() - started, errorClass, message }
  }
}

export const shopifySpec: ChannelSpec = {
  key: 'SHOPIFY',
  channelType: 'SHOPIFY',
  displayName: 'Shopify',
  available: true,
  auth: {
    mode: 'oauth2_code',
    // `region` carries the shop domain for Shopify; validated by the anchored regex at connect time.
    authorizeUrl: ({ region }) => `https://${region}/admin/oauth/authorize`,
    tokenUrl: ({ region }) => `https://${region}/admin/oauth/access_token`,
    tokenRequestAuth: 'body',
    scopeSeparator: ',',
    codeParamInCallback: 'code',
    callbackMetadata: ['shop', 'timestamp'],
    tokenResponseMetadata: ['scope', 'associated_user_scope'],
    pkce: false,
    identityRequired: true,
    requiredScopes: SHOPIFY_REQUIRED_SCOPES,
    reviewGatedScopes: [
      { scope: 'read_marketplace_fulfillment_orders', reason: 'Shopify marketplace channel app access' },
      { scope: 'read_merchant_approval_signals', reason: 'Must be enabled for this channel app by Shopify' },
      { scope: 'read_all_orders', reason: 'Shopify approval (orders older than 60 days)' },
      { scope: 'read_customer_payment_methods', reason: 'Shopify subscription API approval' },
      { scope: 'read_own_subscription_contracts', reason: 'Shopify subscription API approval' },
      { scope: 'write_own_subscription_contracts', reason: 'Shopify subscription API approval' },
      { scope: 'read_users', reason: 'Eligible Shopify Plus store and app access' },
    ],
    accessTokenLifetimeSec: null, // custom-distribution offline token: valid until uninstall/revocation
    refreshTokenLifetimeSec: null, // custom apps: non-expiring offline token
    rotatesRefreshToken: false,
  },
  identity,
  heartbeat,
  discoverScopes: async (handle) => {
    const identity = handle.identity
    if (!identity?.userId) return []
    return [{
      kind: 'shop',
      externalId: identity.userId,
      label: identity.storeName ?? identity.username ?? handle.region ?? 'Shopify store',
      region: handle.region ?? undefined,
      metadata: { storeUrl: identity.storeUrl ?? null },
    }]
  },
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
