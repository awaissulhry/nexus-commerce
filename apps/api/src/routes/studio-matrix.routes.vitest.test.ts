/**
 * MX.1 — the four Matrix routes probed with `app.inject()`, prisma and the July primitives mocked so the DOOR's own
 * logic runs (CAS, refusals by name, noop, applied) against a small read.
 *
 *   read    : the response is validated at RUNTIME against the contract's vocabularies (every coordinate key/kind/cells,
 *             every cell's version/listing/sync/queue words) — the same shape check the page's parse boundary makes.
 *   write   : a stale `expectedVersion` → `conflict` carrying the CURRENT version and NOTHING delegated (positive control:
 *             the same cell with the right version → `applied` and the primitive called once); the parent → `refused` with
 *             the parent's sentence; an unchanged value → `noop` with no version spent; a price without
 *             `products.price.edit` → `refused` with the permission sentence (positive control: with it → applied).
 *   verbs   : `commit:false` answers EXACTLY `previewVerb(read, req, { can, simulated:false })` — one read fed to both;
 *             `commit:true` with a carried change the fresh preview does not reproduce → refused, nothing written.
 *   revert  : an unknown operation → 404 by name.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { previewVerb } from '@nexus/shared/matrix-preview'
import { MATRIX_CELL_KINDS, type MatrixRead } from '@nexus/shared/matrix-contract'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  follow: vi.fn(),
  buffer: vi.fn(),
  fulfil: vi.fn(),
  prices: vi.fn(),
  tx: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  bulkCreate: vi.fn(),
  bulkFindUnique: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('../db.js', () => ({
  default: {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => mocks.tx(fn),
    channelListing: { updateMany: (...a: unknown[]) => mocks.updateMany(...a), findMany: (...a: unknown[]) => mocks.findMany(...a), findUnique: (...a: unknown[]) => mocks.findUnique(...a) },
    bulkOperation: { create: (...a: unknown[]) => mocks.bulkCreate(...a), findUnique: (...a: unknown[]) => mocks.bulkFindUnique(...a), updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn().mockResolvedValue({}) },
    syncControlAudit: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    outboundSyncQueue: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  },
}))
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../services/pim/matrix.service.js', () => ({ getMatrixRead: (...a: unknown[]) => mocks.read(...a) }))
vi.mock('../services/follow-master.service.js', () => ({ setFollowMasterQuantity: (...a: unknown[]) => mocks.follow(...a), setStockBuffer: (...a: unknown[]) => mocks.buffer(...a) }))
vi.mock('../services/pim/fulfillment-method.service.js', () => ({ setFulfillmentMethod: (...a: unknown[]) => mocks.fulfil(...a) }))
vi.mock('../services/pim/channel-price-write.service.js', () => ({ writeChannelPrices: (...a: unknown[]) => mocks.prices(...a) }))
vi.mock('../services/stock-movement.service.js', () => ({ recascadeAfterSyncControlChange: async () => ({ ok: 0, noLedger: 0, failed: 0 }) }))
vi.mock('../services/outbound-enqueue.js', () => ({ fireOutboundJobs: async () => undefined }))
vi.mock('../services/sync-coalesce.js', () => ({ coalescePendingQuantityRows: async () => 0 }))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: (...a: unknown[]) => mocks.refresh(...a) } }))
vi.mock('../services/pim/studio-sheet.service.js', () => ({ UnknownProductError: class extends Error { code = 'unknown_product' } }))
vi.mock('../services/pim/product-relationship.service.js', () => ({ ProductRelationshipError: class extends Error { statusCode = 409; code = 'relationship' } }))

import routes from './studio-matrix.routes.js'

const read = (): MatrixRead => ({
  version: 9, productId: 'root', source: 'live', generatedAt: '2026-09-13T00:00:00.000Z', policies: [],
  coordinates: [
    { key: 'AMAZON:EU', kind: 'region-inventory', channel: 'AMAZON', market: 'EU', label: 'Amazon EU · Inventory · IT DE', region: 'EU', alias: null, accountId: 'acc', currency: 'EUR', connected: true, listed: null, draft: null, cells: ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState'], absent: [], sharedInventoryWith: ['IT', 'DE'], inventoryOn: null, vocabulary: { fulfilment: ['FBA', 'FBM'] } },
    { key: 'AMAZON:IT', kind: 'market', channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', region: 'EU', alias: null, accountId: 'acc', currency: 'EUR', connected: true, listed: 1, draft: 0, cells: ['listing', 'price', 'salePrice'], absent: [], sharedInventoryWith: null, inventoryOn: 'AMAZON:EU', vocabulary: { fulfilment: ['FBA', 'FBM'] } },
    { key: 'AMAZON:UK', kind: 'market', channel: 'AMAZON', market: 'UK', label: 'Amazon · UK', region: 'UK', alias: null, accountId: 'acc', currency: 'GBP', connected: true, listed: null, draft: null, cells: [], absent: [], sharedInventoryWith: null, inventoryOn: null, vocabulary: { fulfilment: ['FBA', 'FBM'] } },
  ],
  rows: [
    { id: 'root', sku: 'PARENT', role: 'parent', stock: { available: 10, uncounted: false, locations: [{ code: 'IT-MAIN', available: 10 }] }, basePrice: 100, status: 'ACTIVE', cells: {
      'AMAZON:EU': { listingId: 'l-root-it', version: 1, listing: null, fulfilment: { method: 'FBM', source: 'derived', guard: 'FBM', reported: null }, sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 10, held: 10, buffer: 0, poolAvailable: 10, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false }, queue: { state: 'never', at: null, reason: null, syncType: null, via: null }, price: null, sale: null, writable: { fulfilment: false, syncMode: false, syncQty: false, syncBuffer: false }, writeBlockedReason: { syncQty: 'Set on the variants — the parent has no listing of its own', fulfilment: 'Set on the variants — the parent has no listing of its own', syncMode: 'Set on the variants — the parent has no listing of its own', syncBuffer: 'Set on the variants — the parent has no listing of its own' } },
    } },
    { id: 'c1', sku: 'CHILD-1', role: 'variant', stock: { available: 10, uncounted: false, locations: [{ code: 'IT-MAIN', available: 10 }] }, basePrice: 100, status: 'ACTIVE', cells: {
      'AMAZON:EU': { listingId: 'l-c1-it', version: 3, listing: null, fulfilment: { method: 'FBM', source: 'set', guard: 'FBM', reported: null }, sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 10, held: 10, buffer: 0, poolAvailable: 10, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false }, queue: { state: 'sent', at: '2026-09-13T00:00:00.000Z', reason: null, syncType: 'QUANTITY_UPDATE', via: null }, price: null, sale: null, writable: { fulfilment: true, syncMode: true, syncQty: true, syncBuffer: true }, writeBlockedReason: {} },
      'AMAZON:IT': { listingId: 'l-c1-it', version: 3, listing: { state: 'listed', externalId: 'B0X', detail: null, published: true }, fulfilment: null, sync: null, queue: null, price: { value: 100, currency: 'EUR', source: 'master', formula: null, clamped: null }, sale: { value: null, start: null, end: null }, writable: { price: true, salePrice: true }, writeBlockedReason: {} },
    } },
  ],
})

let app: FastifyInstance
beforeAll(async () => { app = Fastify(); await app.register(routes); await app.ready() })
afterAll(() => app.close())
beforeEach(() => {
  vi.clearAllMocks()
  mocks.read.mockImplementation(async () => read())
  mocks.tx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ channelListing: { updateMany: (...a: unknown[]) => mocks.updateMany(...a), findUnique: (...a: unknown[]) => mocks.findUnique(...a) } }))
  mocks.updateMany.mockResolvedValue({ count: 1 })
  mocks.findMany.mockResolvedValue([{ id: 'l-c1-it', marketplace: 'IT', version: 3, offerClosedAt: null }, { id: 'l-c1-de', marketplace: 'DE', version: 5, offerClosedAt: null }])
  mocks.follow.mockResolvedValue({ updated: 2, skippedFba: 0, unchanged: 0, matched: 2, results: [] })
  mocks.prices.mockImplementation(async ({ targets }: { targets: Array<{ listingId: string; expectedVersion: number }> }) => ({ results: targets.map((t) => ({ listingId: t.listingId, outcome: 'applied', version: t.expectedVersion + 1, queueId: 'q1' })), applied: targets.length, refused: 0, noop: 0, conflict: 0 }))
  mocks.refresh.mockResolvedValue(undefined)
  mocks.bulkCreate.mockResolvedValue({ id: 'op-1', createdAt: new Date('2026-09-13T10:00:00.000Z') })
  mocks.bulkFindUnique.mockResolvedValue(null)
})

const LISTING = new Set(['listed', 'draft', 'excluded', 'not-set-up', 'needs-value', 'suppressed', 'closed', 'error', 'ended'])
const SYNC = new Set(['FOLLOW', 'PINNED', 'PAUSED', 'FBA_EXCLUDED', 'UNCOUNTED', 'CLOSED'])
const QUEUE = new Set(['sent', 'queued', 'sending', 'failed', 'dead', 'paused', 'never'])

/** The runtime shape check the page's parse boundary makes, plus the vocabularies it trusts blindly. */
export function assertMatrixShape(body: unknown): string[] {
  const problems: string[] = []
  const b = body as MatrixRead
  if (b.source !== 'live') problems.push('source is not live')
  if (typeof b.version !== 'number') problems.push('no version')
  const keys = new Set<string>()
  for (const c of b.coordinates) {
    if (typeof c.key !== 'string') problems.push('coordinate without key')
    keys.add(c.key)
    if (!['market', 'region-inventory', 'global'].includes(c.kind)) problems.push(`${c.key}: kind ${c.kind}`)
    for (const k of c.cells) if (!MATRIX_CELL_KINDS.includes(k)) problems.push(`${c.key}: cell kind ${k}`)
    if (c.kind === 'region-inventory' && !c.sharedInventoryWith?.length) problems.push(`${c.key}: region without sharedInventoryWith`)
    if (c.inventoryOn && !b.coordinates.some((x) => x.key === c.inventoryOn)) problems.push(`${c.key}: inventoryOn points nowhere`)
    if (c.inventoryOn && c.cells.some((k) => ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState'].includes(k))) problems.push(`${c.key}: carries inventory kinds despite inventoryOn`)
  }
  for (const r of b.rows) {
    if (!['parent', 'variant'].includes(r.role)) problems.push(`${r.sku}: role`)
    for (const [k, c] of Object.entries(r.cells)) {
      if (!keys.has(k)) problems.push(`${r.sku}: cell on unknown coordinate ${k}`)
      if (typeof c.version !== 'number') problems.push(`${r.sku}/${k}: version`)
      if (c.listing && !LISTING.has(c.listing.state)) problems.push(`${r.sku}/${k}: listing ${c.listing.state}`)
      if (c.sync && !SYNC.has(c.sync.kind)) problems.push(`${r.sku}/${k}: sync ${c.sync.kind}`)
      if (c.queue && !QUEUE.has(c.queue.state)) problems.push(`${r.sku}/${k}: queue ${c.queue.state}`)
      for (const w of Object.keys(c.writable)) if (!MATRIX_CELL_KINDS.includes(w as never)) problems.push(`${r.sku}/${k}: writable ${w}`)
      for (const [w, v] of Object.entries(c.writable)) if (v === false && !c.writeBlockedReason[w as never]) problems.push(`${r.sku}/${k}: ${w} held without a sentence`)
    }
  }
  return problems
}

describe('GET /products/:id/studio/matrix', () => {
  it('answers the read, validated at runtime against the contract vocabularies, and asks the price permission', async () => {
    const res = await app.inject({ method: 'GET', url: '/products/root/studio/matrix?accountId=acc&locale=it' })
    expect(res.statusCode).toBe(200)
    expect(assertMatrixShape(res.json())).toEqual([])
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ productId: 'root', accountId: 'acc', locale: 'it', canEditPrice: true }))
    /* the validator has teeth: a read with a held cell and no sentence is a problem */
    const broken = read(); broken.rows[1]!.cells['AMAZON:IT']!.writable.price = false
    expect(assertMatrixShape(broken)).toEqual(['CHILD-1/AMAZON:IT: price held without a sentence'])
  })
})

