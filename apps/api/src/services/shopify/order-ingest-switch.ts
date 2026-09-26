/**
 * Shopify order ingest — OFF unless `NEXUS_ENABLE_SHOPIFY_ORDER_INGEST=1` (exactly `1`).
 *
 * Registering Shopify's webhook topics is what starts Shopify order ingest: from that moment every order
 * Shopify sends, including an old order that is merely edited, is taken from stock. There is no start time
 * (T0) yet, and the registration also subscribes product topics that overwrite Nexus product names and can
 * deactivate products. So nothing registers Shopify webhooks until the Shopify order plan turns this on.
 */
export const SHOPIFY_ORDER_INGEST_FLAG = 'NEXUS_ENABLE_SHOPIFY_ORDER_INGEST'

export const shopifyOrderIngestEnabled = (): boolean => process.env[SHOPIFY_ORDER_INGEST_FLAG] === '1'

export const SHOPIFY_WEBHOOKS_OFF_CODE = 'shopify_order_ingest_off'

export const SHOPIFY_WEBHOOKS_OFF_MESSAGE =
  'Shopify webhook registration is off: it would start importing Shopify orders and taking them from stock, ' +
  `with no start date. It stays off until Shopify order import is switched on (${SHOPIFY_ORDER_INGEST_FLAG}=1).`
