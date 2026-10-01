import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type { Prisma } from '@prisma/client'
import type { concurrentDatabase } from '../../test-support/concurrent-database.js'

/** Real restricted PostgreSQL: family fan-out, concurrent callers, savepoint/retry evidence and RLS. */
const state = vi.hoisted(() => ({
  db: null as Awaited<ReturnType<typeof concurrentDatabase>> | null,
  beforeUnit: null as ((id: string) => Promise<void>) | null,
  afterUnit: null as ((id: string) => Promise<void>) | null,
  unitCalls: [] as string[],
}))
vi.mock('@nexus/database', () => ({ default: new Proxy({}, { get: (_target, property) => {
  if (!state.db) throw new Error('eBay family-clear PostgreSQL fixture is not started')
  const value = Reflect.get(state.db.client, property)
  return typeof value === 'function' ? value.bind(state.db.client) : value
} }) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('./bulk-edit.service.js', async load => {
  const actual = await load<typeof import('./bulk-edit.service.js')>()
  return { ...actual, applyProductBulkEdits: async (...args: Parameters<typeof actual.applyProductBulkEdits>) => {
    const id = args[0].changes[0].id
    if (!args[2]) { state.unitCalls.push(id); await state.beforeUnit?.(id) }
    const result = await actual.applyProductBulkEdits(...args)
    if (!args[2]) await state.afterUnit?.(id)
    return result
  } }
})

import prisma from '../../db.js'
import { afterDatabaseCommit } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { CONCURRENT_PG_ENV, concurrentDatabase as makeDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { applyProductBulkSave, type BulkSaveUnit, type BulkSaveResult } from './bulk-save.service.js'
import { writeContent } from '../pim/content-write.js'
import type { ContentAddress } from '@nexus/shared/content-language'
import { seedClearEnvironment, seedClearFamily, clearListings, clearUnit, itemSpecifics,
  COUNTRY_NAME, COLOR_FIELD, type ClearEnvironment, type ClearFamily } from '../../test-support/ebay-family-clear-fixture.js'

const OTHER_BUSINESS = 'e2e-family-clear-other-business'
const scopedTo = (workspaceId: string) => <T>(work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const scoped = scopedTo(LEGACY_WORKSPACE_ID)
const context = { formulaCascade: false, contentPerRow: true, logger: { warn: vi.fn(), error: vi.fn() } }
const save = (units: BulkSaveUnit[]) => scoped(() => applyProductBulkSave({ units }, context))
let environment: ClearEnvironment
let counted: number | null = null
const restoreCounters: Array<() => void> = []
const confirmed = (result: BulkSaveResult) => {
  expect(result.units.map(unit => unit.status), JSON.stringify(result.units)).toEqual(result.units.map(() => 200))
  for (const unit of result.units) expect(unit.body.errors ?? []).toEqual([])
}
const rows = (family: ClearFamily) => scoped(() => clearListings(prisma, family))
async function cleared(family: ClearFamily) {
  const stored = await rows(family)
  for (const row of stored) expect(itemSpecifics(row)[COUNTRY_NAME] ?? null).toBeNull()
  expect(itemSpecifics(stored.find(row => row.productId === family.parentId)!)).toHaveProperty(COUNTRY_NAME, null)
  return stored
}
function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

describe.skipIf(!concurrentDatabaseUrl())(`eBay family clear on real PostgreSQL (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => {
    state.db = await makeDatabase()
    await state.db.pool.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [OTHER_BUSINESS])
    await scoped(async () => { environment = await seedClearEnvironment(prisma) })
    // Include both driver copies, including the SET statement inside a workspace-scoped query.
    for (const pg of new Set([import.meta.url, new URL('../../../../../packages/database/package.json', import.meta.url).href].map(path => createRequire(path)('pg')))) {
      const original = pg.Client.prototype.query
      pg.Client.prototype.query = function (...args: unknown[]) {
        if (counted !== null) counted += (args[0] as { constructor?: { name?: string } })?.constructor?.name === 'ScopedQuery' ? 2 : 1
        return original.apply(this, args)
      }
      restoreCounters.push(() => { pg.Client.prototype.query = original })
    }
  }, 120_000)
  afterAll(async () => { for (const restore of restoreCounters) restore(); await state.db?.close() }, 60_000)

  for (const size of [21, 105]) it(`clears ${size} family rows once within the original 15-statements-per-row budget`, async () => {
    const family = await scoped(() => seedClearFamily(prisma, environment, { children: size - 1 }))
    const before = await rows(family)
    const units = family.productIds.map(id => clearUnit(family, before.find(row => row.productId === id)!))
    counted = 0
    let result: BulkSaveResult, statements: number
    try { result = await save(units); statements = counted }
    finally { counted = null }
    confirmed(result!)
    const stored = await cleared(family)
    for (const row of stored) expect(row.version).toBe(before.find(prior => prior.id === row.id)!.version + 1)
    for (const unit of result!.units) {
      expect(unit.body).toMatchObject({ versionOf: 'channelListing', currentVersion: stored.find(row => row.productId === unit.key)!.version })
      for (const receipt of (unit.body.familyListings ?? []) as Array<{ listingId: string; version: number }>) {
        expect(receipt.version).toBe(stored.find(row => row.id === receipt.listingId)!.version)
      }
    }
    expect(result!.units.slice(1).every(unit => unit.body.updated === 0 && unit.body.unchanged === 1)).toBe(true)
    console.info(JSON.stringify({ check: 'ebay-family-clear-statements', rows: size, statements: statements!, budget: size * 15 }))
    expect(statements!).toBeGreaterThan(0)
    expect(statements!).toBeLessThanOrEqual(size * 15)
  }, 180_000)

  it('keeps an external sibling update after a forced concurrent snapshot and retry', async () => {
    const family = await scoped(() => seedClearFamily(prisma, environment)), before = (await rows(family)).filter(row => family.children.includes(row.productId))
    const entered = gate(), resume = gate()
    state.unitCalls.length = 0
    state.beforeUnit = async () => { state.beforeUnit = null; entered.open(); await resume.promise }
    const units = before.map(row => clearUnit(family, row))
    units[1].changes.push({ id: before[1].productId, field: COLOR_FIELD, value: 'Must not overwrite', target: 'channel' })
    const pending = save(units)
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('The concurrent writer barrier was not reached') })])
      // The original unsupported batch has read the family in its Serializable transaction. This independent
      // application connection commits before its serial fallback continues, forcing it to retry that snapshot.
      await scoped(() => prisma.channelListing.update({ where: { id: before[1].id }, data: { version: { increment: 1 }, platformAttributes: {
        ...(before[1].platformAttributes as Prisma.JsonObject), itemSpecifics: { ...itemSpecifics(before[1]), Colore: 'External' },
      } } }))
      resume.open()
      const result = await pending
      expect(result.units.map(unit => unit.status)).toEqual([200, 409])
      expect(state.unitCalls.filter(id => id === before[0].productId).length).toBeGreaterThanOrEqual(2)
      const stored = await cleared(family)
      expect(itemSpecifics(stored.find(row => row.id === before[1].id)!)).toHaveProperty('Colore', 'External')
    } finally { state.beforeUnit = null; resume.open(); await pending.catch(() => undefined) }
  }, 120_000)

  it('discards completed proof, writes, audit and commit effects after a savepoint or whole-attempt rollback', async () => {
    for (const failure of ['savepoint', 'retry'] as const) {
      const family = await scoped(() => seedClearFamily(prisma, environment)), pinId = family.children[0]
      const address: ContentAddress = { tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: family.accountId } }
      await scoped(() => writeContent({ productId: pinId, address, values: { title: 'Before pin' }, label: 'Title' }))
      const allBefore = await rows(family), before = family.children.map(id => allBefore.find(row => row.productId === id)!)
      const pin = await scoped(() => prisma.channelListingTranslation.findFirstOrThrow({ where: { channelListingId: before[0].id, language: 'it' } }))
      const auditIds = [...family.productIds, ...allBefore.map(row => row.id)]
      const auditBefore = await scoped(() => prisma.auditLog.count({ where: { entityId: { in: auditIds } } }))
      const effects: string[] = []
      let failed = false
      state.unitCalls.length = 0
      state.afterUnit = async id => {
        if (failed || id !== before[failure === 'retry' ? 1 : 0].productId) return
        failed = true
        await afterDatabaseCommit(`aborted-family-clear-${failure}`, async () => { effects.push('aborted') })
        throw failure === 'retry' ? Object.assign(new Error('Synthetic lost race after completed unit proof'), { code: 'P2034' })
          : new Error('Synthetic failure after completed unit proof')
      }
      try {
        const units = before.map(row => clearUnit(family, row))
        units[0].changes.push({ id: pinId, field: 'name', value: 'Saved pin', contentAddress: address,
          contentVersion: pin.version, contentAcknowledged: true })
        units.push({ ...clearUnit(family, before[0], undefined, `${pinId}:after-content`),
          changes: [{ id: pinId, field: COLOR_FIELD, value: 'After content', target: 'channel' }] })
        const result = await save(units)
        expect(failed).toBe(true)
        expect(result.units.map(unit => unit.status)).toEqual(failure === 'retry' ? [200, 200, 200] : [500, 200, 200])
        if (failure === 'savepoint') expect(result.units[0].body.nothingSaved).toBe(true)
        else expect(state.unitCalls.filter(id => id === before[0].productId).length).toBe(3)
        expect(effects).toEqual([])
        for (const row of await cleared(family)) expect(row.version).toBe(allBefore.find(prior => prior.id === row.id)!.version
          + 1 + (row.productId === pinId ? failure === 'retry' ? 2 : 1 : 0))
        await scoped(async () => {
          expect(await prisma.auditLog.count({ where: { entityId: { in: auditIds } } })).toBe(auditBefore + (failure === 'retry' ? 3 : 2))
          expect(await prisma.channelListingTranslation.findUniqueOrThrow({ where: { id: pin.id }, select: { name: true, version: true } }))
            .toEqual({ name: failure === 'retry' ? 'Saved pin' : 'Before pin', version: pin.version + (failure === 'retry' ? 1 : 0) })
        })
      } finally { state.afterUnit = null }
    }
  }, 120_000)

  it('uses the restricted runtime role and refuses another workspace without changing its rows', async () => {
    const identity = await scoped(() => prisma.$queryRaw<Array<{ role: string; superuser: boolean; bypass: boolean }>>`
      SELECT current_user::text AS role, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`)
    expect(identity).toEqual([{ role: 'nexus_workspace_runtime', superuser: false, bypass: false }])
    const family = await scoped(() => seedClearFamily(prisma, environment))
    const other = scopedTo(OTHER_BUSINESS)
    const foreign = await other(async () => {
      const account = await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Isolated clear other business', isActive: true } })
      return seedClearFamily(prisma, { accountId: account.id, otherAccountId: account.id })
    })
    const foreignBefore = await other(() => clearListings(prisma, foreign))
    const mine = (await rows(family)).filter(row => family.children.includes(row.productId))
    const result = await save([...mine.map(row => clearUnit(family, row)), clearUnit(foreign, foreignBefore[0])])
    confirmed({ ...result, units: result.units.slice(0, -1) })
    expect(result.units.at(-1)!.status).toBeGreaterThanOrEqual(400)
    await cleared(family)
    expect(await other(() => clearListings(prisma, foreign))).toEqual(foreignBefore)
  }, 120_000)
})
