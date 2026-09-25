// PCO plan §1–§2 — what is queued behind each publish gate, what studio Publish did, and which baselines exist.
// READ ONLY: one `BEGIN READ ONLY` transaction, rolled back. Nothing is written.
// Default target: production (root .env). `--local`: the local catalogue (apps/api/.env), as a dry run.
// Every timestamp is formatted as UTC TEXT inside SQL: `pg` reads a Prisma `timestamp without time zone` as LOCAL time.
//
// PREDICTIONS (written 2026-09-25 before the first run):
//  P1 OutboundSyncQueue ≈ 2,200 rows, ≈ 2,199 FAILED (the Owner's Sync Logs read of 09-24); most FAILED rows isDead=true.
//  P2 Rows the drain would pick NOW (PENDING past hold, or FAILED not dead with retryCount<3 or AUTH_REQUIRED): < 50.
//  P3 Production modes are Amazon=live, eBay=live, Shopify=gated (boot log 2026-09-24 20:23 UTC) → Amazon/eBay rows already
//     fire; any Shopify row the drain touches ends SKIPPED (terminal), so no Shopify row waits.
//  P4 studio-publication BulkOperation rows: few (< 30); zero ACCEPTED/VERIFIED on Shopify.
//  P5 ChannelListingSnapshot rows with reason 'pre-publish': 0 (studio Publish never captures one).
//  P7 (added before the second run) the 45 Amazon differences sit in ≤ 5 fields: title word order, fabric, size, colour.
//  P6 ChannelDrift: ≈ 147 Amazon rows, 45 with driftCount > 0 (A-39); some eBay rows (A-40).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('/Users/awais/nexus-commerce/apps/api/package.json')
const { Client } = require('pg')
const dotenv = require('dotenv')

const local = process.argv.includes('--local')
const env = dotenv.parse(readFileSync(local ? '/Users/awais/nexus-commerce/apps/api/.env' : '/Users/awais/nexus-commerce/.env'))
const url = new URL(env.DATABASE_URL)
console.log('target host:', url.hostname, 'db:', url.pathname, local ? '(local dry run)' : '(production, read only)')
if (local ? url.hostname !== '127.0.0.1' : !/neon\.tech$/.test(url.hostname)) { console.error('REFUSE: unexpected host'); process.exit(1) }

