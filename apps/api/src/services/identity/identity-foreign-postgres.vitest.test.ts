/**
 * MCP full control I5 — nexus_identity_foreign_ids (packages/database/workspaces/identity-foreign.sql), on a REAL
 * PostgreSQL: the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs, the production schema and policies,
 * the app connected as the restricted runtime login (NOBYPASSRLS). The function is SECURITY DEFINER and reads every
 * business's listings, so this suite is about what it must NOT say.
 *
 * Three businesses. ALPHA asks. BRAVO and CHARLIE hold some of the same ids. Person M belongs to ALPHA and BRAVO;
 * person N to ALPHA only.
 *
 *   1. ALPHA learns which of ITS OWN ids another business holds — and nothing about an id it does not hold (no probe),
 *      an id only a deleted product elsewhere carries, or an ASIN (a catalogue id, legal in several businesses).
 *   2. The other business is named only to a member of it (M sees "Bravo"); N, and a system caller, read
 *      "another business" and no id of it; CHARLIE, where M is no member, stays unnamed even to M.
 *   3. Shopify ids match in either stored form (gid:// or short).
 *   4. Only the runtime role may execute it; PUBLIC may not; it needs a business; at most 1000 ids.
 *   5. Control: row-level security still hides BRAVO's listing from ALPHA's own queries.
 *   6. Check #2 of the identity audit reads it in the business it runs in.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))

import { identityCheck } from './identity-checks.js'
import { runCheck } from './identity-audit.service.js'

const RUN = randomBytes(5).toString('hex')
const ALPHA = `idf_alpha_${RUN}`
const BRAVO = `idf_bravo_${RUN}`
const CHARLIE = `idf_charlie_${RUN}`
const NAMES: Record<string, string> = { [ALPHA]: 'Alpha business', [BRAVO]: 'Bravo business', [CHARLIE]: 'Charlie business' }
const people = { m: '', n: '' }

/** Ids, by who holds them. */
const ID = {
  sharedWithBravo: `5${RUN.replace(/\D/g, '1').padEnd(10, '1').slice(0, 10)}1`,
  sharedWithCharlie: `5${RUN.replace(/\D/g, '2').padEnd(10, '2').slice(0, 10)}2`,
  alphaOnly: `5${RUN.replace(/\D/g, '3').padEnd(10, '3').slice(0, 10)}3`,
  bravoOnly: `5${RUN.replace(/\D/g, '4').padEnd(10, '4').slice(0, 10)}4`,
  deletedInBravo: `5${RUN.replace(/\D/g, '5').padEnd(10, '5').slice(0, 10)}5`,
  shopify: `77${RUN.replace(/\D/g, '6').padEnd(8, '6').slice(0, 8)}`,
  asin: `B0${RUN.toUpperCase().slice(0, 8)}`,
}

const as = <T>(workspaceId: string, actorUserId: string | null, work: () => Promise<T>) =>
  withWorkspace({ workspaceId, actorUserId, membershipId: null, roleKeys: [] }, work)

type Row = { external_id: string; holder: string; holder_workspace_id: string | null; listing_count: number }
const foreign = (workspaceId: string, actor: string | null, channel: string, ids: string[] | null) =>
  as(workspaceId, actor, () => database.client.$queryRaw<Row[]>`SELECT * FROM nexus_identity_foreign_ids(${channel}, ${ids}::text[])`)

async function listing(workspaceId: string, sku: string, channel: string, external: string, deleted = false) {
  await as(workspaceId, null, async () => {
    const product = await database.client.product.create({ data: { sku, name: sku, basePrice: '9.00', ...(deleted ? { deletedAt: new Date() } : {}) } })
    await database.client.channelListing.create({
      data: { productId: product.id, channel, marketplace: channel === 'EBAY' ? 'IT' : 'GLOBAL', region: 'IT', channelMarket: `${channel}_IT`, listingStatus: 'ACTIVE', externalListingId: external },
    })
  })
}

