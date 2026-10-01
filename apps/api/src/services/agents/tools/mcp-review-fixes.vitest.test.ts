/**
 * MCP review, 2026-10-01 — the defects a fresh review found in the tools Claude reaches, each proved through the
 * doors a person or Claude uses (callTool, executeTool, runOrQueueTool, and the Settings › AI approve route), on a
 * real PostgreSQL with the production schema (PGlite). Nothing is sent to any marketplace from here.
 *
 *   Settings › AI approve   parks for the undo window and is re-checked before it runs, like the Approvals page;
 *                           two identical -10 % requests approved there no longer both run. An expired request is
 *                           not approvable.
 *   set-price               0, "" and null are refused; so is a price outside the product's own floor or ceiling.
 *   bulk-price-change       the same floor and ceiling; a listing whose rule takes it outside them is named.
 *   publish-listing         names one market; refuses to guess between markets, and refuses a draft.
 *   send-customer-message   the Amazon/eBay messaging warning reads the order's channel.
 *   order-search            the status is filtered before the limit.
 *   product-analytics       revenue per currency; a parent counts its variations.
 *   insights-metric         summed by the database, with the same answer.
 *   channel-price-stock     each listing's currency and the master currency.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// As db.ts wraps it: inside a transaction, `prisma.x` is that transaction's client.
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
// No Redis, and the product writer's read cache and readiness rebuild left out (as bulk.tools.vitest.test.ts does).
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { resolvePermissions } from '../../../lib/auth/rbac.js'
import { callTool, executeTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { runOrQueueTool } from '../approval-gate.service.js'
import { commitScheduledApproval } from '../../agent-fleet/approval-inbox.service.js'
import agentRoutes from '../../../routes/agents.routes.js'

const A = LEGACY_WORKSPACE_ID
const DB_TEST_TIMEOUT = 30_000
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const person = (permissions: Set<string>, userId = 'u-review'): UserPrincipal => ({
  kind: 'user', userId, label: 'Review tester', permissions: { isOwner: false, permissions }, workspace: business, via: 'app',
})
const ALL = person(EVERYTHING)
/** Sees sales, but not money (no financials). */
const NO_MONEY = person(new Set([...Object.values(F)]))

type Data = Record<string, any>
type Visible = { ok: boolean; error?: string; data?: Data; preview?: Data }

/** A tool's dry run as `who` sees it; a refusal by the door comes back as `{ refused }`. */
async function dryRun(tool: string, args: Record<string, unknown>, who: UserPrincipal = ALL): Promise<Visible & { refused?: ToolAccessError }> {
  try {
    return (await inside(() => callTool(who, tool, args))).visible as Visible
  } catch (error) {
    if (error instanceof ToolAccessError) return { ok: false, refused: error }
    throw error
  }
}

