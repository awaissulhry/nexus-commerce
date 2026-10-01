import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import type { FastifyInstance } from 'fastify'
import type { ContentAddress } from '@nexus/shared/content-language'
import type { formulaDatabase } from '../../test-support/formula-database.js'

/**
 * Qualified content receipts on the sheet's real save (`POST /api/products/bulk-save`): the real routes, row writer,
 * content writers, formulas and shared-text cascade on a disposable database. Only external side effects are replaced.
 * The pure evidence is content-version-receipts.vitest.test.ts; races, rollback and retry on a real multi-connection
 * server are content-version-receipts-postgres.vitest.test.ts.
 */
const state = vi.hoisted(() => ({ db: null as Awaited<ReturnType<typeof formulaDatabase>> | null, failRecalculation: false, failAfterContentWrite: false, loseFinals: false }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('./readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn(), { reconcileFamilyReadiness: vi.fn() }))
// A content unit's own recalculation, made to fail on demand AFTER its content write: the unit must roll back whole.
vi.mock('./mapping/cell-formula.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./mapping/cell-formula.service.js')>()
  return { ...actual, reevaluateDependents: async (...args: Parameters<typeof actual.reevaluateDependents>) => {
    if (state.failRecalculation) throw new Error('synthetic failure after the content write')
    return actual.reevaluateDependents(...args)
  } }
})

// A canonical content write that stores its row and then fails (a non-SQL error): only a formula's own write is made to.
vi.mock('./content-write.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./content-write.js')>()
  return { ...actual, writeContent: async (...args: Parameters<typeof actual.writeContent>) => {
    const written = await actual.writeContent(...args)
    if (state.failAfterContentWrite) { state.failAfterContentWrite = false; throw new Error('synthetic failure after the canonical content write') }
    return written
  } }
})

// The final read made to miss every row (a final pair that cannot be read): the receipts are withheld, the save stands.
vi.mock('./content-version-receipt-capture.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./content-version-receipt-capture.js')>()
  return { ...actual, readFinalContentPairs: async (...args: Parameters<typeof actual.readFinalContentPairs>) => {
    const finalOf = await actual.readFinalContentPairs(...args)
    return state.loseFinals ? () => undefined : finalOf
  } }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeContent } from './content-write.js'
