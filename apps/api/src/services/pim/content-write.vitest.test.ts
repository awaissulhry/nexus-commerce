import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => { const { formulaDatabase } = await import('../../test-support/formula-database.js'); state.db = await formulaDatabase(); return { default: state.db.client } })
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
import prisma from '../../db.js'
import { beforeDatabaseCommit, inDatabaseTransaction } from '../../lib/database-context.js'
import { reconcileFamilyReadiness } from './readiness-index.service.js'
import { writeContent } from './content-write.js'
import { writeTranslation } from './translation-write.js'
import { resolveContent } from './content-resolver.js'
import { contentListing } from './content-read.js'
import { resolveWriteRouting } from './studio-sheet.service.js'
import { applyContentBulk } from './content-bulk-write.js'
import { applyProductBulkEdits } from '../products/bulk-edit.service.js'
const column = { key: 'name', label: 'Product title', writeField: 'name', storage: 'column', shape: 'scalar', kind: 'text', editable: true, maxLength: 40 } as any
const coord = { channel: 'AMAZON', market: 'DE', accountId: 'lx-amazon' }
const shared = { tier: 'language', language: 'de' } as const
const pin = { tier: 'pin', language: 'de', coordinate: coord } as const
const context = { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }
async function read(language = 'de', market = 'DE') {
 const product = await prisma.product.findUniqueOrThrow({ where: { id: 'lx-child' }, include: { translations: true } })
 const listing = await prisma.channelListing.findFirstOrThrow({ where: { productId: product.id, marketplace: market }, include: { translations: true } })
 const hydrated = contentListing(product, listing, { ...coord, market }, market === 'BE' ? ['nl','fr'] : [language])!
 return { product, listing, resolved: resolveContent({ product: product as any, listing: hydrated, field: 'title', address: { requested: language, coordinate: hydrated.coordinate } }) }
}
async function bulk(value: unknown, address: any, acknowledged = false) {
 const product = await prisma.product.findUniqueOrThrow({ where: { id: 'lx-child' } })
 const listing = await prisma.channelListing.findFirstOrThrow({ where: { productId: product.id, marketplace: 'DE' } })
 const change = { id: product.id, field: 'name', value, contentAddress: address, contentAcknowledged: acknowledged }
 return applyContentBulk({ changes: [change], expectedVersion: address?.tier === 'pin' ? listing.version : product.version,
  marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'DE', accountId: 'lx-amazon', locale: 'de' }] }, context, [{ change, column }], async () => ({ updated: 0 }))
}
beforeAll(async () => {
 await prisma.product.create({ data: { id: 'lx-child', sku: 'LX-CHILD', name: 'Italiano', basePrice: 10, description: 'Originale', localizedContent: { de: { title: 'Untouched JSON' } } } })
 await prisma.channelConnection.create({ data: { id: 'lx-amazon', channelType: 'AMAZON', isActive: true } as any })
 for (const [code, languages] of [['IT',['it']],['DE',['de']],['BE',['nl','fr']],['UK',['en']]] as const) {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: code, currency: 'EUR', region: 'EU', language: languages[0], languages: [...languages] } })
  await prisma.channelListing.create({ data: { id: `lx-${code}`, productId: 'lx-child', channel: 'AMAZON', channelMarket: `AMAZON_${code}`, marketplace: code, region: 'EU', channelConnectionId: 'lx-amazon', title: `Legacy ${code}`, followMasterTitle: true } })
 }
}, 30000)
afterAll(async () => { await state.db?.close() })
describe('LX.8 addressed writes, real disposable PostgreSQL, no provider', () => {
 it('refuses a missing address with the sheet label and no write', async () => {
  const before = await read(); const result = await bulk('Missing address', undefined)
  expect(result.errors[0].error).toBe('Product title needs a ContentAddress before it can be saved.')
  expect((await read()).product.version).toBe(before.product.version)
 })
 it('treats follows=true drift as inherited, offers both answers, and declining writes nothing', async () => {
  const before = await read(); expect(before.resolved).toMatchObject({ tier:'pin', follows:true, drift:true })
  const route = resolveWriteRouting(column, coord, null, { requested:'de', primary:'it', resolved:before.resolved, market:'DE', accountId:'lx-amazon' })
  expect(route.contentAddress).toBeNull(); expect(route.contentAcknowledgement!.shared.address).toEqual(shared); expect(route.contentAcknowledgement!.pin.address).toEqual(pin)
  const refused = await bulk('Unacknowledged drift', shared)
  expect(refused.updated).toBe(0); expect(refused.errors[0].error).toContain('Product title needs a choice:')
  expect((await read()).product.version).toBe(before.product.version)
 })
 it('acknowledged drift writes reviewed German with Product and translation CAS, only German followers cascade', async () => {
  const before = await read(), other = await prisma.channelListing.findMany({ where:{ marketplace:{ not:'DE' } } })
  const result = await bulk('Deutscher Titel', shared, true); expect(result.errors).toEqual([])
  const after = await read(); expect(after.resolved).toMatchObject({ value:'Deutscher Titel', tier:'language', language:'de' })
  expect(after.product.version).toBe(before.product.version+1); expect(after.product.translations[0]).toMatchObject({ language:'de', version:1, source:'manual' }); expect(after.product.translations[0].reviewedAt).toBeInstanceOf(Date)
  expect(resolveContent({product:after.product as any,field:'title',localizableKeys:['untranslated_schema_field'],address:{requested:'de'}}).translation?.outdated).toBe(false)
  expect(after.product.localizedContent).toEqual(before.product.localizedContent); expect(after.listing.title).toBe(before.listing.title)
  expect(after.listing.version).toBe(before.listing.version+1)
  expect(await prisma.readinessIndex.findFirst({ where: { productId: 'lx-child', channel: null, language: 'de' } })).toMatchObject({ pct: null, requiredFilled: 1, requiredTotal: 1 }) // The disposable fixture has no cached category schema.
  expect(await prisma.channelListing.findMany({ where:{ marketplace:{ not:'DE' } } })).toEqual(other)
 })
 it('a pin writes the new table and never changes the shared value', async () => {
  const before = await read(); const result = await bulk('Nur auf Amazon DE', pin, true); expect(result.errors).toEqual([])
  const after = await read(); expect(after.resolved).toMatchObject({ value:'Nur auf Amazon DE', tier:'pin', follows:false })
  expect(after.product.version).toBe(before.product.version); expect(after.listing.title).toBe(before.listing.title)
  expect(after.listing.translations[0].version).toBe(before.listing.translations[0].version+1)
 })
 it('a pin cannot silently write shared text; acknowledged shared edits preserve the pin', async () => {
  expect((await bulk('Silent conversion', shared)).errors[0].error).toContain('needs a choice')
  expect((await bulk('Gemeinsam geändert', shared, true)).errors).toEqual([])
  expect((await read()).resolved.value).toBe('Nur auf Amazon DE')
 })
 it('rejects stale CAS and invalid paste/fill values without changing either table', async () => {
  const before = await read(); expect((await bulk('x'.repeat(41), pin)).errors[0].error).toBe('Product title takes at most 40 characters')
  await expect(writeContent({ productId:'lx-child', address:pin, values:{ title:'Stale' }, expectedVersion:0, label:'Product title' })).rejects.toThrow('Product title changed.')
  const after=await read(); expect(after.product).toEqual(before.product); expect(after.listing).toEqual(before.listing)
 })
 it('clears and resets pins without resurrecting legacy text or changing legacy columns', async () => {
  await writeContent({ productId:'lx-child', address:pin, values:{ title:null }, label:'Product title' }); expect((await read()).resolved).toMatchObject({ value:null, tier:'pin', follows:false })
  await writeContent({ productId:'lx-child', address:pin, values:{}, reset:['title'], label:'Product title' }); expect((await read()).resolved).toMatchObject({ value:'Gemeinsam geändert', tier:'language' })
  expect((await read()).listing.title).toBe('Legacy DE')
 })
 it('primary writes stay on Product and mask following Italian snapshots', async () => {
  await writeContent({ productId:'lx-child', address:{ tier:'source' }, values:{ title:'Titolo nuovo' }, label:'Product title' })
  expect((await read('it','IT')).resolved).toMatchObject({ value:'Titolo nuovo', tier:'source', language:'it' })
 })
 it('Belgium cascades both ordered languages independently and keeps audit languages', async () => {
  for (const language of ['nl','fr']) {
   await writeTranslation({ productId:'lx-child', locale:language, address:{tier:'language',language}, values:{name:`Shared ${language}`}, state:'reviewed' })
   expect((await read(language,'BE')).resolved).toMatchObject({ value:`Shared ${language}`, language })
  }
  const audit = await prisma.auditLog.findMany({ where:{ entityId:'lx-child' } }); expect(audit.length).toBeGreaterThan(4); expect(audit.every(row => typeof (row.metadata as any).language === 'string')).toBe(true)
 })
 it('the actual bulk entry point uses the sheet label and routes German text through the same writer', async () => {
  const scope = { marketplace: 'DE', locale: 'de' }
  const missing = await applyProductBulkEdits({ changes:[{id:'lx-child',field:'name',value:'Missing'}],marketplaceContexts:[scope as any] },context)
  expect(missing.updated).toBe(0);expect(missing.errors[0].error).toBe('Name needs a ContentAddress before it can be saved.')
  const before=await read()
  const saved=await applyProductBulkEdits({changes:[{id:'lx-child',field:'name',value:'Bulk German',contentAddress:shared}],expectedVersion:before.product.version,marketplaceContexts:[scope as any]},context)
  expect(saved.errors).toEqual([]);expect((await read()).product.translations.find(t=>t.language==='de')).toMatchObject({name:'Bulk German',version:expect.any(Number)})
 })
 it('two pasted slots preserve each other and an explicit list clear stays [] on the wire', async () => {
  const changes=[1,3].map(index=>({id:'lx-child',field:`bulletPoints[${index}]`,value:`Slot ${index}`,contentAddress:shared}))
  const edits=changes.map(change=>({change,column:{...column,key:'bulletPoints',writeField:'bulletPoints',shape:'list'}}))
  const saved=await applyContentBulk({changes,marketplaceContexts:[{marketplace:'DE',locale:'de'} as any]},context,edits,async()=>({updated:0}))
  expect(saved.errors).toEqual([]);expect((await read()).product.translations.find(t=>t.language==='de')?.bulletPoints).toEqual(['Slot 1','','Slot 3'])
 })
 it('a parent language write reaches a child that inherits that language', async () => {
  await prisma.product.create({data:{id:'lx-parent',sku:'LX-PARENT',name:'Parent source',basePrice:10}})
  await prisma.product.create({data:{id:'lx-leaf',sku:'LX-LEAF',name:'Child source',basePrice:10,parentId:'lx-parent'}})
  await prisma.channelListing.create({data:{id:'lx-leaf-de',productId:'lx-leaf',channel:'AMAZON',channelMarket:'AMAZON_DE',marketplace:'DE',region:'EU',channelConnectionId:'lx-amazon',followMasterTitle:true}})
  await writeTranslation({productId:'lx-parent',locale:'de',address:shared,values:{name:'Parent German'},state:'reviewed'})
  expect(await prisma.channelListing.findUniqueOrThrow({where:{id:'lx-leaf-de'}})).toMatchObject({version:2})
  expect(await prisma.outboundSyncQueue.findFirstOrThrow({where:{channelListingId:'lx-leaf-de'}})).toMatchObject({payload:expect.objectContaining({productId:'lx-leaf',language:'de',title:'Parent German'})})
 })

})

