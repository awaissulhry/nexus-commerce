import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type { FastifyInstance } from 'fastify'
import type { formulaDatabase } from '../../test-support/formula-database.js'
import type { concurrentDatabase } from '../../test-support/concurrent-database.js'

// Production writers, receipts, readiness and cache on a disposable database. No marketplace or queue calls.
const state = vi.hoisted(() => ({ db: null as Awaited<ReturnType<typeof formulaDatabase>> | Awaited<ReturnType<typeof concurrentDatabase>> | null,
  serial: false, batches: 0, failAfterBatch: false, inspectFallback: false, abortedOnlyId: '',
  watchedIds: [] as string[], fallbackRows: [] as Array<{ productId: string | null; platformAttributes: unknown; version: number }>,
  effects: [] as string[], producers: [] as string[],
}))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  state.db = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => ({ enqueued: true })) }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/database-context.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/database-context.js')>()
  return { ...actual, beforeDatabaseCommit: (key: string, producer: () => Promise<unknown>) =>
    actual.beforeDatabaseCommit(key, async () => { state.producers.push(key); return producer() }) }
})
vi.mock('./bulk-edit.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./bulk-edit.service.js')>()
  return { ...actual, applyProductBulkEdits: async (...args: Parameters<typeof actual.applyProductBulkEdits>) => {
    if (args[2] && state.serial) throw new Error('Serial differential control')
    if (!args[2] && state.inspectFallback) {
      state.inspectFallback = false
      state.fallbackRows = await readWatched()
    }
    return actual.applyProductBulkEdits(...args)
  } }
})
vi.mock('./bulk-edit-platform-batch.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./bulk-edit-platform-batch.js')>()
  return { ...actual, writePlatformBatch: async (...args: Parameters<typeof actual.writePlatformBatch>) => {
    const result = await actual.writePlatformBatch(...args)
    state.batches++
    if (state.failAfterBatch) {
      state.failAfterBatch = false
      await readWatched() // Remember the tentative writes. The serial fallback must read the restored rows.
      const { afterDatabaseCommit, afterDatabaseCommitBatch, beforeDatabaseCommit } = await import('../../lib/database-context.js')
      await afterDatabaseCommit('aborted-platform-effect', async () => { state.effects.push('aborted') })
      await beforeDatabaseCommit('aborted-platform-producer', async () => { state.effects.push('aborted-producer') })
      await afterDatabaseCommitBatch('product-cache:bulk-edit', [state.abortedOnlyId], async () => { state.effects.push('aborted-cache') })
      state.inspectFallback = true
      throw new Error('Synthetic failure after all batch work was registered')
    }
    return result
  } }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import type { BulkSaveUnit, BulkSaveResult } from './bulk-save.service.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { writeContent } from '../pim/content-write.js'
import { setCellFormula } from '../pim/mapping/cell-formula.service.js'
import type { ContentAddress } from '@nexus/shared/content-language'
import { concurrentDatabaseUrl, raceChannelListingInserts } from '../../test-support/concurrent-database.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let app: FastifyInstance
let account: string
let sequence = 0
let counted: number | null = null
const restoreCounters: Array<() => void> = []
const readWatched = () => prisma.channelListing.findMany({ where: { productId: { in: state.watchedIds } },
  select: { productId: true, platformAttributes: true, version: true }, orderBy: { productId: 'asc' } })
