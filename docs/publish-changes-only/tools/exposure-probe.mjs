// PCO plan §4.2 — overwrite exposure per channel and market: listings a studio Publish could reach (offer not closed), and how many
// of them the nightly content read has COMPARED (and found different) vs NOT read yet. Production, READ ONLY (rolled back).
// PREDICTION (written before the run): Amazon IT: most open listings NOT yet content-read (90 of 273 read); Amazon DE open = 36,
// of which GALE-JACKET 21 read; eBay: 0 listings content-compared (the ebay-content source compared none on its first run).
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('/Users/awais/nexus-commerce/apps/api/package.json')
const { Client } = require('pg'); const dotenv = require('dotenv')
const env = dotenv.parse(readFileSync('/Users/awais/nexus-commerce/.env'))
if (!/neon\.tech$/.test(new URL(env.DATABASE_URL).hostname)) { console.error('REFUSE: unexpected host'); process.exit(1) }
const c = new Client({ connectionString: env.DATABASE_URL, statement_timeout: 60000 }); await c.connect()
const out = {}
try {
  await c.query('BEGIN READ ONLY')
  out.readOnly = (await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only
  out.exposure = (await c.query(`
    SELECT l.channel AS ch, l.marketplace AS mkt, count(*)::int AS listings,
      count(*) FILTER (WHERE l."offerClosedAt" IS NULL)::int AS open,
      count(*) FILTER (WHERE l."offerClosedAt" IS NULL AND (d."checkedBySource"->'amazon-content'->>'outcome' = 'compared'
        OR d."checkedBySource"->'ebay-content'->>'outcome' = 'compared'))::int AS open_content_compared,
      count(*) FILTER (WHERE l."offerClosedAt" IS NULL AND d."driftCount" > 0 AND (d."checkedBySource" ? 'amazon-content' OR d."checkedBySource" ? 'ebay-content'))::int AS open_content_differs
    FROM "ChannelListing" l LEFT JOIN "ChannelDrift" d ON d."channelListingId" = l.id
    WHERE l.channel IN ('AMAZON', 'EBAY') GROUP BY 1, 2 ORDER BY 1, 2`)).rows
} finally { await c.query('ROLLBACK').catch(() => {}); await c.end() }
writeFileSync('/Users/awais/nexus-commerce/docs/publish-changes-only/records/2026-09-25-exposure-probe.json', JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 0).replace(/},{/g, '},\n{'))
