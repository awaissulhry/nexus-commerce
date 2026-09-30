/**
 * Sync Control — a stock buffer on one Amazon EU market is held to the whole EU group, like a quantity.
 *
 * 🔴 WHAT THIS GUARDS. Amazon keeps ONE merchant quantity per SKU across the EU markets, and a listing that follows the
 * pool publishes pool − buffer. Sync Control's EU gate (SCT.4/5b) covered FOLLOW / PIN / ZERO_PIN but not BUFFER, so a
 * buffer set on IT alone left IT and DE sending Amazon two different numbers for one quantity. The Studio matrix
 * already writes a buffer to the whole EU group. Now BUFFER takes the same gate as a quantity: without consent it
 * answers 409 with the true scope and writes nothing; with `expandEuAligned` it covers every open, non-FBA EU row.
 *
 * The real Sync Control route over a real PostgreSQL in-process (PGlite).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../services/outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return { addJobSafely: vi.fn(async () => undefined), outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue, redis: { connection: null } }
})
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { projectBufferAndDetect } from '../services/amazon-eu-quantity-guard.js'

const BUSINESS = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(BUSINESS, work)
let app: FastifyInstance
let account = ''
let ebayAccount = ''
beforeAll(async () => {
  await scoped(async () => {
    for (const code of ['IT', 'DE', 'FR', 'ES']) {
      await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    }
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'buffer-eu', isActive: true } })).id
    // Every listing names its account, as a live one does: the queue row's destination is then read through the
    // transaction (a listing with none reads the accounts through a second connection, which PGlite does not have).
    ebayAccount = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'buffer-eu-ebay', isActive: true } })).id
  })
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    Object.assign(request, { authUser: { id: 'person-sc', email: 'sync-control@example.test', displayName: 'Sync Control person', status: 'active', mfaRequired: false, twoFactorEnabledAt: null, permissionsVersion: 1, roleKeys: [] } })
    withWorkspace(BUSINESS, done)
  })
  await app.register((await import('@fastify/multipart')).default)
  const { default: routes } = await import('./sync-control.routes.js')
  await app.register(routes, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

type Row = { marketplace: string; fba?: boolean; closed?: boolean; buffer?: number; channel?: string }
async function seed(id: string, rows: Row[]) {
  return scoped(async () => {
    await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10, totalStock: 9 } })
    const out: Record<string, string> = {}
    for (const r of rows) {
      const channel = r.channel ?? 'AMAZON'
      const row = await prisma.channelListing.create({ data: {
        productId: id, channel, channelConnectionId: channel === 'AMAZON' ? account : ebayAccount, channelMarket: `${channel}_${r.marketplace}`,
        marketplace: r.marketplace, region: 'EU', price: 10, quantity: 5, followMasterQuantity: true, stockBuffer: r.buffer ?? 0,
        fulfillmentMethod: r.fba ? 'FBA' : 'FBM', offerClosedAt: r.closed ? new Date() : null, listingStatus: 'ACTIVE', isPublished: true,
      } })
      out[`${channel}:${r.marketplace}`] = row.id
    }
    return out
  })
}
const target = (productId: string, marketplace: string, channel = 'AMAZON') =>
  ({ productId, channel, marketplace, channelConnectionId: channel === 'AMAZON' ? account : ebayAccount, aliasKey: '' })
const buffers = async (ids: Record<string, string>) => {
  const rows = await scoped(() => prisma.channelListing.findMany({ where: { id: { in: Object.values(ids) } }, select: { id: true, stockBuffer: true, version: true } }))
  return Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, rows.find((r) => r.id === id)!.stockBuffer]))
}
const act = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/stock/sync-control/actions', payload: body as never })

describe('a buffer on one Amazon EU market', () => {
  it('🔴 without consent: 409 with the true scope, and NOTHING is written', async () => {
    const l = await seed('buf-eu', [{ marketplace: 'IT' }, { marketplace: 'DE' }, { marketplace: 'FR', closed: true }, { marketplace: 'ES', fba: true }])
    const before = await buffers(l)
    const res = await act({ action: 'BUFFER', buffer: 2, listings: [target('buf-eu', 'IT')] })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ euExpandRequired: true, addedRowCount: 1, preview: [{ sku: 'BUF-EU', addedMarkets: ['DE'] }] })
    expect(res.json().error).toMatch(/Amazon keeps ONE quantity per SKU across EU markets, so this BUFFER really covers 1 more row\(s\) on DE/)
    expect(await buffers(l)).toEqual(before)
    expect(await scoped(() => prisma.outboundSyncQueue.count({ where: { channelListingId: { in: Object.values(l) } } }))).toBe(0)
  }, 60_000)

  it('🔴 with consent (expandEuAligned): every open, non-FBA EU row takes the buffer — never the closed or the FBA one', async () => {
    const l = await seed('buf-eu-ok', [{ marketplace: 'IT' }, { marketplace: 'DE' }, { marketplace: 'FR', closed: true }, { marketplace: 'ES', fba: true }])
    const res = await act({ action: 'BUFFER', buffer: 2, listings: [target('buf-eu-ok', 'IT')], expandEuAligned: true })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ euExpanded: 1 })
    expect(await buffers(l)).toEqual({ 'AMAZON:IT': 2, 'AMAZON:DE': 2, 'AMAZON:FR': 0, 'AMAZON:ES': 0 })
  }, 60_000)

  it('no conflict when the other EU markets already hold that buffer: written as asked, nothing added', async () => {
    const l = await seed('buf-eu-agree', [{ marketplace: 'IT' }, { marketplace: 'DE', buffer: 2 }])
    const res = await act({ action: 'BUFFER', buffer: 2, listings: [target('buf-eu-agree', 'IT')] })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().euExpanded).toBeUndefined()
    expect(await buffers(l)).toEqual({ 'AMAZON:IT': 2, 'AMAZON:DE': 2 })
  }, 60_000)

  it('the whole EU group in one action needs no consent', async () => {
    const l = await seed('buf-eu-all', [{ marketplace: 'IT' }, { marketplace: 'DE' }])
    const res = await act({ action: 'BUFFER', buffer: 3, listings: [target('buf-eu-all', 'IT'), target('buf-eu-all', 'DE')] })
    expect(res.statusCode, res.body).toBe(200)
    expect(await buffers(l)).toEqual({ 'AMAZON:IT': 3, 'AMAZON:DE': 3 })
  }, 60_000)

  it('an eBay buffer is per listing, as before (eBay has real per-listing quantities)', async () => {
    const l = await seed('buf-ebay', [{ marketplace: 'IT', channel: 'EBAY' }])
    const res = await act({ action: 'BUFFER', buffer: 4, listings: [target('buf-ebay', 'IT', 'EBAY')] })
    expect(res.statusCode, res.body).toBe(200)
    expect(await buffers(l)).toEqual({ 'EBAY:IT': 4 })
  }, 60_000)

  it('positive control: the quantity gate is unchanged — PIN on IT alone still answers 409', async () => {
    await seed('pin-eu', [{ marketplace: 'IT' }, { marketplace: 'DE' }])
    await scoped(() => prisma.channelListing.updateMany({ where: { productId: 'pin-eu', marketplace: 'DE' }, data: { followMasterQuantity: false, quantityOverride: 3, quantity: 3 } }))
    const res = await act({ action: 'FOLLOW', listings: [target('pin-eu', 'IT')] })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ euExpandRequired: true })
  }, 60_000)
})

describe('projectBufferAndDetect', () => {
  const row = (marketplace: string, stockBuffer: number, extra: Record<string, unknown> = {}) =>
    ({ marketplace, followMasterQuantity: true, quantityOverride: null, quantity: 5, stockBuffer, ...extra })
  it('agreeing buffers are no conflict; a different one is, and names the markets', () => {
    expect(projectBufferAndDetect([row('IT', 0), row('DE', 2)], new Set(['IT']), 2).conflict).toBe(false)
    const v = projectBufferAndDetect([row('IT', 0), row('DE', 0)], new Set(['IT']), 2)
    expect(v).toEqual({ conflict: true, detail: 'buffers would differ (IT=2, DE=0) — Amazon keeps ONE quantity per SKU across EU markets' })
  })
  it('FBA, paused and closed rows express no intent and never make a conflict', () => {
    for (const extra of [{ isFba: true }, { syncPaused: true }, { offerClosed: true }]) {
      expect(projectBufferAndDetect([row('IT', 0), row('DE', 7, extra)], new Set(['IT']), 2).conflict, JSON.stringify(extra)).toBe(false)
    }
  })
})