beforeAll(async () => {
  // Include both driver copies, and the SET statement inside a scoped query call.
  for (const pg of new Set([import.meta.url, new URL('../../../../../packages/database/package.json', import.meta.url).href].map(path => createRequire(path)('pg')))) {
    const original = pg.Client.prototype.query
    pg.Client.prototype.query = function (...args: unknown[]) {
      if (counted !== null) counted += (args[0] as { constructor?: { name?: string } })?.constructor?.name === 'ScopedQuery' ? 2 : 1
      return original.apply(this, args)
    }
    restoreCounters.push(() => { pg.Client.prototype.query = original })
  }
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'synthetic-platform-batch', isActive: true } })).id
  })
  app = (await import('fastify')).default()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done))
  await app.register((await import('../../routes/products.routes.js')).default, { prefix: '/api' })
  await app.register((await import('../../routes/cell-formula.routes.js')).default, { prefix: '/api' })
  await app.register((await import('../../routes/products-bulk-save.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 60_000)
afterAll(async () => { for (const restore of restoreCounters) restore(); await app?.close(); await state.db?.close() })

async function family(size: number, aliasKey = '') {
  const prefix = `batch-platform-${++sequence}`
  const ids = Array.from({ length: size }, (_, i) => `${prefix}-${i}`)
  await scoped(async () => {
    await prisma.product.create({ data: { id: prefix, sku: prefix, name: prefix, basePrice: 10, isParent: true } })
    await prisma.product.createMany({ data: ids.map(id => ({ id, sku: id, name: id, basePrice: 10, parentId: prefix })) })
    if (aliasKey) await prisma.productListingAlias.create({ data: { id: aliasKey, productId: prefix, channel: 'EBAY', marketplace: 'DE', channelConnectionId: account, label: 'Synthetic alias' } })
    await prisma.channelListing.createMany({ data: [prefix, ...ids].map(productId => ({ id: `l-${productId}`, productId, channel: 'EBAY', marketplace: 'DE', channelMarket: 'EBAY_DE', region: 'EU', channelConnectionId: account, aliasKey,
      platformAttributes: { subtitle: 'before', keep: { nested: true } }, overrideData: { subtitle: 'legacy', keep: true } })) })
  })
  const unit = (id: string, value: unknown = 'after', expectedVersion = 1): BulkSaveUnit => ({ key: id, expectedVersion,
    marketplaceContexts: [{ channel: 'EBAY', marketplace: 'DE', accountId: account, locale: 'de', aliasKey }],
    changes: [{ id, field: 'attr_subtitle', value, target: 'channel', intent: 'set' }] })
  return { root: prefix, ids, unit }
}

async function save(units: BulkSaveUnit[]) {
  const response = await scoped(() => app.inject({ method: 'POST', url: '/api/products/bulk-save', payload: { units } }))
  expect(response.statusCode, response.body).toBe(200)
  return response.json<BulkSaveResult>()
}

it('saves 21 independent listing rows within 15 SQL statements per row, keeping all receipts and next tokens', async () => {
  const f = await family(21)
  counted = 0
  let result: BulkSaveResult
  let statements: number
  try { result = await save(f.ids.map(id => f.unit(id))); statements = counted }
  finally { counted = null }
  expect(result!.failed, JSON.stringify(result!.units.filter(unit => unit.status !== 200))).toBe(0)
  const receiptIds = result!.units.map(unit => String(unit.body.operationId))
  expect(new Set(receiptIds).size).toBe(21)
  await scoped(async () => {
    expect(await prisma.bulkOperation.count({ where: { id: { in: receiptIds } } })).toBe(21)
    expect(await prisma.auditLog.count({ where: { entityId: { in: f.ids } } })).toBe(21)
    expect(await prisma.productEvent.count({ where: { aggregateId: { in: f.ids } } })).toBe(21)
    const stored = await prisma.channelListing.findMany({ where: { productId: { in: f.ids } } })
    for (const row of stored) {
      expect(row.platformAttributes).toEqual({ subtitle: 'after', keep: { nested: true } })
      expect(row.overrideData).toEqual({ keep: true })
      expect(result!.units.find(unit => unit.key === row.productId)?.body).toMatchObject({ currentVersion: row.version, versionOf: 'channelListing' })
    }
  })
  const next = await save(result!.units.map(unit => f.unit(unit.key, 'next', Number(unit.body.currentVersion))))
  expect(next.failed).toBe(0)
  expect(statements!).toBeGreaterThan(0)
  expect(statements!).toBeLessThanOrEqual(21 * 15)
}, 120_000)

it('matches the serial writer for warnings, references, no-ops, pins, resets and partial cells on the successful batch path', async () => {
  const reference = await scoped(() => prisma.ebayDescriptionTheme.create({ data: { name: 'Batch reference choice', html: '<div>{{description}}</div>' } }))
  const serial = await family(7), batch = await family(7)
  const makeUnits = (f: Awaited<ReturnType<typeof family>>) => {
    const units = f.ids.map(id => f.unit(id))
    units[0].changes[0].value = 'x'.repeat(60) // Valid text with the channel's length warning.
    units[1] = f.unit(f.ids[1], 'before', 99) // The canonical no-op does not consume or refuse a token.
    units[2].changes[0].value = { invalid: true }
    units[3].changes.push({ id: f.ids[3], field: 'attr_subtitle', value: { invalid: true }, target: 'channel' })
    units[4].changes = [{ id: f.ids[4], field: 'attr_descriptionThemeId', value: reference.name, target: 'channel' }]
    units[5].changes[0] = { ...units[5].changes[0], value: null, intent: 'reset' }
    units[6].changes[0] = { ...units[6].changes[0], value: 'before', intent: 'pin' }
    return units
  }
  let expected: BulkSaveResult
  state.serial = true
  try { expected = await save(makeUnits(serial)) } finally { state.serial = false }
  const before = state.batches
  const actual = await save(makeUnits(batch))
  expect(state.batches).toBe(before + 1)
  const stable = (result: BulkSaveResult, ids: string[]) => JSON.parse(JSON.stringify(result.units.map(unit => {
    const { operationId: _operationId, elapsedMs: _elapsedMs, ...body } = unit.body
    return { status: unit.status, body }
  })).replaceAll(new RegExp(ids.join('|'), 'g'), id => String(ids.indexOf(id))))
  expect(stable(actual, batch.ids)).toEqual(stable(expected!, serial.ids))
  expect(actual.units[0].body.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'attr_subtitle' })]))
  expect(actual.units[4].body.normalizedChanges).toEqual([{ id: batch.ids[4], field: 'attr_descriptionThemeId', value: reference.id }])
  const receiptRows = (ids: string[]) => scoped(() => prisma.auditLog.findMany({ where: { entityId: { in: ids } }, orderBy: { entityId: 'asc' }, select: { entityId: true, after: true, before: true, metadata: true } }))
  const normalize = (rows: Awaited<ReturnType<typeof receiptRows>>, ids: string[]) => rows.map(row => ({ ...row, entityId: ids.indexOf(row.entityId),
    metadata: { ...(row.metadata as Record<string, unknown>), bulkOperationId: '<receipt>' } }))
  expect(normalize(await receiptRows(batch.ids), batch.ids)).toEqual(normalize(await receiptRows(serial.ids), serial.ids))
}, 120_000)

