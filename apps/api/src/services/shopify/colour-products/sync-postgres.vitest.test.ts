import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ db: null as any, beforeClaimRead: null as null | (() => Promise<void>) }))
vi.mock('@nexus/database', () => ({ default: new Proxy({}, { get: (_, key) => {
  const value = state.db.client[key]
  if (key === 'shopifyColourSync') return new Proxy(value, { get: (_target, method) => method === 'findFirst'
    ? async (...args: unknown[]) => { const hook = state.beforeClaimRead; state.beforeClaimRead = null; await hook?.(); return value.findFirst(...args) }
    : typeof value[method] === 'function' ? value[method].bind(value) : value[method] })
  return typeof value === 'function' ? value.bind(state.db.client) : value
} }) }))
vi.mock('../content-workspace.service.js', async original => ({ ...await original<any>(), contentDestination: async (productId: string, scope: any) => ({
  familyId: productId, accountId: scope.accountId, marketplace: 'GLOBAL', aliasKey: '',
}) }))
import prisma from '../../../db.js'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { claimColourSync, assertColourSyncCurrent, finishColourSync, inColourSync } from './sync-work.js'
import { findColourProducts } from './find.service.js'

const scoped = <T>(fn: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, fn)
describe.skipIf(!concurrentDatabaseUrl())('durable colour work on real PostgreSQL', () => {
  beforeAll(async () => { state.db = await concurrentDatabase() }, 120_000)
  afterAll(async () => { await state.db?.close() }, 60_000)
  async function seed(prefix: string, workspaceId = LEGACY_WORKSPACE_ID) {
    return withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
      const account = await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', accountLabel: prefix, externalAccountId: prefix, authStatus: 'connected', managedBy: 'oauth' } as never })
      const family = await prisma.product.create({ data: { sku: prefix, name: prefix, basePrice: 10, isParent: true } })
      const child = await prisma.product.create({ data: { sku: `${prefix}-S`, name: prefix, basePrice: 10, parentId: family.id } })
      const colour = await prisma.shopifyColourProduct.create({ data: { familyId: family.id, channelConnectionId: account.id, splitAxis: 'color', valueKey: 'color:black', state: 'LINKED', shopifyProductId: 'gid://shopify/Product/1' } })
      const work = await prisma.shopifyColourSync.findFirstOrThrow({ where: { familyId: family.id } })
      return { family, child, colour, work }
    })
  }
  it('captures raw child values and order in one debounced request and withdraws verification', async () => {
    const s = await seed('debounce')
    await scoped(async () => {
      await prisma.shopifyColourProduct.update({ where: { id: s.colour.id }, data: { linkVerifiedAt: new Date() } })
      await prisma.$transaction(async tx => {
        await tx.$executeRaw`UPDATE "Product" SET "categoryAttributes" = '{"variations":{"size":"M"}}'::jsonb WHERE id = ${s.child.id}`
        await tx.product.update({ where: { id: s.family.id }, data: { variationValueOrder: { size: ['size:m', 'size:s'] } } })
      })
      const rows = await prisma.shopifyColourSync.findMany({ where: { familyId: s.family.id } })
      expect(rows).toHaveLength(1)
      expect(rows[0].revision).toBe(s.work.revision + 2)
      expect(rows[0].dueAt).toBeInstanceOf(Date)
      expect((await prisma.shopifyColourProduct.findUniqueOrThrow({ where: { id: s.colour.id } })).linkVerifiedAt).toBeNull()
    })
  })
  it('rolls back both the edit and its request', async () => {
    const s = await seed('rollback')
    await scoped(async () => {
      await expect(prisma.$transaction(async tx => {
        await tx.product.update({ where: { id: s.child.id }, data: { deletedAt: new Date() } })
        throw new Error('rollback')
      })).rejects.toThrow('rollback')
      expect((await prisma.shopifyColourSync.findUniqueOrThrow({ where: { id: s.work.id } })).revision).toBe(s.work.revision)
      expect((await prisma.product.findUniqueOrThrow({ where: { id: s.child.id } })).deletedAt).toBeNull()
      // Positive control: the same edit really does capture work when it commits.
      await prisma.product.update({ where: { id: s.child.id }, data: { deletedAt: new Date() } })
      expect((await prisma.shopifyColourSync.findUniqueOrThrow({ where: { id: s.work.id } })).revision).toBe(s.work.revision + 1)
    })
  })
  it('admits one owner when two runners claim together', async () => {
    const s = await seed('claim')
    await scoped(async () => {
      const [a, b] = await Promise.all([claimColourSync(s.work.id), claimColourSync(s.work.id)])
      expect([a, b].filter(Boolean)).toHaveLength(1)
      expect(await claimColourSync(s.work.id)).toBeNull()
      await finishColourSync((a ?? b)!, false)
    })
  })
  it('keeps an edit made during a run pending and refuses its old completion', async () => {
    const s = await seed('new-edit')
    await scoped(async () => {
      const claim = (await claimColourSync(s.work.id))!
      await prisma.product.update({ where: { id: s.child.id }, data: { deletedAt: new Date() } })
      await expect(inColourSync(claim, () => assertColourSyncCurrent())).rejects.toThrow(/changed/)
      await finishColourSync(claim, true)
      const pending = await prisma.shopifyColourSync.findUniqueOrThrow({ where: { id: claim.id } })
      expect(pending.dueAt).not.toBeNull()
      expect(pending.revision).toBeGreaterThan(claim.revision)
      expect(pending.leaseToken).toBeNull()
    })
  })
  it('fences an expired owner after a replacement claims the work', async () => {
    const s = await seed('expired')
    await scoped(async () => {
      const old = (await claimColourSync(s.work.id))!
      await prisma.shopifyColourSync.update({ where: { id: old.id }, data: { leaseUntil: new Date(0) } })
      const next = (await claimColourSync(s.work.id))!
      expect(next.leaseToken).not.toBe(old.leaseToken)
      await expect(inColourSync(old, () => assertColourSyncCurrent())).rejects.toThrow(/changed/)
      await finishColourSync(old, true)
      expect((await prisma.shopifyColourSync.findUniqueOrThrow({ where: { id: old.id } })).leaseToken).toBe(next.leaseToken)
      await finishColourSync(next, true)
      expect((await prisma.shopifyColourSync.findUniqueOrThrow({ where: { id: next.id } })).dueAt).toBeNull()
    })
  })
  it('keeps both concurrent edits when their capture is blocked on the same request row', async () => {
    const s = await seed('concurrent-edits')
    const second = await scoped(() => prisma.product.create({ data: { sku: 'concurrent-edits-M', name: 'M', basePrice: 10, parentId: s.family.id } }))
    const before = await scoped(() => prisma.shopifyColourSync.findUniqueOrThrow({ where: { id: s.work.id } }))
    const lock = await state.db.pool.connect()
    let edits: Promise<unknown>[] = []
    try {
      await lock.query('BEGIN')
      expect((await lock.query('SELECT id FROM "ShopifyColourSync" WHERE id = $1 FOR UPDATE', [s.work.id])).rows).toHaveLength(1)
      edits = [s.child.id, second.id].map(id => scoped(async () => { await prisma.product.update({ where: { id }, data: { deletedAt: new Date() } }) }))
      let waiting = 0
      for (let i = 0; i < 200 && waiting < 2; i++) {
        await new Promise(resolve => setTimeout(resolve, 25))
        waiting = (await state.db.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'", [state.db.name])).rows[0].n
      }
      expect(waiting, 'both edits must actually block before the release').toBe(2)
    } finally {
      await lock.query('ROLLBACK'); lock.release(); await Promise.all(edits)
    }
    const after = await scoped(() => prisma.shopifyColourSync.findUniqueOrThrow({ where: { id: s.work.id } }))
    expect(after.revision).toBe(before.revision + 2)
    expect(after.dueAt).not.toBeNull()
  })
  it('a moved child queues both its old and new managed families', async () => {
    const a = await seed('move-a'), b = await seed('move-b')
    await scoped(async () => {
      await prisma.product.update({ where: { id: a.child.id }, data: { parentId: b.family.id } })
      const rows = await prisma.shopifyColourSync.findMany({ where: { id: { in: [a.work.id, b.work.id] } } })
      expect(rows.map(r => r.revision)).toEqual([a.work.revision + 1, b.work.revision + 1])
    })
  })
  it('never reads or claims another business\'s pending work', async () => {
    const otherWorkspace = 'colour-sync-other-workspace'
    await state.db.pool.query(`INSERT INTO "Workspace" (id,name,status,"isLegacy","createdByUserId","creationKey","updatedAt") VALUES ($1,'Other','active',false,'test','colour-sync-other',CURRENT_TIMESTAMP)`, [otherWorkspace])
    const other = await seed('other-business', otherWorkspace)
    await scoped(async () => {
      expect(await prisma.shopifyColourSync.findUnique({ where: { id: other.work.id } })).toBeNull()
      expect(await claimColourSync(other.work.id)).toBeNull()
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "ShopifyColourSync" WHERE id = ${other.work.id}`
      expect(rows).toEqual([])
    })
  })
  it('a changed store switch fences a run which read the previous settings', async () => {
    const s = await seed('settings')
    await scoped(async () => {
      const claim = (await claimColourSync(s.work.id))!
      await prisma.channelConnection.update({ where: { id: s.work.channelConnectionId }, data: { connectionMetadata: { shopifyColourProducts: { enabled: false } } } })
      await expect(inColourSync(claim, () => assertColourSyncCurrent())).rejects.toThrow(/changed/)
      await finishColourSync(claim, true)
      expect((await prisma.shopifyColourSync.findUniqueOrThrow({ where: { id: claim.id } })).dueAt).not.toBeNull()
    })
  })
  it('never borrows the token of a replacement owner after pausing before its claim read', async () => {
    const s = await seed('claim-read')
    await scoped(async () => {
      let arrived!: () => void, release!: () => void
      const atRead = new Promise<void>(resolve => { arrived = resolve }), proceed = new Promise<void>(resolve => { release = resolve })
      state.beforeClaimRead = async () => { arrived(); await proceed }
      const first = claimColourSync(s.work.id)
      await atRead
      await prisma.shopifyColourSync.update({ where: { id: s.work.id }, data: { leaseUntil: new Date(0) } })
      const replacement = (await claimColourSync(s.work.id))!
      release()
      expect(await first).toBeNull()
      await inColourSync(replacement, () => assertColourSyncCurrent())
      await finishColourSync(replacement, true)
      expect(await claimColourSync(s.work.id, true)).toBeNull()
    })
  })
  it('Find cannot enter its colour-row write while a sync owns the request', async () => {
    const s = await seed('find-lock-order')
    await scoped(async () => {
      const claim = (await claimColourSync(s.work.id))!
      await expect(findColourProducts(s.family.id, { accountId: s.work.channelConnectionId }, {})).rejects.toThrow('already syncing')
      expect((await prisma.shopifyColourProduct.findUniqueOrThrow({ where: { id: s.colour.id } })).state).toBe('LINKED')
      await finishColourSync(claim, true)
      expect(await findColourProducts(s.family.id, { accountId: s.work.channelConnectionId }, {})).toHaveProperty('familyId', s.family.id)
    })
  })
})
