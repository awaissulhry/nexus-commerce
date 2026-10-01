/**
 * Shared stock by SKU on the Matrix (Owner 2026-10-01; plan docs/shared-stock-by-sku/PLAN-2026-10-01.md §3.3, §4).
 *
 * The real Matrix read over a real PostgreSQL in-process (PGlite) with the generated policies, profiles ON, two
 * businesses and NO product share: a variation connected by SKU to the lender's product says WHO lends it and shows
 * the lent number (Stock, and every Follow cell below it); one that never had stock here stays "Uncounted"; one that
 * LEFT the pool and holds nothing here shows 0 — what is pushed — not "Uncounted, nothing is pushed". The parent
 * names the lender only when all its variations sell from the same lent stock.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return { addJobSafely: vi.fn(async () => undefined), outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue, redis: { connection: null } }
})

import { withWorkspace } from '../../lib/workspace-context.js'
import type { MatrixRead } from '@nexus/shared/matrix-contract'

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const roleBefore = process.env.NEXUS_PROCESS_ROLE
const A = 'ws_a_matrix_lender'
const B = 'ws_b_matrix_borrower'

describe('the Matrix says where a SKU takes its stock from', () => {
  const user = { ownerA: randomUUID(), ownerB: randomUUID() }
  const id: Record<string, string> = {}
  let grantId = ''
  let links: typeof import('../stock-pool/pool-links.service.js')
  let matrix: typeof import('./matrix.service.js')
  const sql = async (text: string, params: unknown[] = []) => (await state.db.db.query(text, params)).rows as Array<Record<string, unknown>>
  const as = <T>(workspaceId: string, actor: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId: actor, membershipId: null, roleKeys: [] }, work)
  const read = () => as(B, user.ownerB, () => matrix.getMatrixRead({ productId: id.bParent, canEditPrice: true })) as Promise<MatrixRead>
  const rowOf = (r: MatrixRead, productId: string) => r.rows.find((row) => row.id === productId)!
  const ebayIt = (r: MatrixRead) => r.coordinates.find((c) => c.channel === 'EBAY' && c.market === 'IT' && c.connected)!.key

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    process.env.NEXUS_PROCESS_ROLE = 'api'
    links = await import('../stock-pool/pool-links.service.js')
    matrix = await import('./matrix.service.js')
    await sql(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    const owner = randomUUID()
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,now())`, [owner])
    for (const [key, uid] of Object.entries(user)) await sql(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',now())`, [uid, `${key}@example.test`])
    await sql(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,'Lender A','active','t',$1,now()), ($2,'Borrower B','active','t',$2,now())`, [A, B])
    for (const [ws, uid] of [[A, user.ownerA], [B, user.ownerA], [B, user.ownerB]]) {
      const m = randomUUID()
      await sql(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',now())`, [m, ws, uid])
      await sql(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [m, owner])
    }
    await sql(`INSERT INTO "Marketplace" ("workspaceId", id, channel, code, name, currency, region, language, languages, "isActive", "updatedAt") VALUES ($1,$2,'EBAY','IT','eBay IT','EUR','EU','it',ARRAY['it'],true,now())`, [B, randomUUID()])
    id.account = randomUUID()
    await sql(`INSERT INTO "ChannelConnection" ("workspaceId", id, "channelType", "accountLabel", "isActive", "isPrimary", "updatedAt") VALUES ($1,$2,'EBAY','Motovento eBay',true,true,now())`, [B, id.account])
    // The same family in both businesses, made separately (same SKUs, no share).
    for (const [prefix, ws] of [['a', A], ['b', B]] as const) {
      id[`${prefix}Parent`] = randomUUID()
      await sql(`INSERT INTO "Product" ("workspaceId", id, sku, name, "basePrice", "isParent", "updatedAt") VALUES ($1,$2,'JACKET','Jacket',105,true,now())`, [ws, id[`${prefix}Parent`]])
      for (const size of ['M', 'L']) {
        id[`${prefix}${size}`] = randomUUID()
        await sql(`INSERT INTO "Product" ("workspaceId", id, sku, name, "basePrice", "parentId", "updatedAt") VALUES ($1,$2,$3,$3,105,$4,now())`, [ws, id[`${prefix}${size}`], `JACKET-${size}`, id[`${prefix}Parent`]])
      }
    }
    for (const size of ['M', 'L']) {
      await sql(`INSERT INTO "ChannelListing" ("workspaceId", id, "productId", channel, marketplace, region, "channelMarket", "channelConnectionId", "listingStatus", "isPublished", quantity, "stockBuffer", "followMasterQuantity", "updatedAt")
        VALUES ($1,$2,$3,'EBAY','IT','IT','EBAY_IT',$4,'ACTIVE',true,0,1,true,now())`, [B, randomUUID(), id[`b${size}`], id.account])
    }
    id.aMain = randomUUID()
    await sql(`INSERT INTO "StockLocation" ("workspaceId", id, type, code, name, "isActive", "updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-MAIN','IT-MAIN',true,now())`, [A, id.aMain])
    for (const [size, n] of [['M', 7], ['L', 3]] as const) {
      await sql(`INSERT INTO "StockLevel" ("workspaceId", id, "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`, [A, randomUUID(), id.aMain, id[`a${size}`], n])
    }
    const grant = await as(A, user.ownerA, () => state.db.client.stockPoolGrant.create({ data: { ownerWorkspaceId: A, workspaceId: B, locationIds: [id.aMain], createdByUserId: user.ownerA } }))
    await as(B, user.ownerB, () => state.db.client.$queryRaw`SELECT nexus_stock_pool_grant_respond(${grant.id}, 'accept', 1::integer)`)
    grantId = grant.id
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    if (roleBefore === undefined) delete process.env.NEXUS_PROCESS_ROLE
    else process.env.NEXUS_PROCESS_ROLE = roleBefore
    await state.db?.close()
  }, 60_000)

  it('before anything is connected: no SKU here was ever counted', async () => {
    const r = await read()
    for (const size of ['M', 'L']) {
      expect(rowOf(r, id[`b${size}`]).stock).toEqual({ available: null, uncounted: true, locations: [], source: null })
      expect(rowOf(r, id[`b${size}`]).cells[ebayIt(r)]!.sync).toMatchObject({ kind: 'UNCOUNTED', intended: null, poolAvailable: null })
    }
  })

  it('a SKU connected by SKU names its lender and shows the lent number, in Stock and in its Follow cells', async () => {
    expect(await as(B, user.ownerB, () => links.switchProducts({ productIds: [id.bM], to: 'pool', grantId, withVariations: false }))).toEqual({ switched: 1, unchanged: 0 })
    const r = await read()
    expect(rowOf(r, id.bM).stock).toEqual({ available: 7, uncounted: false, locations: [{ code: 'IT-MAIN', available: 7 }], source: { kind: 'pool', grantId, lenderName: 'Lender A' } })
    expect(rowOf(r, id.bM).cells[ebayIt(r)]!.sync).toMatchObject({ kind: 'FOLLOW', intended: 6, poolAvailable: 7, buffer: 1 })
    // The other variation still uses its own (uncounted) stock, so the parent names no lender.
    expect(rowOf(r, id.bL).stock.source).toBeNull()
    expect(rowOf(r, id.bParent).stock).toMatchObject({ available: 7, source: null })
  })

  it('the parent names the lender once every variation sells from it', async () => {
    await as(B, user.ownerB, () => links.switchProducts({ productIds: [id.bL], to: 'pool', grantId, withVariations: false }))
    const r = await read()
    expect(rowOf(r, id.bParent).stock).toMatchObject({ available: 10, uncounted: false, source: { kind: 'pool', grantId, lenderName: 'Lender A' } })
  })

  it('after a disconnect with no own stock here: 0 is pushed, and the Matrix says 0, not "Uncounted"', async () => {
    await as(B, user.ownerB, () => links.switchProducts({ productIds: [id.bM], to: 'own', grantId: null, withVariations: false }))
    const r = await read()
    expect(rowOf(r, id.bM).stock).toEqual({ available: 0, uncounted: false, locations: [], source: null })
    expect(rowOf(r, id.bM).cells[ebayIt(r)]!.sync).toMatchObject({ kind: 'FOLLOW', intended: 0, poolAvailable: 0 })
    // The parent: one variation lent (3), one counted at 0 — counted, no single lender.
    expect(rowOf(r, id.bParent).stock).toMatchObject({ available: 3, uncounted: false, source: null })
  })
})
