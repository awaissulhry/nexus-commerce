import pg from 'pg'
import { LEGACY_WORKSPACE_ID } from '@nexus/database/workspace-context'
import { privateSheetDatabaseConfig } from './sheet-database-target.mjs'

// External-change fixture only. Never load a repository .env or target a shared database.
const database = privateSheetDatabaseConfig(process.env.E2E_DATABASE_URL)
const [id, name, mode = 'recreate'] = process.argv.slice(2)
if (id !== 'e2e_aaa_save_child' || !name || !['recreate', 'seed-pair', 'advance', 'same-counter'].includes(mode)) throw new Error('Synthetic alias fixture required')
const db = new pg.Client(database)
await db.connect()
try {
  await db.query('BEGIN')
  await db.query("SELECT set_config('nexus.workspace_id',$1,true)", [LEGACY_WORKSPACE_ID])
  const before = await db.query('SELECT version FROM "Product" WHERE id=$1 FOR UPDATE', [id])
  if (before.rowCount !== 1) throw new Error('Seed the synthetic product first')
  const contentBefore = await db.query('SELECT version FROM "ProductTranslation" WHERE "productId"=$1 AND language=\'de\' FOR UPDATE', [id])
  if ((mode === 'advance' || mode === 'same-counter') && contentBefore.rowCount !== 1) throw new Error('Seed the synthetic translation first')
  // Match the real delete/recreate premise separately checked through both API content writers.
  const contentVersion = mode === 'advance' ? contentBefore.rows[0].version + 1 : mode === 'same-counter' ? contentBefore.rows[0].version : 1
  if (mode === 'advance') {
    await db.query('UPDATE "ProductTranslation" SET name=$2,description=$3,version=version+1,"updatedAt"=now() WHERE "productId"=$1 AND language=\'de\'', [id, name, `${name} description`])
  } else {
    await db.query('DELETE FROM "ProductTranslation" WHERE "productId"=$1 AND language=\'de\'', [id])
    await db.query('INSERT INTO "ProductTranslation"(id,"workspaceId","productId",language,name,description,version,"updatedAt") VALUES ($1,$2,$3,\'de\',$4,$5,$6,now())', [`${id}_de`, LEGACY_WORKSPACE_ID, id, name, mode === 'recreate' ? null : `${name} description`, contentVersion])
  }
  const after = await db.query('UPDATE "Product" SET version=version+$2,"updatedAt"=now() WHERE id=$1 RETURNING version', [id, mode === 'advance' ? 1 : 2])
  await db.query('COMMIT')
  console.log(JSON.stringify({ beforeProductVersion: before.rows[0].version, productVersion: after.rows[0].version, beforeContentVersion: contentBefore.rows[0]?.version, contentVersion }))
} catch {
  await db.query('ROLLBACK')
  throw new Error('Synthetic translation fixture failed')
} finally { await db.end() }
