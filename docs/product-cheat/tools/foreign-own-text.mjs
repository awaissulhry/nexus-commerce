// A-32 (R-30) — count listings whose OWN (pinned) title / description / bullets are the product's primary-language text,
// on a market whose languages do not include that language. The same rule as `apps/api/src/services/pim/foreign-own-text.ts`.
// READ ONLY: one `BEGIN READ ONLY` transaction, rolled back. Nothing is written.
// Default target: production (root .env). `--local`: the local catalogue (apps/api/.env), as a dry run.
// `--primary <code>` if NEXUS_PRIMARY_LANGUAGE is not 'it' where this runs.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('/Users/awais/nexus-commerce/apps/api/package.json')
const { Client } = require('pg')
const dotenv = require('dotenv')

const local = process.argv.includes('--local')
const i = process.argv.indexOf('--primary')
const PRIMARY = (i >= 0 ? process.argv[i + 1] : 'it').toLowerCase()
const env = dotenv.parse(readFileSync(local ? '/Users/awais/nexus-commerce/apps/api/.env' : '/Users/awais/nexus-commerce/.env'))
const url = new URL(env.DATABASE_URL)
console.log('target host:', url.hostname, 'db:', url.pathname, local ? '(local dry run)' : '(production, read only)', '· primary language:', PRIMARY)
if (local ? url.hostname !== '127.0.0.1' : !/neon\.tech$/.test(url.hostname)) { console.error('REFUSE: unexpected host'); process.exit(1) }

// One row per listing on a market that does not speak PRIMARY, with which of its pinned own texts equal the product's
// (or its parent's) own text — the product's own columns are in the primary language.
const MATCHES = `
  WITH scoped AS (
    SELECT l."workspaceId" AS ws, l.channel, l.marketplace, p.sku, l."externalListingId" IS NOT NULL AS live,
      (l."followMasterTitle" = false AND coalesce(l.title, '') <> '' AND (l.title = p.name OR l.title = pp.name)) AS title,
      (l."followMasterDescription" = false AND coalesce(l.description, '') <> '' AND (l.description = p.description OR l.description = pp.description)) AS description,
      (l."followMasterBulletPoints" = false AND cardinality(l."bulletPointsOverride") > 0
        AND (l."bulletPointsOverride" = p."bulletPoints" OR l."bulletPointsOverride" = pp."bulletPoints")) AS bullets
    FROM "ChannelListing" l
    JOIN "Product" p ON p.id = l."productId" AND p."deletedAt" IS NULL
    LEFT JOIN "Product" pp ON pp.id = p."parentId"
    JOIN "Marketplace" m ON m."workspaceId" IS NOT DISTINCT FROM l."workspaceId" AND m.channel = l.channel AND m.code = l.marketplace
    WHERE NOT ($1 = ANY (CASE WHEN cardinality(m.languages) > 0 THEN m.languages ELSE ARRAY[m.language] END)))
  SELECT * FROM scoped`

const c = new Client({ connectionString: env.DATABASE_URL, statement_timeout: 30000 })
await c.connect()
const out = {}
try {
  await c.query('BEGIN READ ONLY')
  out.role = (await c.query(`SELECT current_user AS user, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0]
  out.readOnly = (await c.query(`SHOW transaction_read_only`)).rows[0].transaction_read_only
  // Positive controls: row security can make "could not see" look like "nothing there".
  out.listingsVisible = (await c.query(`SELECT count(*)::int AS n FROM "ChannelListing"`)).rows[0].n
  out.onOtherLanguageMarkets = (await c.query(`SELECT count(*)::int AS n FROM (${MATCHES}) s`, [PRIMARY])).rows[0].n
  out.byMarket = (await c.query(`
    SELECT ws, channel, marketplace, count(*)::int AS listings,
      count(*) FILTER (WHERE title OR description OR bullets)::int AS named, count(*) FILTER (WHERE (title OR description OR bullets) AND live)::int AS named_live,
      count(*) FILTER (WHERE title)::int AS title, count(*) FILTER (WHERE description)::int AS description, count(*) FILTER (WHERE bullets)::int AS bullets
    FROM (${MATCHES}) s GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [PRIMARY])).rows
  out.listings = (await c.query(`
    SELECT ws, channel, marketplace, sku, live, title, description, bullets FROM (${MATCHES}) s
    WHERE title OR description OR bullets ORDER BY ws, channel, marketplace, sku LIMIT 200`, [PRIMARY])).rows
  await c.query('ROLLBACK')
} finally {
  await c.end()
}
console.log('SUMMARY ' + JSON.stringify({ role: out.role, readOnly: out.readOnly, listingsVisible: out.listingsVisible, onOtherLanguageMarkets: out.onOtherLanguageMarkets }))
for (const r of out.byMarket) console.log('MARKET ' + JSON.stringify(r))
for (const r of out.listings) console.log('LISTING ' + JSON.stringify(r))