import { writeTranslation } from './translation-write.js'
import { setCellFormula } from './mapping/cell-formula.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let app: FastifyInstance
let account: string
let serial = 0
beforeAll(async () => {
  await scoped(async () => {
    for (const [code, language] of [['DE', 'de'], ['IT', 'it']]) {
      await prisma.marketplace.create({ data: { channel: 'EBAY', code, name: code, currency: 'EUR', region: 'EU', language, languages: [language] } })
    }
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'synthetic-receipts', isActive: true } })).id
  })
  const { default: Fastify } = await import('fastify')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => {
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register((await import('../../routes/products.routes.js')).default, { prefix: '/api' })
  await app.register((await import('../../routes/cell-formula.routes.js')).default, { prefix: '/api' })
  await app.register((await import('../../routes/products-bulk-save.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 60_000)
afterAll(async () => { await app?.close(); await state.db?.close() })

type Unit = { key: string; changes: Array<Record<string, unknown>>; marketplaceContexts?: Array<Record<string, unknown>>; expectedVersion?: number; dryRun?: boolean }
type UnitAnswer = { key: string; status: number; body: Record<string, any> }
/** The statements one operation sent (calls; a scoped call is its SET plus its statement). */
const measured: Array<{ label: string; statements: number }> = []
const save = async (units: Unit[], label?: string) => {
  const query = label ? vi.spyOn(pg.Client.prototype, 'query') : null
  try {
    const result = await scoped(() => app.inject({ method: 'POST', url: '/api/products/bulk-save', payload: { units } }))
    expect(result.statusCode, result.body).toBe(200)
    if (query) measured.push({ label: label!, statements: query.mock.calls.reduce((n, args) => n + ((args[0] as { constructor?: { name?: string } })?.constructor?.name === 'ScopedQuery' ? 2 : 1), 0) })
    return (result.json() as { units: UnitAnswer[] }).units
  } finally { query?.mockRestore() }
}
const productRow = (id: string) => scoped(() => prisma.product.findUniqueOrThrow({ where: { id }, include: { translations: true } }))
const listingRow = (id: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id }, include: { translations: true } }))
const german: ContentAddress = { tier: 'language', language: 'de' }
const shared = [{ marketplace: 'DE', locale: 'de' }]

/** A product with German text and a German description that a formula derives from the brand. */
async function germanFormulaProduct(prefix: string) {
  const product = await scoped(() => prisma.product.create({ data: { sku: `${prefix}-${++serial}`, name: 'source', brand: 'before', basePrice: 10 } }))
  await scoped(() => writeContent({ productId: product.id, address: german, values: { title: 'German name' }, label: 'Title' }))
  const formula = await scoped(() => setCellFormula({ productId: product.id, scope: 'master', market: 'DE', locale: 'de', fieldKey: 'description', expr: 'upper($brand)', contentAddress: german }))
  expect(formula.error).toBeNull()
  return product
}
const deOf = (row: { translations: Array<{ language: string; version: number; name?: string | null; description?: string | null }> }) => row.translations.find(text => text.language === 'de')!
const nameUnit = (productId: string, value: string, ownerVersion: number, contentVersion: number): Unit => ({ key: `name:${productId}`, expectedVersion: ownerVersion,
  marketplaceContexts: shared, changes: [{ id: productId, field: 'name', value, contentAddress: german, contentVersion }] })

describe('a fact that feeds a German formula', () => {
  it('answers the German row\'s receipt from the caller\'s own token, so the next Name save chains', async () => {
    const product = await germanFormulaProduct('receipt-fact')
    const before = await productRow(product.id), content = deOf(before)
    const [unit] = await save([{ key: 'brand', expectedVersion: before.version, marketplaceContexts: shared, changes: [{ id: product.id, field: 'brand', value: 'after facts' }] }])
    expect(unit.status, JSON.stringify(unit.body)).toBe(200)
    const after = await productRow(product.id)
    expect(deOf(after).description).toBe('AFTER FACTS')
    expect(deOf(after).version).toBeGreaterThan(content.version)
    expect(unit.body.contentVersionReceipts).toEqual([{ tier: 'language', productId: product.id, language: 'de',
      before: { ownerVersion: before.version, contentVersion: content.version }, after: { ownerVersion: after.version, contentVersion: deOf(after).version } }])
    expect(unit.body.contentVersions).toBeUndefined()
    // The next German Name save with the receipt's after pair is accepted; the old pairs are refused.
    const receipt = unit.body.contentVersionReceipts[0]
    const [next] = await save([nameUnit(product.id, 'next German', receipt.after.ownerVersion, receipt.after.contentVersion)])
    expect(next.status, JSON.stringify(next.body)).toBe(200)
    const latest = await productRow(product.id)
    expect(deOf(latest).name).toBe('next German')
    expect((await save([nameUnit(product.id, 'stale owner', before.version, deOf(latest).version)]))[0].status).toBe(409)
    expect((await save([nameUnit(product.id, 'stale content', latest.version, content.version)]))[0].status).toBe(409)
    expect(await productRow(product.id)).toEqual(latest)
  }, 60_000)

  it('starts from the pair it found when someone else changed the German row first, so a stale reader stays stale', async () => {
    const product = await germanFormulaProduct('receipt-foreign')
    const displayed = await productRow(product.id)
    // Another writer saves German Name B; this reader never saw it.
    await scoped(() => writeTranslation({ productId: product.id, locale: 'de', address: german, values: { name: 'Name B' }, state: 'reviewed' }))
    const beforeOperation = await productRow(product.id)
    const [unit] = await save([{ key: 'brand', expectedVersion: beforeOperation.version, marketplaceContexts: shared, changes: [{ id: product.id, field: 'brand', value: 'foreign' }] }])
    expect(unit.status).toBe(200)
    const after = await productRow(product.id)
    expect(unit.body.contentVersionReceipts).toEqual([{ tier: 'language', productId: product.id, language: 'de',
      before: { ownerVersion: beforeOperation.version, contentVersion: deOf(beforeOperation).version }, after: { ownerVersion: after.version, contentVersion: deOf(after).version } }])
    // The receipt does not start from what the stale reader saw.
    expect(unit.body.contentVersionReceipts[0].before).not.toEqual({ ownerVersion: displayed.version, contentVersion: deOf(displayed).version })
    expect(deOf(after).name).toBe('Name B')
  }, 60_000)

  it('treats a recreated German row with an equal counter as a new state (owner lineage, not the counter, matches)', async () => {
    const product = await germanFormulaProduct('receipt-recreated')
    const displayed = await productRow(product.id)
    await scoped(() => writeTranslation({ productId: product.id, locale: 'de', address: german, values: {}, state: 'draft', remove: true }))
    await scoped(() => writeTranslation({ productId: product.id, locale: 'de', address: german, values: { name: 'recreated' }, state: 'reviewed' }))
    const recreated = await productRow(product.id)
    expect(deOf(recreated).version).toBe(1)
    const [unit] = await save([{ key: 'brand', expectedVersion: recreated.version, marketplaceContexts: shared, changes: [{ id: product.id, field: 'brand', value: 'recreated brand' }] }])
    const receipt = unit.body.contentVersionReceipts[0]
    expect(receipt.before).toEqual({ ownerVersion: recreated.version, contentVersion: 1 })
    expect(receipt.before.ownerVersion).toBeGreaterThan(displayed.version)
  }, 60_000)
})

describe('a shared formula that cascades to a following listing', () => {
  it.each([false, true])('pairs the follower pin with its own listing owner (unseen external Name B: %s)', async externalName => {
    const product = await scoped(() => prisma.product.create({ data: { sku: `receipt-follower-${++serial}`, name: 'source', brand: 'before', basePrice: 10 } }))
    const listing = await scoped(() => prisma.channelListing.create({ data: { productId: product.id, channel: 'EBAY', marketplace: 'DE',
      channelMarket: 'EBAY_DE', region: 'EU', channelConnectionId: account, followMasterDescription: true } }))
    const pin: ContentAddress = { tier: 'pin', language: 'de', coordinate: { channel: 'EBAY', market: 'DE', accountId: account } }
    await scoped(() => writeContent({ productId: product.id, address: pin, values: { title: 'Name A' }, label: 'Title' }))
    expect((await scoped(() => setCellFormula({ productId: product.id, scope: 'master', market: 'DE', locale: 'de', fieldKey: 'description', expr: 'upper($brand)', contentAddress: german }))).error).toBeNull()
    const displayed = await listingRow(listing.id), product0 = await productRow(product.id)
    if (externalName) await scoped(() => writeContent({ productId: product.id, address: pin, values: { title: 'Name B' }, label: 'Title',
      expectedVersion: displayed.version, expectedContentVersion: deOf(displayed).version }))
    const beforeOperation = await listingRow(listing.id)
    const [unit] = await save([{ key: 'brand', expectedVersion: product0.version, marketplaceContexts: shared, changes: [{ id: product.id, field: 'brand', value: 'after facts' }] }])
    expect(unit.status, JSON.stringify(unit.body)).toBe(200)
    const after = await listingRow(listing.id)
    expect(deOf(after).name).toBe(externalName ? 'Name B' : 'Name A')
    expect(unit.body.contentVersionReceipts).toEqual(expect.arrayContaining([{ tier: 'pin', productId: product.id, listingId: listing.id, language: 'de',
      before: { ownerVersion: beforeOperation.version, contentVersion: deOf(beforeOperation).version }, after: { ownerVersion: after.version, contentVersion: deOf(after).version } }]))
    // A foreign pin never enters the legacy answer.
    expect(unit.body.contentVersions ?? []).toEqual([])
    const receipt = unit.body.contentVersionReceipts.find((entry: { tier: string }) => entry.tier === 'pin')
    const pinUnit = (ownerVersion: number, contentVersion: number): Unit => ({ key: 'pin', expectedVersion: ownerVersion,
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'DE', accountId: account, locale: 'de' }],
      changes: [{ id: product.id, field: 'name', target: 'channel', value: 'next pin', contentAddress: pin, contentAcknowledged: true, contentVersion }] })
    // The reader that saw Name A only: with the external B it holds the displayed pair, which no receipt advanced.
    const [next] = await save([externalName ? pinUnit(displayed.version, deOf(displayed).version) : pinUnit(receipt.after.ownerVersion, receipt.after.contentVersion)])
    expect(next.status, JSON.stringify(next.body)).toBe(externalName ? 409 : 200)
    if (externalName) expect(await listingRow(listing.id)).toEqual(after)
    else expect(deOf(await listingRow(listing.id)).name).toBe('next pin')
  }, 60_000)
})

