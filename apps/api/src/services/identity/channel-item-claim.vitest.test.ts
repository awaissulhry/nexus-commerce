/**
 * MCP full control I12 — ChannelItemClaim and its trigger on ChannelListing (packages/database/workspaces/
 * channel-item-claim.sql), on PGlite with the production schema and policies: every write goes through the ordinary
 * client as the runtime role, as the listing writers do.
 *
 * REPORT mode: a seller-owned id is claimed for the first family and listing that carries it; the family's variations
 * share it; another family or another business carrying it is NOT refused and changes no claim (the audit reports it);
 * the claim is released when the last row of its listing lets the id go; an ASIN is never claimed; Shopify ids match in
 * either form; the runtime role reads its own business's claims only and writes none. ENFORCE mode (switched here only,
 * by replacing nexus_item_claim_mode()) refuses the conflicting write and lets the family's own through.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) }))

const A = LEGACY_WORKSPACE_ID
const B = 'ws_item_claim_bravo'
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const ITEM = '610000000001'

const claims = async () => (await database.db.query<{ channel: string; marketplace: string; externalId: string; workspaceId: string; rootProductId: string; aliasKey: string }>(
  `SELECT channel, marketplace, "externalId", "workspaceId", "rootProductId", "aliasKey" FROM "ChannelItemClaim" ORDER BY channel, marketplace, "externalId"`)).rows
const product = (workspaceId: string, sku: string, extra: Record<string, unknown> = {}) => inside(workspaceId, async () => {
  ids[sku] = (await database.client.product.create({ data: { sku, name: sku, basePrice: '10.00', ...extra } })).id
})
const listing = (workspaceId: string, key: string, sku: string, channel: string, external: string | null, extra: Record<string, unknown> = {}) => inside(workspaceId, async () => {
  ids[key] = (await database.client.channelListing.create({
    data: { productId: ids[sku], channel, marketplace: 'IT', region: 'IT', channelMarket: `${channel}_IT`, listingStatus: 'ACTIVE', externalListingId: external, ...extra },
  })).id
})
const setId = (workspaceId: string, key: string, external: string | null) =>
  inside(workspaceId, () => database.client.channelListing.update({ where: { id: ids[key] }, data: { externalListingId: external } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, 'Bravo', 'active', 'identity', $1, CURRENT_TIMESTAMP)`, [B])
  await product(A, 'CL-ROOT', { isParent: true })
  await product(A, 'CL-S', { parentId: ids['CL-ROOT'] })
  await product(A, 'CL-OTHER')
  await product(A, 'CL-AMZ')
  await product(A, 'CL-SHOP1')
  await product(B, 'CL-BRAVO')
}, 120_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('I12 — report mode', () => {
  it('the first family to carry an id claims it; its variations share the claim', async () => {
    await listing(A, 'root', 'CL-ROOT', 'EBAY', ITEM)
    await listing(A, 'child', 'CL-S', 'EBAY', ITEM)
    expect(await claims()).toEqual([{ channel: 'EBAY', marketplace: 'IT', externalId: ITEM, workspaceId: A, rootProductId: ids['CL-ROOT'], aliasKey: '' }])
  })

  it('another family, and another business, carrying it are not refused and change no claim', async () => {
    await listing(A, 'other', 'CL-OTHER', 'EBAY', ITEM)
    await listing(B, 'bravo', 'CL-BRAVO', 'EBAY', ITEM)
    expect(await claims()).toEqual([expect.objectContaining({ workspaceId: A, rootProductId: ids['CL-ROOT'] })])
  })

  it('the runtime role reads its own business’s claims only, and writes none', async () => {
    expect(await inside(A, () => database.client.channelItemClaim.count())).toBe(1)
    expect(await inside(B, () => database.client.channelItemClaim.count())).toBe(0)
    await expect(inside(A, () => database.client.channelItemClaim.deleteMany({}))).rejects.toThrow()
    await expect(inside(B, () => database.client.channelItemClaim.create({ data: { channel: 'EBAY', marketplace: 'IT', externalId: '610000000099', workspaceId: B, rootProductId: ids['CL-BRAVO'] } }))).rejects.toThrow()
    expect(await claims()).toHaveLength(1)
  })

  it('a claim is released only when the last row of its listing lets the id go', async () => {
    await setId(A, 'root', null)
    expect(await claims()).toHaveLength(1)
    await setId(A, 'child', null)
    expect(await claims()).toEqual([])
    // The next write of the id by a family claims it again.
    await setId(A, 'other', null)
    await setId(A, 'other', ITEM)
    expect(await claims()).toEqual([expect.objectContaining({ workspaceId: A, rootProductId: ids['CL-OTHER'] })])
  })

  it('an ASIN is never claimed; a Shopify id is the same in either form', async () => {
    await listing(A, 'amz', 'CL-AMZ', 'AMAZON', 'B0CLAIM001')
    await listing(A, 'shop1', 'CL-SHOP1', 'SHOPIFY', 'gid://shopify/Product/9001')
    const rows = await claims()
    expect(rows.find((c) => c.channel === 'AMAZON')).toBeUndefined()
    expect(rows.find((c) => c.channel === 'SHOPIFY')).toMatchObject({ externalId: '9001', rootProductId: ids['CL-SHOP1'] })
  })
})

describe('I12 — enforce mode (switched by replacing nexus_item_claim_mode, here only)', () => {
  it('refuses a write that meets another owner’s claim, lets the holder’s family through, and reports it as a unique violation', async () => {
    await database.db.query(`CREATE OR REPLACE FUNCTION nexus_item_claim_mode() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'enforce'::text $$`)
    try {
      await expect(listing(B, 'bravo2', 'CL-BRAVO', 'SHOPIFY', '9001')).rejects.toThrow(/already held by another listing/)
      await expect(setId(A, 'root', ITEM)).rejects.toThrow(/already held by another listing/)
      // The holder's own rows still write freely.
      await setId(A, 'other', ITEM)
      expect(await claims()).toEqual(expect.arrayContaining([expect.objectContaining({ externalId: ITEM, rootProductId: ids['CL-OTHER'] })]))
    } finally {
      await database.db.query(`CREATE OR REPLACE FUNCTION nexus_item_claim_mode() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'report'::text $$`)
    }
    // Back in report mode the same write goes through.
    await setId(A, 'root', ITEM)
  })
})