const utc = col => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
const c = new Client({ connectionString: env.DATABASE_URL, statement_timeout: 60000 })
await c.connect()
const out = {}
const q = async (key, sql, params = []) => { out[key] = (await c.query(sql, params)).rows }
try {
  await c.query('BEGIN READ ONLY')
  out.role = (await c.query(`SELECT current_user AS user, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0]
  out.readOnly = (await c.query(`SHOW transaction_read_only`)).rows[0].transaction_read_only
  out.dbNow = (await c.query(`SELECT ${utc(`(now() AT TIME ZONE 'UTC')`)} AS now`)).rows[0].now
  // Positive controls: row security can make "could not see" look like "nothing there".
  await q('controls', `SELECT (SELECT count(*)::int FROM "Product") AS products, (SELECT count(*)::int FROM "OutboundSyncQueue") AS queue,
    (SELECT count(*)::int FROM "ChannelListing") AS listings, (SELECT count(*)::int FROM "BulkOperation") AS bulk_ops`)
  await q('workspaces', `SELECT id, name, status, "isLegacy" AS legacy FROM "Workspace" ORDER BY "createdAt"`)

  // §2 — the queue: every row by channel, status, dead, code, type.
  await q('queueGroups', `
    SELECT "targetChannel" AS ch, "syncStatus" AS status, "isDead" AS dead, coalesce("errorCode", '-') AS code, "syncType" AS type,
      count(*)::int AS n, ${utc('min("createdAt")')} AS oldest, ${utc('max("createdAt")')} AS newest, max("retryCount")::int AS max_retry
    FROM "OutboundSyncQueue" GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, n DESC`)

  // The drain's own predicates (outbound-sync.service.ts ~:891 PENDING lane, ~:973 retry lane; AD types excluded there).
  await q('wouldPickNow', `
    SELECT "targetChannel" AS ch, "syncType" AS type, "syncStatus" AS status, coalesce("errorCode", '-') AS code, count(*)::int AS n,
      ${utc('min("createdAt")')} AS oldest, ${utc('max("createdAt")')} AS newest,
      ${utc('min("nextRetryAt")')} AS next_retry_min, ${utc('max("nextRetryAt")')} AS next_retry_max
    FROM "OutboundSyncQueue"
    WHERE ("syncStatus" = 'PENDING' AND ("holdUntil" IS NULL OR "holdUntil" <= (now() AT TIME ZONE 'UTC')))
       OR ("syncStatus" = 'FAILED' AND "isDead" = false AND ("retryCount" < 3 OR "errorCode" = 'AUTH_REQUIRED'))
    GROUP BY 1, 2, 3, 4 ORDER BY 1, n DESC`)
  await q('pendingOnHold', `SELECT "targetChannel" AS ch, "syncType" AS type, count(*)::int AS n, ${utc('max("holdUntil")')} AS hold_max
    FROM "OutboundSyncQueue" WHERE "syncStatus" = 'PENDING' AND "holdUntil" > (now() AT TIME ZONE 'UTC') GROUP BY 1, 2`)
  await q('inProgress', `SELECT "targetChannel" AS ch, "syncType" AS type, count(*)::int AS n, ${utc('min("updatedAt")')} AS oldest_update
    FROM "OutboundSyncQueue" WHERE "syncStatus" = 'IN_PROGRESS' GROUP BY 1, 2`)

  // Queue activity per UTC day, last 10 days: is anything automatic writing to channels now?
  await q('queueByDay', `
    SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day, "targetChannel" AS ch, "syncType" AS type, "syncStatus" AS status, count(*)::int AS n
    FROM "OutboundSyncQueue" WHERE "createdAt" > (now() AT TIME ZONE 'UTC') - interval '10 days' GROUP BY 1, 2, 3, 4 ORDER BY 1 DESC, 2, n DESC`)

  // Why the FAILED rows failed (top messages per channel).
  await q('failedMessages', `
    SELECT "targetChannel" AS ch, left(regexp_replace(coalesce("errorMessage", '-'), '[0-9]{6,}', '#', 'g'), 160) AS msg, count(*)::int AS n,
      ${utc('max("updatedAt")')} AS last
    FROM "OutboundSyncQueue" WHERE "syncStatus" = 'FAILED' GROUP BY 1, 2 ORDER BY n DESC LIMIT 25`)

  // Live writes actually attempted (the shared chokepoint's audit), last 14 days.
  await q('publishAttempts', `
    SELECT channel AS ch, mode, outcome, count(*)::int AS n, ${utc('min("attemptedAt")')} AS first, ${utc('max("attemptedAt")')} AS last
    FROM "ChannelPublishAttempt" WHERE "attemptedAt" > (now() AT TIME ZONE 'UTC') - interval '14 days' GROUP BY 1, 2, 3 ORDER BY 1, n DESC`)

  // §1 — studio Publish history (BulkOperation kind 'studio-publication').
  await q('studioPublications', `
    SELECT changes->'scope'->>'channel' AS ch, status, count(*)::int AS n, ${utc('min("createdAt")')} AS first, ${utc('max("createdAt")')} AS last
    FROM "BulkOperation" WHERE changes->>'kind' = 'studio-publication' GROUP BY 1, 2 ORDER BY 1, 2`)
  await q('studioPublicationsLatest', `
    SELECT ${utc('"createdAt"')} AS at, changes->'scope'->>'channel' AS ch, changes->'scope'->>'marketplace' AS mkt, status, "productCount" AS products,
      left(coalesce(changes->'result'->>'message', ''), 200) AS result
    FROM "BulkOperation" WHERE changes->>'kind' = 'studio-publication' ORDER BY "createdAt" DESC LIMIT 15`)

  // §5 — baselines that exist today.
  await q('snapshots', `SELECT channel AS ch, reason, count(*)::int AS n, count(DISTINCT "channelListingId")::int AS listings,
    count("publishEventId")::int AS with_publish_event, ${utc('max("createdAt")')} AS newest FROM "ChannelListingSnapshot" GROUP BY 1, 2 ORDER BY 1, 2`)
  await q('drift', `SELECT channel AS ch, marketplace AS mkt, count(*)::int AS rows, count(*) FILTER (WHERE "driftCount" > 0)::int AS drifting,
    ${utc('min("lastCheckedAt")')} AS oldest_check, ${utc('max("lastCheckedAt")')} AS newest_check FROM "ChannelDrift" GROUP BY 1, 2 ORDER BY 1, 2`)
  await q('driftSample', `SELECT channel AS ch, marketplace AS mkt, "driftCount" AS n, left("driftedFields"::text, 600) AS fields,
    left("checkedBySource"::text, 200) AS src FROM "ChannelDrift" WHERE "driftCount" > 0 ORDER BY "lastCheckedAt" DESC LIMIT 3`)
  // §6.3 — the 45 Amazon differences by field (P7: concentrated in ≤ 5 fields: title word order, fabric, size, colour).
  await q('driftFields', `SELECT d.channel AS ch, d.marketplace AS mkt, regexp_replace(e->>'field', '\\[.*\\]', '[*]') AS field, count(*)::int AS listings
    FROM "ChannelDrift" d, jsonb_array_elements(d."driftedFields") e WHERE d."driftCount" > 0 GROUP BY 1, 2, 3 ORDER BY 1, 2, listings DESC`)
  await q('driftFamilies', `SELECT d.channel AS ch, d.marketplace AS mkt, coalesce(pp.sku, p.sku) AS family, count(*)::int AS drifting_listings
    FROM "ChannelDrift" d JOIN "ChannelListing" l ON l.id = d."channelListingId" JOIN "Product" p ON p.id = l."productId"
    LEFT JOIN "Product" pp ON pp.id = p."parentId" WHERE d."driftCount" > 0 GROUP BY 1, 2, 3 ORDER BY drifting_listings DESC`)
  await q('driftCompared', `SELECT channel AS ch, marketplace AS mkt, sum(("checkedBySource"->'amazon-content'->>'differing')::int)::int AS differing,
    round(avg(("checkedBySource"->'amazon-content'->>'notCompared')::int), 1) AS avg_not_compared, count(*)::int AS rows
    FROM "ChannelDrift" WHERE "checkedBySource" ? 'amazon-content' GROUP BY 1, 2`)
  await q('listings', `SELECT channel AS ch, count(*)::int AS rows, count("externalListingId")::int AS with_external_id,
    count(*) FILTER (WHERE "isPublished")::int AS is_published, count(*) FILTER (WHERE "listingStatus" = 'ACTIVE')::int AS active,
    count("flatFileSnapshot")::int AS with_flat_file_snapshot, count("lastSyncedAt")::int AS with_last_synced,
    ${utc('max("lastSyncedAt")')} AS last_synced_max FROM "ChannelListing" GROUP BY 1 ORDER BY 1`)
} finally {
  await c.query('ROLLBACK').catch(() => {})
  await c.end()
}
const dir = '/Users/awais/nexus-commerce/docs/publish-changes-only/records'
mkdirSync(dir, { recursive: true })
const file = `${dir}/2026-09-25-gate-queue-probe${local ? '-local' : ''}.json`
writeFileSync(file, JSON.stringify(out, null, 2))
console.log('wrote', file)
console.log(JSON.stringify(out, null, 1))
