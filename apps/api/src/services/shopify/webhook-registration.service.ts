import { publicApiOrigin } from '../public-api-origin.js'
/**
 * P2.4 — register Nexus's Shopify webhooks with each connected shop, and reconcile.
 *
 * Nothing registered them. `ensureShopifySchemaSubscriptions` registers three metafield
 * topics and nothing else, so the seven product/order receivers — and now the five
 * lifecycle and privacy ones — existed as routes that Shopify had never been told
 * about. Combined with the two defects P2.1 and P2.4 found in the receiver itself
 * (no business profile, then a signing secret that production does not have), the
 * Shopify inbound path had three independent reasons to deliver nothing.
 *
 * Per shop, not per app: each connected account gets its own subscriptions pointing at
 * its own callback, so a webhook always identifies which shop sent it and a
 * disconnected shop's subscriptions can be reasoned about on their own.
 *
 * Nothing is ever deleted. An existing subscription on our callback is left alone, and
 * a topic already registered elsewhere is reported rather than repointed — repointing
 * another application's subscription is not ours to do.
 */
import { shopifyAdmin } from './admin-client.js'
import { collectShopifyPages } from './linked-products-gateway.js'
import { logger } from '../../utils/logger.js'
import { SHOPIFY_WEBHOOKS_OFF_MESSAGE, shopifyOrderIngestEnabled } from './order-ingest-switch.js'

/**
 * Shopify's topic enum, the path we receive it on, and the `eventType` written to the
 * ledger — in one row each, because these are three names for one thing and keeping
 * them apart is how `refunds/create` and `refund/create` drifted in P2.1.
 */
export interface ShopifyTopicRegistration {
  /** `WebhookSubscriptionTopic` enum value. */
  topic: string
  /** The receiver path, relative to the API root. */
  path: string
  /** What the receiver writes to `WebhookEvent.eventType`. */
  eventType: string
  /**
   * Some topics are configured in the Partner Dashboard rather than by the Admin API.
   * Rather than guess which, the registration is ATTEMPTED and Shopify's own answer is
   * recorded per topic — the same discipline P2.2 and P2.3 arrived at.
   */
  note?: string
}

export const SHOPIFY_TOPIC_REGISTRATIONS: ShopifyTopicRegistration[] = [
  { topic: 'PRODUCTS_UPDATE', path: '/webhooks/shopify/products/update', eventType: 'product/update' },
  { topic: 'PRODUCTS_DELETE', path: '/webhooks/shopify/products/delete', eventType: 'product/delete' },
  { topic: 'INVENTORY_LEVELS_UPDATE', path: '/webhooks/shopify/inventory/update', eventType: 'inventory/update' },
  { topic: 'ORDERS_CREATE', path: '/webhooks/shopify/orders/create', eventType: 'order/create' },
  { topic: 'ORDERS_UPDATED', path: '/webhooks/shopify/orders/update', eventType: 'order/update' },
  { topic: 'FULFILLMENTS_CREATE', path: '/webhooks/shopify/fulfillments/create', eventType: 'fulfillment/create' },
  { topic: 'REFUNDS_CREATE', path: '/webhooks/shopify/refunds/create', eventType: 'refunds/create' },
  { topic: 'APP_UNINSTALLED', path: '/webhooks/shopify/app/uninstalled', eventType: 'app/uninstalled' },
  { topic: 'APP_SCOPES_UPDATE', path: '/webhooks/shopify/app/scopes_update', eventType: 'app/scopes_update' },
  {
    topic: 'CUSTOMERS_DATA_REQUEST', path: '/webhooks/shopify/customers/data_request', eventType: 'customers/data_request',
    note: 'Shopify may require the privacy topics to be set in the Partner Dashboard; the attempt records its own answer.',
  },
  {
    topic: 'CUSTOMERS_REDACT', path: '/webhooks/shopify/customers/redact', eventType: 'customers/redact',
    note: 'Shopify may require the privacy topics to be set in the Partner Dashboard; the attempt records its own answer.',
  },
  {
    topic: 'SHOP_REDACT', path: '/webhooks/shopify/shop/redact', eventType: 'shop/redact',
    note: 'Shopify may require the privacy topics to be set in the Partner Dashboard; the attempt records its own answer.',
  },
]

