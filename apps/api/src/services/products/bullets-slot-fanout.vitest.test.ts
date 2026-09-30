import { afterAll, beforeAll, expect, it, vi } from 'vitest'

/**
 * Step 4.3 #3 (A-52; R-55, R-60) — the one bullets cell leaves as SLOT writes: one `bulletPoints[i]` change per changed
 * position, all in ONE `PATCH /products/bulk` with the row's version (the sheet's `SheetWriter` coalesces them). This
 * measures what the server does with that request on the REAL route and save path (PGlite, `formulaDatabase()`), with no
 * API product change: the content path (`applyContentBulk`) composes the positions in order, keeps interior holes, judges
 * each position per row on the sheet's route (R-60), and guards the row with one version.
 *
 * Fixture: Amazon·IT `bullet_point` 10 × 700, a pin address on the listing's `it` text (what a pinned bullets cell sends).
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn(), { reconcileFamilyReadiness: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkEdits } from './bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const CAP = 700
const context = { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }
let account = ''
const ids: Record<'ten' | 'refuse' | 'stale' | 'direct' | 'chain', string> = { ten: '', refuse: '', stale: '', direct: '', chain: '' }

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'APJ6JRA9NG5V4' } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'bullets-fanout', isActive: true, externalAccountId: 'SELLER' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
    schemaDefinition: { properties: { bullet_point: { type: 'array', maxItems: 10, selectors: ['marketplace_id', 'language_tag'],
      items: { type: 'object', properties: { value: { type: 'string', maxLength: CAP }, language_tag: { type: 'string' }, marketplace_id: { const: 'APJ6JRA9NG5V4' } } } } } } } })
  for (const key of Object.keys(ids) as Array<keyof typeof ids>) {
    const product = await prisma.product.create({ data: { sku: `fanout-${key}`, name: `fanout ${key}`, basePrice: 10, productType: 'COAT' } })
    await prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account } })
    ids[key] = product.id
  }
}), 60_000)
afterAll(async () => { await state.db?.close() })

const pin = () => ({ tier: 'pin', language: 'it', coordinate: { channel: 'AMAZON', market: 'IT', accountId: account } })
/** What the sheet sends for one row: one change per changed position, the listing's version as the CAS token. */
const slotChanges = (id: string, values: Record<number, string | string[] | null>) => Object.entries(values).map(([i, value]) =>
  ({ id, field: `bulletPoints[${i}]`, value, target: 'channel', contentAddress: pin(), contentAcknowledged: true }))
const contexts = () => [{ channel: 'AMAZON', marketplace: 'IT', accountId: account, locale: 'it', aliasKey: '' }]
const listing = (id: string) => scoped(() => prisma.channelListing.findFirstOrThrow({ where: { productId: id }, include: { translations: true } }))
const stored = async (id: string) => (await listing(id)).translations.find(t => t.language === 'it')?.bulletPoints ?? []