it('rolls back a failed batch, including read memo, events, receipts and commit work, before the serial fallback', async () => {
  const f = await family(3)
  state.watchedIds = f.ids.slice(0, 2)
  state.abortedOnlyId = f.ids[2]
  state.effects.length = 0; state.producers.length = 0; state.fallbackRows.length = 0
  const refresh = vi.spyOn(productReadCacheService, 'refreshMany')
  state.failAfterBatch = true
  const before = state.batches
  try {
    const result = await save(state.watchedIds.map(id => f.unit(id)))
    expect(state.batches).toBe(before + 1) // The failure happened after real set writes and receipt inserts.
    expect(result.failed).toBe(0)
    expect(state.fallbackRows).toHaveLength(2)
    for (const row of state.fallbackRows) expect(row).toMatchObject({ version: 1, platformAttributes: { subtitle: 'before' } })
    expect(state.effects).toEqual([])
    expect(state.producers.filter(key => key.includes('aborted'))).toEqual([])
    expect(state.producers).toHaveLength(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(new Set(refresh.mock.calls[0][0])).toEqual(new Set(state.watchedIds))
    await scoped(async () => {
      expect(await prisma.auditLog.count({ where: { entityId: { in: f.ids } } })).toBe(2)
      expect(await prisma.productEvent.count({ where: { aggregateId: { in: f.ids } } })).toBe(2)
      const operations = (await prisma.bulkOperation.findMany()).filter(operation =>
        (operation.changes as unknown as Array<{ id: string }>).some(change => state.watchedIds.includes(change.id)))
      expect(operations).toHaveLength(2)
      expect(new Set(operations.map(operation => operation.id))).toEqual(new Set(result.units.map(unit => unit.body.operationId)))
      for (const row of await readWatched()) expect(row).toMatchObject({ version: 2, platformAttributes: { subtitle: 'after' } })
      expect(await prisma.channelListing.findFirst({ where: { productId: f.ids[2] }, select: { version: true } })).toEqual({ version: 1 })
    })
  } finally { state.failAfterBatch = false; state.inspectFallback = false; refresh.mockRestore() }
}, 120_000)

it.each(['source', 'language', 'pin'] as const)('keeps %s content receipts between two successful platform groups', async tier => {
  const f = await family(5)
  const id = f.ids[2]
  const address: ContentAddress = tier === 'source' ? { tier } : tier === 'language' ? { tier, language: 'de' }
    : { tier, language: 'de', coordinate: { channel: 'EBAY', market: 'DE', accountId: account } }
  if (tier !== 'source') await scoped(() => writeContent({ productId: id, address, values: { title: 'before content' }, label: 'Title' }))
  const owner = () => scoped(async () => tier === 'pin'
    ? prisma.channelListing.findUniqueOrThrow({ where: { id: `l-${id}` }, include: { translations: true } })
    : prisma.product.findUniqueOrThrow({ where: { id }, include: { translations: true } }))
  const row = await owner()
  const content: BulkSaveUnit = { key: id, expectedVersion: row.version, marketplaceContexts: tier === 'source'
    ? [{ marketplace: 'IT', locale: 'it' }] as BulkSaveUnit['marketplaceContexts'] : f.unit(id).marketplaceContexts,
    changes: [{ id, field: 'name', value: 'saved content', contentAddress: address, contentVersion: row.translations[0]?.version, contentAcknowledged: true }] }
  const before = state.batches
  const result = await save([f.unit(f.ids[0]), f.unit(f.ids[1]), content, f.unit(f.ids[3]), f.unit(f.ids[4])])
  expect(result.failed, JSON.stringify(result.units)).toBe(0)
  expect(state.batches).toBe(before + 2)
  const saved = result.units[2].body
  expect(saved.errors ?? [], JSON.stringify(saved)).toEqual([])
  const stored = await owner()
  expect(saved.currentVersion).toBe(stored.version)
  const versions = saved.contentVersions as Array<{ version: number }> | undefined
  if (tier !== 'source') expect(versions?.[0]?.version).toBe(stored.translations[0].version)
  const next = await save([{ ...content, expectedVersion: Number(saved.currentVersion), changes: content.changes.map(change => ({ ...change, value: 'next content', contentVersion: versions?.[0]?.version })) }])
  expect(next.failed, JSON.stringify(next.units)).toBe(0)
}, 120_000)

it('keeps dependent formulas synchronous through the canonical fallback', async () => {
  const f = await family(2)
  const id = f.ids[0]
  const address: ContentAddress = { tier: 'pin', language: 'de', coordinate: { channel: 'EBAY', market: 'DE', accountId: account } }
  const formula = await scoped(() => setCellFormula({ productId: id, scope: 'channel', channel: 'EBAY', marketplace: 'DE', market: 'DE', locale: 'de',
    channelConnectionId: account, fieldKey: 'description', expr: 'upper($subtitle)', contentAddress: address, contentAcknowledged: true }))
  expect(formula.error, JSON.stringify(formula)).toBeNull()
  const row = await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: `l-${id}` } }))
  const before = state.batches
  const result = await save([f.unit(id, 'formula input', row.version), f.unit(f.ids[1])])
  expect(result.failed, JSON.stringify(result.units)).toBe(0)
  expect(state.batches).toBe(before)
  const stored = await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: row.id }, include: { translations: true } }))
  expect(stored.translations[0].description).toBe('FORMULA INPUT')
  expect(result.units[0].body.currentVersion).toBe(stored.version)
  expect(result.units[0].body.recalculated).toEqual(expect.arrayContaining([expect.objectContaining({ fieldKey: 'description', value: 'FORMULA INPUT', error: null })]))
}, 120_000)