const ids = { bounded: '', percentListing: '', free: '', multi: '', multiDe: '', parent: '', child: '', loner: '' }
let app: FastifyInstance
let approverId = ''

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const db = database.client

  // A person whose own roles allow pricing in bulk: commit re-resolves the approver from the database.
  const role = await db.role.create({
    data: { key: `REVIEW_PRICER_${randomUUID().slice(0, 8)}`, name: 'Review pricer', description: 'test', isSystem: false,
      permissions: ['ai.run', F.productsView, F.productsEdit, F.productsPriceEdit, F.productsBulkRun] },
  })
  const approver = await db.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Rita Reviewer' } })
  approverId = approver.id
  await db.userRole.create({ data: { userId: approver.id, roleId: role.id } })
  const membership = await db.workspaceMembership.create({ data: { workspaceId: A, userId: approver.id, status: 'active' } })
  await db.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })

  await inside(async () => {
    for (const [channel, code, currency] of [['AMAZON', 'IT', 'EUR'], ['AMAZON', 'DE', 'EUR'], ['AMAZON', 'UK', 'GBP'], ['EBAY', 'IT', 'EUR']]) {
      await db.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region: 'EU', language: 'it', languages: ['it'], marketplaceId: `REVIEW_${channel}_${code}` } as never })
    }
    const make = (productId: string, channel: string, marketplace: string, data: Record<string, unknown> = {}) =>
      db.channelListing.create({ data: { productId, channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, ...data } as never })

    // Floor 40, ceiling 80, at 50.
    ids.bounded = (await db.product.create({ data: { sku: 'REV-BOUNDED', name: 'Bounded jacket', basePrice: '50.00', minPrice: '40.00', maxPrice: '80.00' } })).id
    // Ceiling 25 at 20, with an IT listing priced master + 50 %.
    const percent = await db.product.create({ data: { sku: 'REV-PERCENT', name: 'Percent jacket', basePrice: '20.00', maxPrice: '25.00' } })
    ids.percentListing = (await make(percent.id, 'AMAZON', 'IT', { price: '30.00', followMasterPrice: true, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: '50', externalListingId: 'REV-EXT-P' })).id
    // No bounds, no listings: the subject of the double approval.
    ids.free = (await db.product.create({ data: { sku: 'REV-FREE', name: 'Free jacket', basePrice: '100.00' } })).id
    // Live on Amazon IT and DE, a draft on eBay IT, and live on Amazon UK (GBP).
    ids.multi = (await db.product.create({ data: { sku: 'REV-MULTI', name: 'Multi jacket', basePrice: '60.00' } })).id
    await make(ids.multi, 'AMAZON', 'IT', { price: '60.00', followMasterPrice: true, pricingRule: 'FIXED', externalListingId: 'REV-EXT-IT', title: 'Multi IT' })
    ids.multiDe = (await make(ids.multi, 'AMAZON', 'DE', { price: '60.00', followMasterPrice: true, pricingRule: 'FIXED', externalListingId: 'REV-EXT-DE', title: 'Multi DE' })).id
    await make(ids.multi, 'AMAZON', 'UK', { price: '52.00', followMasterPrice: true, pricingRule: 'FIXED', externalListingId: 'REV-EXT-UK' })
    await make(ids.multi, 'EBAY', 'IT', { listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
    // A parent whose sales are its variation's, in two currencies.
    ids.parent = (await db.product.create({ data: { sku: 'REV-PARENT', name: 'Parent jacket', basePrice: '10.00', isParent: true } })).id
    ids.child = (await db.product.create({ data: { sku: 'REV-PARENT-M', name: 'Parent jacket M', basePrice: '10.00', parentId: ids.parent } })).id
    ids.loner = (await db.product.create({ data: { sku: 'REV-LONER', name: 'Loner', basePrice: '10.00' } })).id

    const order = (n: string, data: Record<string, unknown>) => db.order.create({
      data: {
        channel: 'AMAZON', channelOrderId: `REV-ORDER-${n}`, marketplace: 'IT', currencyCode: 'EUR', totalPrice: '10.00',
        customerName: `Buyer ${n}`, customerEmail: `buyer-${n}@example.test`, shippingAddress: { city: 'Milano' }, purchaseDate: new Date(),
        ...data,
      } as never,
    })
    // 22 recent unpaid orders, and one older shipped order: the newest 20 hold no shipped order.
    for (let n = 0; n < 22; n++) await order(`NEW-${n}`, { purchaseDate: new Date(Date.now() - n * 60_000) })
    await order('SHIPPED-OLD', { purchaseDate: new Date(Date.now() - 3 * 86_400_000), paidAt: new Date(), shippedAt: new Date() })
    // The variation sold 2 × 10 EUR on Amazon IT and 1 × 100 SEK on Amazon SE.
    const eur = await order('SALE-EUR', { totalPrice: '20.00', purchaseDate: new Date(Date.now() - 86_400_000) })
    await db.orderItem.create({ data: { orderId: eur.id, productId: ids.child, sku: 'REV-PARENT-M', quantity: 2, price: '10.00' } as never })
    const sek = await order('SALE-SEK', { marketplace: 'SE', currencyCode: 'SEK', totalPrice: '100.00', purchaseDate: new Date(Date.now() - 86_400_000) })
    await db.orderItem.create({ data: { orderId: sek.id, productId: ids.child, sku: 'REV-PARENT-M', quantity: 1, price: '100.00' } as never })
  })

  // The Settings › AI routes, signed in as the approver (permissions from their own roles, profiles off).
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    void (async () => {
      const user = await db.userProfile.findUniqueOrThrow({
        where: { id: approverId },
        select: { id: true, email: true, displayName: true, status: true, permissionsVersion: true, roleAssignments: { select: { role: { select: { key: true } } } } },
      })
      const authUser = { ...user, roleKeys: user.roleAssignments.map((a) => a.role.key) }
      const r = request as unknown as Record<string, unknown>
      r.__sessionLoaded = true
      r.authUser = authUser
      r.__rbacResolved = await resolvePermissions(authUser as never)
      withWorkspace(business, done)
    })().catch(done)
  })
  await app.register(agentRoutes)
  await app.ready()
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
}, 30_000)

