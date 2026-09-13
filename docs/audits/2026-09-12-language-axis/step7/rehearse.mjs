import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { Client } from 'pg'
import { databaseTarget } from '../step1/target.mjs'
const target = await databaseTarget('local'); assert.equal(target.identity.database, 'nexus_development'); assert.equal(new URL(target.connectionString).port, '55439')
Object.assign(process.env, { DATABASE_URL: target.connectionString, NEXUS_WORKSPACES_ENABLED: '0', NEXUS_DISABLE_BACKGROUND_JOBS: '1', ENABLE_QUEUE_WORKERS: 'false' })
const transports = []; globalThis.__lxGateways = []
const deny = () => { transports.push(new Date().toISOString()); throw new Error('LX7 provider transport blocked') }
http.get = deny; http.request = deny; https.get = deny; https.request = deny; globalThis.fetch = deny; syncBuiltinESMExports()
const r = await import('./runtime.mjs'), db = new Client({ connectionString: target.connectionString }); await db.connect()
const rootId = 'cmokmy3a40078pm0p1fvnu523', childId = 'cmokmy0lr0009pm0p9yxk7ho0', userId = 'lx4_gate_da778dba-6b1b-4912-a05b-dad2ba810e47'
const here = new URL('.', import.meta.url), ledger = new URL('../../../pes-claims.md', import.meta.url)
const tables = ['Product', 'ProductTranslation', 'ChannelListing', 'ChannelListingTranslation', 'CellFormula', 'OutboundSyncQueue', 'ReadinessIndex']
const familySql = 'SELECT id FROM "Product" WHERE id=$1 OR "parentId"=$1'
async function read() { const data = {}; for (const table of tables) {
 const where = table === 'Product' ? `id IN (${familySql})` : table === 'ChannelListingTranslation' ? `"channelListingId" IN (SELECT id FROM "ChannelListing" WHERE "productId" IN (${familySql}))` : `"productId" IN (${familySql})`
 data[table] = (await db.query(`SELECT to_jsonb(t) row FROM "${table}" t WHERE ${where} ORDER BY id`, [rootId])).rows.map(r => r.row)
 } return { at: new Date().toISOString(), data } }
