// Step 2.3 / A-22 — which active markets carry more than one content language. READ ONLY.
// Default target: production (root .env). `--local`: the local catalogue, as a dry run.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('/Users/awais/nexus-commerce/apps/api/package.json')
const { Client } = require('pg')
const local = process.argv.includes('--local')
const env = require('dotenv').parse(readFileSync(local ? '/Users/awais/nexus-commerce/apps/api/.env' : '/Users/awais/nexus-commerce/.env'))
const url = new URL(env.DATABASE_URL)
console.log('target host:', url.hostname, local ? '(local dry run)' : '(production, read only)')
if (local ? url.hostname !== '127.0.0.1' : !/neon\.tech$/.test(url.hostname)) { console.error('REFUSE: unexpected host'); process.exit(1) }
const c = new Client({ connectionString: env.DATABASE_URL, statement_timeout: 30000 })
await c.connect()
try {
  await c.query('BEGIN READ ONLY')
  const rows = (await c.query(`SELECT m."workspaceId" AS ws, m.channel, m.code, m.language, m.languages,
      (SELECT count(*)::int FROM "ChannelListing" l WHERE l.channel = m.channel AND l.marketplace = m.code) AS listings
    FROM "Marketplace" m WHERE m."isActive" ORDER BY m.channel, m.code`)).rows
  const multi = rows.filter(r => (r.languages ?? []).length > 1)
  console.log('ACTIVE MARKETS ' + rows.length + ' · MORE THAN ONE LANGUAGE ' + multi.length)
  for (const r of multi) console.log('MULTI ' + JSON.stringify(r))
  await c.query('ROLLBACK')
} finally { await c.end() }
