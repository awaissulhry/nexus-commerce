/**
 * P2.1 — what a replay actually runs.
 *
 * The ledger can put an event back in the queue, but "retry" is meaningless unless
 * something can be run a second time with nothing but the stored payload. That is the
 * only thing this file decides: given a channel and an event type, which function
 * takes the payload.
 *
 * Every entry is a LAZY import on purpose. The handlers live in the receiver modules
 * beside the routes that first call them, and a static import here would be a cycle:
 * the routes import the ledger, the ledger's worker imports this, this imports the
 * routes. A dynamic import inside the lookup also means the worker does not depend on
 * route registration having happened first, which a registry filled by a side effect
 * at boot would have.
 *
 * An event type that is NOT in this table is not a bug to be hidden. It is an event
 * nothing can replay, and the worker dead-letters it with that as the reason rather
 * than retrying it five times to reach the same place eight hours later.
 */

/**
 * What a replay knows besides the payload.
 *
 * The stored payload is the CHANNEL's body and names no Nexus account, so a handler
 * that needs one must be given it rather than deduce it — deducing it means "the only
 * connected account", which the MAP.3 ratchet forbids for good reason.
 */
export interface InboundHandlerContext {
  connectionId: string | null
  eventType: string
  channel: string
  /** Aborted when the processing lease is lost; another worker now owns the event. */
  signal?: AbortSignal
}

export type InboundHandler = (payload: unknown, context?: InboundHandlerContext) => Promise<unknown>

type Loader = () => Promise<InboundHandler>
export type InboundReceiptHandler = (id: string) => Promise<import('./ebay-processing.js').EbayProcessingOutcome>
const RECEIPT_REGISTRY: Record<string, Record<string, () => Promise<InboundReceiptHandler>>> = {
  EBAY: {
    'AUTHORIZATION_REVOCATION': async () => (await import('./ebay-processing.js')).processEbayInbound,
    // The same stored-receipt protocol. Held, never claimed and never dead-lettered, unless
    // NEXUS_ENABLE_EBAY_ORDER_NOTICES=1: processEbayInbound and queueEbayReplay both check it first.
    'ORDER_CONFIRMATION': async () => (await import('./ebay-processing.js')).processEbayInbound,
  },
}

const SHOPIFY_WEBHOOKS = '../../../routes/shopify-webhooks.js'
const ETSY_WEBHOOKS = '../../../routes/etsy-webhooks.routes.js'
const META_WEBHOOKS = '../../marketing/meta-ads/webhook-receiver.js'

/**
 * Keys are the event types the RECEIVERS write, not the channel's own topic strings.
 * They are what is already in the table, so a replay of a row written last month finds
 * its handler as readily as one written today.
 */
