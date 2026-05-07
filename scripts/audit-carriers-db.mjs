#!/usr/bin/env node
// One-shot read-only audit queries for /fulfillment/carriers rebuild.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
dotenv.config({ path: path.join(here, '..', 'packages', 'database', '.env') })

let url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
url = url.replace('-pooler.', '.')

const client = new pg.Client({ connectionString: url })
await client.connect()

async function run(label, sql) {
  try {
    const r = await client.query(sql)
    console.log(`\n=== ${label} ===`)
    console.table(r.rows)
  } catch (e) {
    console.log(`\n=== ${label} (ERROR) ===`)
    console.log(e.message)
  }
}

await run('Carrier table — totals', `
SELECT count(*) AS total,
       count(*) FILTER (WHERE "isActive") AS active,
       count(*) FILTER (WHERE NOT "isActive") AS inactive,
       count(*) FILTER (WHERE "credentialsEncrypted" IS NOT NULL) AS has_creds
FROM "Carrier";
`)

await run('Carrier rows', `
SELECT code, name, "isActive",
       ("credentialsEncrypted" IS NOT NULL) AS has_creds,
       ("defaultServiceMap" IS NOT NULL) AS has_service_map,
       "createdAt"::date AS created,
       "updatedAt"::date AS updated
FROM "Carrier"
ORDER BY code;
`)

await run('Carrier columns', `
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'Carrier'
ORDER BY ordinal_position;
`)

await run('Carrier-related tables present', `
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN (
  'Carrier','CarrierAccount','CarrierService','CarrierServiceMapping',
  'ShippingMethod','CarrierWebhook','CarrierBalance','CarrierMetric',
  'PickupSchedule','PrintFormat','ShippingRule'
)
ORDER BY table_name;
`)

await run('Shipment usage by carrierCode', `
SELECT "carrierCode" AS code,
       count(*) AS shipments,
       count(*) FILTER (WHERE "trackingNumber" IS NOT NULL) AS with_tracking,
       count(*) FILTER (WHERE "labelUrl" IS NOT NULL) AS with_label,
       round(avg("costCents")/100.0,2) AS avg_cost_eur,
       round(sum("costCents")/100.0,2) AS total_spend_eur,
       max("createdAt")::date AS last_shipment
FROM "Shipment"
GROUP BY "carrierCode"
ORDER BY shipments DESC;
`)

await run('ShippingRule count', `
SELECT count(*) AS total,
       count(*) FILTER (WHERE "isActive") AS active,
       count(*) FILTER (WHERE "lastFiredAt" IS NOT NULL) AS ever_fired
FROM "ShippingRule";
`)

await run('Channel/marketplace coverage (for default service mapping)', `
SELECT channel, marketplace, count(*) AS listings
FROM "ChannelListing"
GROUP BY channel, marketplace
ORDER BY channel, marketplace;
`)

await run('Warehouse — sender mapping coverage', `
SELECT count(*) AS total,
       count(*) FILTER (WHERE "sendcloudSenderId" IS NOT NULL) AS with_sender_id,
       count(*) FILTER (WHERE "isActive") AS active
FROM "Warehouse";
`)

await run('TrackingEvent volume by source', `
SELECT source, count(*) AS events,
       max("occurredAt")::date AS most_recent
FROM "TrackingEvent"
GROUP BY source
ORDER BY events DESC;
`)

await run('TrackingMessageLog (channel pushback) status', `
SELECT status, count(*) FROM "TrackingMessageLog"
GROUP BY status ORDER BY 2 DESC;
`)

await client.end()
