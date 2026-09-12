/** Owner-authorized temporary XAVIA fixture rehearsal. No bulk migration or backfill.
 * Fixed local HTTP/database target and one existing product/translation; restore by value with CAS.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from 'pg'
import { databaseTarget } from '../step1/target.mjs'

const kind = process.argv[2]
assert.ok(['media', 'translation'].includes(kind))
const productId = 'cmokmy0lr0009pm0p9yxk7ho0'
const base = 'http://127.0.0.1:8091/api'
const target = await databaseTarget('local')
const db = new Client({ connectionString: target.connectionString, connectionTimeoutMillis: 15000, statement_timeout: 15000 })
const marker = `LX1 reversible ${kind} probe ${new Date().toISOString()}`
const backupPath = `/private/tmp/nexus-lx1-reversal-${kind}-${Date.now()}.json`
const report = { kind, marker, productId, family: 'XAVIA GALE', ...target.identity, base, backupPath, startedAt: new Date().toISOString() }
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)
const hash = value => createHash('sha256').update(canonical(value)).digest('hex')
const changedKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => canonical(a[key]) !== canonical(b[key]))
const mediaPath = `/products/${productId}/product-media?scope=MASTER&market=GLOBAL&locale=en`
const translationPath = `/products/${productId}/translations/en`
async function request(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) })
  const result = { at: new Date().toISOString(), status: response.status, body: await response.json() }
  return result
}
async function snapshot() {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const product = (await db.query('SELECT to_jsonb(p) AS value, md5(to_jsonb(p)::text) AS hash FROM "Product" p WHERE id=$1', [productId])).rows[0]
    assert.ok(product)
    const parent = (await db.query('SELECT * FROM "Product" WHERE id=$1', [product.value.parentId])).rows[0]
    assert.equal(parent.sku, 'GALE-JACKET', 'Fixed probe product must remain in XAVIA family.')
    assert.match(product.value.name, /XAVIA/i)
    const translations = (await db.query('SELECT to_jsonb(t) AS value, md5(to_jsonb(t)::text) AS hash FROM "ProductTranslation" t WHERE "productId"=$1 ORDER BY language', [productId])).rows
    assert.equal(translations.filter(r => r.value.language === 'en').length, 1, 'Rehearse an existing English row only.')
    const translation = translations.find(r => r.value.language === 'en')
    const files = (await db.query('SELECT * FROM "ProductImage" WHERE "productId"=ANY($1) ORDER BY "sortOrder",id', [[productId, parent.id]])).rows
    const listings = (await db.query('SELECT id, md5(to_jsonb(t)::text) AS hash FROM "ChannelListing" t WHERE "productId"=ANY($1) ORDER BY id', [[productId, parent.id]])).rows
    const audit = (await db.query('SELECT id FROM "AuditLog" WHERE "entityId"=$1 ORDER BY id', [productId])).rows.map(r => r.id)
    const at = (await db.query('SELECT clock_timestamp() AS at')).rows[0].at
    return { at, product, parent, translation, translations, files, listings, audit }
  } finally { await db.query('ROLLBACK') }
}
const digest = state => ({ at: state.at, product: state.product.hash, productVersion: state.product.value.version,
  localizedContent: hash(state.product.value.localizedContent), translation: state.translation.hash,
  translationVersion: state.translation.value.version, files: hash(state.files), listings: hash(state.listings) })
async function restore(before, after) {
  const productKeys = changedKeys(before.product.value, after.product.value)
  const translationKeys = changedKeys(before.translation.value, after.translation.value)
  assert.ok(productKeys.every(k => ['localizedContent', 'version', 'updatedAt'].includes(k)), `Unexpected product changes: ${productKeys}`)
  assert.ok(translationKeys.every(k => ['name', 'updatedAt'].includes(k)), `Unexpected translation changes: ${translationKeys}`)
  if (productKeys.length) {
    assert.equal(after.product.value.version, before.product.value.version + 1, 'Concurrent product writer; restore refused.')
    assert.ok(JSON.stringify(after.product.value.localizedContent).includes(marker), 'Our marker is absent; restore refused.')
  }
  if (translationKeys.length) assert.equal(after.translation.value.name, marker, 'Concurrent translation writer; restore refused.')
  await db.query('BEGIN')
  try {
    if (productKeys.length) {
      const result = await db.query(`UPDATE "Product" p SET "localizedContent"=original."localizedContent", version=original.version, "updatedAt"=original."updatedAt"
        FROM jsonb_populate_record(NULL::"Product", $1::jsonb) original WHERE p.id=$2 AND md5(to_jsonb(p)::text)=$3`, [JSON.stringify(before.product.value), productId, after.product.hash])
      assert.equal(result.rowCount, 1, 'Product changed concurrently; restore refused.')
    }
    if (translationKeys.length) {
      const result = await db.query(`UPDATE "ProductTranslation" t SET name=original.name, "updatedAt"=original."updatedAt"
        FROM jsonb_populate_record(NULL::"ProductTranslation", $1::jsonb) original WHERE t.id=$2 AND t."productId"=$3 AND t.language='en' AND md5(to_jsonb(t)::text)=$4`, [JSON.stringify(before.translation.value), before.translation.value.id, productId, after.translation.hash])
      assert.equal(result.rowCount, 1, 'Translation changed concurrently; restore refused.')
    }
    await db.query('COMMIT')
    report.restore = { committedAt: new Date().toISOString(), productKeys, translationKeys, compareAndSwap: true }
  } catch (error) { await db.query('ROLLBACK'); throw error }
}
let before, observed, attempted = false
try {
  await db.connect()
  before = await snapshot()
  const media = await request(mediaPath)
  assert.equal(media.status, 200)
  // Revision is an opaque API concurrency token. Independently compare the stored
  // product values via GET instead of reproducing Prisma's serialization order.
  const productRead = await request(`/products/${productId}`)
  assert.equal(productRead.status, 200)
  for (const key of ['id', 'sku', 'parentId', 'version', 'localizedContent', 'workspaceId']) {
    assert.equal(canonical(productRead.body[key]), canonical(before.product.value[key]), `HTTP/DB mismatch: ${key}`)
  }
  report.apiDatabaseSnapshotMatched = true
  report.before = digest(before)
  await writeFile(backupPath, JSON.stringify({ before, media: media.body, marker, kind }, null, 2), { mode: 0o600, flag: 'wx' })
  let body
  if (kind === 'media') {
    const collection = structuredClone(media.body.collection)
    assert.ok(collection.items.length > 0)
    report.assetId = collection.items[0].assetId
    collection.items[0].alt = marker
    body = { expectedRevision: media.body.revision, collection }
  } else body = { name: marker }
  attempted = true
  report.putStartedAt = new Date().toISOString()
  try {
    const put = await request(kind === 'media' ? mediaPath : translationPath, 'PUT', body)
    report.put = { at: put.at, status: put.status, bodyHash: hash(put.body) }
  } catch (error) { report.put = { at: new Date().toISOString(), status: 'UNKNOWN', error: error.message } }
  await delay(8100)
  observed = await snapshot()
  report.afterWrite = digest(observed)
  const readback = await request(kind === 'media' ? mediaPath : translationPath)
  report.readback = { at: readback.at, status: readback.status, bodyHash: hash(readback.body) }
  report.dbMarkerPresent = kind === 'media'
    ? observed.product.value.localizedContent.en?._productMedia?.items.find(i => i.assetId === report.assetId)?.alt === marker
    : observed.product.value.localizedContent.en?.title === marker && observed.translation.value.name === marker
  report.httpMarkerPresent = kind === 'media'
    ? readback.body.collection?.items.find(i => i.assetId === report.assetId)?.alt === marker
    : readback.body.name === marker || readback.body.title === marker
  report.productChangedKeys = changedKeys(before.product.value, observed.product.value)
  report.translationChangedKeys = changedKeys(before.translation.value, observed.translation.value)
  report.auditRowsRetained = observed.audit.filter(id => !before.audit.includes(id))
  assert.equal(report.put.status, 200)
  assert.ok(report.dbMarkerPresent && report.httpMarkerPresent, 'Positive control did not persist through DB and HTTP.')
  assert.equal(observed.product.value.version, before.product.value.version + 1)
  assert.equal(hash(observed.files), hash(before.files), 'Media files changed unexpectedly.')
  assert.equal(hash(observed.listings), hash(before.listings), 'Listings changed during probe.')
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  try {
    if (attempted) {
      if (!observed) { await delay(8100); observed = await snapshot() }
      await restore(before, observed)
      await delay(8100)
      const restored = await snapshot()
      report.afterRestore = digest(restored)
      assert.equal(restored.product.hash, before.product.hash, 'Product not restored by value.')
      assert.equal(restored.translation.hash, before.translation.hash, 'Translation not restored by value.')
      assert.equal(hash(restored.translations), hash(before.translations), 'Other translations changed.')
      assert.equal(hash(restored.files), hash(before.files))
      assert.equal(hash(restored.listings), hash(before.listings))
      report.restoredByValue = true
      const read = await request(mediaPath)
      assert.equal(read.status, 200)
      report.restoredHttp = { at: read.at, status: read.status, temporaryMarkerAbsent: !JSON.stringify(read.body).includes(marker) }
      assert.ok(report.restoredHttp.temporaryMarkerAbsent)
    }
  } catch (error) { report.restoreError = error.message; process.exitCode = 1 }
  await db.end()
  report.finishedAt = new Date().toISOString()
  await writeFile(new URL(`./${kind}-rehearsal.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
