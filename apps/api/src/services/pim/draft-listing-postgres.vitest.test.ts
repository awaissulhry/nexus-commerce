import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Product-sheet create path, step 2 — two concurrent `ensureDraftListings` calls on one coordinate create ONE set.
 *
 * On `concurrent-database.ts`, never PGlite: PGlite is one connection, so it serialises the two calls and the test
 * would pass whether or not the insert is safe. The race is FORCED, not hoped for: a third connection holds a SHARE
 * lock on "ChannelListing", so both callers read "no listing here" and then block on their INSERT; the test waits
 * until PostgreSQL reports both of them waiting before it releases the lock. The application client is the
 * restricted runtime login (row security enforced), so the drafts are also written the way production writes them.
 * Every id is invented.
 *
 * Run: node scripts/run-real-postgres-tests.mjs (it starts a throwaway PostgreSQL 17 and sets NEXUS_TEST_CONCURRENT_PG_URL).
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`draft-listing-postgres: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { activeDatabaseTransaction, inDatabaseTransaction } from '../../lib/database-context.js'
import { ensureDraftListings, type EnsuredDraftListing } from './draft-listing.service.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl, raceChannelListingInserts } from '../../test-support/concurrent-database.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}

describe.skipIf(!concurrentDatabaseUrl())(`ensureDraftListings — concurrent calls create one set (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => {
    state.db = await concurrentDatabase()
    await scoped(async () => {
      await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'SE', name: 'Sweden', currency: 'SEK', region: 'EU', language: 'sv', languages: ['sv'] } })
      ids.account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'race', isActive: true, isPrimary: true,
        externalAccountId: 'SELLER-RACE', authStatus: 'connected', managedBy: 'oauth' } as never })).id
      for (const family of ['committed', 'serial']) {
        ids[family] = (await prisma.product.create({ data: { sku: `RACE-${family}`, name: family, basePrice: 10, isParent: true } })).id
        for (const size of ['S', 'M', 'L']) {
          ids[`${family}${size}`] = (await prisma.product.create({ data: { sku: `RACE-${family}-${size}`, name: `${family} ${size}`, basePrice: 10, parentId: ids[family] } })).id
        }
      }
    })
  }, 120_000)
  afterAll(async () => { await state.db?.close() }, 60_000)

  /** Both callers must have READ the coordinate and be BLOCKED on their insert before the lock is released. */
  async function race<T>(calls: Array<() => Promise<T>>): Promise<T[]> {
    const settled = await raceChannelListingInserts(state.db, calls.map(call => () => scoped(call)))
    for (const outcome of settled) if ('error' in outcome) throw outcome.error
    return settled.map(outcome => (outcome as { value: T }).value)
  }

  const familyRows = (family: string) => scoped(() => prisma.channelListing.findMany({
    where: { productId: { in: [ids[family], ids[`${family}S`], ids[`${family}M`], ids[`${family}L`]] } }, orderBy: { productId: 'asc' } }))

  function expectOneSet(results: EnsuredDraftListing[][], rows: Array<{ id: string; productId: string; syncPaused: boolean; channelConnectionId: string | null }>) {
    expect(rows).toHaveLength(4)
    expect(rows.every(row => row.syncPaused && row.channelConnectionId === ids.account)).toBe(true)
    // Both callers answer with the same four rows…
    for (const result of results) expect(result.map(r => r.id).sort()).toEqual(rows.map(r => r.id).sort())
    // …and each row was created by exactly one of them.
    for (const row of rows) expect(results.map(result => result.find(r => r.id === row.id)!.created).filter(Boolean)).toHaveLength(1)
  }

  it('READ COMMITTED: the later caller waits, inserts nothing and returns the rows the first one created', async () => {
    const call = (productId: string) => () => prisma.$transaction(tx => ensureDraftListings(tx, { channel: 'AMAZON', market: 'SE', productIds: [productId], family: true }))
    const results = await race([call(ids.committed), call(ids.committedM)])
    expectOneSet(results, await familyRows('committed'))
    // One caller created the whole family; the other created nothing.
    expect(results.map(result => result.filter(r => r.created).length).sort()).toEqual([0, 4])
  }, 90_000)

  it('SERIALIZABLE: the later caller loses with a serialization failure, and the retry returns the same set', async () => {
    let attempts = 0
    const call = (productId: string) => () => inDatabaseTransaction(prisma, async () => {
      attempts += 1
      return ensureDraftListings(activeDatabaseTransaction()!, { channel: 'AMAZON', market: 'SE', productIds: [productId], family: true })
    }, { isolationLevel: 'Serializable' })
    const results = await race([call(ids.serial), call(ids.serialL)])
    expectOneSet(results, await familyRows('serial'))
    // The loser really lost and ran again (the arm that proves the retry, not a lucky ordering).
    expect(attempts).toBe(3)
  }, 90_000)
})