describe('one operation of several units', () => {
  it('ends every receipt at the final pair after later units, and never advances a stale caller', async () => {
    const product = await germanFormulaProduct('receipt-operation')
    const before = await productRow(product.id)
    const units = await save([
      { key: 'first', expectedVersion: before.version, marketplaceContexts: shared, changes: [{ id: product.id, field: 'brand', value: 'first formula' }] },
      // An unguarded unit permits a second own write without inventing a predicted token.
      { key: 'second', marketplaceContexts: shared, changes: [{ id: product.id, field: 'brand', value: 'final formula' }] },
      { key: 'stale', expectedVersion: before.version, marketplaceContexts: shared, changes: [{ id: product.id, field: 'brand', value: 'must refuse' }] },
    ])
    expect(units.map(unit => [unit.key, unit.status])).toEqual([['first', 200], ['second', 200], ['stale', 409]])
    const after = await productRow(product.id), final = { ownerVersion: after.version, contentVersion: deOf(after).version }
    expect(deOf(after).description).toBe('FINAL FORMULA')
    expect(units[0].body.contentVersionReceipts).toEqual([{ tier: 'language', productId: product.id, language: 'de',
      before: { ownerVersion: before.version, contentVersion: deOf(before).version }, after: final }])
    // The second unit began after the first: its before pair is the state the first unit left, never the caller's.
    const second = units[1].body.contentVersionReceipts[0]
    expect(second.after).toEqual(final)
    expect(second.before.ownerVersion).toBeGreaterThan(before.version)
    expect(second.before.contentVersion).toBeGreaterThan(deOf(before).version)
    expect(units[2].body).not.toHaveProperty('contentVersionReceipts')
  }, 60_000)

  it('a unit that rolls back after its content write answers no receipt and stores nothing; the others keep theirs', async () => {
    const [kept, rolled] = [await germanFormulaProduct('receipt-kept'), await germanFormulaProduct('receipt-rolled')]
    const [keptBefore, rolledBefore] = [await productRow(kept.id), await productRow(rolled.id)]
    const first = await save([nameUnit(kept.id, 'kept name', keptBefore.version, deOf(keptBefore).version)])
    expect(first[0].status).toBe(200)
    const keptAfterFirst = await productRow(kept.id)
    state.failRecalculation = true
    let units: UnitAnswer[]
    try {
      units = await save([nameUnit(rolled.id, 'rolled name', rolledBefore.version, deOf(rolledBefore).version)])
    } finally { state.failRecalculation = false }
    expect(units[0].status).toBe(500)
    expect(units[0].body).toMatchObject({ nothingSaved: true })
    expect(units[0].body).not.toHaveProperty('contentVersionReceipts')
    expect(await productRow(rolled.id)).toEqual(rolledBefore)
    // The direct write of the kept unit answers its own receipt, alongside the legacy token.
    expect(first[0].body.contentVersionReceipts).toEqual([{ tier: 'language', productId: kept.id, language: 'de',
      before: { ownerVersion: keptBefore.version, contentVersion: deOf(keptBefore).version },
      after: { ownerVersion: keptAfterFirst.version, contentVersion: deOf(keptAfterFirst).version } }])
    expect(first[0].body.contentVersions).toEqual([{ id: kept.id, tier: 'language', language: 'de', version: deOf(keptAfterFirst).version }])
  }, 60_000)

  it('a receipt whose final pair cannot be read is withheld; the operation is saved', async () => {
    const product = await germanFormulaProduct('receipt-withheld')
    const before = await productRow(product.id)
    state.loseFinals = true
    let units: UnitAnswer[]
    try {
      units = await save([nameUnit(product.id, 'saved without receipt', before.version, deOf(before).version)])
    } finally { state.loseFinals = false }
    expect(units[0].status, JSON.stringify(units[0].body)).toBe(200)
    expect(units[0].body).not.toHaveProperty('contentVersionReceipts')
    expect(deOf(await productRow(product.id)).name).toBe('saved without receipt')
  }, 60_000)

  it('a dry run, a byte-identical write and a plain fact answer no receipt', async () => {
    const product = await scoped(() => prisma.product.create({ data: { sku: `receipt-quiet-${++serial}`, name: 'source', brand: 'plain', basePrice: 10 } }))
    await scoped(() => writeContent({ productId: product.id, address: german, values: { title: 'same German' }, label: 'Title' }))
    const before = await productRow(product.id)
    const dry = await save([{ ...nameUnit(product.id, 'dry', before.version, deOf(before).version), dryRun: true }])
    expect(dry[0].body).not.toHaveProperty('contentVersionReceipts')
    const same = await save([nameUnit(product.id, 'same German', before.version, deOf(before).version)])
    expect(same[0].status, JSON.stringify(same[0].body)).toBe(200)
    expect(same[0].body).not.toHaveProperty('contentVersionReceipts')
    const fact = await save([{ key: 'fact', expectedVersion: before.version, marketplaceContexts: shared, changes: [{ id: product.id, field: 'brand', value: 'plain fact' }] }])
    expect(fact[0].status).toBe(200)
    expect(fact[0].body).not.toHaveProperty('contentVersionReceipts')
  }, 60_000)
})

