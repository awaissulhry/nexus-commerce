import pg from 'pg'
import { LEGACY_WORKSPACE_ID } from '@nexus/database/workspace-context'

// External-change fixture only. Never load a repository .env or target a shared database.
const url = new URL(process.env.E2E_DATABASE_URL)
if (url.hostname !== '127.0.0.1' || url.port !== '55530' || url.pathname !== '/nexus_pse_test') throw new Error('Private sheet test database required')
const [id, name] = process.argv.slice(2)
if (id !== 'e2e_aaa_save_child' || !name) throw new Error('Synthetic alias fixture required')
const db = new pg.Client({ connectionString: url.href })
await db.connect()
try {
  await db.query('BEGIN')
  await db.query("SELECT set_config('nexus.workspace_id',$1,true)", [LEGACY_WORKSPACE_ID])
  const before = await db.query('SELECT version FROM "Product" WHERE id=$1 FOR UPDATE', [id])
  if (before.rowCount !== 1) throw new Error('Seed the synthetic product first')
  // Match the real delete/recreate premise separately checked through both API content writers.
  await db.query('DELETE FROM "ProductTranslation" WHERE "productId"=$1 AND language=\'de\'', [id])
  await db.query('INSERT INTO "ProductTranslation"(id,"workspaceId","productId",language,name,version,"updatedAt") VALUES ($1,$2,$3,\'de\',$4,1,now())', [`${id}_de`, LEGACY_WORKSPACE_ID, id, name])
  const after = await db.query('UPDATE "Product" SET version=version+2,"updatedAt"=now() WHERE id=$1 RETURNING version', [id])
  await db.query('COMMIT')
  console.log(JSON.stringify({ productVersion: after.rows[0].version, contentVersion: 1 }))
} catch {
  await db.query('ROLLBACK')
  throw new Error('Synthetic translation fixture failed')
} finally { await db.end() }
