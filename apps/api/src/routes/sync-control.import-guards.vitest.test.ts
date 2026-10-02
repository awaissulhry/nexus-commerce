/**
 * MCP full control 08 S2 (F9) — the Sync Control Excel import (preview and apply) obeys the same two guards as the
 * Sync Control actions.
 *
 *   FBA   The apply wrote a listing whenever `fulfillmentMethod` was not 'FBA'. A listing that is FBA by its other
 *         evidence (Amazon's fulfilment channel code, the product's method) took a pinned quantity or a pause. Now
 *         the fail-closed `isFbaCoordinate` test decides, in the preview and again in the apply.
 *   EU    Amazon keeps ONE merchant quantity per SKU across the EU markets. The import had no EU gate: a sheet that
 *         pinned DE alone (or set a buffer on IT alone) was written, and only the send backstop refused later, so
 *         Nexus and Amazon disagreed. Now such a product's Amazon EU rows are skipped with the reason, and nothing is
 *         written for them; a sheet that sets every EU market the same way applies as before.
 *
 * The real Sync Control route over a real PostgreSQL in-process (PGlite); the workbook is the route's own format.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../services/outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined), enqueueOutboundRowsInstant: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return { addJobSafely: vi.fn(async () => undefined), outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue, redis: { connection: null } }
})
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../services/product-read-cache.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) },
}))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { buildSyncControlWorkbook } from '../services/sync-control-excel.js'

const BUSINESS = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(BUSINESS, work)
let app: FastifyInstance
let account = ''

beforeAll(async () => {
  await scoped(async () => {
    for (const code of ['IT', 'DE', 'FR', 'UK']) {
      await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    }
    account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'import-guards', isActive: true } })).id
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

type Row = { marketplace: string; method?: 'FBA' | 'FBM' | null; amazonChannelCode?: string }
async function seed(id: string, rows: Row[]) {
  return scoped(async () => {
    await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10, totalStock: 9 } })
    const out: Record<string, string> = {}
    for (const r of rows) {
      const row = await prisma.channelListing.create({ data: {
        productId: id, channel: 'AMAZON', channelConnectionId: account, channelMarket: `AMAZON_${r.marketplace}`,
        marketplace: r.marketplace, region: 'EU', price: 10, quantity: 5, followMasterQuantity: true, stockBuffer: 0,
        fulfillmentMethod: r.method === undefined ? 'FBM' : r.method, listingStatus: 'ACTIVE', isPublished: true,
        platformAttributes: r.amazonChannelCode ? { fulfillment_availability: [{ fulfillment_channel_code: r.amazonChannelCode }] } : undefined,
      } as never })
      out[r.marketplace] = row.id
    }
    return out
  })
}
const listingState = async (ids: Record<string, string>) => {
  const rows = await scoped(() => prisma.channelListing.findMany({
    where: { id: { in: Object.values(ids) } },
    select: { id: true, quantity: true, quantityOverride: true, followMasterQuantity: true, syncPaused: true, stockBuffer: true },
  }))
  return Object.fromEntries(Object.entries(ids).map(([k, id]) => {
    const { id: _id, ...rest } = rows.find((r) => r.id === id)!
    return [k, rest]
  }))
}

type SheetRow = { sku: string; market: string; mode: string; pinnedQty?: number | ''; buffer?: number }
async function upload(path: 'preview' | 'apply', rows: SheetRow[]) {
  const workbook = await buildSyncControlWorkbook(rows.map((r) => ({
    product: r.sku, sku: r.sku, channel: 'AMAZON', market: r.market, itemId: '', lane: 'LISTING', mode: r.mode,
    pinnedQty: r.pinnedQty ?? '', buffer: r.buffer ?? 0, pool: '', intended: '', live: '', drift: '', locked: '',
  })), [])
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(workbook)]), 'sync-control.xlsx')
  const request = new Request('http://test.invalid', { method: 'POST', body: form })
  const response = await app.inject({
    method: 'POST', url: `/api/stock/sync-control/import/${path}`,
    headers: { 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()),
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as { changes?: Array<{ key: string; field: string; to: string }>; skipped: Array<{ key: string; reason: string }>; applied?: number }
}
const FOLLOWING = { quantity: 5, quantityOverride: null, followMasterQuantity: true, syncPaused: false, stockBuffer: 0 }

describe('F9 — the import never writes an FBA listing (fail-closed isFbaCoordinate)', () => {
  it('a listing that is FBA by Amazon’s fulfilment channel code takes no pinned quantity', async () => {
    const l = await seed('imp-fba-pin', [{ marketplace: 'UK', method: null, amazonChannelCode: 'AMAZON_EU' }])
    const preview = await upload('preview', [{ sku: 'IMP-FBA-PIN', market: 'UK', mode: 'Pinned', pinnedQty: 3 }])
    expect(preview.changes).toEqual([])
    expect(preview.skipped).toEqual([{ key: 'IMP-FBA-PIN@AMAZON:UK', reason: 'FBA (Amazon-managed)' }])
    await upload('apply', [{ sku: 'IMP-FBA-PIN', market: 'UK', mode: 'Pinned', pinnedQty: 3 }])
    expect(await listingState(l)).toEqual({ UK: FOLLOWING })
  }, 60_000)

  it('nor is it paused', async () => {
    const l = await seed('imp-fba-pause', [{ marketplace: 'UK', method: null, amazonChannelCode: 'AMAZON_EU' }])
    await upload('apply', [{ sku: 'IMP-FBA-PAUSE', market: 'UK', mode: 'Paused' }])
    expect(await listingState(l)).toEqual({ UK: FOLLOWING })
  }, 60_000)

  it('control: an FBM listing outside the EU group is pinned as the sheet says', async () => {
    const l = await seed('imp-fbm-uk', [{ marketplace: 'UK' }])
    const out = await upload('apply', [{ sku: 'IMP-FBM-UK', market: 'UK', mode: 'Pinned', pinnedQty: 3 }])
    expect(out.applied).toBe(1)
    expect(await listingState(l)).toEqual({ UK: { ...FOLLOWING, quantity: 3, quantityOverride: 3, followMasterQuantity: false } })
  }, 60_000)
})

describe('F9 — the Amazon EU gate on the import', () => {
  it('pinning DE alone while IT and FR follow is skipped with the reason; nothing is written', async () => {
    const l = await seed('imp-eu-de', [{ marketplace: 'IT' }, { marketplace: 'DE' }, { marketplace: 'FR' }])
    const sheet = [{ sku: 'IMP-EU-DE', market: 'DE', mode: 'Pinned', pinnedQty: 0 }]
    const preview = await upload('preview', sheet)
    expect(preview.changes).toEqual([])
    expect(preview.skipped).toEqual([{ key: 'IMP-EU-DE@AMAZON:DE', reason: expect.stringMatching(/ONE quantity per SKU across EU markets/) }])
    const applied = await upload('apply', sheet)
    expect(applied.applied).toBe(0)
    expect(await listingState(l)).toEqual({ IT: FOLLOWING, DE: FOLLOWING, FR: FOLLOWING })
  }, 60_000)

  it('a buffer on IT alone is skipped too (a following listing publishes pool − buffer)', async () => {
    const l = await seed('imp-eu-buf', [{ marketplace: 'IT' }, { marketplace: 'DE' }])
    await upload('apply', [{ sku: 'IMP-EU-BUF', market: 'IT', mode: '', buffer: 3 }])
    expect(await listingState(l)).toEqual({ IT: FOLLOWING, DE: FOLLOWING })
  }, 60_000)

  it('control: every EU market pinned at the same number in one sheet is applied', async () => {
    const l = await seed('imp-eu-all', [{ marketplace: 'IT' }, { marketplace: 'DE' }, { marketplace: 'FR' }])
    const out = await upload('apply', ['IT', 'DE', 'FR'].map((market) => ({ sku: 'IMP-EU-ALL', market, mode: 'Pinned', pinnedQty: 2 })))
    expect(out.applied).toBe(3)
    const pinned = { ...FOLLOWING, quantity: 2, quantityOverride: 2, followMasterQuantity: false }
    expect(await listingState(l)).toEqual({ IT: pinned, DE: pinned, FR: pinned })
  }, 60_000)

  it('control: an FBA sibling expresses no intent, so pinning the one FBM EU market is applied', async () => {
    const l = await seed('imp-eu-fba-sibling', [{ marketplace: 'IT' }, { marketplace: 'DE', method: null, amazonChannelCode: 'AMAZON_EU' }])
    const out = await upload('apply', [{ sku: 'IMP-EU-FBA-SIBLING', market: 'IT', mode: 'Pinned', pinnedQty: 4 }])
    expect(out.applied).toBe(1)
    expect(await listingState(l)).toEqual({ IT: { ...FOLLOWING, quantity: 4, quantityOverride: 4, followMasterQuantity: false }, DE: FOLLOWING })
  }, 60_000)
})
