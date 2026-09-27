import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Step 7, part 1 — concurrent writers on one coordinate leave ONE row, and a listing the channel has ends up live.
 *
 * On `concurrent-database.ts`, never PGlite: PGlite is one connection, so it serialises the calls and the test would
 * pass whether or not the insert is safe. The race is FORCED, not hoped for: a third connection holds a SHARE lock on
 * "ChannelListing", so both callers read "no listing here" and then block on their INSERT; the test waits until
 * PostgreSQL reports both of them waiting before it releases the lock. The application client is the restricted
 * runtime login (row security enforced). Every id is invented.
 *
 * Run: node scripts/run-real-postgres-tests.mjs --suites '[{"name":"live listings","file":"src/services/pim/live-listing-postgres.vitest.test.ts","expect":2}]'
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`live-listing-postgres: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { recordLiveListings } from './live-listing.service.js'
import { ensureDraftListings } from './draft-listing.service.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl, raceChannelListingInserts } from '../../test-support/concurrent-database.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}

describe.skipIf(!concurrentDatabaseUrl())(`recordLiveListings — concurrent writers leave one row (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => {
    state.db = await concurrentDatabase()
    await scoped(async () => {
      await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'SE', name: 'Sweden', currency: 'SEK', region: 'EU', language: 'sv', languages: ['sv'] } })
      ids.account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'race', isActive: true, isPrimary: true,
        externalAccountId: 'SELLER-RACE', authStatus: 'connected', managedBy: 'oauth' } as never })).id
      for (const key of ['twoLive', 'draftAndLive']) ids[key] = (await prisma.product.create({ data: { sku: `LIVE-RACE-${key}`, name: key, basePrice: 10 } })).id
    })
  }, 120_000)
  afterAll(async () => { await state.db?.close() }, 60_000)

  /** Both callers must have READ the coordinate and be BLOCKED on their insert before the lock is released. */
  async function race<T>(calls: Array<() => Promise<T>>): Promise<T[]> {
    const settled = await raceChannelListingInserts(state.db, calls.map(call => () => scoped(call)))
    for (const outcome of settled) if ('error' in outcome) throw outcome.error
    return settled.map(outcome => (outcome as { value: T }).value)
  }

  const rowsOf = (productId: string) => scoped(() => prisma.channelListing.findMany({ where: { productId } }))
  const live = (productId: string) => () => prisma.$transaction(tx => recordLiveListings(tx, { channel: 'AMAZON', market: 'SE', accountId: ids.account,
    rows: [{ productId, listingStatus: 'ACTIVE', externalListingId: 'ASIN-RACE' }] }))

  it('two recorders: one row, created by exactly one of them, and both answer with it', async () => {
    const results = await race([live(ids.twoLive), live(ids.twoLive)])
    const rows = await rowsOf(ids.twoLive)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ channelConnectionId: ids.account, listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, externalListingId: 'ASIN-RACE' })
    expect(results.map(([r]) => r.id)).toEqual([rows[0].id, rows[0].id])
    expect(results.map(([r]) => r.created).sort()).toEqual([false, true])
  }, 90_000)

  it('a draft creator and a recorder: one row, and it ends up live and unpaused whichever inserted first', async () => {
    const draft = () => prisma.$transaction(tx => ensureDraftListings(tx, { channel: 'AMAZON', market: 'SE', accountId: ids.account, productIds: [ids.draftAndLive] }))
    await race<unknown>([draft, live(ids.draftAndLive)])
    const rows = await rowsOf(ids.draftAndLive)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, externalListingId: 'ASIN-RACE' })
  }, 90_000)
})