let app: any
beforeAll(async () => {
  const Fastify = (await import('fastify')).default
  const { default: productsRoutes } = await import('../../routes/products.routes.js')
  app = Fastify()
  // Production runs every handler inside the request's business (`lib/workspace-hook.ts`); with profiles OFF it does nothing.
  app.addHook('preHandler', (_request: unknown, _reply: unknown, done: () => void) => {
    if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') { done(); return }
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register(productsRoutes)
  await app.ready()
}, 60_000)
afterAll(async () => { await app?.close() })

/** The sheet's route: `PATCH /products/bulk` (per-row content refusals, R-60). */
const patch = (id: string, values: Record<number, string | string[] | null>, version?: number) => scoped(async () => {
  const expectedVersion = version ?? (await listing(id)).version
  return app.inject({ method: 'PATCH', url: '/products/bulk', payload: { changes: slotChanges(id, values), marketplaceContexts: contexts(), expectedVersion } })
})
const TEN: Record<number, string | null> = { 1: 'b1', 2: 'b2', 3: null, 4: 'b4', 5: 'b5', 6: 'b6', 7: null, 8: 'b8', 9: 'b9', 10: 'b10' }

it('F1 ten slot changes in ONE request: stored in order, the two interior holes kept', async () => {
  const response = await patch(ids.ten, TEN)
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json().errors ?? []).toEqual([])
  expect(await stored(ids.ten)).toEqual(['b1', 'b2', '', 'b4', 'b5', 'b6', '', 'b8', 'b9', 'b10'])
}, 60_000)

it('F2 ONE position edited: only that position changes, the other nine (holes included) are untouched', async () => {
  const before = await stored(ids.ten)
  const response = await patch(ids.ten, { 4: 'FOUR' })
  expect(response.statusCode, response.body).toBe(200)
  const after = await stored(ids.ten)
  expect(after[3]).toBe('FOUR')
  expect(after.filter((_, i) => i !== 3)).toEqual(before.filter((_, i) => i !== 3))
}, 60_000)

// P1 (`pim/value-verdict.ts`) — only a value the slot's type cannot hold is refused (a list sent to one position); an
// over-cap bullet is stored and named in `warnings` (F6).
it('F3 ten changes with position 4 holding a LIST (its type cannot hold it): position 4 alone is refused by name, the other nine are stored', async () => {
  expect((await patch(ids.refuse, { 1: 'old1', 2: 'old2', 3: 'old3', 4: 'old4' })).statusCode).toBe(200)
  const response = await patch(ids.refuse, { ...TEN, 4: ['one', 'two'] })
  expect(response.statusCode, response.body).toBe(200)
  const body = response.json()
  expect(body.errors).toEqual([expect.objectContaining({ id: ids.refuse, field: 'bulletPoints[4]', error: expect.stringContaining('takes ONE value') })])
  expect(await stored(ids.refuse)).toEqual(['b1', 'b2', '', 'old4', 'b5', 'b6', '', 'b8', 'b9', 'b10'])
}, 60_000)

it('F6 P1: position 4 over the 700 cap is STORED with the other nine, and the warning names Bullet 4 and the cap', async () => {
  const response = await patch(ids.refuse, { ...TEN, 4: 'x'.repeat(CAP + 1) })
  expect(response.statusCode, response.body).toBe(200)
  const body = response.json()
  expect(body.errors ?? []).toEqual([])
  expect(body.warnings).toEqual([expect.objectContaining({ id: ids.refuse, field: 'bulletPoints[4]', warning: expect.stringMatching(/^Bullet 4 takes at most 700 characters/) })])
  expect(await stored(ids.refuse)).toEqual(['b1', 'b2', '', 'x'.repeat(CAP + 1), 'b5', 'b6', '', 'b8', 'b9', 'b10'])
}, 60_000)

it('F4 a stale version refuses the WHOLE request (one row, one CAS): nothing is stored', async () => {
  expect((await patch(ids.stale, { 1: 'kept' })).statusCode).toBe(200)
  const before = await listing(ids.stale)
  const response = await patch(ids.stale, TEN, before.version - 1)
  expect(response.statusCode, response.body).toBe(409)
  const after = await listing(ids.stale)
  expect(after.translations.find(t => t.language === 'it')?.bulletPoints).toEqual(['kept'])
  expect(after.version).toBe(before.version)
}, 60_000)

it('F5 control — off the sheet route (no per-row opt-in) the same refused request stores NOTHING', async () => {
  const before = await stored(ids.direct)
  const result = await scoped(async () => applyProductBulkEdits({ changes: slotChanges(ids.direct, { ...TEN, 4: ['one', 'two'] }), marketplaceContexts: contexts(),
    expectedVersion: (await listing(ids.direct)).version } as never, context) as Promise<any>)
  expect(result).toMatchObject({ success: false, updated: 0 })
  expect(await stored(ids.direct)).toEqual(before)
}, 60_000)

it('F9 the answer names the pin text\'s new version, and the next save sent with it lands (the sheet chains without a read)', async () => {
  // What the sheet sends: the pin text's version as each bullet cell's `contentVersion` (0 while no pin text exists).
  const save = (values: Record<number, string>, contentVersion: number) => scoped(async () => app.inject({ method: 'PATCH', url: '/products/bulk', payload: {
    changes: slotChanges(ids.chain, values).map(change => ({ ...change, contentVersion })), marketplaceContexts: contexts(), expectedVersion: (await listing(ids.chain)).version } }))
  const first = await save({ 1: 'one' }, 0)
  expect(first.statusCode, first.body).toBe(200)
  expect(first.json().contentVersions).toEqual([{ id: ids.chain, tier: 'pin', language: 'it', version: 1 }])
  const second = await save({ 2: 'two' }, first.json().contentVersions[0].version)
  expect(second.statusCode, second.body).toBe(200)
  expect(second.json().contentVersions).toEqual([{ id: ids.chain, tier: 'pin', language: 'it', version: 2 }])
  expect(await stored(ids.chain)).toEqual(['one', 'two'])
  // The token is real: the version from before the second save is refused, and nothing is written.
  const stale = await save({ 3: 'three' }, 1)
  expect(stale.statusCode).not.toBe(200)
  expect(await stored(ids.chain)).toEqual(['one', 'two'])
})
