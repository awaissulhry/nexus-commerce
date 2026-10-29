import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFloorAuth } from '../seed/floor-auth'
import { seed as seedFloorSync } from '../seed/floor-sync'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The floor sync's walls beyond the generated isolation tests (B-W0-30; PLT-237, PLT-239, PLT-189; A1 §2.1
 * "Append-only", §3.8), on a database built from the migrations and seeded twice, through the real login and the scoped
 * client (…_floor_sync_guards):
 *   - the sync ledger (FloorSyncEvent) is append-only for every login, the owner included, and the office never writes it;
 *   - a refused action (FloorRefusedAction) is kept open with its words and fix; what the tablet sent never changes; it
 *     closes once: resolved only by the ledger row of the same tablet and client event id, or discarded with when, from
 *     where and why; it is never deleted;
 *   - the seed is idempotent.
 * The refusals are check_violation (SQLSTATE 23514).
 */

const NS = 'floor-sync-db'
let db: MigratedDatabase
let factory: FactoryDatabase
let core: CoreSeed

const key = (name: string): string => seedUuid(NS, name)
const siteA = key('site:A1')
const companyA = key('company:A')
const tablet = key('device:A1:cutting')

const floor = (): FactoryScope => ({ audience: 'floor', tenantId: core.tenantId, actorId: tablet, siteId: siteA })
const office = (): FactoryScope => ({ audience: 'office', tenantId: core.tenantId, actorId: core.actorId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (table: string) => Number((await admin(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [core.tenantId]))[0]!.n)

const event = (clientEventId: string) => ({
  id: randomUUID(),
  siteId: siteA,
  deviceId: tablet,
  clientEventId,
  kind: 'production.bundles.make',
  deviceSeq: 7,
  deviceTime: new Date('2026-10-29T08:00:00.000Z'),
  serverTime: new Date('2026-10-29T08:05:00.000Z'),
  clockSkewSeconds: 300,
  outcome: 'ACCEPTED' as const,
  resultType: 'Bundle',
  resultId: randomUUID(),
  requestId: 'test-request',
})

const refused = (clientEventId: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  companyId: companyA,
  siteId: siteA,
  deviceId: tablet,
  clientEventId,
  kind: 'production.bundles.make',
  deviceSeq: 7,
  code: 'FLOOR_NOT_READY',
  message: 'Bundles are held at this site until its floor is ready.',
  fix: 'It is sent again by itself once the floor is ready.',
  final: false,
  summary: { quantity: 10 },
  payload: { workOrderId: randomUUID() },
  serverTime: new Date('2026-10-29T08:01:00.000Z'),
  ...extra,
})

const newRefused = async (clientEventId = `evt-${randomUUID()}`) => {
  const row = refused(clientEventId)
  await as(floor(), (client) => client.floorRefusedAction.create({ data: row, select: { id: true } }))
  return row
}

beforeAll(async () => {
  db = await migratedDatabase('floor_sync')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  core = await seedCore({ db: factory, namespace: NS })
  await seedFloorAuth({ db: factory, namespace: NS })
  await seedFloorSync({ db: factory, namespace: NS })
}, 60_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('is idempotent: a second run inserts nothing', async () => {
    const before = [await count('FloorSyncEvent'), await count('FloorRefusedAction')]
    await seedFloorSync({ db: factory, namespace: NS })
    expect([await count('FloorSyncEvent'), await count('FloorRefusedAction')]).toEqual(before)
    expect(before).toEqual([2, 2])
  })
})