describe('a formula whose own write fails after its content was stored', () => {
  it('answers no receipt for that write, and the formula shows its error', async () => {
    const product = await germanFormulaProduct('receipt-nested')
    const before = await productRow(product.id)
    state.failAfterContentWrite = true
    let units: UnitAnswer[]
    try {
      units = await save([{ key: 'brand', expectedVersion: before.version, marketplaceContexts: shared, changes: [{ id: product.id, field: 'brand', value: 'nested failure' }] }])
    } finally { state.failAfterContentWrite = false }
    expect(units[0].status, JSON.stringify(units[0].body)).toBe(200)
    // The formula's write answered as a failed internal request: the formula carries an error, whatever its words.
    expect(units[0].body.recalculated).toEqual([expect.objectContaining({ fieldKey: 'description', value: null, error: expect.stringMatching(/\S/) })])
    expect((await productRow(product.id)).brand).toBe('nested failure')
    // Its ledger was discarded: no receipt tells the sheet that this German row moved, so its old pair stays and refuses.
    expect(units[0].body).not.toHaveProperty('contentVersionReceipts')
    const [next] = await save([nameUnit(product.id, 'after a failed formula', units[0].body.currentVersion, deOf(before).version)])
    expect(next.status).toBe(409)
    const formula = await scoped(() => prisma.cellFormula.findFirstOrThrow({ where: { productId: product.id, fieldKey: 'description' } }))
    expect(formula.lastError).toEqual(units[0].body.recalculated[0].error)
  }, 60_000)
})

