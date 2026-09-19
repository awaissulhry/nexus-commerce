/**
 * P1.3 — a queue row created through services/outbound-rows.ts carries its destination account, read
 * back from a real PostgreSQL table (generated schema + real profile policies): the second account's
 * listing → the second account; a product two accounts hold → no account; `create`, `createMany` and
 * `createManyAndReturn` alike, inside a transaction.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, { get: (_t, p) => (database.client as unknown as Record<string, unknown>)[p as string] }),
}))

const LEGACY = 'nexus_legacy_workspace'
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inLegacy = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe('P1.3 — the destination account is written with the row', () => {
  let rows: typeof import('./outbound-rows.js')
  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    rows = await import('./outbound-rows.js')
    const q = (sql: string, params: unknown[] = []) => database.db.query(sql, params)
    await q(`INSERT INTO "ChannelConnection" ("workspaceId", id, "channelType", "isActive", "isPrimary", "authStatus", "updatedAt") VALUES
      ($1, 'ebay-A', 'EBAY', true, true, 'connected', CURRENT_TIMESTAMP), ($1, 'ebay-B', 'EBAY', true, false, 'connected', CURRENT_TIMESTAMP)`, [LEGACY])
    await q(`INSERT INTO "Product" ("workspaceId", id, sku, name, "basePrice", "updatedAt") VALUES
      ($1, 'P1', 'SKU-1', 'One', 10, CURRENT_TIMESTAMP), ($1, 'P2', 'SKU-2', 'Two', 10, CURRENT_TIMESTAMP)`, [LEGACY])
    await q(`INSERT INTO "ChannelListing" ("workspaceId", id, "productId", "channelMarket", channel, region, marketplace, "channelConnectionId", "updatedAt") VALUES
      ($1, 'L-A', 'P1', 'EBAY_IT', 'EBAY', 'IT', 'IT', 'ebay-A', CURRENT_TIMESTAMP),
      ($1, 'L-B', 'P1', 'EBAY_DE', 'EBAY', 'DE', 'DE', 'ebay-B', CURRENT_TIMESTAMP),
      ($1, 'L-C', 'P2', 'EBAY_IT', 'EBAY', 'IT', 'IT', 'ebay-A', CURRENT_TIMESTAMP)`, [LEGACY])
    await q(`INSERT INTO "ChannelListing" ("workspaceId", id, "productId", "channelMarket", channel, region, marketplace, "channelConnectionId", "aliasKey", "updatedAt") VALUES
      ($1, 'L-D', 'P2', 'EBAY_IT', 'EBAY', 'IT', 'IT', 'ebay-B', 'second', CURRENT_TIMESTAMP)`, [LEGACY])
  }, 120_000)
  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  })
  const stored = async (id: string) => (await database.db.query<{ channelConnectionId: string | null }>(`SELECT "channelConnectionId" FROM "OutboundSyncQueue" WHERE id = $1`, [id])).rows[0]?.channelConnectionId

  it('create: the second account\'s listing → the second account (before P1.3 it went to the primary)', async () => {
    const row = await inLegacy(() => rows.createOutboundRow(database.client as never, {
      data: { productId: 'P1', channelListingId: 'L-B', targetChannel: 'EBAY', targetRegion: 'DE', syncType: 'QUANTITY_UPDATE', payload: { quantity: 3 } },
      select: { id: true },
    }))
    expect(await stored(row.id)).toBe('ebay-B')
  })

  it('createMany inside a transaction: each row its own listing\'s account', async () => {
    await inLegacy(() => database.client.$transaction(async (tx) => {
      await rows.createOutboundRows(tx as never, { data: [
        { productId: 'P1', channelListingId: 'L-A', targetChannel: 'EBAY', targetRegion: 'IT', syncType: 'PRICE_UPDATE', payload: { batch: 'm' } },
        { productId: 'P1', channelListingId: 'L-B', targetChannel: 'EBAY', targetRegion: 'DE', syncType: 'PRICE_UPDATE', payload: { batch: 'm' } },
      ] })
    }))
    const found = await database.db.query<{ channelListingId: string; channelConnectionId: string }>(`SELECT "channelListingId", "channelConnectionId" FROM "OutboundSyncQueue" WHERE "syncType" = 'PRICE_UPDATE' ORDER BY "channelListingId"`)
    expect(found.rows).toEqual([{ channelListingId: 'L-A', channelConnectionId: 'ebay-A' }, { channelListingId: 'L-B', channelConnectionId: 'ebay-B' }])
  })

  it('createManyAndReturn: a product two accounts hold in one market gets NO account (the sender refuses it)', async () => {
    const [row] = await inLegacy(() => rows.createOutboundRowsAndReturn(database.client as never, {
      data: [{ productId: 'P2', targetChannel: 'EBAY', targetRegion: 'IT', syncType: 'QUANTITY_UPDATE', payload: {} }],
      select: { id: true },
    }))
    expect(await stored(row.id)).toBeNull()
  })
})
