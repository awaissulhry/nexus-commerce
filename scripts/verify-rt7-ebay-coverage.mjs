#!/usr/bin/env node
/**
 * RT.7 verifier — audits eBay push-notification coverage.
 *
 * Reports:
 *   1. Subscribed event types (what we asked eBay to send us)
 *   2. Received event types over the configurable window (what eBay
 *      actually pushed)
 *   3. Coverage gaps: subscribed-but-never-received vs received-but-
 *      unsubscribed (eBay sometimes sends events even without explicit
 *      subscription; we want them logged either way)
 *
 * Usage: node scripts/verify-rt7-ebay-coverage.mjs [--days N]
 *
 * The subscribed-events list is hardcoded from
 * apps/api/src/routes/ebay-notification.routes.ts. Keep this list
 * in sync if you change the SetNotificationPreferences XML.
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const daysFlag = process.argv.indexOf('--days')
const days = daysFlag > -1 ? Number(process.argv[daysFlag + 1] ?? '7') : 7

// Keep in sync with apps/api/src/routes/ebay-notification.routes.ts
// (the events array in setup-ebay-notifications).
const SUBSCRIBED = new Set([
  'AuctionCheckoutComplete',
  'FixedPriceTransaction',
  'ItemSold',
  'ItemMarkedAsShipped',
  'ItemMarkedAsPaid',
  'ReturnOpened',
  'ReturnClosed',
  'EOR_OrderRefunded',
  // RT.10 — quantity / item revision push.
  'ItemRevised',
])

// What the REST notification webhook sees (different namespace than
// Trading API event names — eBay routes both to the same endpoint).
const REST_TOPICS_KNOWN = new Set([
  'marketplace.order.created',
  'marketplace.order.cancelled',
])

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
const c = new pg.Client({ connectionString: url })
await c.connect()

console.log(`\n=== Window: last ${days} days ===\n`)

console.log('=== 1. Subscribed event types (per setup-ebay-notifications) ===')
console.log([...SUBSCRIBED].sort().join('  '))

console.log('\n=== 2. Received eventTypes (WebhookEvent rows) ===')
const received = await c.query(`
  SELECT
    "eventType",
    count(*) AS total,
    count(*) FILTER (WHERE "isProcessed") AS processed,
    count(*) FILTER (WHERE "error" IS NOT NULL) AS failed,
    max("createdAt") AS latest
  FROM "WebhookEvent"
  WHERE channel = 'EBAY'
    AND "createdAt" > now() - ($1 || ' days')::interval
  GROUP BY "eventType"
  ORDER BY total DESC;
`, [days])
if (received.rows.length === 0) {
  console.log(
    '(no eBay events received in this window — either no eBay activity or push not delivering)',
  )
} else {
  console.table(received.rows)
}

const receivedSet = new Set(received.rows.map((r) => r.eventType))

console.log('\n=== 3. Coverage gaps ===')
const subscribedNeverReceived = [...SUBSCRIBED].filter((e) => !receivedSet.has(e))
const receivedNotSubscribed = [...receivedSet].filter(
  (e) => !SUBSCRIBED.has(e) && !REST_TOPICS_KNOWN.has(e),
)
const restTopicsReceived = [...receivedSet].filter((e) => REST_TOPICS_KNOWN.has(e))

console.log({
  subscribed_never_received: subscribedNeverReceived,
  received_not_subscribed: receivedNotSubscribed,
  rest_topics_received: restTopicsReceived,
})

if (subscribedNeverReceived.length > 0) {
  console.log(
    `\n⚠️  ${subscribedNeverReceived.length} subscribed event(s) never received over ${days}d. Expected for low-volume events on a small marketplace footprint; investigate if blank for >30d on an active account.`,
  )
}
if (receivedNotSubscribed.length > 0) {
  console.log(
    `\nℹ️  ${receivedNotSubscribed.length} event type(s) received without explicit subscription. eBay sometimes broadcasts these — they're logged correctly via the catch-all handler.`,
  )
}

await c.end()
console.log(
  '\nTip: hit GET /api/admin/ebay-notification-status from a logged-in tab for the live subscription list.',
)
