/**
 * P2.3 — what an eBay notification topic means, in one place.
 *
 * The receiver used to branch on four topic strings written inline:
 * `marketplace.order.created`, `marketplace.order.cancelled`,
 * `marketplace.inventory_item.updated` and `ItemRevised`. The first three are not eBay
 * topic IDs in any form — eBay's Notification API uses SCREAMING_SNAKE ids — and the
 * fourth is a Trading API event name from the other, older delivery system.
 *
 * They survived because nothing ever contradicted them. There was no destination and no
 * subscription, so **no genuine eBay notification had ever arrived**: every EBAY row in
 * the ledger is one of this repository's own probes, including one called
 * `probe.deploy.wait`. A name only looks wrong when something real disagrees with it.
 *
 * Three things follow, and all three are in this file.
 *
 * 1. The real topic ids are declared once, and `setupEbayNotifications` checks them
 *    against eBay's own catalogue so a wrong one is reported rather than assumed.
 * 2. The invented names stay readable as LEGACY ALIASES — not because eBay sends them,
 *    but because rows carrying them are in the ledger and a replay must still route.
 * 3. A topic we do not recognise, whose payload nevertheless carries an order id, is
 *    still acted on, and logged by name. That is how the real id gets LEARNED from the
 *    first genuine notification instead of guessed at a second time.
 */
import { logger } from '../../../utils/logger.js'

export type EbayTopicAction =
  | 'order_created'
  | 'order_cancelled'
  | 'listing_changed'
  | 'account_deletion'
  | 'authorization_revoked'

/** How the action was decided — worth recording, because two of these are weak. */
export type EbayTopicVia = 'topic' | 'legacy_alias' | 'payload_shape' | 'none'

/** eBay's real topic ids. Verified against `getTopics` by the setup. */
const TOPIC_ROUTES: Record<string, EbayTopicAction> = {
  MARKETPLACE_ACCOUNT_DELETION: 'account_deletion',
  AUTHORIZATION_REVOCATION: 'authorization_revoked',
  ORDER_CONFIRMATION: 'order_created',
  ITEM_PRICE_REVISION: 'listing_changed',
  ITEM_AVAILABILITY: 'listing_changed',
}

/**
 * Names this repository invented, kept only so stored rows still route on replay.
 *
 * Deliberately NOT merged into the table above: these must never be offered to eBay as
 * subscription topics, and keeping them apart is what stops that happening by accident.
 */
const LEGACY_ALIASES: Record<string, EbayTopicAction> = {
  ITEM_SOLD: 'order_created',
  'marketplace.order.created': 'order_created',
  'marketplace.order.cancelled': 'order_cancelled',
  'marketplace.inventory_item.updated': 'listing_changed',
  ItemRevised: 'listing_changed',
}

export interface EbayTopicDecision {
  action: EbayTopicAction | null
  via: EbayTopicVia
}

/** Every real eBay topic id this router knows. Used by the setup and by a test. */
export function knownEbayTopicIds(): string[] {
  return Object.keys(TOPIC_ROUTES)
}

/** The invented names, exposed so a guard can assert they are never subscribed. */
export function legacyEbayTopicAliases(): string[] {
  return Object.keys(LEGACY_ALIASES)
}

/**
 * What to do with a notification.
 *
 * The payload fallback is narrow on purpose: an order id, and nothing else, means
 * "there is an order here worth pulling". eBay's order service is idempotent on
 * (channel, channelOrderId), so acting on a topic we cannot name costs a sync that
 * would have happened at the next cron tick anyway — and it is far cheaper than
 * dropping a genuine sale because its topic id was not the one we guessed.
 */
export function ebayTopicAction(topic: string | null | undefined, payload: unknown): EbayTopicDecision {
  const name = (topic ?? '').trim()
  if (name && TOPIC_ROUTES[name]) return { action: TOPIC_ROUTES[name], via: 'topic' }
  if (name && LEGACY_ALIASES[name]) return { action: LEGACY_ALIASES[name], via: 'legacy_alias' }

  const data = (payload as any)?.notification?.data ?? (payload as any)?.notification ?? {}
  const orderId = data?.orderId ?? data?.orderID
  if (typeof orderId === 'string' && orderId !== '') {
    // The loud line. If this ever fires in production it names the real topic id, which
    // is the one thing this file cannot supply for itself.
    logger.error('[eBay notification] UNMAPPED topic carrying an order id — add it to TOPIC_ROUTES', {
      topic: name || '(none)', orderId,
    })
    return { action: 'order_created', via: 'payload_shape' }
  }
  return { action: null, via: 'none' }
}
