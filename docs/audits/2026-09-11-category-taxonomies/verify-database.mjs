import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
const db = new PGlite({ extensions: { pg_trgm } })
const prior = await readFile('packages/database/prisma/migrations/20260908b_workspace_data_isolation/migration.sql','utf8')
const guard = prior.slice(prior.indexOf('CREATE OR REPLACE FUNCTION nexus_workspace_reference_guard()'), prior.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Workspace"'))
await db.exec(`CREATE ROLE nexus_workspace_runtime; CREATE TABLE "Workspace" (id TEXT PRIMARY KEY,status TEXT); CREATE TABLE "UserProfile" (id TEXT PRIMARY KEY,status TEXT); CREATE TABLE "WorkspaceMembership" ("workspaceId" TEXT,"userId" TEXT,status TEXT); GRANT SELECT ON "Workspace","UserProfile","WorkspaceMembership" TO nexus_workspace_runtime; INSERT INTO "Workspace" VALUES ('a','active'),('b','active'); INSERT INTO "UserProfile" VALUES ('user-a','active'),('user-b','active'); INSERT INTO "WorkspaceMembership" VALUES ('a','user-a','active'),('b','user-b','active'); ${guard}`)
await db.exec(await readFile('packages/database/prisma/migrations/20260911_category_taxonomies/migration.sql','utf8'))
await db.exec(`SET ROLE nexus_workspace_runtime; SELECT set_config('nexus.workspace_id','a',false),set_config('nexus.actor_id','user-a',false); INSERT INTO "MarketplaceTaxonomy" (id,channel,marketplace,"updatedAt") VALUES ('a-source','EBAY','IT',now()); INSERT INTO "MarketplaceTaxonomySnapshot" (id,"sourceId",status) VALUES ('a-old','a-source','SUCCEEDED'),('a-new','a-source','IMPORTING'); UPDATE "MarketplaceTaxonomy" SET "activeSnapshotId"='a-old' WHERE id='a-source';`)
await assert.rejects(db.exec(`UPDATE "MarketplaceTaxonomy" SET "activeSnapshotId"='a-new' WHERE id='a-source'`), /incomplete/)
await assert.rejects(db.exec(`INSERT INTO "MarketplaceTaxonomy" (id,"workspaceId",channel,marketplace,"updatedAt") VALUES ('wrong','b','EBAY','IT',now())`), /row-level security/)
await db.exec(`SELECT set_config('nexus.workspace_id','b',false),set_config('nexus.actor_id','user-b',false); INSERT INTO "MarketplaceTaxonomy" (id,channel,marketplace,"updatedAt") VALUES ('b-source','EBAY','IT',now());`)
assert.equal((await db.query(`SELECT count(*)::int n FROM "MarketplaceTaxonomy"`)).rows[0].n,1)
await assert.rejects(db.exec(`INSERT INTO "MarketplaceTaxonomySnapshot" (id,"sourceId",status) VALUES ('cross','a-source','SUCCEEDED')`), /unavailable/)
await db.exec(`SELECT set_config('nexus.workspace_id','a',false),set_config('nexus.actor_id','user-b',false);`)
assert.equal((await db.query(`SELECT count(*)::int n FROM "MarketplaceTaxonomy"`)).rows[0].n,0)
await db.exec(`SELECT set_config('nexus.actor_id','user-a',false);`)
const at = performance.now()
await db.exec(`INSERT INTO "MarketplaceTaxonomyNode" (id,"snapshotId","externalId",name,path,assignable) SELECT 'n-'||i,'a-new',lpad(i::text,8,'0'),'Category '||i,CASE WHEN i % 1000 = 0 THEN 'Automotive › Protective Gear › Racing Suits ' ELSE 'Automotive › Equipment › Category ' END || i,true FROM generate_series(1,100000) i;`)
const insertMs = performance.now()-at
assert.equal((await db.query(`SELECT "activeSnapshotId" FROM "MarketplaceTaxonomy" WHERE id='a-source'`)).rows[0].activeSnapshotId,'a-old')
await db.exec(`BEGIN; UPDATE "MarketplaceTaxonomySnapshot" SET status='SUCCEEDED' WHERE id='a-new'; UPDATE "MarketplaceTaxonomy" SET "activeSnapshotId"='a-new' WHERE id='a-source'; COMMIT;`)
await assert.rejects(db.exec(`INSERT INTO "MarketplaceTaxonomyNode" (id,"snapshotId","externalId",name,path,assignable) VALUES ('duplicate','a-new','00000001','Duplicate','Duplicate',true)`), /duplicate key/)
await db.exec(`RESET ROLE; ANALYZE "MarketplaceTaxonomyNode"; SET ROLE nexus_workspace_runtime;`)
const times=[]
for(let i=0;i<25;i++){const at=performance.now();const result=await db.query(`SELECT "externalId",path FROM "MarketplaceTaxonomyNode" WHERE "snapshotId"=$1 AND (path ILIKE $2 OR "externalId" ILIKE $2) ORDER BY path,"externalId" LIMIT 50`,['a-new','%suit%']);assert.equal(result.rows.length,50);times.push(performance.now()-at)}
const plan=(await db.query(`EXPLAIN SELECT "externalId",path FROM "MarketplaceTaxonomyNode" WHERE "snapshotId"='a-new' AND (path ILIKE '%suit%' OR "externalId" ILIKE '%suit%') ORDER BY path,"externalId" LIMIT 50`)).rows.map(r=>r['QUERY PLAN']).join('\n')
const indexes = (await db.query(`SELECT indexname FROM pg_indexes WHERE tablename='MarketplaceTaxonomyNode'`)).rows.map(r=>r.indexname)
assert.ok(indexes.includes('MarketplaceTaxonomyNode_path_search_idx'))
const sorted=times.toSorted((a,b)=>a-b)
const evidence={engine:'PGlite PostgreSQL, isolated single connection; not a production concurrency benchmark',nodes:100000,insertMs,searchSamples:times.length,searchP95Ms:sorted[Math.ceil(sorted.length*.95)-1],checks:['migration applies','business isolation','actor membership','cross-business references rejected','incomplete revisions rejected','atomic activation','duplicate external IDs rejected','local full-path search with RLS enabled'],queryPlan:plan,indexes}
await writeFile('docs/audits/2026-09-11-category-taxonomies/database-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));await db.close()
