import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { Client } from 'pg'
import { databaseTarget } from '../step1/target.mjs'
const target = await databaseTarget('local'); assert.equal(target.identity.database, 'nexus_development')
const connection = new URL(target.connectionString); assert.equal(connection.port, '55439'); connection.searchParams.set('options', '-c default_transaction_read_only=on')
Object.assign(process.env, { DATABASE_URL: connection.href, NEXUS_WORKSPACES_ENABLED: '0', NEXUS_DISABLE_BACKGROUND_JOBS: '1', ENABLE_QUEUE_WORKERS: 'false' })
const transports = []; globalThis.__lxGateways = []
const deny = () => { transports.push(new Date().toISOString()); throw new Error('LX7 provider transport blocked') }
http.get = deny; http.request = deny; https.get = deny; https.request = deny; globalThis.fetch = deny; syncBuiltinESMExports()
const r = await import('./runtime.mjs'), db = new Client({ connectionString: connection.href }); await db.connect()
const rootId = 'cmokmy3a40078pm0p1fvnu523', childId = 'cmokmy0lr0009pm0p9yxk7ho0'
try {
 const identity = (await db.query("SELECT current_database() database,current_setting('transaction_read_only') read_only")).rows[0]; assert.equal(identity.read_only, 'on')
 const family = await r.prisma.product.findMany({ where: { OR: [{ id: rootId }, { parentId: rootId }] }, select: { id: true, sku: true, name: true, familyId: true } })
 if (process.argv.includes('--census')) {
  const baseline = JSON.parse(await fs.readFile(new URL('write-baseline.json', import.meta.url), 'utf8')).data.Product
  const current = (await db.query('SELECT to_jsonb(p) row FROM "Product" p WHERE id=$1 OR "parentId"=$1 ORDER BY id', [rootId])).rows.map(r=>r.row)
  const extra = current.filter(p=>!baseline.some(b=>b.id===p.id)).map(p=>({id:p.id,sku:p.sku,parentId:p.parentId,createdAt:p.createdAt,deletedAt:p.deletedAt}))
  const originalChanges = baseline.flatMap(b=>{const row=current.find(p=>p.id===b.id);const fields=Object.keys(b).filter(k=>JSON.stringify(b[k])!==JSON.stringify(row?.[k]));return fields.length?[{id:b.id,fields}]:[]})
  const audits = extra.length ? (await db.query('SELECT "entityId",action,"createdAt",metadata FROM "AuditLog" WHERE "entityId"=ANY($1::text[]) ORDER BY "createdAt" DESC LIMIT 30',[extra.map(p=>p.id)])).rows : []
  const receipt={at:new Date().toISOString(),identity,total:current.length,extra,originalChanges,audits};await fs.writeFile(new URL('fixture-census.json',import.meta.url),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));await db.end();await r.prisma.$disconnect();process.exit(0)
 }
 assert.equal(family.length, 21); assert.match(family.find(p => p.id === childId).name, /XAVIA/)
 const listing = await r.prisma.channelListing.findFirstOrThrow({ where: { productId: rootId, channel: 'AMAZON', marketplace: 'DE', aliasKey: '' } })
 const loads = []; r.clearStudioColumnCache()
 for (let i = 0; i < 3; i++) {
  const started = Date.now()
  const sheet = await r.getStudioSheet({ productId: rootId, scope: 'channel', channel: 'AMAZON', market: 'DE', locale: 'de', accountId: listing.channelConnectionId })
  assert.ok(sheet.rows.length); assert.ok(sheet.meta.schemaAge.length)
  for (const age of sheet.meta.schemaAge) {
   const cached = await r.prisma.categorySchema.findFirstOrThrow({ where: { channel: 'AMAZON', marketplace: 'DE', productType: age.productType, isActive: true }, orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } })
   assert.equal(new Date(age.fetchedAt).getTime(), cached.fetchedAt.getTime()); assert.ok(new Date(age.fetchedAt).getTime() < started - 8000)
  }
  loads.push({ loadedAt: new Date(started).toISOString(), ms: Date.now() - started, rows: sheet.rows.length, schemaAge: sheet.meta.schemaAge })
 }
 const page = await r.listingReadiness({ productIds: childId, channel: 'AMAZON', marketplace: 'BE' }, null)
 assert.deepEqual(page.rows.map(row => row.locale).sort(), ['fr', 'nl'])
 const values = Object.fromEntries(await r.catalogLanguageValues([rootId, childId], 'de'))
 const index = await r.prisma.readinessIndex.findMany({ where: { productId: childId, channel: null, language: 'de' } })
 assert.equal(values[childId].readiness.computedAt, index[0].computedAt.toISOString())
 const preview = await r.previewCatalogTranslation({ language: 'de', fields: ['title'], scope: { kind: 'readiness', query: { productIds: childId, channel: 'SHARED', language: 'de' } } })
 assert.equal(preview.total, 1); assert.equal(preview.getDraft, 1); assert.equal(preview.generationEnabled, false)
 const account = (await db.query('SELECT id FROM "UserProfile" WHERE id=$1', ['lx4_gate_da778dba-6b1b-4912-a05b-dad2ba810e47'])).rows[0]; assert.ok(account)
 assert.equal(transports.length, 0); assert.equal(globalThis.__lxGateways.length, 0)
 const receipt = { at: new Date().toISOString(), target: target.identity, identity, family, fixture: { rootId, childId, accountId: listing.channelConnectionId, userId: account.id }, loads, languageValues: values, belgiumRows: page.rows, translationPreview: preview, transports, gateways: globalThis.__lxGateways }
 await fs.writeFile(new URL('local-read.json', import.meta.url), JSON.stringify(receipt, null, 2))
 console.log(JSON.stringify({ cacheLoads: loads, belgiumLanguages: page.rows.map(row => row.locale), preview: { total: preview.total, getDraft: preview.getDraft }, providerAttempts: 0 }))
} finally { await db.end(); await r.prisma.$disconnect() }
