/**
 * MCP full control I12 — the channel item claim under a real race, on a REAL PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, production schema and policies, the restricted runtime login). PGlite has one
 * connection and cannot race.
 *
 * Two businesses write a listing carrying the same eBay Item ID at the same moment, again and again:
 *   report mode  — both writes succeed and exactly one claim exists, held by one of them;
 *   enforce mode — exactly one write succeeds and holds the claim; the other is refused.
 * Enforce is switched only inside this throwaway database (production stays in report mode until the Owner says).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))

const RUN = randomBytes(5).toString('hex')
const ALPHA = `icl_alpha_${RUN}`
const BRAVO = `icl_bravo_${RUN}`
const products: Record<string, string> = {}
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ROUNDS = 12

const write = (workspaceId: string, itemId: string, market: string) => inside(workspaceId, () => database.client.channelListing.create({
  data: { productId: products[workspaceId], channel: 'EBAY', marketplace: market, region: market, channelMarket: `EBAY_${market}`, listingStatus: 'ACTIVE', externalListingId: itemId },
}))
const claimsOf = async (itemId: string) =>
  (await database.pool.query(`SELECT "workspaceId" FROM "ChannelItemClaim" WHERE channel = 'EBAY' AND "externalId" = $1`, [itemId])).rows as Array<{ workspaceId: string }>

describe.skipIf(!concurrentDatabaseUrl())('I12 — one channel item, two businesses, the same moment (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    database = await concurrentDatabase()
    const owner = await database.client.userProfile.create({ data: { email: `icl-${RUN}@example.test`, status: 'active' } })
    for (const id of [ALPHA, BRAVO]) {
      await database.client.workspace.create({ data: { id, name: id, createdByUserId: owner.id, creationKey: randomUUID() } })
      products[id] = (await inside(id, () => database.client.product.create({ data: { sku: `ICL-${RUN}`, name: 'Race jacket', basePrice: '10.00' } }))).id
    }
  }, 240_000)

  afterAll(async () => {
    await database?.close()
    vi.unstubAllEnvs()
  }, 120_000)

  it('report mode: both writes succeed, and each item has exactly one claim', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const itemId = `71${RUN.replace(/\D/g, '1').slice(0, 6).padEnd(6, '1')}${String(round).padStart(4, '0')}`
      const results = await Promise.allSettled([write(ALPHA, itemId, `R${round}`), write(BRAVO, itemId, `R${round}`)])
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
      const held = await claimsOf(itemId)
      expect(held).toHaveLength(1)
      expect([ALPHA, BRAVO]).toContain(held[0].workspaceId)
    }
  })

  it('enforce mode: exactly one of the two writes succeeds, and it holds the claim', async () => {
    await database.pool.query(`CREATE OR REPLACE FUNCTION nexus_item_claim_mode() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'enforce'::text $$`)
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const itemId = `72${RUN.replace(/\D/g, '2').slice(0, 6).padEnd(6, '2')}${String(round).padStart(4, '0')}`
        const results = await Promise.allSettled([write(ALPHA, itemId, `E${round}`), write(BRAVO, itemId, `E${round}`)])
        const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [[ALPHA, BRAVO][i]] : []))
        expect(won).toHaveLength(1)
        const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
        expect(String(lost.reason?.message ?? lost.reason)).toMatch(/already held by another listing/)
        expect(await claimsOf(itemId)).toEqual([{ workspaceId: won[0] }])
      }
    } finally {
      await database.pool.query(`CREATE OR REPLACE FUNCTION nexus_item_claim_mode() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'report'::text $$`)
    }
  })
})
