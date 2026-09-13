/** Query only: split the accepted 866 R2 observations; do not run either resolver. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { Client } from 'pg'
const rows = JSON.parse(gunzipSync(await readFile(new URL('./accepted-production-diffs.json.gz', import.meta.url)))).diffs.filter(row => row.classification === 'R2-default-language-listing-pin')
assert.equal(rows.length, 866)
assert.equal(process.env.RAILWAY_ENVIRONMENT_NAME, 'production')
const target = new URL(process.env.DATABASE_URL)
assert.ok(!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
const db = new Client({ connectionString: target.href, application_name: 'nexus-lx3-r2-follow-query', connectionTimeoutMillis: 15000 })
try {
  await db.connect(); await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const transaction = (await db.query("SELECT current_setting('transaction_read_only') AS read_only, transaction_timestamp() AS at")).rows[0]
  assert.equal(transaction.read_only, 'on')
  const listings = (await db.query('SELECT id, "followMasterTitle", "followMasterDescription", "followMasterBulletPoints" FROM "ChannelListing" WHERE id = ANY($1::text[]) ORDER BY id', [[...new Set(rows.map(row => row.listingId))]])).rows
  const byId = new Map(listings.map(row => [row.id, row]))
  const split = { true: 0, false: 0, null: 0 }, byField = {}, observations = []
  const column = { title: 'followMasterTitle', description: 'followMasterDescription', bulletPoints: 'followMasterBulletPoints' }
  for (const row of rows) {
    assert.ok(byId.has(row.listingId)); assert.ok(column[row.field])
    const follows = byId.get(row.listingId)[column[row.field]]
    const key = follows == null ? 'null' : String(follows)
    split[key]++; (byField[row.field] ??= { true: 0, false: 0, null: 0 })[key]++
    observations.push({ reader: row.reader, listingId: row.listingId, field: row.field, language: row.language, follows, classification: follows === true ? 'drift' : 'operator pin' })
  }
  await db.query('ROLLBACK')
  const receipt = { target: { environment: 'production', host: target.hostname, database: target.pathname.slice(1) }, transaction, rolledBack: true, observations: rows.length, uniqueListings: listings.length, split, byField, listingFlags: listings, classifiedObservations: observations }
  await writeFile(new URL('./r2-flags.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ ...receipt, listingFlags: undefined, classifiedObservations: undefined }, null, 2))
} finally { await db.query('ROLLBACK').catch(() => {}); await db.end() }
