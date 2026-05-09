import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })

const url = (process.env.DATABASE_URL || '').replace('-pooler', '')
const client = new pg.Client({ connectionString: url })
await client.connect()

const sample = await client.query(`SELECT id FROM "AuditLog" LIMIT 1`)
if (sample.rows.length === 0) { console.log('no AuditLog rows'); process.exit(0) }
const id = sample.rows[0].id

console.log(`Testing UPDATE on AuditLog id=${id}`)
try {
  await client.query(`UPDATE "AuditLog" SET action='hijacked' WHERE id=$1`, [id])
  console.log('FAIL: UPDATE was allowed')
  process.exit(1)
} catch (e) {
  console.log('OK: UPDATE blocked →', e.message.slice(0, 200))
}

console.log(`Testing DELETE on AuditLog id=${id}`)
try {
  await client.query(`DELETE FROM "AuditLog" WHERE id=$1`, [id])
  console.log('FAIL: DELETE was allowed')
  process.exit(1)
} catch (e) {
  console.log('OK: DELETE blocked →', e.message.slice(0, 200))
}
await client.end()
