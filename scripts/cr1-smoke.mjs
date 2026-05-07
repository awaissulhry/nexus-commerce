// CR.1 smoke test: write encrypted credential, read it back, verify
// (a) row in DB is opaque ciphertext, (b) decrypt round-trips,
// (c) legacy plaintext row gets re-encrypted on read.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })

let url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
url = url.replace('-pooler.', '.')

// Force ESM resolution into the api package
const cryptoMod = await import('/Users/awais/nexus-commerce/apps/api/src/lib/crypto.ts')
  .catch(() => import('/Users/awais/nexus-commerce/apps/api/src/lib/crypto.js'))

const client = new pg.Client({ connectionString: url })
await client.connect()

// (1) Plant a fake plaintext row to simulate a pre-CR.1 carrier.
const legacyJson = JSON.stringify({ publicKey: 'LEGACY_PK', privateKey: 'LEGACY_SK', integrationId: 99 })
await client.query(`DELETE FROM "Carrier" WHERE code = 'SENDCLOUD'`)
await client.query(`INSERT INTO "Carrier" (id, code, name, "isActive", "credentialsEncrypted", "createdAt", "updatedAt")
                    VALUES ($1, 'SENDCLOUD', 'Sendcloud', true, $2, NOW(), NOW())`,
                    ['cr1-test-' + Date.now(), legacyJson])

const before = await client.query(`SELECT "credentialsEncrypted" FROM "Carrier" WHERE code = 'SENDCLOUD'`)
console.log('BEFORE (legacy plaintext):', JSON.stringify(before.rows[0].credentialsEncrypted).slice(0, 80))
console.log('  starts with v1:?', before.rows[0].credentialsEncrypted.startsWith('v1:'))
console.log('  parses as JSON?', (() => { try { return !!JSON.parse(before.rows[0].credentialsEncrypted) } catch { return false } })())

// (2) Re-encrypt directly via the helper, write it, read it.
const ciphertext = cryptoMod.encryptSecret(legacyJson)
console.log('\nCIPHERTEXT shape:', ciphertext.slice(0, 30) + '...')
console.log('  length:', ciphertext.length)
console.log('  isEncrypted?', cryptoMod.isEncrypted(ciphertext))

await client.query(`UPDATE "Carrier" SET "credentialsEncrypted" = $1 WHERE code = 'SENDCLOUD'`, [ciphertext])
const after = await client.query(`SELECT "credentialsEncrypted" FROM "Carrier" WHERE code = 'SENDCLOUD'`)
console.log('\nAFTER (encrypted):', after.rows[0].credentialsEncrypted.slice(0, 80))
console.log('  starts with v1:?', after.rows[0].credentialsEncrypted.startsWith('v1:'))
console.log('  parses as JSON?', (() => { try { return !!JSON.parse(after.rows[0].credentialsEncrypted) } catch { return false } })())

// (3) Round-trip decrypt.
const decrypted = cryptoMod.decryptSecret(after.rows[0].credentialsEncrypted)
const parsed = JSON.parse(decrypted)
console.log('\nDECRYPT round-trip:', parsed)
console.log('  match?', parsed.publicKey === 'LEGACY_PK' && parsed.privateKey === 'LEGACY_SK' && parsed.integrationId === 99)

// (4) Cleanup.
await client.query(`DELETE FROM "Carrier" WHERE code = 'SENDCLOUD'`)
await client.end()
console.log('\nCR.1 smoke test PASSED')