describe('the sync ledger is append-only', () => {
  it('the tablet records an event; nobody changes or removes it, the owner included', async () => {
    const row = event(`evt-${randomUUID()}`)
    await as(floor(), (client) => client.floorSyncEvent.create({ data: row, select: { id: true } }))
    await expect(run(floor(), 'UPDATE "FloorSyncEvent" SET "deviceSeq" = 8 WHERE "id" = $1::uuid', row.id)).rejects.toThrow(/permission denied/)
    await expect(admin('UPDATE "FloorSyncEvent" SET "deviceSeq" = 8 WHERE "id" = $1', [row.id])).rejects.toThrow(/never changed/)
    await expect(admin('DELETE FROM "FloorSyncEvent" WHERE "id" = $1', [row.id])).rejects.toThrow(/never changed/)
    await expect(admin('TRUNCATE "FloorSyncEvent" CASCADE')).rejects.toThrow(/is refused/)
  })

  it('a recorded event keeps its id, kind and result; one per tablet and client event id', async () => {
    await expect(as(floor(), (client) => client.floorSyncEvent.create({ data: { ...event(`evt-${randomUUID()}`), kind: ' ' }, select: { id: true } }))).rejects.toThrow(/keeps the tablet's id for it/)
    await expect(as(floor(), (client) => client.floorSyncEvent.create({ data: { ...event(`evt-${randomUUID()}`), deviceSeq: -1 }, select: { id: true } }))).rejects.toThrow(/from 0/)
    const id = `evt-${randomUUID()}`
    await as(floor(), (client) => client.floorSyncEvent.create({ data: event(id), select: { id: true } }))
    await expect(as(floor(), (client) => client.floorSyncEvent.create({ data: event(id), select: { id: true } }))).rejects.toThrow(/Unique constraint|unique/i)
  })

  it('the office reads the ledger and never writes it', async () => {
    expect(await as(office(), (client) => client.floorSyncEvent.count())).toBeGreaterThan(0)
    await expect(as(office(), (client) => client.floorSyncEvent.create({ data: event(`evt-${randomUUID()}`), select: { id: true } }))).rejects.toThrow(/permission denied|row-level security/)
  })
})

describe('a refused action', () => {
  it('is kept open, with its words and fix, and names a module refusal by type and id or not at all', async () => {
    await expect(as(floor(), (client) => client.floorRefusedAction.create({ data: refused(`evt-${randomUUID()}`, { status: 'DISCARDED', discardedAt: new Date(), discardedBy: 'FLOOR', discardReason: 'x' }), select: { id: true } }))).rejects.toThrow(/kept open/)
    await expect(as(floor(), (client) => client.floorRefusedAction.create({ data: refused(`evt-${randomUUID()}`, { fix: ' ' }), select: { id: true } }))).rejects.toThrow(/its words and its fix/)
    await expect(as(floor(), (client) => client.floorRefusedAction.create({ data: refused(`evt-${randomUUID()}`, { moduleRefusalType: 'FloorScanRefusal' }), select: { id: true } }))).rejects.toThrow(/by type and id/)
    await expect(as(floor(), (client) => client.floorRefusedAction.create({ data: refused(`evt-${randomUUID()}`, { moduleRefusalType: 'FloorScanRefusal', moduleRefusalId: randomUUID() }), select: { id: true } }))).resolves.toBeDefined()
  })

  it('keeps what the tablet sent', async () => {
    const row = await newRefused()
    await expect(run(floor(), 'UPDATE "FloorRefusedAction" SET "message" = $2 WHERE "id" = $1::uuid', row.id, 'Something else.')).rejects.toThrow(/keeps what the tablet sent/)
    await expect(run(floor(), `UPDATE "FloorRefusedAction" SET "payload" = '{}'::jsonb WHERE "id" = $1::uuid`, row.id)).rejects.toThrow(/keeps what the tablet sent/)
    await expect(run(floor(), `UPDATE "FloorRefusedAction" SET "discardReason" = 'x' WHERE "id" = $1::uuid`, row.id)).rejects.toThrow(/only when it is resolved or discarded/)
  })

  it('is resolved only by the ledger row of the same tablet and client event id', async () => {
    const row = await newRefused()
    const other = event(`evt-${randomUUID()}`)
    const same = event(row.clientEventId)
    await as(floor(), (client) => client.floorSyncEvent.createMany({ data: [other, same] }))
    const resolve = (eventId: string) => run(floor(), `UPDATE "FloorRefusedAction" SET "status" = 'RESOLVED', "resolvedByEventId" = $2::uuid, "resolvedAt" = now(), "version" = "version" + 1 WHERE "id" = $1::uuid`, row.id, eventId)
    await expect(resolve(other.id)).rejects.toThrow(/sent again under the same id/)
    await expect(run(floor(), `UPDATE "FloorRefusedAction" SET "status" = 'RESOLVED', "resolvedByEventId" = $2::uuid WHERE "id" = $1::uuid`, row.id, same.id)).rejects.toThrow(/with the time/)
    await expect(resolve(same.id)).resolves.toBe(1)
    // Closed once.
    await expect(run(floor(), `UPDATE "FloorRefusedAction" SET "status" = 'DISCARDED', "discardedAt" = now(), "discardedBy" = 'FLOOR', "discardReason" = 'late', "resolvedByEventId" = NULL, "resolvedAt" = NULL WHERE "id" = $1::uuid`, row.id)).rejects.toThrow(/closes once/)
  })

  it('is discarded with when, from where and why; by the tablet or the office; never deleted', async () => {
    const row = await newRefused()
    const discard = (scope: FactoryScope, reason: string | null, by = 'FLOOR') => run(scope, `UPDATE "FloorRefusedAction" SET "status" = 'DISCARDED', "discardedAt" = now(), "discardedBy" = $3::"FloorDiscardAudience", "discardReason" = $2 WHERE "id" = $1::uuid`, row.id, reason, by)
    await expect(discard(floor(), null)).rejects.toThrow(/when, from where and why/)
    await expect(discard(floor(), '  ')).rejects.toThrow(/when, from where and why/)
    await expect(discard(office(), 'Done again by hand at the table.', 'OFFICE')).resolves.toBe(1)
    await expect(discard(floor(), 'again')).rejects.toThrow(/closes once/)
    await expect(run(floor(), 'DELETE FROM "FloorRefusedAction" WHERE "id" = $1::uuid', row.id)).rejects.toThrow(/permission denied/)
    await expect(admin('DELETE FROM "FloorRefusedAction" WHERE "id" = $1', [row.id])).rejects.toThrow(/never deleted/)
  })

  it('the office reads and closes them, and never makes one', async () => {
    await expect(as(office(), (client) => client.floorRefusedAction.create({ data: refused(`evt-${randomUUID()}`), select: { id: true } }))).rejects.toThrow(/permission denied|row-level security/)
    expect(await as(office(), (client) => client.floorRefusedAction.count({ where: { status: 'OPEN' } }))).toBeGreaterThan(0)
  })
})
