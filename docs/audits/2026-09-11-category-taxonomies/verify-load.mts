/** Disposable PostgreSQL DB; actual taxonomy HTTP handlers, Prisma and business RLS. */
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { Client, Pool } from 'pg'
import { parse } from 'dotenv'
import Fastify from 'fastify'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const env = parse(await readFile(`${root}apps/api/.env`))
Object.assign(process.env, env)
const url = new URL(env.DATABASE_URL)
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('Load verification is local only.')
const admin = new Client({ connectionString: url.href })
const name = `nexus_taxonomy_load_${randomUUID().replaceAll('-', '')}`
await admin.connect()
await admin.query(`CREATE DATABASE "${name}"`)
url.pathname = `/${name}`
process.env.DATABASE_URL = url.href
process.env.NEXUS_WORKSPACES_ENABLED = '1'
const db = new Client({ connectionString: url.href })
const pool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 30_000 })
const app = Fastify({ logger: { level: 'error' } })
let prisma: any
try {
  await db.connect()
  const prior = await readFile(`${root}packages/database/prisma/migrations/20260908b_workspace_data_isolation/migration.sql`, 'utf8')
  const guard = prior.slice(prior.indexOf('CREATE OR REPLACE FUNCTION nexus_workspace_reference_guard()'), prior.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Workspace"'))
  await db.query(`CREATE TABLE "Workspace" (id TEXT PRIMARY KEY, status TEXT); CREATE TABLE "UserProfile" (id TEXT PRIMARY KEY, status TEXT); CREATE TABLE "WorkspaceMembership" ("workspaceId" TEXT, "userId" TEXT, status TEXT); GRANT SELECT ON "Workspace", "UserProfile", "WorkspaceMembership" TO nexus_workspace_runtime; INSERT INTO "Workspace" VALUES ('load-a','active'),('load-b','active'); INSERT INTO "UserProfile" VALUES ('user-a','active'),('user-b','active'); INSERT INTO "WorkspaceMembership" VALUES ('load-a','user-a','active'),('load-b','user-b','active'); ${guard}`)
  await db.query(await readFile(`${root}packages/database/prisma/migrations/20260911_category_taxonomies/migration.sql`, 'utf8'))
  await db.query(`SET ROLE nexus_workspace_runtime; SELECT set_config('nexus.workspace_id','load-a',false),set_config('nexus.actor_id','user-a',false); INSERT INTO "MarketplaceTaxonomy" (id,channel,marketplace,"updatedAt","lastSyncedAt","nextSyncAt") VALUES ('load-source','EBAY','IT',now(),now(),now()+interval '1 day'); INSERT INTO "MarketplaceTaxonomySnapshot" (id,"sourceId",status,"nodeCount") VALUES ('load-snapshot','load-source','SUCCEEDED',100000); UPDATE "MarketplaceTaxonomy" SET "activeSnapshotId"='load-snapshot' WHERE id='load-source';`)
  await db.query(`INSERT INTO "MarketplaceTaxonomyNode" (id,"snapshotId","externalId",name,path,assignable) SELECT 'n-'||i,'load-snapshot',lpad(i::text,8,'0'),'Category '||i,CASE WHEN i%1000=0 THEN 'Automotive › Protective Gear › Racing Suits ' ELSE 'Automotive › Equipment › Category ' END||i,true FROM generate_series(1,100000) i; RESET ROLE; ANALYZE "MarketplaceTaxonomyNode";`)
  const { workspacePrisma } = await import('@nexus/database/workspace-router')
  prisma = workspacePrisma(pool)
  ;(globalThis as any).workspacePrisma = prisma
  const { withWorkspace } = await import('@nexus/database/workspace-context')
  const scope = { workspaceId: 'load-a', actorUserId: 'user-a', membershipId: 'load-membership', roleKeys: [] }
  app.addHook('onRequest', (request, _reply, done) => withWorkspace(request.headers['x-test-business'] === 'b' ? { ...scope, workspaceId: 'load-b', actorUserId: 'user-b' } : scope, done))
  await app.register((await import('../../../apps/api/src/routes/taxonomy.routes.js')).default, { prefix: '/api' })
  await app.ready()
  const route = '/api/pim/taxonomies/EBAY/IT/nodes'
  const isolated = await app.inject({ url: route, headers: { 'x-test-business': 'b' } })
  assert.equal(isolated.statusCode, 200, isolated.body)
  assert.equal(isolated.json().state, 'missing')
  const coldStarted = performance.now()
  const warm = await app.inject({ url: `${route}?q=suit` })
  const coldLoadMs = performance.now() - coldStarted
  assert.equal(warm.statusCode, 200)
  assert.equal(warm.json().total, 100)
  assert.equal(warm.json().items.length, 50)
  assert.equal((await app.inject({ url: `${route}?snapshotId=retired` })).statusCode, 409)
  const queries = ['suit', 'racing suit', 'protective', 'equipment', 'category 123', '00001000', 'absent', '', 'automotive', 'suits 50000']
  const metrics = []
  for (const concurrency of [1, 50]) {
    let next = 0
    const elapsed: number[] = []
    const started = performance.now()
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < 100) {
        const index = next++, at = performance.now()
        const result = await app.inject({ url: `${route}?q=${encodeURIComponent(queries[index % queries.length])}` })
        assert.equal(result.statusCode, 200, result.body)
        assert.equal(result.json().snapshotId, 'load-snapshot')
        assert.ok(result.json().items.length <= 50)
        elapsed.push(performance.now() - at)
      }
    }))
    elapsed.sort((a,b) => a-b)
    metrics.push({ concurrency, requests: elapsed.length, p50Ms: elapsed[49], p95Ms: elapsed[94], p99Ms: elapsed[98], wallMs: performance.now() - started })
  }
  const distinctStarted = performance.now(), distinct: number[] = []
  await Promise.all(Array.from({length:50}, async (_,i) => {
    const at = performance.now(), result = await app.inject({url:`${route}?q=${encodeURIComponent(`Category ${23001+i}`)}`})
    assert.equal(result.statusCode,200,result.body)
    assert.equal(result.json().total,1)
    distinct.push(performance.now()-at)
  }))
  distinct.sort((a,b)=>a-b)
  // A revoked actor cannot see a warm cached revision.
  await db.query('UPDATE "WorkspaceMembership" SET status=$1 WHERE "userId"=$2',['revoked','user-a'])
  assert.equal((await app.inject({url:route})).json().state,'missing')
  const report = { at: new Date().toISOString(), engine: 'local PostgreSQL 17; actual Fastify handlers via injection, Prisma pool max=1 and authenticated business RLS; synthetic 100,000 nodes', nodes: 100000, crossBusinessIsolation: true, revokedActorDeniedWarmCache: true, replacedSnapshotRejected: true, coldLoadMs, metrics,
    distinctQueries: {concurrency:50,requests:50,p95Ms:distinct[47],wallMs:performance.now()-distinctStarted} }
  await writeFile(new URL('./load-evidence.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await app.close()
  if (prisma) await prisma.$disconnect()
  await pool.end()
  await db.end()
  await admin.query(`DROP DATABASE "${name}"`)
  await admin.end()
}
process.exit(0)