const delay = () => new Promise(resolve => setTimeout(resolve, 8100))
const announce = message => fs.appendFile(ledger, `\nLX7 local fixture · ${new Date().toISOString()} · ${message}\n`)
for (const name of ['write-baseline.json','write-after.json','write-restored.json','write-receipt.json']) { const file = new URL(name, here); try { await fs.rename(file, new URL(`${name}.${Date.now()}.previous`, here)) } catch (error) { if (error.code !== 'ENOENT') throw error } }
const before = await read(); assert.equal(before.data.Product.length, 21); const child = before.data.Product.find(p => p.id === childId); assert.match(child.name, /XAVIA/)
assert.ok(before.data.OutboundSyncQueue.filter(row => row.productId === childId).every(row => ['FAILED','COMPLETED','SYNCED','CANCELLED'].includes(row.syncStatus)), 'Existing pending child queue prevents rehearsal')
await fs.writeFile(new URL('write-baseline.json', here), JSON.stringify(before, null, 2), { flag: 'wx' })
const phases = []; let job
const holdNewQueue = () => r.prisma.outboundSyncQueue.updateMany({ where: { productId: childId, id: { notIn: before.data.OutboundSyncQueue.map(row => row.id) } }, data: { holdUntil: new Date('2099-01-01') } })
const noProvider = () => { assert.deepEqual(transports, []); assert.deepEqual(globalThis.__lxGateways, []) }
async function applyRows(rows, mode = 'update') {
 const context = await r.loadTransferContext(rows), plan = await r.withCachedSchemas(() => r.buildTransferPlan(rows, mode, context, r.transferContracts('IT')))
 assert.deepEqual(plan.issues, []); assert.ok(plan.targets.length)
 for (const target of plan.targets) await r.inDatabaseTransaction(r.prisma, async () => { await r.applyTransferTarget(r.prisma, target, 'lx7-workbook-fixture', userId); await holdNewQueue() })
 return plan
}
const row = patch => ({ row: 3, entity: 'Products', sku: child.sku, channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field: 'name', action: 'SET', ...patch })
try {
 await announce('Starting exclusive local development rehearsal on the fixed XAVIA child: synthetic German draft → delayed read → run revert → delayed read → language workbook/pins/clear → by-value restore. Provider transport blocked; any new queue work held atomically. No publish rehearsal.')
 const input = { language: 'de', fields: ['title'], scope: { kind: 'readiness', query: { productIds: childId, channel: 'SHARED', language: 'de' } } }
 const preview = await r.previewCatalogTranslation(input, userId); assert.equal(preview.getDraft, 1); assert.equal(preview.total, 1)
 let committed = Date.now()
 job = await r.applyCatalogTranslationDrafts(input, preview.token, { [childId]: { title: 'XAVIA Deutscher Entwurf LX7' } }, userId)
 assert.equal(job.status, 'COMPLETED'); committed = Date.now(); await delay()
 const draft = await read(), draftRow = draft.data.ProductTranslation.find(t => t.productId === childId && t.language === 'de')
 assert.equal(draftRow.name, 'XAVIA Deutscher Entwurf LX7'); assert.equal(draftRow.source, 'ai'); assert.equal(draftRow.reviewedAt, null)
 assert.deepEqual(draft.data.ChannelListing, before.data.ChannelListing); assert.deepEqual(draft.data.OutboundSyncQueue, before.data.OutboundSyncQueue)
 const visible = (await r.catalogLanguageValues([childId], 'de')).get(childId); assert.equal(visible.title.provenance.member, 'ai')
 const owner = await r.prisma.product.findUniqueOrThrow({ where: { id: childId }, include: { translations: true, parent: { include: { translations: true } } } })
 const listing = await r.prisma.channelListing.findFirstOrThrow({ where: { productId: childId, channel: 'AMAZON', marketplace: 'DE', aliasKey: '' }, include: { translations: true } })
 const pinnedReview = r.publishReviewIssues(await r.resolvePublishContent({ product: owner, parent: owner.parent, listing, marketplace: 'DE' })); assert.equal(pinnedReview.length, 0)
 const review = r.publishReviewIssues(await r.resolvePublishContent({ product: owner, parent: owner.parent, listing: null, marketplace: 'DE' }))
 assert.ok(review.some(issue => issue.language === 'de' && issue.message.includes('German')))
 phases.push({ phase: 'synthetic draft', jobId: job.id, delayedReadMs: Date.now() - committed, source: draftRow.source, reviewedAt: draftRow.reviewedAt, mark: visible.title.provenance.member, review, existingPinnedListingUnaffected: true, unchangedListings: true, unchangedQueue: true })
 const reverted = await r.revertCatalogTranslation(job.id, userId); assert.equal(reverted.status, 'REVERTED', JSON.stringify(reverted.errors)); committed = Date.now(); await delay()
 const restoredDraft = await read()
 assert.deepEqual(restoredDraft.data.ProductTranslation, before.data.ProductTranslation)
 assert.equal((await r.catalogLanguageValues([childId], 'de')).get(childId).title.language, 'it')
 phases.push({ phase: 'run revert', jobId: job.id, delayedReadMs: Date.now() - committed, status: reverted.status, translationValuesRestored: true })
 const sharedPlan = await applyRows([row({ locale: 'de', value: 'XAVIA Deutscher Import LX7' }), row({ row: 4, locale: 'fr', value: 'XAVIA Import français LX7' })])
 const accountId = listing.channelConnectionId
 const coordinate = { channel: 'AMAZON', accountId, marketplace: 'DE', aliasKey: '' }
 const pinPlan = await applyRows([row({ ...coordinate, entity: 'Overrides', locale: 'de', field: 'item_name', value: 'XAVIA Deutscher Pin LX7' })])
 committed = Date.now(); await delay(); const imported = await read()
 for (const language of ['de', 'fr']) { const t = imported.data.ProductTranslation.find(t => t.productId === childId && t.language === language); assert.equal(t.source, 'manual'); assert.ok(t.reviewedAt) }
 const pinListing = imported.data.ChannelListing.find(l => l.id === listing.id)
 const pins = imported.data.ChannelListingTranslation.filter(t => t.channelListingId === pinListing.id && t.language === 'de')
 assert.deepEqual(pins.map(t => t.language).sort(), ['de']); assert.ok(pins.every(t => t.reviewedAt && t.source === 'manual'))
 assert.equal(imported.data.Product.find(p => p.id === childId).name, child.name); assert.deepEqual(imported.data.Product.find(p => p.id === childId).localizedContent, child.localizedContent)
 phases.push({ phase: 'workbook router', delayedReadMs: Date.now() - committed, sharedAddresses: sharedPlan.targets.flatMap(t => t.contentWrites.map(w => w.address)), pinAddresses: pinPlan.targets.flatMap(t => (t.contentWrites ?? []).map(w => w.address)), nativeSourceUnchanged: true, legacyJsonUnchanged: true })
 // The same machine-key workbook is a no-op under Ignore and a German-only clear under Clear.
 const blankScope = { sheet: 'Content de', entity: 'Products', channel: '', accountId: '', marketplace: '', locale: 'de', category: '', fields: [{ field: 'name', label: 'Title', type: 'text' }], rows: [row({ locale: 'de', action: '', value: undefined })] }
 const ExcelJS = (await import('exceljs')).default, book = new ExcelJS.Workbook(); await book.xlsx.load(await r.writeCatalogWorkbook([blankScope]))
 assert.ok(book.getWorksheet('Content de').getRow(2).values.includes('name@de'))
 const ignored = r.readCatalogWorkbook(book, undefined, { blankPolicy: 'ignore' }); assert.equal(ignored.rows.length, 0)
 const cleared = r.readCatalogWorkbook(book, undefined, { blankPolicy: 'clear' }); assert.deepEqual(cleared.issues, []); assert.equal(cleared.rows.length, 1); assert.equal(cleared.rows[0].locale, 'de'); assert.equal(cleared.rows[0].action, 'CLEAR')
 await applyRows(cleared.rows); committed = Date.now(); await delay(); const clearRead = await read()
 const german = clearRead.data.ProductTranslation.find(t => t.productId === childId && t.language === 'de'), french = clearRead.data.ProductTranslation.find(t => t.productId === childId && t.language === 'fr')
 assert.equal(german.name, null); assert.equal(german.attributes.title, null); assert.equal(french.name, 'XAVIA Import français LX7')
 phases.push({ phase: 'blank policy', delayedReadMs: Date.now() - committed, ignoreRows: 0, clearRows: 1, clearedLanguage: 'de', frenchPreserved: true })
 const workbook = await r.withCachedSchemas(() => r.exportCatalogTransfer({ market: 'IT', skus: [child.sku], marketplaces: ['DE'], layout: 'wide' }))
 await fs.writeFile(new URL('fixture-language-workbook.xlsx', here), workbook.data)
 const reopened = new ExcelJS.Workbook(); await reopened.xlsx.load(workbook.data); const roundtrip = r.readCatalogWorkbook(reopened)
 assert.deepEqual(roundtrip.issues, []); assert.ok(roundtrip.rows.some(row => row.locale === 'de' && row.field === 'item_name')); assert.ok(roundtrip.rows.some(row => row.locale === 'fr' && row.field === 'name'))
 noProvider(); await fs.writeFile(new URL('write-receipt.json', here), JSON.stringify({ at: new Date().toISOString(), target: target.identity, phases, providerAttempts: 0, workbookRows: roundtrip.rows.length }, null, 2))
 console.log(JSON.stringify({ phases, providerAttempts: 0 }))
} finally {
 if (job) { const persisted = await r.prisma.bulkOperation.findUnique({ where: { id: job.id } }); if (persisted && persisted.status !== 'REVERTED') await r.revertCatalogTranslation(job.id, userId).catch(error => phases.push({ phase: 'emergency run revert', error: String(error) })) }
 const after = await read(); await fs.writeFile(new URL('write-after.json', here), JSON.stringify(after, null, 2))
 await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
 try {
  assert.deepEqual((await read()).data, after.data, 'Concurrent fixture edit: refusing to overwrite it')
  const actions = []
  for (const table of [...tables].reverse()) {
   const old = new Map(before.data[table].map(row => [row.id, row]))
   for (const current of after.data[table]) {
    const prior = old.get(current.id); if (JSON.stringify(prior) === JSON.stringify(current)) continue
    if (!prior) { const result = await db.query(`DELETE FROM "${table}" t WHERE id=$1 AND to_jsonb(t)=$2::jsonb`, [current.id, JSON.stringify(current)]); assert.equal(result.rowCount, 1); actions.push({ table, id: current.id, action: 'remove fixture-created row' }) }
    else { const fields = Object.keys(prior).filter(key => !['id','workspaceId'].includes(key) && JSON.stringify(prior[key]) !== JSON.stringify(current[key])); assert.ok(fields.every(key => /^[A-Za-z][A-Za-z0-9]*$/.test(key))); const columns = fields.map(key => `"${key}"`).join(','); const result = await db.query(`UPDATE "${table}" t SET (${columns})=(SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}",$1::jsonb)) WHERE id=$2 AND to_jsonb(t)=$3::jsonb`, [JSON.stringify(prior), current.id, JSON.stringify(current)]); assert.equal(result.rowCount, 1); actions.push({ table, id: current.id, fields }) }
   }
   for (const prior of before.data[table].filter(row => !after.data[table].some(current => current.id === row.id))) { assert.equal(table, 'ReadinessIndex'); await db.query(`INSERT INTO "ReadinessIndex" SELECT * FROM jsonb_populate_record(NULL::"ReadinessIndex",$1::jsonb)`, [JSON.stringify(prior)]) }
  }
  await db.query('COMMIT'); const restoredAt = Date.now(); await delay(); const restored = await read(); assert.deepEqual(restored.data, before.data); noProvider()
  const receipt = { at: restored.at, restoredByValue: true, delayedReadMs: Date.now() - restoredAt, tables: tables.map(table => ({ table, rows: restored.data[table].length, equal: true })), actions, retained: 'BulkOperation and audit history', jobId: job?.id, providerAttempts: 0 }
  await fs.writeFile(new URL('write-restored.json', here), JSON.stringify(receipt, null, 2)); await announce(`RESTORED and released: all seven family table snapshots match by value after ${receipt.delayedReadMs} ms; audit/BulkOperation history retained. Provider attempts 0.`); console.log(JSON.stringify({ restoredByValue: true, delayedReadMs: receipt.delayedReadMs, tables: receipt.tables }))
 } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error }
 finally { await db.end(); await r.prisma.$disconnect() }
}