it('contains a malformed cell in its own unit and still saves the surrounding rows', async () => {
  const f = await family(5)
  const units = f.ids.map(id => f.unit(id))
  units[2].changes.push(null as never)
  const result = await save(units)
  expect(result.units.map(unit => unit.status)).toEqual([200, 200, 500, 200, 200])
  expect(result.units[2].body.nothingSaved).toBe(true)
  const rows = await scoped(() => prisma.channelListing.findMany({ where: { productId: { in: f.ids } } }))
  for (const row of rows) expect((row.platformAttributes as { subtitle: string }).subtitle).toBe(row.productId === f.ids[2] ? 'before' : 'after')
}, 120_000)

it.each([0, 1])('preserves create-only token0 and normal token1 semantics for an existing listing at version%i', async version => {
  const f = await family(2)
  await scoped(() => prisma.channelListing.updateMany({ where: { productId: { in: f.ids } }, data: { version } }))
  const before = await scoped(() => prisma.channelListing.findMany({ where: { productId: { in: f.ids } }, orderBy: { id: 'asc' } }))
  const result = await save(f.ids.map(id => f.unit(id, 'changed value', version)))
  expect.soft(result.units.map(unit => unit.status)).toEqual(version === 0 ? [409, 409] : [200, 200])
  const after = await scoped(() => prisma.channelListing.findMany({ where: { productId: { in: f.ids } }, orderBy: { id: 'asc' } }))
  if (version === 0) {
    for (const unit of result.units) expect.soft(unit.body).toMatchObject({ code: 'VERSION_CONFLICT', expectedVersion: 0, currentVersion: 0, versionOf: 'channelListing' })
    expect.soft(after).toEqual(before)
    expect.soft(await scoped(() => prisma.auditLog.count({ where: { entityId: { in: f.ids } } }))).toBe(0)
  } else {
    for (const row of after) expect(row).toMatchObject({ version: 2, platformAttributes: { subtitle: 'changed value' } })
    expect(result.units.every(unit => unit.body.currentVersion === 2)).toBe(true)
  }
}, 120_000)

