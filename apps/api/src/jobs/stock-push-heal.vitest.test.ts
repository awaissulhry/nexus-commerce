/**
 * Stock push heal (Owner 2026-10-06: "make sure that the stock updates in real time across profiles") — a quantity
 * push that failed for good is queued again, once, within its budget; never where the cascade would not send.
 *
 * A disposable PostgreSQL (PGlite) with the generated production policies, profiles ON. Business B sells one product
 * from its own warehouse and one from business A's lent warehouse (a SKU link). The queue is the real table; only the
 * instant-lane enqueue (Redis) is a fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
const fake = vi.hoisted(() => ({ addJobSafely: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return {
    addJobSafely: fake.addJobSafely,
    outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue,
    redis: { connection: null },
  }
})

const A = 'ws_a_heal_lender'
const B = 'ws_b_heal_borrower'
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED

type Row = Record<string, any>

describe('stock push heal — a failed quantity push is queued again', () => {
  let heal: typeof import('./stock-push-heal.job.js')
  const id: Record<string, string> = {}
  const sql = async (text: string, params: unknown[] = []) => (await database.db.query(text, params)).rows as Row[]
  const inB = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: B, actorUserId: null, membershipId: null, roleKeys: [] }, work)
  const run = (options: { max?: number } = {}) => inB(() => heal.runStockPushHeal(options))
  /** One listing per market, so one product can carry many (the listing key is product + channel + market). */
  const MARKETS = ['DE', 'FR', 'ES', 'GB', 'AT', 'NL', 'BE', 'PL', 'SE', 'IE', 'CH', 'DK', 'PT', 'CZ']
  const onMarket = (market: string, extra: Record<string, unknown> = {}) =>
    listing(id.own, { quantity: 4, marketplace: market, region: market, channelMarket: `EBAY_${market}`, ...extra })

  const listing = async (productId: string, extra: Record<string, unknown> = {}) => {
    const lid = randomUUID()
    const cols = {
      id: lid, workspaceId: B, productId, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${lid.slice(0, 6)}`, quantity: 0,
      channelConnectionId: id.store, updatedAt: new Date(), ...extra,
    }
    const keys = Object.keys(cols)
    await sql(`INSERT INTO "ChannelListing" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(cols))
    return lid
  }
  /** A quantity row for a listing, `ageMinutes` old. */
  const push = async (listingId: string, productId: string, status: string, ageMinutes: number, extra: Record<string, unknown> = {}) => {
    const rid = randomUUID()
    const at = new Date(Date.now() - ageMinutes * 60_000)
    const cols = {
      id: rid, workspaceId: B, productId, channelListingId: listingId, targetChannel: 'EBAY', syncStatus: status, syncType: 'QUANTITY_UPDATE',
      payload: JSON.stringify({ source: 'STOCK_MOVEMENT', quantity: 1 }), retryCount: 0, maxRetries: 3, createdAt: at, updatedAt: at, ...extra,
    }
    const keys = Object.keys(cols)
    // Times as the application stores them (UTC wall time): the pg driver would send a Date in this machine's zone.
    const values = Object.values(cols).map((v) => (v instanceof Date ? v.toISOString() : v))
    await sql(`INSERT INTO "OutboundSyncQueue" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((k, i) => (k === 'syncStatus' ? `$${i + 1}::"OutboundSyncStatus"` : k === 'targetChannel' ? `$${i + 1}::"SyncChannel"` : k === 'payload' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(',')})`, values)
    return rid
  }
  const dead = (listingId: string, productId: string, ageMinutes: number, extra: Record<string, unknown> = {}) =>
    push(listingId, productId, 'FAILED', ageMinutes, { isDead: true, diedAt: new Date(), errorCode: 'MAX_RETRIES_EXCEEDED', errorMessage: 'eBay timed out', retryCount: 3, ...extra })
  const rows = (listingId: string) =>
    sql(`SELECT id, "syncStatus"::text AS status, payload, "channelConnectionId", "holdUntil" FROM "OutboundSyncQueue" WHERE "channelListingId" = $1 ORDER BY "createdAt", id`, [listingId])
  const heals = async (listingId: string) => (await rows(listingId)).filter((r) => r.payload?.source === 'STOCK_PUSH_HEAL')

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    heal = await import('./stock-push-heal.job.js')
    await sql(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    for (const [ws, name] of [[A, 'Lender A'], [B, 'Borrower B']]) {
      await sql(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$2,'active','heal',$1,CURRENT_TIMESTAMP)`, [ws, name])
    }
    const location = async (workspaceId: string, code: string) => {
      const lid = randomUUID()
      await sql(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "updatedAt") VALUES ($1,$2,'WAREHOUSE',$3,$3,CURRENT_TIMESTAMP)`, [lid, workspaceId, code])
      return lid
    }
    id.aMain = await location(A, 'A-MAIN')
    id.bMain = await location(B, 'B-MAIN')
    const product = async (workspaceId: string, sku: string) => {
      const pid = randomUUID()
      await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$2,$3,$3,10,CURRENT_TIMESTAMP)`, [pid, workspaceId, sku])
      return pid
    }
    id.own = await product(B, 'SKU-OWN-1')
    id.lent = await product(A, 'SKU-POOL-1')
    id.borrowed = await product(B, 'SKU-POOL-1')
    const stock = (workspaceId: string, locationId: string, productId: string, quantity: number) =>
      sql(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,CURRENT_TIMESTAMP)`, [randomUUID(), workspaceId, locationId, productId, quantity])
    await stock(B, id.bMain, id.own, 4)
    await stock(A, id.aMain, id.lent, 6)
    // A lends A-MAIN to B, and B's product sells from it by SKU. Seeded as superuser with the consent guards off: this
    // file tests the heal, not the consent rules (stock-pool-rules.vitest.test.ts does).
    id.grant = randomUUID()
    await sql(`ALTER TABLE "StockPoolGrant" DISABLE TRIGGER USER`)
    await sql(`INSERT INTO "StockPoolGrant" (id, "ownerWorkspaceId", "workspaceId", "locationIds", status, "createdByUserId", "updatedAt") VALUES ($1,$2,$3,$4,'active','heal',CURRENT_TIMESTAMP)`, [id.grant, A, B, [id.aMain]])
    await sql(`ALTER TABLE "StockPoolGrant" ENABLE TRIGGER USER`)
    await sql(`ALTER TABLE "StockPoolLink" DISABLE TRIGGER USER`)
    await sql(`INSERT INTO "StockPoolLink" (id, "workspaceId", "grantId", sku, "productId", "sourceProductId", status, "updatedAt") VALUES ($1,$2,$3,'SKU-POOL-1',$4,$5,'active',CURRENT_TIMESTAMP)`, [randomUUID(), B, id.grant, id.borrowed, id.lent])
    await sql(`ALTER TABLE "StockPoolLink" ENABLE TRIGGER USER`)
    id.store = randomUUID()
    await sql(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "accountLabel", "externalAccountId", "isActive", "isPrimary", "authStatus", "updatedAt") VALUES ($1,$2,'EBAY','Store B','seller-b',true,true,'connected',CURRENT_TIMESTAMP)`, [id.store, B])
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  })

  beforeEach(async () => {
    await sql(`UPDATE "ChannelConnection" SET "authStatus" = 'connected', "isActive" = true`)
    await sql(`DELETE FROM "OutboundSyncQueue"`)
    await sql(`DELETE FROM "SyncChannelPolicy"`)
    await sql(`DELETE FROM "ChannelListing"`)
    fake.addJobSafely.mockClear()
  })

  it('the budget: a refusal once a day; other failures 3 a day, an hour apart (pure)', () => {
    const now = Date.parse('2026-10-06T12:00:00Z')
    const ago = (h: number) => new Date(now - h * 3600_000)
    expect(heal.budgetAllows('REFUSED', [], now)).toBe(true)
    expect(heal.budgetAllows('REFUSED', [ago(23)], now)).toBe(false)
    expect(heal.budgetAllows('REFUSED', [ago(25)], now)).toBe(true)
    expect(heal.budgetAllows('RETRYABLE', [ago(0.5)], now)).toBe(false)
    expect(heal.budgetAllows('RETRYABLE', [ago(2), ago(1)], now)).toBe(true)
    expect(heal.budgetAllows('RETRYABLE', [ago(3), ago(2), ago(1)], now)).toBe(false)
    expect(heal.budgetAllows('RETRYABLE', [ago(30), ago(2), ago(1)], now)).toBe(true)
    // The error code decides first: a refusal's own code is a refusal on whichever try it came — also the third.
    expect(heal.healClassOf({ status: 'FAILED', isDead: true, errorCode: 'EBAY_VALIDATION', retryCount: 1, maxRetries: 3 })).toBe('REFUSED')
    expect(heal.healClassOf({ status: 'FAILED', isDead: true, errorCode: 'EBAY_VALIDATION', retryCount: 3, maxRetries: 3 })).toBe('REFUSED')
    expect(heal.healClassOf({ status: 'FAILED', isDead: true, errorCode: 'NON_RETRYABLE', retryCount: 3, maxRetries: 3 })).toBe('REFUSED')
    // The "kept failing" codes are retryable, whatever the count.
    expect(heal.healClassOf({ status: 'FAILED', isDead: true, errorCode: 'MAX_RETRIES_EXCEEDED', retryCount: 3, maxRetries: 3 })).toBe('RETRYABLE')
    expect(heal.healClassOf({ status: 'FAILED', isDead: true, errorCode: 'AUTH_REQUIRED', retryCount: 0, maxRetries: 3 })).toBe('RETRYABLE')
    // No code: died with retries left = refused; with them spent = kept failing.
    expect(heal.healClassOf({ status: 'FAILED', isDead: true, errorCode: null, retryCount: 1, maxRetries: 3 })).toBe('REFUSED')
    expect(heal.healClassOf({ status: 'FAILED', isDead: true, errorCode: null, retryCount: 3, maxRetries: 3 })).toBe('RETRYABLE')
    expect(heal.healClassOf({ status: 'PENDING', isDead: false, errorCode: null, retryCount: 0, maxRetries: 3 })).toBe('RETRYABLE')
  })

  it('a dead push is queued again once, through the cascade path; the next run finds nothing more to do', async () => {
    const lid = await listing(id.own, { quantity: 4 })
    const failed = await dead(lid, id.own, 30)
    expect(await run()).toMatchObject({ candidates: 1, healed: 1 })
    const [old, fresh] = await rows(lid)
    expect(old).toMatchObject({ id: failed, status: 'FAILED' })
    expect(fresh).toMatchObject({ status: 'PENDING', channelConnectionId: id.store })
    expect(fresh.payload).toMatchObject({
      source: 'STOCK_PUSH_HEAL', quantity: 4, healOf: failed, healReason: 'DEAD', healClass: 'RETRYABLE', healAttempt: 1,
      previousStatus: 'FAILED', previousErrorCode: 'MAX_RETRIES_EXCEEDED', previousError: 'eBay timed out',
    })
    expect(fake.addJobSafely).toHaveBeenCalledTimes(1)
    expect(fake.addJobSafely.mock.calls[0][2]).toMatchObject({ queueId: fresh.id, syncType: 'QUANTITY_UPDATE', source: 'STOCK_PUSH_HEAL' })
    expect(await run()).toMatchObject({ candidates: 0, healed: 0 })
    expect(await rows(lid)).toHaveLength(2)
  })

  it('a newer successful push, or a retry still scheduled, means nothing to heal', async () => {
    const sent = await listing(id.own, { quantity: 4 })
    await dead(sent, id.own, 60)
    await push(sent, id.own, 'SUCCESS', 10)
    const retrying = await listing(id.own, { quantity: 4, marketplace: 'DE', region: 'DE', channelMarket: 'EBAY_DE' })
    await push(retrying, id.own, 'FAILED', 5, { retryCount: 1, errorCode: 'RETRY_SCHEDULED', nextRetryAt: new Date(Date.now() + 60_000) })
    const waiting = await listing(id.own, { quantity: 4, marketplace: 'FR', region: 'FR', channelMarket: 'EBAY_FR' })
    await push(waiting, id.own, 'PENDING', 20)
    expect(await run()).toMatchObject({ candidates: 0, healed: 0 })
    expect(fake.addJobSafely).not.toHaveBeenCalled()
  })

  it('a push PENDING for hours is replaced: the old row is cancelled, one fresh row is queued', async () => {
    const lid = await listing(id.own, { quantity: 4 })
    const stuck = await push(lid, id.own, 'PENDING', 180)
    expect(await run()).toMatchObject({ healed: 1 })
    const [old, fresh] = await rows(lid)
    expect(old).toMatchObject({ id: stuck, status: 'CANCELLED' })
    expect(fresh.payload).toMatchObject({ source: 'STOCK_PUSH_HEAL', healReason: 'STALE_PENDING', healOf: stuck })
  })

  it('a channel refusal is retried at most once a day, and each heal says why', async () => {
    const lid = await listing(id.own, { quantity: 4 })
    const refused = await dead(lid, id.own, 30, { errorCode: 'EBAY_VALIDATION', errorMessage: 'Item specifics missing', retryCount: 1 })
    expect(await run()).toMatchObject({ healed: 1 })
    const [first] = await heals(lid)
    expect(first.payload).toMatchObject({ healClass: 'REFUSED', previousErrorCode: 'EBAY_VALIDATION', previousError: 'Item specifics missing' })
    // eBay refuses the heal too: it is now the newest row, dead — and today's heal is spent, so the candidate query
    // leaves it out.
    await sql(`UPDATE "OutboundSyncQueue" SET "syncStatus" = 'FAILED', "isDead" = true, "errorCode" = 'EBAY_VALIDATION', "retryCount" = 1 WHERE id = $1`, [first.id])
    expect(await run()).toMatchObject({ candidates: 0, healed: 0 })
    // A day later it is tried once more.
    await sql(`UPDATE "OutboundSyncQueue" SET "createdAt" = "createdAt" - interval '26 hours', "updatedAt" = "updatedAt" - interval '26 hours' WHERE id = $1`, [refused])
    await sql(`UPDATE "OutboundSyncQueue" SET "createdAt" = "createdAt" - interval '25 hours', "updatedAt" = "updatedAt" - interval '25 hours' WHERE id = $1`, [first.id])
    expect(await run()).toMatchObject({ healed: 1 })
    const second = (await heals(lid)).at(-1)!
    expect(second.payload).toMatchObject({ healOf: first.id, healAttempt: 1, healClass: 'REFUSED' })
  })

  it('never where the cascade would not send: paused, policy-paused, selling paused, ended, draft, account down, Nexus number off', async () => {
    const cases = {
      paused: await listing(id.own, { quantity: 4, syncPaused: true }),
      policy: await listing(id.own, { quantity: 4, marketplace: 'DE', region: 'DE', channelMarket: 'EBAY_DE' }),
      closed: await listing(id.own, { quantity: 4, marketplace: 'FR', region: 'FR', channelMarket: 'EBAY_FR', offerClosedAt: new Date() }),
      ended: await listing(id.own, { quantity: 4, marketplace: 'ES', region: 'ES', channelMarket: 'EBAY_ES', listingStatus: 'ENDED' }),
      draft: await listing(id.own, { quantity: 4, marketplace: 'GB', region: 'GB', channelMarket: 'EBAY_GB', listingStatus: 'DRAFT', isPublished: false, externalListingId: null }),
      differs: await listing(id.own, { quantity: 9, marketplace: 'AT', region: 'AT', channelMarket: 'EBAY_AT' }),
    }
    await sql(`INSERT INTO "SyncChannelPolicy" (id, "workspaceId", channel, marketplace, "pushesPaused", "updatedAt") VALUES ($1,$2,'EBAY','DE',true,CURRENT_TIMESTAMP)`, [randomUUID(), B])
    for (const lid of Object.values(cases)) await dead(lid, id.own, 30)
    // The candidate query leaves out what a column holds (paused, policy, closed, ended, draft); the Nexus number is
    // the ledger's, so that one is read and skipped in code.
    const result = await run()
    expect(result).toMatchObject({ candidates: 1, healed: 0 })
    expect(result.skipped).toEqual({ nexus_number_differs: 1 })
    expect(fake.addJobSafely).not.toHaveBeenCalled()
    expect((await sql(`SELECT count(*)::int AS n FROM "OutboundSyncQueue" WHERE payload->>'source' = 'STOCK_PUSH_HEAL'`))[0].n).toBe(0)

    // Positive control: a listing with nothing holding it is skipped while its account needs signing in, and healed
    // once it is back.
    await sql(`DELETE FROM "ChannelListing"`)
    const lid = await listing(id.own, { quantity: 4, marketplace: 'NL', region: 'NL', channelMarket: 'EBAY_NL' })
    await dead(lid, id.own, 30)
    await sql(`UPDATE "ChannelConnection" SET "authStatus" = 'needs_reauth' WHERE id = $1`, [id.store])
    expect(await run()).toMatchObject({ candidates: 0, healed: 0 })
    await sql(`UPDATE "ChannelConnection" SET "authStatus" = 'connected' WHERE id = $1`, [id.store])
    expect(await run()).toMatchObject({ healed: 1 })
    expect(await heals(lid)).toHaveLength(1)
  })

  it('the code repeats every column gate: each held listing is refused by listingGate too (pure)', () => {
    const base = {
      id: 'l1', productId: 'p1', channel: 'EBAY', marketplace: 'IT', region: 'IT', externalListingId: 'ITEM-1', quantity: 4, stockBuffer: 0,
      followMasterQuantity: false, fulfillmentMethod: null, syncPaused: false, offerClosedAt: null, listingStatus: 'ACTIVE', isPublished: true,
      sourceLocationCodes: [], channelConnectionId: 'c1', product: { fulfillmentMethod: null, deletedAt: null }, channelConnection: { isActive: true, authStatus: 'connected' },
    }
    const gate = (extra: Record<string, unknown>) => heal.listingGate({ ...base, ...extra } as never, undefined, new Map(), () => 'FBM')
    expect(gate({})).toBeNull()
    expect(gate({ syncPaused: true })).toBe('push_locked')
    expect(gate({ offerClosedAt: new Date() })).toBe('push_locked')
    expect(gate({ listingStatus: 'ENDED' })).toBe('push_locked')
    expect(gate({ listingStatus: 'DRAFT', isPublished: false, externalListingId: null })).toBe('still_draft')
    expect(gate({ channelConnection: { isActive: true, authStatus: 'needs_reauth' } })).toBe('account_down')
    expect(gate({ channelConnection: { isActive: false, authStatus: 'connected' } })).toBe('account_down')
    expect(gate({ product: { fulfillmentMethod: null, deletedAt: new Date() } })).toBe('product_deleted')
    expect(gate({ quantity: null })).toBe('uncounted')
    expect(heal.listingGate({ ...base } as never, undefined, new Map(), () => 'FBA')).toBe('fba')
    const paused = new Map([['EBAY:IT@', { pushesPaused: true, newListingDefaultMode: 'FOLLOW' }]])
    expect(heal.listingGate({ ...base } as never, undefined, paused, () => 'FBM')).toBe('paused')
  })

  it('held listings never hide a newer one that can be healed, whatever the window (max 1)', async () => {
    // More held rows than one run reads (SCAN_PAGES pages of max), all older than the one that can be healed.
    const held = heal.SCAN_PAGES + 1
    const healable = async () => {
      const lid = await onMarket('DK')
      await dead(lid, id.own, 30)
      return lid
    }
    const reset = async () => {
      for (const table of ['OutboundSyncQueue', 'SyncChannelPolicy', 'ChannelListing']) await sql(`DELETE FROM "${table}"`)
    }

    // 1. Held by a column: paused, selling closed, ended, an FBA listing.
    const columns = [{ syncPaused: true }, { offerClosedAt: new Date() }, { listingStatus: 'ENDED' }, { fulfillmentMethod: 'FBA' }]
    for (let i = 0; i < held; i++) await dead(await onMarket(MARKETS[i], columns[i % columns.length]), id.own, 90 + i)
    let target = await healable()
    expect(await run({ max: 1 })).toMatchObject({ candidates: 1, healed: 1 })
    expect(await heals(target)).toHaveLength(1)
    await reset()

    // 2. Held by their budget: each listing's latest row is today's heal, refused again by the channel.
    for (let i = 0; i < held; i++) {
      const lid = await onMarket(MARKETS[i])
      await dead(lid, id.own, 180 + i, { errorCode: 'EBAY_VALIDATION', retryCount: 1 })
      await dead(lid, id.own, 90 + i, { errorCode: 'EBAY_VALIDATION', retryCount: 1, payload: JSON.stringify({ source: 'STOCK_PUSH_HEAL', quantity: 4 }) })
    }
    target = await healable()
    expect(await run({ max: 1 })).toMatchObject({ candidates: 1, healed: 1 })
    expect(await heals(target)).toHaveLength(1)
    await reset()

    // 3. Held by a policy: eBay paused channel-wide, except the healable listing's market, which a market row resumes
    //    (the market decides first, as policyFor does).
    await sql(`INSERT INTO "SyncChannelPolicy" (id, "workspaceId", channel, marketplace, "pushesPaused", "updatedAt") VALUES ($1,$2,'EBAY','*',true,CURRENT_TIMESTAMP), ($3,$2,'EBAY','DK',false,CURRENT_TIMESTAMP)`, [randomUUID(), B, randomUUID()])
    for (let i = 0; i < held; i++) await dead(await onMarket(MARKETS[i]), id.own, 90 + i)
    target = await healable()
    expect(await run({ max: 1 })).toMatchObject({ candidates: 1, healed: 1 })
    expect(await heals(target)).toHaveLength(1)
    await reset()

    // 4. Held by what only the ledger says (the Nexus number differs): read and skipped in code, page by page — the
    //    healable row is still reached within SCAN_PAGES pages.
    for (let i = 0; i < heal.SCAN_PAGES - 1; i++) await dead(await onMarket(MARKETS[i], { quantity: 9 }), id.own, 90 + i)
    target = await healable()
    expect(await run({ max: 1 })).toMatchObject({ candidates: heal.SCAN_PAGES, healed: 1, skipped: { nexus_number_differs: heal.SCAN_PAGES - 1 }, capped: false })
    expect(await heals(target)).toHaveLength(1)
  })

  it('a refusal on the third try is still a refusal: one heal a day, not three', async () => {
    const lid = await listing(id.own, { quantity: 4 })
    await dead(lid, id.own, 30, { errorCode: 'EBAY_VALIDATION', errorMessage: 'Item specifics missing', retryCount: 3 })
    expect(await run()).toMatchObject({ healed: 1 })
    const [first] = await heals(lid)
    expect(first.payload).toMatchObject({ healClass: 'REFUSED' })
    await sql(`UPDATE "OutboundSyncQueue" SET "syncStatus" = 'FAILED', "isDead" = true, "errorCode" = 'EBAY_VALIDATION', "retryCount" = 3 WHERE id = $1`, [first.id])
    // Two hours later a retryable failure would be healed again; a refusal waits for the next day.
    await sql(`UPDATE "OutboundSyncQueue" SET "createdAt" = "createdAt" - interval '2 hours', "updatedAt" = "updatedAt" - interval '2 hours' WHERE "channelListingId" = $1`, [lid])
    expect(await run()).toMatchObject({ candidates: 0, healed: 0 })
    expect(await heals(lid)).toHaveLength(1)
  })

  it('a failure that kept failing is healed up to 3 times a day, at least an hour apart', async () => {
    const lid = await listing(id.own, { quantity: 4 })
    await dead(lid, id.own, 30)
    const failAgainAndAge = async (hours: number) => {
      const latest = (await heals(lid)).at(-1)!
      await sql(`UPDATE "OutboundSyncQueue" SET "syncStatus" = 'FAILED', "isDead" = true, "errorCode" = 'MAX_RETRIES_EXCEEDED', "retryCount" = 3 WHERE id = $1`, [latest.id])
      await sql(`UPDATE "OutboundSyncQueue" SET "createdAt" = "createdAt" - make_interval(hours => $2), "updatedAt" = "updatedAt" - make_interval(hours => $2) WHERE "channelListingId" = $1`, [lid, hours])
    }
    expect(await run()).toMatchObject({ healed: 1 })
    await failAgainAndAge(0)
    expect(await run()).toMatchObject({ candidates: 0, healed: 0 }) // within the hour
    await failAgainAndAge(2)
    expect(await run()).toMatchObject({ healed: 1 })
    await failAgainAndAge(2)
    expect(await run()).toMatchObject({ healed: 1 })
    expect(await heals(lid)).toHaveLength(3)
    await failAgainAndAge(2)
    expect(await run()).toMatchObject({ candidates: 0, healed: 0 }) // 3 in the last 24 h
    expect((await heals(lid)).map((h) => h.payload.healClass)).toEqual(['RETRYABLE', 'RETRYABLE', 'RETRYABLE'])
  })

  it('a listing that sells from another business\'s stock is healed to the pool\'s number', async () => {
    const pooled = await listing(id.borrowed, { quantity: 6 })
    const failed = await dead(pooled, id.borrowed, 30)
    const stale = await listing(id.borrowed, { quantity: 7, marketplace: 'DE', region: 'DE', channelMarket: 'EBAY_DE' })
    await dead(stale, id.borrowed, 30)
    const result = await run()
    expect(result).toMatchObject({ candidates: 2, healed: 1, skipped: { nexus_number_differs: 1 } })
    const [fresh] = await heals(pooled)
    expect(fresh.payload).toMatchObject({ source: 'STOCK_PUSH_HEAL', quantity: 6, healOf: failed })
    expect(await heals(stale)).toEqual([])
  })
})
