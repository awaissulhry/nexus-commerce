import { publicApiOrigin } from '../public-api-origin.js'
/**
 * P2.4 — register Nexus's Shopify webhooks with each connected shop, and reconcile.
 *
 * 2026-10-15 — only what Shopify order import needs: the order topics and app/uninstalled, and only for an account
 * whose order import was started (it has its start date, order-ingest-switch.ts). No product topics (Shopify follows
 * Nexus: products/update would rename Nexus products, products/delete deactivate them), no inventory_levels/update (it
 * would set Nexus counts from Shopify's), no privacy topics (configured with the app, not per shop). A subscription of
 * any other topic already on the shop is listed in the result (`leftInPlace`) and never deleted: a person decides.
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
import { SHOPIFY_ORDER_IMPORT_NOT_STARTED_MESSAGE, SHOPIFY_WEBHOOKS_OFF_MESSAGE, shopifyOrderIngestEnabled, shopifyOrderIngestStart } from './order-ingest-switch.js'

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
}

/**
 * The topics Shopify order import registers, and only these. orders/updated also carries a payment, a cancellation and
 * a fulfilment status change, so no orders/paid, orders/cancelled or orders/fulfilled subscription is needed.
 */
export const SHOPIFY_TOPIC_REGISTRATIONS: ShopifyTopicRegistration[] = [
  { topic: 'ORDERS_CREATE', path: '/webhooks/shopify/orders/create', eventType: 'order/create' },
  { topic: 'ORDERS_UPDATED', path: '/webhooks/shopify/orders/update', eventType: 'order/update' },
  { topic: 'FULFILLMENTS_CREATE', path: '/webhooks/shopify/fulfillments/create', eventType: 'fulfillment/create' },
  { topic: 'REFUNDS_CREATE', path: '/webhooks/shopify/refunds/create', eventType: 'refunds/create' },
  { topic: 'APP_UNINSTALLED', path: '/webhooks/shopify/app/uninstalled', eventType: 'app/uninstalled' },
]

export interface TopicOutcome {
  topic: string
  status: 'already_ours' | 'created' | 'elsewhere' | 'refused'
  callbackUrl?: string
  detail?: string
}

/** A subscription of this app on the shop whose topic is not one order import registers. Never deleted here. */
export interface LeftInPlaceSubscription {
  topic: string
  callbackUrl?: string
  detail: string
}

export interface ShopifyRegistrationResult {
  accountId: string
  live: boolean
  reason?: string
  base?: string
  perTopic: TopicOutcome[]
  leftInPlace?: LeftInPlaceSubscription[]
}

const WRITES_NEXUS_TOPIC = /^(PRODUCTS|INVENTORY_LEVELS|INVENTORY_ITEMS)_/

function leftInPlaceDetail(topic: string): string {
  return WRITES_NEXUS_TOPIC.test(topic)
    ? 'A product or inventory topic, which order import does not register. While it exists Shopify keeps sending it to Nexus. Left in place: a person decides whether to delete it in Shopify.'
    : 'Not an order topic. Left in place.'
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
  // Without its start date an account would receive orders it must not import: registered only after the start.
  if (!(await shopifyOrderIngestStart(accountId))) return { accountId, live: false, reason: SHOPIFY_ORDER_IMPORT_NOT_STARTED_MESSAGE, perTopic: [] }
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
        // Shopify's own answer, kept verbatim.
        perTopic.push({
          topic: row.topic, status: 'refused',
          detail: result?.userErrors?.map((e: { message: string }) => e.message).join('; '),
        })
      }
    } catch (error) {
      perTopic.push({ topic: row.topic, status: 'refused', detail: error instanceof Error ? error.message : String(error) })
    }
  }

  const registered = new Set(SHOPIFY_TOPIC_REGISTRATIONS.map((row) => row.topic))
  const leftInPlace = existing
    .filter((s) => !registered.has(s.topic))
    .map((s) => ({ topic: s.topic, callbackUrl: s.endpoint?.callbackUrl, detail: leftInPlaceDetail(s.topic) }))
  if (leftInPlace.some((s) => WRITES_NEXUS_TOPIC.test(s.topic))) {
    logger.warn('[shopify-webhooks] product or inventory subscriptions are on the shop; left in place for a person to decide', {
      accountId, topics: leftInPlace.filter((s) => WRITES_NEXUS_TOPIC.test(s.topic)).map((s) => s.topic).join(' '),
    })
  }

  const refused = perTopic.filter((t) => t.status === 'refused')
  if (refused.length) {
    logger.warn('[shopify-webhooks] some topics were not registered', {
      accountId, refused: refused.map((t) => `${t.topic}: ${t.detail}`).join(' | '),
    })
  }
  return { accountId, live: true, base: origin.origin, perTopic, leftInPlace }
}