const REGISTRY: Record<string, Record<string, Loader>> = {
  SHOPIFY: {
    'product/update': async () => (await import(SHOPIFY_WEBHOOKS)).handleProductUpdate,
    'product/delete': async () => (await import(SHOPIFY_WEBHOOKS)).handleProductDelete,
    'inventory/update': async () => (await import(SHOPIFY_WEBHOOKS)).handleInventoryUpdate,
    // The order topics replay through Shopify order import's start date, exactly as the receiver runs them.
    'order/create': async () => (await import(SHOPIFY_WEBHOOKS)).ingestShopifyOrderCreate,
    'order/update': async () => (await import(SHOPIFY_WEBHOOKS)).ingestShopifyOrderUpdate,
    'fulfillment/create': async () => (await import(SHOPIFY_WEBHOOKS)).ingestShopifyFulfillmentCreate,
    'refunds/create': async () => (await import(SHOPIFY_WEBHOOKS)).ingestShopifyRefundCreate,
    // Shopify marketing consent (2026-10-26) — a buyer's e-mail consent changed (nothing is sent anywhere).
    'customers_email_marketing_consent/update': async () => (await import(SHOPIFY_WEBHOOKS)).handleEmailMarketingConsentUpdate,
    // P2.4 — the app lifecycle and privacy topics. `app/uninstalled` is the one that
    // most needs to be replayable: its failure leaves Nexus writing to a shop that has
    // removed the app.
    'app/uninstalled': async () => (await import(SHOPIFY_WEBHOOKS)).handleAppUninstalled,
    'app/scopes_update': async () => (await import(SHOPIFY_WEBHOOKS)).handleScopesUpdate,
    'customers/data_request': async () => (await import(SHOPIFY_WEBHOOKS)).privacyTopicHandler('customers/data_request'),
    // customers/redact deletes the customer's marketing-consent row; other erasure stays the Owner's unit.
    'customers/redact': async () => (await import(SHOPIFY_WEBHOOKS)).handleCustomersRedact,
    'shop/redact': async () => (await import(SHOPIFY_WEBHOOKS)).privacyTopicHandler('shop/redact'),
  },
  // P2.5 — every Etsy order event goes through one handler, which reads the receipt
  // back from Etsy rather than trusting the notification body. A replay resolves the
  // account from the workspace it runs in, because the stored payload is Etsy's own
  // body and carries no Nexus account.
  ETSY: {
    'order.paid': async () => (await import(ETSY_WEBHOOKS)).handleEtsyOrderEvent,
    'order.shipped': async () => (await import(ETSY_WEBHOOKS)).handleEtsyOrderEvent,
    'order.canceled': async () => (await import(ETSY_WEBHOOKS)).handleEtsyOrderEvent,
    'order.delivered': async () => (await import(ETSY_WEBHOOKS)).handleEtsyOrderEvent,
    // Historical stored names remain replayable, never offered as subscriptions.
    'order.cancelled': async () => (await import(ETSY_WEBHOOKS)).handleEtsyOrderEvent,
    'order.refunded': async () => (await import(ETSY_WEBHOOKS)).handleEtsyOrderEvent,
  },
  // Meta ads step 30 — the topics the Meta receiver acts on (a re-read of the ad account and/or an alerts-inbox
  // notice); META_HANDLED_TOPICS in marketing/meta-ads/webhook-topics.ts is the same list (a test holds them equal).
  // Topics Meta only records are written as done and need no handler. Each change is re-checked for ownership first.
  META: {
    'ad_account.effective_status': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'ad_account.field_changed': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'ad_account.subscriptions': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'ad_account.creative_fatigue': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'ad_account.ad_recommendations': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'ad_account.in_process_ad_objects': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'ad_account.with_issues_ad_objects': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'ad_account.ads_async_creation_request': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'ad_account.product_set_issue': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'application.ad_account': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'application.ads_rules_engine': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'application.async_requests': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'application.dev_alerts': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'page.leadgen': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'page.messaging_in_thread_lead_form_submit': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'page.messaging_policy_enforcement': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'page.messaging_integrity': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'page.product_review': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'instagram.messaging_policy_enforcement': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'catalog.items_batch': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'catalog.product_feed': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'permissions.connected': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'permissions.public_search': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
    'permissions.social_ads': async () => (await import(META_WEBHOOKS)).handleMetaWebhookEvent,
  },
}

/** True when this event has a handler — without loading it. */
export function canReplayInbound(channel: string, eventType: string): boolean {
  return Boolean(REGISTRY[channel]?.[eventType] || RECEIPT_REGISTRY[channel]?.[eventType])
}

/** Legacy payload handlers. Claimed receipts use inboundReceiptHandlerFor instead. */
export async function inboundHandlerFor(channel: string, eventType: string): Promise<InboundHandler | null> {
  const loader = REGISTRY[channel]?.[eventType]
  if (!loader) return null
  const fn = await loader()
  if (typeof fn !== 'function') {
    throw new Error(`The replay handler registered for ${channel}/${eventType} is not a function.`)
  }
  return fn
}

/** Stored-receipt handlers own claim acquisition and atomic completion themselves. */
export async function inboundReceiptHandlerFor(channel: string, eventType: string): Promise<InboundReceiptHandler | null> {
  const loader = RECEIPT_REGISTRY[channel]?.[eventType]
  return loader ? loader() : null
}

/** Every channel and event type that can be replayed. Used by the tests and the API. */
export function replayableEventTypes(): Array<{ channel: string; eventType: string }> {
  return Object.entries({ ...REGISTRY, ...RECEIPT_REGISTRY }).flatMap(([channel, types]) =>
    Object.keys(types).map((eventType) => ({ channel, eventType })),
  )
}

/**
 * A replay that could not even start, as distinct from one that ran and failed.
 *
 * The two want opposite answers: a handler that threw deserves another attempt with a
 * backoff, while an event nothing knows how to run deserves dead letters immediately.
 * Without a distinct type they both arrive at the same catch block as a string.
 */
export class ReplayUnsupported extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplayUnsupported'
  }
}