it('matches the serial writer when a formula belongs to the family parent, whose inputs a child edit does not change', async () => {
  const serial = await family(2), batch = await family(2)
  const address: ContentAddress = { tier: 'pin', language: 'de', coordinate: { channel: 'EBAY', market: 'DE', accountId: account } }
  for (const f of [serial, batch]) {
    expect((await scoped(() => setCellFormula({ productId: f.root, scope: 'channel', channel: 'EBAY', marketplace: 'DE', market: 'DE', locale: 'de',
      channelConnectionId: account, fieldKey: 'description', expr: 'upper($subtitle)', contentAddress: address, contentAcknowledged: true }))).error).toBeNull()
  }
  const parent = (id: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: `l-${id}` }, include: { translations: true } }))
  const before = await Promise.all([parent(serial.root), parent(batch.root)])
  state.serial = true
  let expected: BulkSaveResult
  try { expected = await save(serial.ids.map(id => serial.unit(id, 'child value'))) } finally { state.serial = false }
  const batches = state.batches
  const actual = await save(batch.ids.map(id => batch.unit(id, 'child value')))
  expect(state.batches).toBe(batches + 1)
  expect([expected!.failed, actual.failed]).toEqual([0, 0])
  for (const result of [expected!, actual]) for (const unit of result.units) {
    expect(unit.body).toMatchObject({ updated: 1, currentVersion: 2, versionOf: 'channelListing' })
    expect(unit.body.recalculated).toBeUndefined()
  }
  expect(await parent(serial.root)).toEqual(before[0])
  expect(await parent(batch.root)).toEqual(before[1])
  expect(before[1].translations[0].description).toBe('BEFORE')
}, 120_000)