const basePrice = async (id: string) => inside(async () => Number((await database.client.product.findUniqueOrThrow({ where: { id } })).basePrice))
const approval = (id: string) => inside(() => database.client.agentApproval.findUniqueOrThrow({ where: { id } }))

async function queueAs(who: UserPrincipal, tool: string, args: Record<string, unknown>) {
  const run = await inside(() => database.client.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'running' } }))
  const queued = await inside(() => runOrQueueTool(tool, args, who, run.id, { forceAsk: true }))
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  return queued.approvalId!
}

const settingsDecide = async (id: string, decision: 'approve' | 'reject') => {
  const response = await app.inject({ method: 'POST', url: `/agent/approvals/${id}/${decision}`, payload: {} })
  return { status: response.statusCode, body: response.json() as Data }
}

/** The undo window, closed: as the maintenance sweep finds it 20 s later. */
const windowClosed = (id: string) => inside(() => database.client.agentApproval.update({ where: { id }, data: { executeAfter: new Date(Date.now() - 1000) } }))

describe('Settings › AI approve takes the Approvals page path', { timeout: DB_TEST_TIMEOUT }, () => {
  it('parks for the undo window instead of running at once', async () => {
    const id = await queueAs(ALL, 'set-price', { productId: ids.free, price: 101 })
    const decided = await settingsDecide(id, 'approve')
    expect(decided).toMatchObject({ status: 200, body: { ok: true, status: 'scheduled' } })
    expect(await basePrice(ids.free)).toBe(100)
    expect(await approval(id)).toMatchObject({ status: 'scheduled', decidedByUserId: approverId })
    // Too early: refused, still nothing changed.
    expect(await inside(() => commitScheduledApproval(id))).toMatchObject({ ok: false, error: 'still inside the undo window' })
    expect(await basePrice(ids.free)).toBe(100)
    await windowClosed(id)
    expect(await inside(() => commitScheduledApproval(id))).toMatchObject({ ok: true })
    expect(await basePrice(ids.free)).toBe(101)
    await inside(() => database.client.product.update({ where: { id: ids.free }, data: { basePrice: '100.00' } }))
  })

  it('two identical -10 % requests approved there: the first runs, the second is handed back as stale', async () => {
    const args = { products: [ids.free], operation: 'percent', value: -10 }
    const first = await queueAs(ALL, 'bulk-price-change', args)
    const second = await queueAs(ALL, 'bulk-price-change', args)
    expect((await settingsDecide(first, 'approve')).body).toMatchObject({ ok: true, status: 'scheduled' })
    expect((await settingsDecide(second, 'approve')).body).toMatchObject({ ok: true, status: 'scheduled' })
    await windowClosed(first)
    await windowClosed(second)
    expect(await inside(() => commitScheduledApproval(first))).toMatchObject({ ok: true })
    expect(await basePrice(ids.free)).toBe(90)
    const late = await inside(() => commitScheduledApproval(second))
    expect(late.ok).toBe(false)
    expect(late.error).toMatch(/^not run — /)
    // 90, not 81: the second -10 % did not compound.
    expect(await basePrice(ids.free)).toBe(90)
    expect(await approval(second)).toMatchObject({ status: 'pending', decidedBy: null })
  })

  it('reject discards it, with nothing changed', async () => {
    const id = await queueAs(ALL, 'set-price', { productId: ids.free, price: 5 })
    expect(await settingsDecide(id, 'reject')).toMatchObject({ status: 200, body: { ok: true, status: 'rejected' } })
    expect(await approval(id)).toMatchObject({ status: 'rejected', decidedByUserId: approverId })
    expect(await basePrice(ids.free)).toBe(90)
  })

  it('a request past its expiry cannot be approved, even before the sweep marks it expired', async () => {
    const id = await queueAs(ALL, 'set-price', { productId: ids.free, price: 95 })
    await inside(() => database.client.agentApproval.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } }))
    const decided = await settingsDecide(id, 'approve')
    expect(decided.body).toMatchObject({ ok: false, error: 'This request expired before anyone approved it. Nothing changed.' })
    expect(await approval(id)).toMatchObject({ status: 'pending', decidedBy: null })
    expect(await basePrice(ids.free)).toBe(90)
  })
})