describe('PATCH /products/:id/studio/matrix — the door', () => {
  const write = (cells: unknown[]) => app.inject({ method: 'PATCH', url: '/products/root/studio/matrix', payload: { cells } })
  it('a stale expectedVersion is a conflict carrying the CURRENT version and delegates nothing; the right version applies once', async () => {
    const stale = await write([{ rowId: 'c1', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 7, expectedVersion: 2 }])
    expect(stale.json().results[0]).toMatchObject({ outcome: 'conflict', version: 3 })
    expect(mocks.follow).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
    /* positive control */
    const ok = await write([{ rowId: 'c1', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 7, expectedVersion: 3 }])
    expect(ok.json().results[0]).toMatchObject({ outcome: 'applied', version: 4, expandedTo: ['AMAZON:IT', 'AMAZON:DE'] })
    expect(mocks.follow).toHaveBeenCalledTimes(1)
    expect(mocks.follow).toHaveBeenCalledWith(expect.objectContaining({ productIds: ['c1'], channel: 'AMAZON', markets: ['IT', 'DE'], follow: false }))
    /* the typed value is staged into `quantity` under CAS on EVERY EU row, with each row's own version */
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: 'l-c1-it', version: 3 }, data: { quantity: 7, version: { increment: 1 } } })
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: 'l-c1-de', version: 5 }, data: { quantity: 7, version: { increment: 1 } } })
    expect(mocks.refresh).toHaveBeenCalledWith(['c1'])
  })
  it('the parent is refused with its own sentence; an unchanged Follow is a noop that spends no version', async () => {
    const parent = await write([{ rowId: 'root', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 1, expectedVersion: 1 }])
    expect(parent.json().results[0]).toMatchObject({ outcome: 'refused', reason: 'Set on the variants — the parent has no listing of its own', version: 1 })
    const same = await write([{ rowId: 'c1', coordinateKey: 'AMAZON:EU', cell: 'syncMode', value: 'FOLLOW', expectedVersion: 3 }])
    expect(same.json().results[0]).toMatchObject({ outcome: 'noop', version: 3 })
    expect(mocks.follow).not.toHaveBeenCalled(); expect(mocks.updateMany).not.toHaveBeenCalled()
  })
  it('a sibling EU row that moved makes the region write a conflict and rolls back — never a partial EU write', async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    mocks.findUnique.mockResolvedValue({ version: 3 })
    const res = await write([{ rowId: 'c1', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 7, expectedVersion: 3 }])
    expect(res.json().results[0]).toMatchObject({ outcome: 'conflict' })
    expect(mocks.follow).not.toHaveBeenCalled()
  })
  it('products.price.edit is enforced on the price cells inside the door, with a positive control', async () => {
    process.env.NEXUS_RBAC_MODE = 'enforce'
    try {
      const held = await write([{ rowId: 'c1', coordinateKey: 'AMAZON:IT', cell: 'price', value: 90, expectedVersion: 3 }])
      expect(held.json().results[0]).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('products.price.edit') })
      expect(mocks.prices).not.toHaveBeenCalled()
    } finally { delete process.env.NEXUS_RBAC_MODE }
    const ok = await write([{ rowId: 'c1', coordinateKey: 'AMAZON:IT', cell: 'price', value: 90, expectedVersion: 3 }])
    expect(ok.json().results[0]).toMatchObject({ outcome: 'applied', version: 4 })
    expect(mocks.prices).toHaveBeenCalledWith(expect.objectContaining({ targets: [{ listingId: 'l-c1-it', price: 90, expectedVersion: 3 }], source: 'MANUAL_OVERRIDE' }))
  })
  it('refuses a malformed body at the boundary', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/products/root/studio/matrix', payload: { cells: [{ rowId: 'c1' }] } })).statusCode).toBe(400)
  })
})