export interface TopicOutcome {
  topic: string
  status: 'already_ours' | 'created' | 'elsewhere' | 'refused'
  callbackUrl?: string
  detail?: string
}

export interface ShopifyRegistrationResult {
  accountId: string
  live: boolean
  reason?: string
  base?: string
  perTopic: TopicOutcome[]
}

/** The public HTTPS origin Shopify must be able to reach. */
function publicOrigin(): { origin: string } | { error: string } {
  // 🔴 2026-09-21 — one accessor for all three readers. This copy threw on a malformed value
  // where the shared one reports it, and the sign-in path read a different set of variables
  // entirely. `publicApiOrigin()` carries the whole rule and the measurement behind it.
  const resolved = publicApiOrigin()
  if ('error' in resolved) return { error: `${resolved.error} Shopify webhooks cannot be registered without it.` }
  return resolved
}

/**
 * Make one shop's subscriptions match this table. Idempotent, and never destructive.
 */
export async function ensureShopifyWebhookSubscriptions(accountId: string): Promise<ShopifyRegistrationResult> {
  // Registration starts Shopify order ingest; every caller (route, job, script) is refused until it is on.
  if (!shopifyOrderIngestEnabled()) return { accountId, live: false, reason: SHOPIFY_WEBHOOKS_OFF_MESSAGE, perTopic: [] }
  const origin = publicOrigin()
  if ('error' in origin) return { accountId, live: false, reason: origin.error, perTopic: [] }

  const { graphql } = await shopifyAdmin(accountId)
  const existing = await collectShopifyPages<{ topic: string; endpoint: { callbackUrl?: string } }>(async (after) =>
    (await graphql(
      `query NexusWebhookSubscriptions($after:String) { webhookSubscriptions(first:100,after:$after) { nodes { topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } } pageInfo { hasNextPage endCursor } } }`,
      { after },
    )).webhookSubscriptions,
  )

  const perTopic: TopicOutcome[] = []
  for (const row of SHOPIFY_TOPIC_REGISTRATIONS) {
    const callbackUrl = `${origin.origin}${row.path}`
    const mine = existing.find((s) => s.topic === row.topic && s.endpoint?.callbackUrl === callbackUrl)
    if (mine) {
      perTopic.push({ topic: row.topic, status: 'already_ours', callbackUrl })
      continue
    }
    const other = existing.find((s) => s.topic === row.topic)
    if (other) {
      // Reported, not repointed. Another application's subscription is not ours to move,
      // and silently taking it over is how one integration breaks another.
      perTopic.push({
        topic: row.topic, status: 'elsewhere', callbackUrl: other.endpoint?.callbackUrl,
        detail: 'This topic is already subscribed to a different callback. Left untouched.',
      })
      continue
    }
    try {
      const { webhookSubscriptionCreate: result } = await graphql(
        `mutation NexusWebhookSubscription($topic:WebhookSubscriptionTopic!,$subscription:WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic:$topic,webhookSubscription:$subscription) { webhookSubscription { id } userErrors { message } } }`,
        { topic: row.topic, subscription: { callbackUrl, format: 'JSON' } },
      )
      if (result?.webhookSubscription?.id && !result.userErrors?.length) {
        perTopic.push({ topic: row.topic, status: 'created', callbackUrl })
      } else {
        // Shopify's own answer, kept verbatim. For the privacy topics this is where we
        // learn whether the Admin API accepts them at all.
        perTopic.push({
          topic: row.topic, status: 'refused',
          detail: [result?.userErrors?.map((e: { message: string }) => e.message).join('; '), row.note].filter(Boolean).join(' — '),
        })
      }
    } catch (error) {
      perTopic.push({
        topic: row.topic, status: 'refused',
        detail: [error instanceof Error ? error.message : String(error), row.note].filter(Boolean).join(' — '),
      })
    }
  }

  const refused = perTopic.filter((t) => t.status === 'refused')
  if (refused.length) {
    logger.warn('[shopify-webhooks] some topics were not registered', {
      accountId, refused: refused.map((t) => `${t.topic}: ${t.detail}`).join(' | '),
    })
  }
  return { accountId, live: true, base: origin.origin, perTopic }
}