describe('set-price', { timeout: DB_TEST_TIMEOUT }, () => {
  it('refuses 0, an empty price and null: each would have become a master price of 0', async () => {
    for (const price of [0, '', null, -1]) {
      const out = await dryRun('set-price', { productId: ids.bounded, price })
      expect(out.refused?.code, `price ${JSON.stringify(price)}`).toBe('invalid_arguments')
    }
  })

  it('refuses a price outside the floor or ceiling set on the product, in the preview and when it runs', async () => {
    const low = await dryRun('set-price', { productId: ids.bounded, price: 30 })
    expect(low).toMatchObject({ ok: false })
    // The shared verdict (`storedPriceReason`), in the master-price write's own words: the preview says what the run would.
    expect(low.error).toBe('Not changed: 30.00 is below its pricing floor of 40.00.')
    const high = await dryRun('set-price', { productId: ids.bounded, price: 90 })
    expect(high.error).toContain('90.00 is above its pricing ceiling of 80.00')
    expect(await dryRun('set-price', { productId: ids.bounded, price: 60 })).toMatchObject({ ok: true, preview: { changes: { 'base price': { from: 50, to: 60 } } } })

    // Approved at 60, then the floor rose to 70: the run refuses and changes nothing.
    await inside(() => database.client.product.update({ where: { id: ids.bounded }, data: { minPrice: '70.00' } }))
    const ran = (await inside(() => executeTool(ALL, 'set-price', { productId: ids.bounded, price: 60 }))).raw
    expect(ran).toMatchObject({ ok: false, error: 'Not changed: 60.00 is below its pricing floor of 70.00.' })
    expect(await basePrice(ids.bounded)).toBe(50)
    await inside(() => database.client.product.update({ where: { id: ids.bounded }, data: { minPrice: '40.00' } }))
  })
})

describe('bulk-price-change and the product’s own floor and ceiling', { timeout: DB_TEST_TIMEOUT }, () => {
  it('refuses a master price outside them, naming the product and the bound', async () => {
    const out = await dryRun('bulk-price-change', { products: [ids.bounded, ids.free], operation: 'percent', value: -30 })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('A master price must stay within the pricing floor and ceiling set on the product: REV-BOUNDED (35.00 is below its pricing floor of 40.00)')
    expect(out.error).toMatch(/Nothing was queued\.$/)
  })

  it('names a listing its pricing rule takes outside them: the push will refuse it', async () => {
    // Master 20 → 22 is inside the ceiling of 25; the IT listing at master + 50 % would be 33.
    const out = await dryRun('bulk-price-change', { products: ['REV-PERCENT'], operation: 'percent', value: 10 })
    expect(out.ok, out.error).toBe(true)
    expect(out.preview).toMatchObject({ totals: { listingsSent: 1, listingsRefusedAtPush: 1 } })
    expect(out.preview!.warning).toContain('1 listing would be sent a price outside the pricing floor or ceiling set on the product')
    expect(out.preview!.listings).toEqual(['REV-PERCENT · Amazon IT: 30.00 → 33.00 (refused when sent: 33.00 is above its pricing ceiling of 25.00)'])
  })

  it('a change with no bound in play reads as before: no new keys', async () => {
    const out = await dryRun('bulk-price-change', { products: ['REV-MULTI'], operation: 'percent', value: 10 })
    expect(out.ok, out.error).toBe(true)
    expect(out.preview!.totals).not.toHaveProperty('listingsRefusedAtPush')
    expect(out.preview).not.toHaveProperty('warning')
  })
})

describe('publish-listing re-sends exactly one listing', { timeout: DB_TEST_TIMEOUT }, () => {
  it('without a market, refuses to guess between the markets the product sells in', async () => {
    const out = await dryRun('publish-listing', { productId: ids.multi, channel: 'AMAZON' })
    expect(out).toMatchObject({ ok: false, error: 'This product has AMAZON listings in DE, IT, UK. Name the market (marketplace) to publish. Nothing was queued.' })
  })

  it('with a market, previews that listing and queues that listing', async () => {
    const out = await dryRun('publish-listing', { productId: ids.multi, channel: 'amazon', marketplace: 'de' })
    expect(out).toMatchObject({ ok: true, preview: { channel: 'AMAZON', marketplace: 'DE', title: 'Multi DE', currentlyPublished: true } })
    const ran = (await inside(() => executeTool(ALL, 'publish-listing', { productId: ids.multi, channel: 'AMAZON', marketplace: 'DE' }))).raw
    expect(ran.ok, ran.error).toBe(true)
    const row = await inside(() => database.client.outboundSyncQueue.findUniqueOrThrow({ where: { id: (ran.data as Data).queueId } }))
    expect(row).toMatchObject({ channelListingId: ids.multiDe, syncType: 'LISTING_SYNC', payload: { marketplace: 'DE' } })
  })

  it('refuses a draft, which the publish worker would skip', async () => {
    const out = await dryRun('publish-listing', { productId: ids.multi, channel: 'EBAY', marketplace: 'IT' })
    expect(out).toMatchObject({ ok: false, error: 'The EBAY IT listing is a draft or has publishing switched off in Nexus, so the publish worker would skip it and send nothing. Publish it from the product in Nexus. Nothing was queued.' })
  })

  it('a market the product does not sell in is named', async () => {
    const out = await dryRun('publish-listing', { productId: ids.multi, channel: 'AMAZON', marketplace: 'FR' })
    expect(out).toMatchObject({ ok: false, error: 'This product has no AMAZON FR listing. Nothing was queued.' })
  })
})

