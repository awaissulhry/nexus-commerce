/** Read-only pre/post receipts. No application bootstrap; no business-data write statements. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { databaseTarget } from './target.mjs'

const [name, phase] = process.argv.slice(2)
assert.ok(['before', 'after'].includes(phase), 'Use before or after.')
const target = await databaseTarget(name)
const db = new Client({ connectionString: target.connectionString, connectionTimeoutMillis: 15000, statement_timeout: 30000, application_name: 'nexus-lx1-readonly' })
const migration = '20260912_lx1_translation_store'
const sha = value => createHash('sha256').update(value).digest('hex')
try {
  await db.connect()
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const receipt = (await db.query("SELECT current_setting('transaction_read_only') AS read_only, transaction_timestamp() AS at")).rows[0]
  assert.equal(receipt.read_only, 'on')
  const rowHashes = {}
  for (const table of ['Product', 'ProductTranslation', 'ChannelListing', 'Marketplace']) {
    // Ignore only newly added columns; every pre-existing column participates.
    const exclude = table === 'ProductTranslation' ? ['attributes', 'sourceHash', 'authoredAt', 'version'] : []
    rowHashes[table] = (await db.query(`SELECT id, md5((to_jsonb(t) - $1::text[])::text) AS hash FROM "${table}" t ORDER BY id`, [exclude])).rows
  }
  assert.ok(rowHashes.Product.length > 0 && rowHashes.ChannelListing.length > 0, 'Positive control absent.')
  const coverage = (await db.query(`SELECT m.channel, m.code AS market, m.language, count(l.id)::int AS listings,
    count(l.id) FILTER (WHERE nullif(btrim(l.title), '') IS NOT NULL)::int AS title_nonempty,
    count(l.id) FILTER (WHERE nullif(btrim(l.description), '') IS NOT NULL)::int AS description_nonempty
    FROM "Marketplace" m LEFT JOIN "ChannelListing" l ON l.channel=m.channel
      AND (CASE WHEN l.marketplace IN ('DEFAULT','') THEN l.region ELSE l.marketplace END)=m.code
      AND (to_jsonb(l)->>'workspaceId') IS NOT DISTINCT FROM (to_jsonb(m)->>'workspaceId')
    GROUP BY m.id, m.channel, m.code, m.language ORDER BY m.channel,m.code`)).rows
  assert.equal(coverage.reduce((sum, row) => sum + row.listings, 0), rowHashes.ChannelListing.length, 'Every listing must be attributed exactly once.')
  const columns = (await db.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ProductTranslation' AND column_name=ANY($1) ORDER BY column_name`, [['attributes', 'sourceHash', 'authoredAt', 'version']])).rows
  const triggers = (await db.query(`SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition FROM pg_trigger
    WHERE tgrelid='"Product"'::regclass AND tgname='Product_localizedContent_readonly'`)).rows
  const history = (await db.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name')).rows
  const productContent = (await db.query(`SELECT id, sku, "parentId", "localizedContent", name, description, "bulletPoints", keywords,
    "categoryAttributes", "variantAttributes" FROM "Product" WHERE sku='GALE-JACKET' OR "parentId" IN (SELECT id FROM "Product" WHERE sku='GALE-JACKET') ORDER BY id`)).rows
  const translations = (await db.query('SELECT * FROM "ProductTranslation" ORDER BY id')).rows
  const jsonContentHashes = (await db.query('SELECT id, md5("localizedContent"::text) AS hash FROM "Product" ORDER BY id')).rows
  const report = { ...target.identity, phase, receipt, columns, triggers, coverage, rowHashes, jsonContentHashes, translationCount: translations.length,
    sourceFiles: { scriptSha256: sha(await readFile(new URL('./inspect.mjs', import.meta.url))) }, history, family: { rows: productContent.length, ids: productContent.map(row => row.id) } }
  if (phase === 'after') {
    const before = JSON.parse(await readFile(new URL(`./${name}-before.json`, import.meta.url)))
    report.existingRowChanges = Object.fromEntries(Object.keys(rowHashes).map(table => {
      const prior = new Map(before.rowHashes[table].map(row => [row.id, row.hash]))
      const now = new Map(rowHashes[table].map(row => [row.id, row.hash]))
      return [table, { added: [...now.keys()].filter(id => !prior.has(id)), removed: [...prior.keys()].filter(id => !now.has(id)), changed: [...now.keys()].filter(id => prior.has(id) && prior.get(id) !== now.get(id)) }]
    }))
    assert.equal(columns.length, 4, 'LX.1 columns incomplete.')
    assert.ok(triggers.length === 1 && triggers[0].tgenabled === 'O', 'Read-only guard missing/disabled.')
    assert.ok(history.some(row => row.migration_name === migration && row.finished_at && !row.rolled_back_at), 'Migration not marked applied.')
    assert.equal(JSON.stringify(jsonContentHashes), JSON.stringify(before.jsonContentHashes), 'Legacy JSON changed.')
    assert.equal(JSON.stringify(rowHashes.ProductTranslation), JSON.stringify(before.rowHashes.ProductTranslation), 'Existing translation data changed.')
  }
  await db.query('ROLLBACK')
  report.rolledBack = true
  await writeFile(new URL(`./${name}-${phase}.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n')
  // Test-only local fixture snapshot stays in /tmp, never executed as a writer or checked into the audit.
  // Capture hashes only here; response comparisons use the read-only route probe.
  console.log(JSON.stringify({ target: name, phase, at: receipt.at, columns: columns.map(row => row.column_name), triggerCount: triggers.length, translationCount: translations.length, familyRows: productContent.length, existingRowChanges: report.existingRowChanges, coverage }, null, 2))
} finally { await db.query('ROLLBACK').catch(() => {}); await db.end() }
