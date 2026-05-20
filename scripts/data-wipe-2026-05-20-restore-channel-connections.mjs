#!/usr/bin/env node
// Restore the 7 EBAY ChannelConnection rows deleted in Phase 2.
// User direction: ChannelConnection + Marketplace are sensitive config —
// don't touch without explicit per-row approval.
//
// Restoration approach: original id + channelType + marketplace + managedBy +
// displayName + createdAt are preserved from snapshot CSV. Token columns +
// metadata were NULL on all 7 rows (per audit), so re-inserting with NULL
// defaults is faithful to the pre-wipe state. isActive forced to false to
// respect the partial unique index on (channelType, marketplace) WHERE
// isActive=true (the verified eBay row holds that slot).
//
// Idempotent: ON CONFLICT (id) DO NOTHING.
//
// Usage:
//   node scripts/data-wipe-2026-05-20-restore-channel-connections.mjs

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

// Read snapshot
const csvPath = '/tmp/data-wipe-2026-05-20/channel-connection-snapshot.csv'
const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n')
const header = lines.shift().split(',')
const rows = lines.map(line => {
  // simple CSV split — snapshot uses no commas inside fields except in quoted timestamps
  const parts = []
  let cur = '', inQuote = false
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; continue }
    if (ch === ',' && !inQuote) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  parts.push(cur)
  const obj = {}
  header.forEach((k, i) => obj[k] = parts[i])
  return obj
})

// Filter to the rows that were deleted (EBAY with no tokens)
const toRestore = rows.filter(r =>
  r.channelType === 'EBAY' && r.has_access_token === 'false' && r.has_refresh_token === 'false'
)

console.log(`Snapshot has ${rows.length} rows; ${toRestore.length} to restore.`)

await c.query('BEGIN')

let restored = 0
let skipped = 0
for (const row of toRestore) {
  const r = await c.query(`
    INSERT INTO "ChannelConnection"
      (id, "channelType", marketplace, "managedBy", "displayName",
       "accessToken", "refreshToken", "tokenExpiresAt",
       "ebayAccessToken", "ebayRefreshToken", "ebayTokenExpiresAt",
       "isActive", "createdAt", "updatedAt")
    VALUES ($1, 'EBAY', NULL, 'oauth', $2,
            NULL, NULL, NULL,
            NULL, NULL, NULL,
            false, $3, NOW())
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `, [row.id, row.displayName || null, row.createdAt.replace(/^"|"$/g, '')])

  if (r.rowCount > 0) {
    restored++
    console.log(`  restored ${row.id} (displayName="${row.displayName || ''}", createdAt=${row.createdAt})`)
  } else {
    skipped++
    console.log(`  skipped ${row.id} (already present)`)
  }
}

// Verify final count
const v = await c.query(`
  SELECT "channelType", count(*) AS rows,
         count(*) FILTER (WHERE "isActive" = true) AS active
  FROM "ChannelConnection"
  GROUP BY "channelType"
  ORDER BY "channelType"
`)
console.log(`\nFinal ChannelConnection state:`)
console.table(v.rows)

await c.query('COMMIT')
console.log(`\nRestored ${restored} rows, skipped ${skipped} duplicates. Committed.`)

await c.end()