it('LX.5 index failure rolls back content, versions, cascades and index in the same transaction', async () => {
 const before = await read(), indexBefore = await prisma.readinessIndex.findMany({ orderBy: { id: 'asc' } })
 await expect(inDatabaseTransaction(prisma, async () => {
  await writeContent({ productId: 'lx-child', address: shared, values: { title: 'Must roll back' }, label: 'Product title' })
  await beforeDatabaseCommit('forced-index-failure', async () => { throw new Error('Index unavailable') })
 })).rejects.toThrow('Index unavailable')
 expect(await read()).toEqual(before)
 expect(await prisma.readinessIndex.findMany({ orderBy: { id: 'asc' } })).toEqual(indexBefore)
})
it('LX.5 reconcile repairs a missing index without touching content or legacy JSON', async () => {
 const before = await read()
 await prisma.readinessIndex.deleteMany({})
 expect(await reconcileFamilyReadiness('lx-child')).toBeGreaterThan(0)
 expect(await read()).toEqual(before)
 expect(await prisma.readinessIndex.count({ where: { productId: 'lx-child', channel: null, language: 'sv' } })).toBe(0)
 expect(await prisma.readinessIndex.count({ where: { productId: 'lx-child', channel: null, language: 'de' } })).toBe(1)
})

it('LX.F P1-4/P2-14 — one fallback issue per field, carrying the machine-readable kind', async () => {
 // Real writer-produced rows: the arms above wrote German and French titles, so
 // `description`/`bulletPoints`/`keywords` are the fields that still fall back to
 // the Italian source for `fr`. Each must appear EXACTLY ONCE (P1-4) and carry
 // `kind: 'language-fallback'` so no reader has to match the sentence (P2-14).
 expect(await reconcileFamilyReadiness('lx-child')).toBeGreaterThan(0)
 const rows = await prisma.readinessIndex.findMany({ where: { productId: 'lx-child', language: 'fr', channel: null } })
 const missing = rows.flatMap(row => row.missing as any[])
 const fallback = missing.filter(issue => issue.kind === 'language-fallback')
 expect(fallback.map(issue => issue.field).sort()).toEqual(['bulletPoints', 'description', 'keywords'])
 expect(new Set(fallback.map(issue => issue.field)).size).toBe(fallback.length) // never the same field twice
 for (const issue of fallback) expect(issue.reason).toContain('fr content is missing; showing it fallback.')
 // POSITIVE CONTROL, two arms. (a) The field that WAS translated into German is
 // absent from German's fallback set while its untranslated siblings are present.
 const german = (await prisma.readinessIndex.findMany({ where: { productId: 'lx-child', language: 'de', channel: null } }))
  .flatMap(row => (row.missing as any[]).filter(issue => issue.kind === 'language-fallback')).map(issue => issue.field)
 expect(german).not.toContain('name')
 expect(german).toContain('description')
 // (b) The primary language cannot fall back, so it carries none at all.
 const italian = await prisma.readinessIndex.findMany({ where: { productId: 'lx-child', language: 'it', channel: null } })
 expect(italian.flatMap(row => (row.missing as any[]).filter(issue => issue.kind === 'language-fallback'))).toEqual([])
})

