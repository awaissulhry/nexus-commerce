/**
 * AE.3 / shared stock — a first copy into a business that sells NOWHERE YET.
 *
 * Production, 2026-09-21: "Gale Jacket" was shared from Xavia Racing to Motovento, a business profile with
 * no Marketplace row at all. Every one of the 21 records was refused with
 * `family: Unknown market "IT". This platform has:` — an empty list. The reference market belongs to the
 * business that SHARES the products (the copy reads its values there); the receiving business does not need
 * it, and a new profile has none. The copy and the live sync therefore ask for the column model with
 * `allowUnknownMarket`, while every operator-facing sheet keeps the strict check (a typo'd `?market=` must
 * still be refused by name).
 *
 * Needs NEXUS_TEST_CONCURRENT_PG_URL (a throwaway Docker PostgreSQL); SKIPS without it — the column model
 * reads Marketplace and ChannelListing, so a mocked sheet-columns service (as the other AE suites use)
 * cannot see this at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})

const OWNER = 'ws_owner_unknown_market'
const FOLLOWER = 'ws_follower_unknown_market'
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED

describe.skipIf(!serverUrl)(`AE.3 — a copy into a business with no marketplace (needs ${CONCURRENT_PG_ENV})`, () => {
  let sheet: typeof import('../pim/sheet-columns.service.js')
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
  const as = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 8 })
    for (const [id, name] of [[OWNER, 'Xavia Racing'], [FOLLOWER, 'Motovento']]) {
      await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$2,'active','ae3',$1,now())`, [id, name])
    }
    // The business that shares the products sells on eBay IT; the receiving one sells nowhere yet.
    await q(`INSERT INTO "Marketplace" (id, "workspaceId", channel, code, name, region, currency, language, languages, "updatedAt")
      VALUES ($1,$2,'EBAY','IT','eBay Italy','EU','EUR','it',ARRAY['it'],now())`, [randomUUID(), OWNER])
    sheet = await import('../pim/sheet-columns.service.js')
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  const columnsFor = (workspaceId: string, allowUnknownMarket?: boolean) =>
    as(workspaceId, () => sheet.getSheetColumns({ market: 'IT', allowUnknownMarket, familyIds: [], productTypes: [], scopeKind: 'master', includeEmptyChannels: true }))

  it('the sharing business has the market: its sheet is built either way', async () => {
    expect((await columnsFor(OWNER)).columns.length).toBeGreaterThan(0)
  })

  it('the receiving business has no marketplace at all: the strict check refuses the market by name', async () => {
    const error = await columnsFor(FOLLOWER).then(() => null, (e: unknown) => e as { code?: string; message: string })
    expect(error?.code).toBe('unknown_market')
    expect(error?.message).toBe('Unknown market "IT". This platform has: ')
  })

  it('a copy or a live sync reads the OWNER\'s market: the same call is built, with the master columns', async () => {
    const built = await columnsFor(FOLLOWER, true)
    expect(built.columns.length).toBeGreaterThan(0)
    expect(built.columns.map((column) => column.key)).toContain('name')
    // No marketplace here, so the market brings no channel coordinate — master fields only.
    expect(built.columns.every((column) => column.scope !== 'channel')).toBe(true)
  })
})
