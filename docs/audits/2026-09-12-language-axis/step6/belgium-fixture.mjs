/** Q-LX6-1: explicitly authorized local cached-contract fixture, never a migration. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { databaseTarget } from '../step1/target.mjs'
const seed = process.argv[2] === 'seed'
assert.ok(seed || process.argv[2] === 'inspect')
const target = await databaseTarget('local')
assert.equal(target.identity.database, 'nexus_development')
const c = new Client({ connectionString: target.connectionString, connectionTimeoutMillis: 5000 })
const here = new URL('.', import.meta.url)
const announce = text => fs.appendFileSync(new URL('../../../pes-claims.md', here), `\nLX6 local Belgium contract FIXTURE · ${new Date().toISOString()} · ${text}\n`)
const fingerprint = row => ({ id: row.id, workspaceId: row.workspaceId, marketplace: row.marketplace, schemaVersion: row.schemaVersion, fetchedAt: row.fetchedAt, expiresAt: row.expiresAt, isActive: row.isActive,
  payloadSha256: createHash('sha256').update(JSON.stringify([row.schemaDefinition, row.variationThemes])).digest('hex') })
try {
  await c.connect()
  assert.equal((await c.query('SELECT current_database() AS name')).rows[0].name, 'nexus_development')
  await c.query(seed ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN READ ONLY')
  const family = (await c.query('SELECT "workspaceId" FROM "Product" WHERE id=$1 AND sku=$2', ['cmokmy3a40078pm0p1fvnu523', 'GALE-JACKET'])).rows[0]
  assert.ok(family)
  const query = 'SELECT * FROM "CategorySchema" WHERE "workspaceId"=$1 AND channel=$2 AND marketplace=$3 AND "productType"=$4 ORDER BY id'
  const params = [family.workspaceId, 'AMAZON', 'NL', 'OUTERWEAR']
  const source = (await c.query(query, params)).rows
  const before = (await c.query(query, [family.workspaceId, 'AMAZON', 'BE', 'OUTERWEAR'])).rows
  assert.ok(source.some(row => row.isActive), 'Active local NL OUTERWEAR cache required')
  const receipt = { at: new Date().toISOString(), fixture: true, authorization: 'Owner Q-LX6-1', target: target.identity, source: source.map(fingerprint), before: before.map(fingerprint), inserted: [] }
  if (seed) {
    assert.equal(before.length, 0, 'Refuse to overwrite any existing Belgium contract')
    announce(`fixture seed starting — nexus_development only; copy ${source.length} AMAZON/NL OUTERWEAR CategorySchema rows to previously empty AMAZON/BE. Preserve cached definitions, timestamps and versions; new fixture-prefixed IDs only. No Product, translation, listing or production write.`)
    for (const row of source) {
      const id = `lx6_be_contract_fixture_${randomUUID()}`
      await c.query('INSERT INTO "CategorySchema" (id,"workspaceId",channel,marketplace,"productType","schemaVersion","schemaDefinition","variationThemes","fetchedAt","expiresAt","isActive") SELECT $1,"workspaceId",channel,$2,"productType","schemaVersion","schemaDefinition","variationThemes","fetchedAt","expiresAt","isActive" FROM "CategorySchema" WHERE id=$3', [id, 'BE', row.id])
      receipt.inserted.push({ sourceId: row.id, fixtureId: id })
    }
    await c.query('COMMIT')
    receipt.committedAt = new Date().toISOString()
    await new Promise(resolve => setTimeout(resolve, 8100))
    receipt.after = (await c.query(query, [family.workspaceId, 'AMAZON', 'BE', 'OUTERWEAR'])).rows.map(fingerprint)
    receipt.rereadAt = new Date().toISOString()
    assert.equal(receipt.after.length, source.length)
    for (const entry of receipt.inserted) {
      const from = receipt.source.find(row => row.id === entry.sourceId), to = receipt.after.find(row => row.id === entry.fixtureId)
      assert.ok(from && to)
      for (const key of ['payloadSha256', 'schemaVersion', 'isActive']) assert.deepEqual(to[key], from[key])
      assert.equal(new Date(to.fetchedAt).toISOString(), new Date(from.fetchedAt).toISOString())
    }
    fs.writeFileSync(new URL('belgium-fixture-receipt.json', here), JSON.stringify(receipt, null, 2)+'\n')
    announce(`fixture seed finished — committed ${receipt.after.length} rows and re-read after >=8s; source payload hashes, versions and fetchedAt match. Receipt step6/belgium-fixture-receipt.json. Synthetic NL-derived BE contract is for local screen acceptance only, not a verified Belgian provider contract.`)
  } else {
    await c.query('ROLLBACK')
    fs.writeFileSync(new URL('belgium-fixture-before.json', here), JSON.stringify(receipt, null, 2)+'\n')
  }
  console.log(JSON.stringify(receipt))
} catch (error) {
  await c.query('ROLLBACK').catch(() => {})
  console.error(error.message); process.exitCode = 1
} finally { await c.end() }