it('LX.F F8 — a byte-identical language write is a NO-OP, and a real change still bumps', async () => {
  // LX.7V measured a re-import of an unchanged file moving the translation 1 → 2 and
  // `Product.version` 7 → 8, which can defeat the revert's own CAS.
  const before = await read()
  const first = await bulk('Identischer Titel', shared, true)
  expect(first.errors).toEqual([])
  const once = await read()
  // ARM: the same bytes again — no product bump, no translation bump, no audit row.
  const auditsBefore = await prisma.auditLog.count({ where: { entityId: 'lx-child' } })
  const again = await bulk('Identischer Titel', shared, true)
  expect(again.errors).toEqual([])
  const twice = await read()
  expect(twice.product.version).toBe(once.product.version)
  expect(twice.product.translations[0].version).toBe(once.product.translations[0].version)
  expect(await prisma.auditLog.count({ where: { entityId: 'lx-child' } })).toBe(auditsBefore)
  // POSITIVE CONTROL in the same run: a real change still bumps both.
  const changed = await bulk('Anderer Titel', shared, true)
  expect(changed.errors).toEqual([])
  const after = await read()
  expect(after.product.version).toBe(twice.product.version + 1)
  expect(after.product.translations[0].version).toBe(twice.product.translations[0].version + 1)
  expect(after.resolved.value).toBe('Anderer Titel')
  expect(once.product.version).toBeGreaterThan(before.product.version)
})
