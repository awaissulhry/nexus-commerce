/**
 * P4.4 (CX) — the eBay price read-back's dedupe, in real PostgreSQL.
 *
 * The dedupe is a Prisma JSON-path match on `SyncHealthLog.conflictData.remote.dedupeKey`
 * (source | marketplace | offer or item/SKU | outcome class). A mock can only echo the `where` it was
 * given; whether PostgreSQL finds the row — and only within one business, under the production
 * policies — is what this suite measures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))
vi.mock('./sync-health.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./sync-health.service.js')>()
  return { ...real, syncHealthService: { logConflict: (input: any) => new real.SyncHealthService(database.client).logConflict(input) } }
})
const { recordEbayPriceUnconfirmed } = await import('./ebay-price-readback.service.js')

const OWNER = 'nexus_legacy_workspace'
const OTHER = randomUUID()
const inProfile = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const record = (ref: string, outcome = 'PRICE_MISMATCH', marketplace = 'EBAY_IT', source: 'INVENTORY_GET_OFFER' | 'TRADING_GETITEM' = 'INVENTORY_GET_OFFER') =>
  recordEbayPriceUnconfirmed({ productId: null, source, marketplace, ref, outcome, sku: 'SKU-PG', message: `Price unconfirmed (${ref})`, localData: { sentPrice: 19.9 }, remoteData: { offerId: ref } })
const rows = async (ref: string) =>
  (await database.pool.query(`SELECT "workspaceId", "resolutionStatus", "conflictData"->'remote'->>'dedupeKey' AS key FROM "SyncHealthLog" WHERE "conflictData"->'remote'->>'offerId' = $1 ORDER BY "createdAt"`, [ref])).rows

describe.skipIf(!concurrentDatabaseUrl())('eBay price read-back dedupe in real PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    database = await concurrentDatabase({ maxConnections: 4 })
    await database.pool.query('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Other price owner\',\'test\',$1,now())', [OTHER])
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the same key within 24 h is found by the JSON-path match: logged once, then deduped', async () => {
    const ref = `offer:${randomUUID()}`
    expect(await inProfile(OWNER, () => record(ref))).toBe('logged')
    expect(await inProfile(OWNER, () => record(ref))).toBe('deduped')
    expect(await rows(ref)).toEqual([{ workspaceId: OWNER, resolutionStatus: 'UNRESOLVED', key: `INVENTORY_GET_OFFER|EBAY_IT|${ref}|PRICE` }])
  })

  it('another outcome class, marketplace or source on the same offer is its own slot; product-less rows do not share one', async () => {
    const ref = `offer:${randomUUID()}`
    expect(await inProfile(OWNER, () => record(ref, 'READ_FAILED'))).toBe('logged')
    expect(await inProfile(OWNER, () => record(ref, 'STALE_READ'))).toBe('deduped') // same class: UNCONFIRMED
    expect(await inProfile(OWNER, () => record(ref, 'PRICE_MISMATCH'))).toBe('logged') // not hidden by "unconfirmed"
    expect(await inProfile(OWNER, () => record(ref, 'CURRENCY_MISMATCH'))).toBe('logged')
    expect(await inProfile(OWNER, () => record(ref, 'PRICE_MISMATCH', 'EBAY_DE'))).toBe('logged')
    expect(await inProfile(OWNER, () => record(ref, 'PRICE_MISMATCH', 'EBAY_IT', 'TRADING_GETITEM'))).toBe('logged')
    expect(await inProfile(OWNER, () => record(`offer:${randomUUID()}`))).toBe('logged')
    expect((await rows(ref)).map((r) => r.key).sort()).toEqual([
      `INVENTORY_GET_OFFER|EBAY_IT|${ref}|UNCONFIRMED`,
      `INVENTORY_GET_OFFER|EBAY_IT|${ref}|PRICE`,
      `INVENTORY_GET_OFFER|EBAY_IT|${ref}|CURRENCY`,
      `INVENTORY_GET_OFFER|EBAY_DE|${ref}|PRICE`,
      `TRADING_GETITEM|EBAY_IT|${ref}|PRICE`,
    ].sort())
  })

  it('a RESOLVED row, or one older than 24 h, does not suppress a new record', async () => {
    const resolved = `offer:${randomUUID()}`
    expect(await inProfile(OWNER, () => record(resolved))).toBe('logged')
    await database.pool.query(`UPDATE "SyncHealthLog" SET "resolutionStatus"='MANUAL_RESOLVED' WHERE "conflictData"->'remote'->>'offerId' = $1`, [resolved])
    expect(await inProfile(OWNER, () => record(resolved))).toBe('logged')
    const old = `offer:${randomUUID()}`
    expect(await inProfile(OWNER, () => record(old))).toBe('logged')
    await database.pool.query(`UPDATE "SyncHealthLog" SET "createdAt" = now() - interval '25 hours' WHERE "conflictData"->'remote'->>'offerId' = $1`, [old])
    expect(await inProfile(OWNER, () => record(old))).toBe('logged')
    expect(await rows(resolved)).toHaveLength(2)
    expect(await rows(old)).toHaveLength(2)
  })

  it('another business\'s identical key does not dedupe this business\'s record', async () => {
    const ref = `offer:${randomUUID()}`
    expect(await inProfile(OTHER, () => record(ref))).toBe('logged')
    expect(await inProfile(OWNER, () => record(ref))).toBe('logged')
    expect((await rows(ref)).map((r) => r.workspaceId).sort()).toEqual([OTHER, OWNER].sort())
  })
})