it.skipIf(!concurrentDatabaseUrl())('uses the restricted runtime role and refuses a foreign business without changing its row', async () => {
  const db = state.db as Awaited<ReturnType<typeof concurrentDatabase>>
  const mode = process.env.NEXUS_WORKSPACES_ENABLED
  process.env.NEXUS_WORKSPACES_ENABLED = '1'
  try {
    const role = await scoped(() => prisma.$queryRaw<Array<{ role: string; superuser: boolean; bypass: boolean }>>`
      SELECT current_user::text AS role, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`)
    expect(role).toEqual([{ role: 'nexus_workspace_runtime', superuser: false, bypass: false }])
    const foreign = 'platform-batch-foreign'
    await db.pool.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [foreign])
    const outside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: foreign, actorUserId: null, membershipId: null, roleKeys: [] }, work)
    await outside(() => prisma.product.create({ data: { id: foreign, sku: foreign, name: foreign, basePrice: 10 } }))
    await outside(() => prisma.channelListing.create({ data: { id: `l-${foreign}`, productId: foreign, channel: 'EBAY', marketplace: 'DE', channelMarket: 'EBAY_DE', region: 'EU', platformAttributes: { subtitle: 'private' } } }))
    const f = await family(2)
    const before = await outside(() => prisma.channelListing.findUniqueOrThrow({ where: { id: `l-${foreign}` } }))
    const result = await save([...f.ids.map(id => f.unit(id)), f.unit(foreign)])
    expect(result.units.slice(0, 2).every(unit => unit.status === 200)).toBe(true)
    expect(result.units[2].status >= 400 || result.units[2].body.updated === 0).toBe(true)
    expect(await outside(() => prisma.channelListing.findUniqueOrThrow({ where: { id: before.id } }))).toEqual(before)
  } finally { if (mode === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED; else process.env.NEXUS_WORKSPACES_ENABLED = mode }
}, 120_000)

it.skipIf(!concurrentDatabaseUrl())('forces two operations to race on the same original tokens and keeps only one set of receipts', async () => {
  const f = await family(4)
  const attempts = await raceChannelListingInserts(state.db as Awaited<ReturnType<typeof concurrentDatabase>>,
    ['first writer', 'second writer'].map(value => () => save(f.ids.map(id => f.unit(id, value)))))
  const outcomes = attempts.map(result => { if ('error' in result) throw result.error; return result.value })
  expect(outcomes.map(result => result.saved).sort()).toEqual([0, 4])
  const loser = outcomes.find(result => result.failed === 4)!
  expect(loser.units.every(unit => unit.status === 409 && unit.body.currentVersion === 2)).toBe(true)
  await scoped(async () => {
    const rows = await prisma.channelListing.findMany({ where: { productId: { in: f.ids } } })
    expect(new Set(rows.map(row => (row.platformAttributes as { subtitle: string }).subtitle)).size).toBe(1)
    expect(rows.every(row => row.version === 2)).toBe(true)
    expect(await prisma.auditLog.count({ where: { entityId: { in: f.ids } } })).toBe(4)
    expect(await prisma.productEvent.count({ where: { aggregateId: { in: f.ids } } })).toBe(4)
  })
}, 180_000)

it('keeps per-unit stale, no-op, invalid and partial-cell outcomes on an alias listing', async () => {
  const f = await family(5, 'alternate')
  const units = f.ids.map(id => f.unit(id))
  units[1] = f.unit(f.ids[1], 'stale', 9)
  units[2] = f.unit(f.ids[2], 'before', 9)
  units[3] = f.unit(f.ids[3], { invalid: true })
  units[4].changes.push({ id: f.ids[4], field: 'attr_subtitle', value: { invalid: true }, target: 'channel' })
  const result = await save(units)
  expect(result.units.map(unit => unit.status), JSON.stringify(result.units)).toEqual([200, 409, 200, 400, 200])
  expect(result.units[1].body).toMatchObject({ code: 'VERSION_CONFLICT', expectedVersion: 9, currentVersion: 1, versionOf: 'channelListing' })
  expect(result.units[2].body).toMatchObject({ updated: 0, unchanged: 1, currentVersion: 1 })
  expect(result.units[4].body).toMatchObject({ updated: 1, errors: [expect.objectContaining({ id: f.ids[4], field: 'attr_subtitle' })] })
  const rows = await scoped(() => prisma.channelListing.findMany({ where: { productId: { in: f.ids } } }))
  for (const row of rows) expect((row.platformAttributes as { subtitle: string }).subtitle).toBe([f.ids[0], f.ids[4]].includes(row.productId!) ? 'after' : 'before')
}, 120_000)
