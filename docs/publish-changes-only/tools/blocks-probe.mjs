// PCO plan §1b — how many families/listings each NON-gate block stops today (production, READ ONLY).
// One `BEGIN READ ONLY` transaction, rolled back. Nothing is written. `--local`: the local catalogue as a dry run.
//
// PREDICTIONS (written 2026-09-25 before the first run):
//  B1 eBay listings on the Inventory model (platformAttributes.__offerIds / offerId → studio-publication-ebay.ts:97 refuses): > 0,
//     because 1,710 July queue rows failed on "get offers 404" (Inventory API offers).
//  B2 eBay listings with fulfillmentMethod FBA (eby:110 refuses): small, < 20.
//  B3 Amazon listings with a closed offer (studio-publication-amazon.ts:38 refuses the WHOLE family): < 10 (SCT.6 is new).
//  B4 Shopify: 1 connection, 0 Nexus ChannelListing rows (the listings read found only AMAZON and EBAY).
//  B5 roles holding products.publish (OWNER is implicit-all): OWNER + ADMIN at least.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('/Users/awais/nexus-commerce/apps/api/package.json')
const { Client } = require('pg')
const dotenv = require('dotenv')
const local = process.argv.includes('--local')
const env = dotenv.parse(readFileSync(local ? '/Users/awais/nexus-commerce/apps/api/.env' : '/Users/awais/nexus-commerce/.env'))
const url = new URL(env.DATABASE_URL)
console.log('target host:', url.hostname, local ? '(local dry run)' : '(production, read only)')
if (local ? url.hostname !== '127.0.0.1' : !/neon\.tech$/.test(url.hostname)) { console.error('REFUSE: unexpected host'); process.exit(1) }

const c = new Client({ connectionString: env.DATABASE_URL, statement_timeout: 60000 })
await c.connect()
const out = {}
const q = async (key, sql) => { out[key] = (await c.query(sql)).rows }
try {
  await c.query('BEGIN READ ONLY')
  out.readOnly = (await c.query(`SHOW transaction_read_only`)).rows[0].transaction_read_only
  // A family = the parent, or the product itself when it has none.
  await q('ebayModel', `SELECT l."workspaceId" AS ws,
      CASE WHEN l."platformAttributes" ? '__offerIds' OR l."platformAttributes" ? 'offerId' THEN 'INVENTORY (refused)' ELSE 'TRADING' END AS model,
      count(*)::int AS listings, count(DISTINCT coalesce(p."parentId", p.id))::int AS families,
      count(*) FILTER (WHERE l."listingStatus" = 'ACTIVE')::int AS active
    FROM "ChannelListing" l JOIN "Product" p ON p.id = l."productId" WHERE l.channel = 'EBAY' GROUP BY 1, 2 ORDER BY 1, 2`)
  await q('ebayFba', `SELECT count(*)::int AS listings, count(DISTINCT coalesce(p."parentId", p.id))::int AS families
    FROM "ChannelListing" l JOIN "Product" p ON p.id = l."productId" WHERE l.channel = 'EBAY' AND l."fulfillmentMethod" = 'FBA'`)
  await q('amazonClosed', `SELECT l.marketplace AS mkt, count(*)::int AS listings, count(DISTINCT coalesce(p."parentId", p.id))::int AS families_refused
    FROM "ChannelListing" l JOIN "Product" p ON p.id = l."productId" WHERE l.channel = 'AMAZON' AND l."offerClosedAt" IS NOT NULL GROUP BY 1`)
  await q('listingsByChannelMarket', `SELECT channel AS ch, marketplace AS mkt, count(*)::int AS listings,
    count(DISTINCT l."productId")::int AS products FROM "ChannelListing" l GROUP BY 1, 2 ORDER BY 1, 2`)
  await q('connections', `SELECT "workspaceId" AS ws, "channelType" AS ch, "isActive" AS active, "authStatus" AS auth, count(*)::int AS n
    FROM "ChannelConnection" GROUP BY 1, 2, 3, 4 ORDER BY 1, 2`)
  await q('publishRoles', `SELECT coalesce("workspaceId", '(template)') AS ws, key, name, ('products.publish' = ANY(permissions)) AS has_publish,
    (SELECT count(*)::int FROM "WorkspaceMemberRole" m WHERE m."roleId" = r.id) AS members
    FROM "Role" r WHERE key = 'OWNER' OR 'products.publish' = ANY(permissions) ORDER BY 1, 2`)
} finally {
  await c.query('ROLLBACK').catch(() => {})
  await c.end()
}
const file = `/Users/awais/nexus-commerce/docs/publish-changes-only/records/2026-09-25-blocks-probe${local ? '-local' : ''}.json`
writeFileSync(file, JSON.stringify(out, null, 2))
console.log('wrote', file)
console.log(JSON.stringify(out, null, 1))