describe('statements on the common path', () => {
  it('measures a plain fact, a plain German Name and a fact feeding a German formula (one row each)', async () => {
    const plain = await scoped(() => prisma.product.create({ data: { sku: `receipt-count-${++serial}`, name: 'source', brand: 'b', basePrice: 10 } }))
    await scoped(() => writeContent({ productId: plain.id, address: german, values: { title: 'count name' }, label: 'Title' }))
    const formula = await germanFormulaProduct('receipt-count-formula')
    // Warm the route once so module loading and first-use caches are not counted.
    const warm = await productRow(plain.id)
    await save([{ key: 'warm', expectedVersion: warm.version, marketplaceContexts: shared, changes: [{ id: plain.id, field: 'brand', value: 'warm' }] }])
    let row = await productRow(plain.id)
    await save([{ key: 'fact', expectedVersion: row.version, marketplaceContexts: shared, changes: [{ id: plain.id, field: 'brand', value: 'measured fact' }] }], 'plain fact')
    row = await productRow(plain.id)
    await save([nameUnit(plain.id, 'measured name', row.version, deOf(row).version)], 'plain German Name')
    row = await productRow(formula.id)
    await save([{ key: 'formula', expectedVersion: row.version, marketplaceContexts: shared, changes: [{ id: formula.id, field: 'brand', value: 'measured formula' }] }], 'fact feeding a German formula')
    // One operation of 21 rows, each a German Name: the final pairs are one batched read for the whole operation.
    const family = await Promise.all(Array.from({ length: 21 }, async (_, i) => {
      const member = await scoped(() => prisma.product.create({ data: { sku: `receipt-count-row-${++serial}-${i}`, name: 'row', basePrice: 10 } }))
      await scoped(() => writeContent({ productId: member.id, address: german, values: { title: `row ${i}` }, label: 'Title' }))
      return productRow(member.id)
    }))
    await save(family.map(member => nameUnit(member.id, `measured ${member.sku}`, member.version, deOf(member).version)), '21 German Names in one operation')
    console.info(`CONTENT_RECEIPT_STATEMENTS ${JSON.stringify(measured)}`)
    for (const entry of measured) expect(entry.statements).toBeGreaterThan(0)
  }, 60_000)
})
