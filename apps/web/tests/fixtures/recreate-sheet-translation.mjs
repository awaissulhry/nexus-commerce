import pg from 'pg'
import { LEGACY_WORKSPACE_ID } from '@nexus/database/workspace-context'

// External-change fixture only. Never load a repository .env or target a shared database: a database on this machine
// whose name contains "test" (hard rule 1), as `sheet-alias-seed.mjs` requires; the family is that seed's.
if (!process.env.E2E_DATABASE_URL) throw new Error('Set E2E_DATABASE_URL to a LOCAL test database.')
const url = new URL(process.env.E2E_DATABASE_URL)
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) || !url.pathname.includes('test')) throw new Error('A local test database is required')
const workspace = process.env.E2E_WORKSPACE_ID ?? LEGACY_WORKSPACE_ID
const [id, name] = process.argv.slice(2)
if (id !== 'e2e_aaa_save_child' || !name) throw new Error('Synthetic alias fixture required')
const db = new pg.Client({ connectionString: url.href })
await db.connect()
try {
  await db.query('BEGIN')
  await db.query("SELECT set_config('nexus.workspace_id',$1,true)", [workspace])
  const before = await db.query('SELECT version FROM "Product" WHERE id=$1 FOR UPDATE', [id])
  if (before.rowCount !== 1) throw new Error('Seed the synthetic product first')
  // Match the real delete/recreate premise separately checked through both API content writers.
  await db.query('DELETE FROM "ProductTranslation" WHERE "productId"=$1 AND language=\'de\'', [id])
  await db.query('INSERT INTO "ProductTranslation"(id,"workspaceId","productId",language,name,version,"updatedAt") VALUES ($1,$2,$3,\'de\',$4,1,now())', [`${id}_de`, workspace, id, name])
  const after = await db.query('UPDATE "Product" SET version=version+2,"updatedAt"=now() WHERE id=$1 RETURNING version', [id])
  await db.query('COMMIT')
  console.log(JSON.stringify({ productVersion: after.rows[0].version, contentVersion: 1 }))
} catch {
  await db.query('ROLLBACK')
  throw new Error('Synthetic translation fixture failed')
} finally { await db.end() }