describe('reads', { timeout: DB_TEST_TIMEOUT }, () => {
  it('send-customer-message warns about Amazon messaging for an Amazon order (its market is IT)', async () => {
    const order = await inside(() => database.client.order.findFirstOrThrow({ where: { channelOrderId: 'REV-ORDER-NEW-0' } }))
    const out = await dryRun('send-customer-message', { orderId: order.id, message: 'Your parcel ships today.' })
    expect(out.ok, out.error).toBe(true)
    expect(out.preview).toMatchObject({ marketplace: 'IT', marketplaceWarning: 'Amazon orders: contact buyers via Amazon Buyer-Seller Messaging, not direct email (policy).' })
  })

  it('order-search filters the status before the limit', async () => {
    const shipped = await dryRun('order-search', { status: 'Shipped', limit: 20 })
    expect(shipped.ok, shipped.error).toBe(true)
    expect(shipped.data!.orders.map((o: Data) => o.channelOrderId)).toEqual(['REV-ORDER-SHIPPED-OLD'])
    expect((await dryRun('order-search', { status: 'lost' })).refused?.code).toBe('invalid_arguments')
  })

  it('product-analytics: revenue per currency, and a parent counts its variation', async () => {
    const parent = await dryRun('product-analytics', { productId: ids.parent, days: 30 })
    expect(parent.data).toMatchObject({ sku: 'REV-PARENT', variationsCounted: 1, unitsSold: 3, orderCount: 2, revenueByCurrency: { EUR: 20, SEK: 100 } })
    expect(parent.data).not.toHaveProperty('revenue')
    const child = await dryRun('product-analytics', { productId: ids.child, days: 30 })
    expect(child.data).toMatchObject({ unitsSold: 3, revenueByCurrency: { EUR: 20, SEK: 100 } })
    expect(child.data).not.toHaveProperty('variationsCounted')
    expect((await dryRun('product-analytics', { productId: ids.loner })).data).toMatchObject({ unitsSold: 0, revenueByCurrency: {} })
    // Money stays with those cleared for it.
    const hidden = await dryRun('product-analytics', { productId: ids.parent }, NO_MONEY)
    expect(hidden.data).toMatchObject({ unitsSold: 3 })
    expect(hidden.data).not.toHaveProperty('revenueByCurrency')
  })

  it('insights-metric: the database adds it up, per currency and market', async () => {
    const out = await dryRun('insights-metric', { days: 30 })
    expect(out.ok, out.error).toBe(true)
    // 22 + 1 + 1 orders at EUR 10 / 10 / 20, and one at SEK 100.
    expect(out.data).toMatchObject({ orderCount: 25, unitsSold: 3, revenueByCurrency: { EUR: 250, SEK: 100 } })
    expect(out.data!.topMarketplaces).toEqual([{ marketplace: 'IT', orderCount: 24 }, { marketplace: 'SE', orderCount: 1 }])
  })

  it('channel-price-stock: each listing’s currency and the master currency', async () => {
    const out = await dryRun('channel-price-stock', { productId: ids.multi, limit: 10 })
    expect(out.ok, out.error).toBe(true)
    const byMarket = Object.fromEntries((out.data!.items as Data[]).map((item) => [`${item.channel} ${item.market}`, item.price]))
    expect(byMarket['AMAZON UK']).toMatchObject({ currency: 'GBP', masterCurrency: 'EUR', followsMaster: true })
    expect(byMarket['AMAZON IT']).toMatchObject({ currency: 'EUR', masterCurrency: 'EUR' })
    expect(byMarket['EBAY IT']).toMatchObject({ currency: 'EUR' })
  })
})
