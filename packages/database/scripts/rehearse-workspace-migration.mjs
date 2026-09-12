/** Usage: node .../rehearse-workspace-migration.mjs <pre-workspace-schema.prisma> [--historical-indexes] */
import { PGlite } from '@electric-sql/pglite'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const baseline = process.argv[2]
const historicalIndexes = process.argv.includes('--historical-indexes')
if (!baseline) throw new Error('Provide the pre-workspace schema snapshot to rehearse.')
const legacySchema = await readFile(baseline, 'utf8')
const sql = execFileSync(`${root}/node_modules/.bin/prisma`, ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', baseline, '--script'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
const db = await PGlite.create()
try {
  await db.exec(sql)
  await db.exec(await readFile(`${root}/packages/database/prisma/migrations/20260509_l6_0_audit_log_immutability/migration.sql`, 'utf8'))
  await db.exec(`INSERT INTO "AuditLog" (id,"entityType","entityId",action,metadata) VALUES ('audit_before','Product','parent','create','{"preserve":true}')`)
  const auditBefore = await db.query('SELECT id, "entityType", "entityId", action, metadata, "createdAt" FROM "AuditLog"')
  if (historicalIndexes) await db.exec(`
    ALTER TABLE "AmazonAdsDailyPerformance" ADD CONSTRAINT "AmazonAdsDailyPerformance_unique"
      UNIQUE USING INDEX "AmazonAdsDailyPerformance_profileId_adProduct_entityType_en_key";
    ALTER TABLE "Return" ADD CONSTRAINT "Return_rmaNumber_key" UNIQUE USING INDEX "Return_rmaNumber_key";
    ALTER INDEX "CellFormula_productId_scope_channel_marketplace_locale_fiel_key" RENAME TO "CellFormula_coord_key";
    DROP INDEX "StockLevel_locationId_productId_variationId_key";
    CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("locationId", "productId") WHERE "variationId" IS NULL;
    CREATE UNIQUE INDEX "StockLevel_loc_prod_var_unique" ON "StockLevel" ("locationId", "productId", "variationId") WHERE "variationId" IS NOT NULL;
    DROP INDEX "ReturnPolicy_channel_marketplace_productType_key";
    CREATE UNIQUE INDEX "ReturnPolicy_scope_uniq" ON "ReturnPolicy" (channel, COALESCE(marketplace, '__NULL__'), COALESCE("productType", '__NULL__'));
    CREATE UNIQUE INDEX "NotificationPreference_eventType_key" ON "NotificationPreference" ("eventType");
    ALTER TABLE "SyncLog" DROP COLUMN "itemsSuccessful", DROP COLUMN "details";
  `)
  await db.exec(`
    INSERT INTO "UserProfile" (id,email,"updatedAt") VALUES ('rehearsal_owner','owner@example.test',NOW());
    INSERT INTO "Role" (id,key,name,"isSystem","updatedAt") VALUES ('owner_role','OWNER','Owner',true,NOW());
    INSERT INTO "UserRole" (id,"userId","roleId") VALUES ('assignment','rehearsal_owner','owner_role');
    INSERT INTO "AccountSettings" (id,"businessName","updatedAt") VALUES ('settings','Xavia Racing',NOW());
    INSERT INTO "ChannelConnection" (id,"channelType","accountLabel","isActive","updatedAt") VALUES ('ebay_a','EBAY','Xavia Racing eBay',true,NOW()),('amazon_a','AMAZON','Xavia Racing Amazon',true,NOW());
    INSERT INTO "Product" (id,sku,name,"basePrice","updatedAt") VALUES ('parent','PARENT-SKU','Parent',25,NOW()),('child','CHILD-SKU','Child',15,NOW());
    UPDATE "Product" SET "parentId"='parent' WHERE id='child';
  `)
  const original = await db.query('SELECT id, sku, name, "basePrice", "parentId" FROM "Product" ORDER BY id')
  const migrations = ['20260908a_business_workspaces', '20260908b_workspace_data_isolation', '20260908c_sync_log_result_columns', '20260908d_profile_directory_pagination', '20260908e_guarded_account_assignment']
  for (const migration of migrations) await db.exec(await readFile(`${root}/packages/database/prisma/migrations/${migration}/migration.sql`, 'utf8'))
  const after = await db.query('SELECT id, sku, name, "basePrice", "parentId" FROM "Product" ORDER BY id')
  assert.deepEqual(after.rows, original.rows)
  await db.query('SELECT "itemsSuccessful", details FROM "SyncLog" LIMIT 0')
  assert.deepEqual((await db.query('SELECT id, "entityType", "entityId", action, metadata, "createdAt" FROM "AuditLog"')).rows, auditBefore.rows)
  await assert.rejects(db.exec(`UPDATE "AuditLog" SET action='changed' WHERE id='audit_before'`), /AuditLog rows are immutable/)
  const ownership = await db.query('SELECT DISTINCT "workspaceId" FROM "Product" UNION SELECT DISTINCT "workspaceId" FROM "ChannelConnection" UNION SELECT DISTINCT "workspaceId" FROM "AccountSettings"')
  assert.deepEqual(ownership.rows, [{ workspaceId: 'nexus_legacy_workspace' }])
  const models = JSON.parse(await readFile(`${root}/packages/database/workspaces/model-ownership.json`, 'utf8')).workspaceModels
  for (const table of models) {
    const policies = await db.query('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname=$1', [table])
    assert.deepEqual(policies.rows[0], { relrowsecurity: true, relforcerowsecurity: true }, table)
  }
  await db.exec(`BEGIN; SET LOCAL ROLE nexus_workspace_runtime; SELECT set_config('nexus.workspace_id','nexus_legacy_workspace',true),set_config('nexus.actor_id','rehearsal_owner',true);`)
  assert.equal((await db.query('SELECT id FROM "Product"')).rows.length, 2)
  await db.exec('COMMIT')
  await db.exec(`BEGIN; SET LOCAL ROLE nexus_workspace_runtime; SELECT set_config('nexus.workspace_id','unknown_workspace',true),set_config('nexus.actor_id','rehearsal_owner',true);`)
  assert.equal((await db.query('SELECT id FROM "Product"')).rows.length, 0)
  await db.exec('COMMIT')
  await db.exec(`
    INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ('other_workspace','Other business','rehearsal_owner','other',NOW());
    INSERT INTO "Product" (id,sku,name,"basePrice","updatedAt","workspaceId") VALUES ('other_product','PARENT-SKU','Other product',25,NOW(),'other_workspace');
    INSERT INTO "StockLocation" (id,type,code,name,"updatedAt","workspaceId") VALUES ('stock_location','WAREHOUSE','MAIN','Main',NOW(),'nexus_legacy_workspace');
    INSERT INTO "StockLevel" (id,"locationId","productId","lastUpdatedAt","workspaceId") VALUES ('stock_level','stock_location','parent',NOW(),'nexus_legacy_workspace');
    INSERT INTO "ReturnPolicy" (id,channel,"updatedAt","workspaceId") VALUES ('policy','AMAZON',NOW(),'nexus_legacy_workspace'),('other_policy','AMAZON',NOW(),'other_workspace');
    INSERT INTO "NotificationPreference" (id,"eventType","updatedAt","workspaceId") VALUES ('default_preference','NEW_ORDER',NOW(),'nexus_legacy_workspace');
    INSERT INTO "NotificationPreference" (id,"userId","eventType","updatedAt","workspaceId") VALUES ('user_preference','rehearsal_owner','NEW_ORDER',NOW(),'nexus_legacy_workspace');
  `)
  await assert.rejects(db.exec(`INSERT INTO "StockLevel" (id,"locationId","productId","lastUpdatedAt","workspaceId") VALUES ('duplicate_stock','stock_location','parent',NOW(),'nexus_legacy_workspace')`), { code: '23505' })
  await assert.rejects(db.exec(`INSERT INTO "ReturnPolicy" (id,channel,"updatedAt","workspaceId") VALUES ('duplicate_policy','AMAZON',NOW(),'nexus_legacy_workspace')`), { code: '23505' })
  await assert.rejects(db.exec(`INSERT INTO "NotificationPreference" (id,"eventType","updatedAt","workspaceId") VALUES ('duplicate_preference','NEW_ORDER',NOW(),'nexus_legacy_workspace')`), { code: '23505' })
  process.stdout.write(JSON.stringify({ ok: true, historicalIndexes, baselineSha256: createHash('sha256').update(legacySchema).digest('hex'), migrations, protectedTables: models.length, preservedProducts: after.rows.length, preservedAccounts: 2, legacyOwnership: 'nexus_legacy_workspace', nullUniquenessPreserved: true, separateBusinessSku: true }, null, 2) + '\n')
} finally { await db.close() }