describe('POST …/verbs and …/verbs/:id/revert', () => {
  it('commit:false answers exactly the shared preview run on the same read', async () => {
    const req = { params: { verb: 'adjust-prices', percent: -5 }, targets: [{ rowId: 'c1', coordinateKey: 'AMAZON:IT' }, { rowId: 'root', coordinateKey: 'AMAZON:IT' }], commit: false }
    const res = await app.inject({ method: 'POST', url: '/products/root/studio/matrix/verbs', payload: req })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(previewVerb(read(), req as never, { can: () => true, simulated: false }))))
    expect(res.json().changes[0]).toMatchObject({ sku: 'CHILD-1', to: 95, toLabel: '€95.00' })
    expect(res.json().simulated).toBe(false)
  })
  it('commit:true re-verifies a carried change and refuses one the fresh preview does not reproduce; the honest one applies as ONE operation', async () => {
    const carried = { verb: 'set-price', changes: [
      { rowId: 'c1', sku: 'CHILD-1', coordinateKey: 'AMAZON:IT', cell: 'price', from: 100, to: 80, fromLabel: '€100.00', toLabel: '€80.00' },
      { rowId: 'root', sku: 'PARENT', coordinateKey: 'AMAZON:IT', cell: 'price', from: null, to: 80, fromLabel: '—', toLabel: '€80.00' },
    ], refusals: [], notices: [], confirm: 'confirm', confirmWord: null, simulated: false }
    const res = await app.inject({ method: 'POST', url: '/products/root/studio/matrix/verbs', payload: { params: { verb: 'set-price' }, targets: carried.changes.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey })), commit: true, preview: carried } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.results.map((r: { outcome: string }) => r.outcome)).toEqual(['applied', 'refused'])
    expect(body.results[1].reason).toBe('No listing on this coordinate') // the parent has no AMAZON:IT cell in this read → the fresh preview refuses it
    expect(body.operation).toMatchObject({ id: 'op-1', verb: 'set-price', applied: 1, refused: 1 })
    expect(body.operation.before).toEqual([{ rowId: 'c1', coordinateKey: 'AMAZON:IT', cells: read().rows[1]!.cells['AMAZON:IT'] }])
    expect(mocks.bulkCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PARTIAL', changeCount: 2 }) }))
  })
  it('an unknown operation cannot be reverted, by name', async () => {
    const res = await app.inject({ method: 'POST', url: '/products/root/studio/matrix/verbs/nope/revert' })
    expect(res.statusCode).toBe(404); expect(res.json().error).toBe('operation_not_revertible')
  })
})