describe.skipIf(!concurrentDatabaseUrl())('I5 — nexus_identity_foreign_ids: own ids another business holds, named only to its members (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    database = await concurrentDatabase()
    const db = database.client
    const person = (name: string) => db.userProfile.create({ data: { email: `idf-${name}-${RUN}@example.test`, status: 'active', displayName: `IDF ${name}` } })
    people.m = (await person('m')).id
    people.n = (await person('n')).id
    for (const id of [ALPHA, BRAVO, CHARLIE]) await db.workspace.create({ data: { id, name: NAMES[id], createdByUserId: people.m, creationKey: randomUUID() } })
    for (const [workspaceId, userId] of [[ALPHA, people.m], [ALPHA, people.n], [BRAVO, people.m]] as const) {
      await db.workspaceMembership.create({ data: { workspaceId, userId, status: 'active' } })
    }
    await listing(ALPHA, 'A-1', 'EBAY', ID.sharedWithBravo)
    await listing(ALPHA, 'A-2', 'EBAY', ID.sharedWithCharlie)
    await listing(ALPHA, 'A-3', 'EBAY', ID.alphaOnly)
    await listing(ALPHA, 'A-4', 'EBAY', ID.deletedInBravo)
    await listing(ALPHA, 'A-5', 'SHOPIFY', `gid://shopify/Product/${ID.shopify}`)
    await listing(ALPHA, 'A-6', 'AMAZON', ID.asin)
    await listing(BRAVO, 'B-1', 'EBAY', ID.sharedWithBravo)
    await listing(BRAVO, 'B-1B', 'EBAY', ID.sharedWithBravo)
    await listing(BRAVO, 'B-2', 'EBAY', ID.bravoOnly)
    await listing(BRAVO, 'B-3', 'EBAY', ID.deletedInBravo, true)
    await listing(BRAVO, 'B-4', 'SHOPIFY', ID.shopify)
    await listing(BRAVO, 'B-5', 'AMAZON', ID.asin)
    await listing(CHARLIE, 'C-1', 'EBAY', ID.sharedWithCharlie)
  }, 240_000)

  afterAll(async () => {
    await database?.close()
    vi.unstubAllEnvs()
  }, 120_000)

  it('names Bravo to M, a member of it; Charlie, where M is no member, stays "another business"', async () => {
    expect(await foreign(ALPHA, people.m, 'EBAY', null)).toEqual([
      { external_id: ID.sharedWithBravo, holder: 'Bravo business', holder_workspace_id: BRAVO, listing_count: 2 },
      { external_id: ID.sharedWithCharlie, holder: 'another business', holder_workspace_id: null, listing_count: 1 },
    ].sort((x, y) => x.external_id.localeCompare(y.external_id)))
  })

  it('N (a member of Alpha only) and a system caller read "another business", never a name or an id of it', async () => {
    for (const actor of [people.n, null]) {
      const rows = await foreign(ALPHA, actor, 'EBAY', null)
      expect(rows.map((r) => [r.external_id, r.holder, r.holder_workspace_id]).sort()).toEqual([
        [ID.sharedWithBravo, 'another business', null], [ID.sharedWithCharlie, 'another business', null],
      ].sort())
      expect(JSON.stringify(rows)).not.toMatch(/Bravo|Charlie|idf_bravo|idf_charlie/)
    }
  })

  it('never answers an id the caller does not hold — asking for Bravo\'s ids finds nothing (no probing)', async () => {
    expect(await foreign(ALPHA, people.m, 'EBAY', [ID.bravoOnly])).toEqual([])
    expect(await foreign(ALPHA, people.m, 'EBAY', [ID.bravoOnly, ID.sharedWithBravo]))
      .toEqual([{ external_id: ID.sharedWithBravo, holder: 'Bravo business', holder_workspace_id: BRAVO, listing_count: 2 }])
    // Alpha's own id that only a DELETED product elsewhere carries is not held elsewhere.
    expect(await foreign(ALPHA, people.m, 'EBAY', [ID.alphaOnly, ID.deletedInBravo])).toEqual([])
  })

  it('a Shopify product matches in either stored form; the answer is in the short form', async () => {
    expect(await foreign(ALPHA, people.m, 'SHOPIFY', null)).toEqual([{ external_id: ID.shopify, holder: 'Bravo business', holder_workspace_id: BRAVO, listing_count: 1 }])
    expect(await foreign(ALPHA, people.m, 'SHOPIFY', [`gid://shopify/Product/${ID.shopify}`])).toHaveLength(1)
  })

  it('refuses an ASIN (a catalogue id), a call with no business, and more than 1000 ids', async () => {
    await expect(foreign(ALPHA, people.m, 'AMAZON', null)).rejects.toThrow(/seller-owned ids only/)
    await expect(database.pool.query(`SELECT * FROM nexus_identity_foreign_ids('EBAY', NULL)`)).rejects.toThrow(/needs a business/)
    await expect(foreign(ALPHA, people.m, 'EBAY', Array.from({ length: 1001 }, (_, i) => String(i)))).rejects.toThrow(/at most 1000/)
  })

  it('only the runtime role may execute it; PUBLIC may not; it runs as its owner with a pinned search_path', async () => {
    const [grant] = (await database.pool.query(`SELECT
      has_function_privilege('nexus_workspace_runtime', 'nexus_identity_foreign_ids(text, text[])', 'EXECUTE') AS runtime,
      EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = 'nexus_identity_foreign_ids' AND a.grantee = 0) AS public,
      (SELECT prosecdef FROM pg_proc WHERE proname = 'nexus_identity_foreign_ids') AS definer,
      (SELECT proconfig FROM pg_proc WHERE proname = 'nexus_identity_foreign_ids') AS config`)).rows
    expect(grant).toMatchObject({ runtime: true, public: false, definer: true })
    expect(String(grant.config)).toMatch(/search_path=public, ?pg_temp/)
    const probe = `idf_probe_${RUN}`
    await database.pool.query(`CREATE ROLE ${probe} NOLOGIN`)
    try {
      const [row] = (await database.pool.query(`SELECT has_function_privilege('${probe}', 'nexus_identity_foreign_ids(text, text[])', 'EXECUTE') AS ok`)).rows
      expect(row.ok).toBe(false)
    } finally {
      await database.pool.query(`DROP ROLE ${probe}`)
    }
  })

  it('control: row-level security still hides Bravo\'s listings from Alpha\'s own queries', async () => {
    const seen = await as(ALPHA, people.m, () => database.client.channelListing.count({ where: { externalListingId: ID.sharedWithBravo } }))
    expect(seen).toBe(1)
    const inBravo = await as(BRAVO, people.m, () => database.client.channelListing.count({ where: { externalListingId: ID.sharedWithBravo } }))
    expect(inBravo).toBe(2)
  })

  it('check #2 of the identity audit reads it, in the business it runs in', async () => {
    const run = (workspaceId: string, actor: string | null) =>
      as(workspaceId, actor, async () => (await runCheck(identityCheck('channel-id-in-another-business')!, { limit: 50, withTotal: true })))
    const alpha = await run(ALPHA, people.m)
    expect(alpha.total).toBe(3)
    expect(alpha.findings.map((f) => [f.channel, f.details?.externalId, f.sku, f.details?.heldBy]).sort()).toEqual([
      ['EBAY', ID.sharedWithBravo, 'A-1', ['Bravo business']],
      ['EBAY', ID.sharedWithCharlie, 'A-2', ['another business']],
      ['SHOPIFY', ID.shopify, 'A-5', ['Bravo business']],
    ].sort())
    // Bravo, asked by M (no member of Charlie, a member of Alpha): Alpha is named, and Bravo's own skus are shown.
    const bravo = await run(BRAVO, people.m)
    expect(bravo.findings.map((f) => [f.details?.externalId, f.sku, f.details?.heldBy]).sort()).toEqual([
      [ID.sharedWithBravo, 'B-1', ['Alpha business']],
      [ID.shopify, 'B-4', ['Alpha business']],
    ].sort())
    // Charlie, asked by a system caller: unnamed.
    const charlie = await run(CHARLIE, null)
    expect(charlie.findings.map((f) => [f.details?.externalId, f.details?.heldBy])).toEqual([[ID.sharedWithCharlie, ['another business']]])
  })
})
