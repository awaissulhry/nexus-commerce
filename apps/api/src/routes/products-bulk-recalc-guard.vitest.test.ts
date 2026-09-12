/**
 * The READER half of the formula re-entrancy guard (hub ruling, 2026-09-04).
 *
 * `writeValue` in the formula service reaches `/api/products/bulk` through
 * `fastify.inject`, and that route now runs a recalculation pass after it
 * commits. So the route must recognise its OWN cascade's writes and not start
 * a second walk — an unhonoured header recurses, and a recursion under load is
 * a hang, not a wrong value.
 *
 * The writer half (that `cell-formula.routes.ts` SETS the header) and the walk
 * itself are covered elsewhere; this file pins only that the route READS it,
 * and reads it as an explicit value rather than a presence.
 *
 * Run: npx vitest run src/routes/products-bulk-recalc-guard.vitest.test.ts
 */
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null }))
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const PRODUCT_ID = 'cmokmy3a40078pm0p1fvnu523'

const productFindMany = vi.fn()
const productFindUnique = vi.fn()
const productUpdate = vi.fn()
const productUpdateMany = vi.fn()
const channelListingFindMany = vi.fn()
const channelListingFindUnique = vi.fn()
const channelListingUpdate = vi.fn()
const channelListingUpsert = vi.fn()
const bulkOperationCreate = vi.fn()
const executeRaw = vi.fn()
const $transaction = vi.fn()
const cellFormulaFindMany = vi.fn()
const formulaAccountAccess = vi.fn()

vi.mock('../db.js', () => ({
  default: {
    product: {
      findMany: (...a: unknown[]) => productFindMany(...a),
      findUnique: (...a: unknown[]) => productFindUnique(...a),
      update: (...a: unknown[]) => productUpdate(...a),
      updateMany: (...a: unknown[]) => productUpdateMany(...a),
    },
    channelListing: {
      findMany: (...a: unknown[]) => channelListingFindMany(...a),
      findUnique: (...a: unknown[]) => channelListingFindUnique(...a),
      update: (...a: unknown[]) => channelListingUpdate(...a),
      upsert: (...a: unknown[]) => channelListingUpsert(...a),
    },
    cellFormula: { findMany: (...a: unknown[]) => cellFormulaFindMany(...a) },
    bulkOperation: { create: (...a: unknown[]) => bulkOperationCreate(...a) },
    $transaction: (...a: unknown[]) => $transaction(...a),
    $executeRaw: (...a: unknown[]) => executeRaw(...a),
  },
}))
vi.mock('../services/connection-resolver.service.js', () => ({
  primaryConnectionIds: async () => new Map<string, string | null>(),
  resolveConnection: async ({ accountId }: { accountId: string }) => ({ id: accountId, channelType: 'EBAY', isActive: true }),
  isPrimaryChannelConnection: (...args: unknown[]) => formulaAccountAccess(...args),
}))
vi.mock('../services/pim/field-registry.service.js', () => ({
  getAvailableFields: async () => [],
  getFieldDefinition: async () => ({ id: 'attr_ceCertification', editable: true, type: 'text' }),
}))
// The recalc tests isolate cascade dispatch; the fixture has no additional Information fields.
vi.mock('../services/pim/mapping/resolve-batch.service.js', () => ({
  resolveBatch: async () => ({ products: [{ productId: PRODUCT_ID, cells: {} }] }),
}))

/** The pass itself is tested in `cell-formula-recalc.vitest.test.ts`; here it is
 *  a counter, so "did the route call it" is the only variable. */
const reevaluate = vi.fn()
vi.mock('../services/pim/mapping/cell-formula.service.js', () => ({
  reevaluateDependents: (...a: unknown[]) => reevaluate(...a),
}))

import productsRoutes from './products.routes.js'

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(productsRoutes)
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  for (const m of [productFindMany, productFindUnique, productUpdate, productUpdateMany,
    channelListingFindMany, channelListingFindUnique, channelListingUpdate, channelListingUpsert,
    bulkOperationCreate, executeRaw, $transaction, cellFormulaFindMany, reevaluate]) m.mockReset()
  $transaction.mockResolvedValue([])
  bulkOperationCreate.mockResolvedValue({ id: 'bulk_test' })
  productFindUnique.mockResolvedValue({ version: 27 })
  channelListingFindUnique.mockResolvedValue({ version: 19 })
  productUpdate.mockReturnValue({ __stmt: 'product.update' })
  channelListingUpsert.mockReturnValue({ __stmt: 'listing.upsert' })
  productFindMany.mockResolvedValue([
    { id: PRODUCT_ID, manufacturer: null, version: 26, categoryAttributes: {} },
  ])
  channelListingFindMany.mockResolvedValue([])
  // This product DOES carry a formula, so the short-circuit does not hide the guard.
  cellFormulaFindMany.mockResolvedValue([{ productId: PRODUCT_ID }])
  reevaluate.mockResolvedValue([])
  formulaAccountAccess.mockReset().mockResolvedValue(false)
})

/** A real change, so the request commits and reaches the pass. */
const patch = (headers?: Record<string, string>) =>
  app.inject({
    method: 'PATCH',
    url: '/products/bulk',
    ...(headers ? { headers } : {}),
    payload: { changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: 'XAVIA RACING' }], expectedVersion: 26 },
  })

describe('the bulk route READS the formula-cascade header', () => {
  it.each(['account-a', 'account-b'])('recalculates only the edited account coordinate: %s', async accountId => {
    const res = await app.inject({ method: 'PATCH', url: '/products/bulk', payload: {
      changes: [{ id: PRODUCT_ID, field: 'ebay_title', value: 'Account title', target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT', accountId }],
    } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ updated: 1 })
    expect(reevaluate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      productId: PRODUCT_ID, changedFields: ['ebay_title'],
      coordinate: expect.objectContaining({ channel: 'EBAY', marketplace: 'IT', channelConnectionId: accountId, aliasKey: '' }),
    }))
  })
  it('WITHOUT the header: the cascade runs exactly once, for the fields written', async () => {
    const res = await patch()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ success: true, updated: 1 })
    expect(reevaluate).toHaveBeenCalledTimes(1)
    expect(reevaluate.mock.calls[0][0]).toMatchObject({
      productId: PRODUCT_ID,
      changedFields: ['manufacturer'],
    })
  })

  it('WITH the header: no cascade at all — and the write still happens', async () => {
    const res = await patch({ 'x-nexus-formula-cascade': '1' })
    expect(res.statusCode).toBe(200)
    // The guard must skip the CASCADE, not the write. A guard that also
    // skipped the write would make every formula-driven value silently vanish.
    expect(res.json()).toMatchObject({ success: true, updated: 1 })
    expect(reevaluate).not.toHaveBeenCalled()
  })

  it('the flag is read as a VALUE, not a presence: "0" still cascades', async () => {
    // `!!request.headers['x-nexus-formula-cascade']` would pass the two cases
    // above and silently stop cascading for any caller that sent the header
    // with any other value.
    const res = await patch({ 'x-nexus-formula-cascade': '0' })
    expect(res.statusCode).toBe(200)
    expect(reevaluate).toHaveBeenCalledTimes(1)
  })

  it('a product carrying NO formula is not walked at all', async () => {
    cellFormulaFindMany.mockResolvedValue([])
    const res = await patch()
    expect(res.statusCode).toBe(200)
    expect(reevaluate).not.toHaveBeenCalled()
  })

  it('a cascade that THROWS still answers 200 — the write is already committed', async () => {
    // The INNER, per-product catch: one product's walk failing.
    reevaluate.mockRejectedValue(new Error('boom'))
    const res = await patch()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ success: true, updated: 1 })
  })

  it('one product\'s cascade failing does not stop the NEXT product\'s', async () => {
    // The inner catch's whole purpose, and it is invisible with one product:
    // rethrowing from it just lands in the outer catch, so every
    // single-product test above still passes. Two products, the FIRST one
    // failing, is the only shape that can see the difference.
    const OTHER = 'cmokmy0jf0003pm0ppnu1b2yy'
    productFindMany.mockResolvedValue([
      { id: PRODUCT_ID, manufacturer: null, version: 26, categoryAttributes: {} },
      { id: OTHER, manufacturer: null, version: 26, categoryAttributes: {} },
    ])
    cellFormulaFindMany.mockResolvedValue([{ productId: PRODUCT_ID }, { productId: OTHER }])
    reevaluate.mockImplementation(async ({ productId }: { productId: string }) => {
      if (productId === PRODUCT_ID) throw new Error('first product exploded')
      return []
    })
    const res = await app.inject({
      method: 'PATCH',
      url: '/products/bulk',
      payload: { changes: [
        { id: PRODUCT_ID, field: 'manufacturer', value: 'XAVIA RACING' },
        { id: OTHER, field: 'manufacturer', value: 'XAVIA RACING' },
      ] },
    })
    expect(res.statusCode).toBe(200)
    // BOTH were attempted — the second is the assertion that matters.
    expect(reevaluate).toHaveBeenCalledTimes(2)
    expect(reevaluate.mock.calls.map((c) => c[0].productId).sort()).toEqual([OTHER, PRODUCT_ID].sort())
    // The failure is reported against the product it belongs to, not the batch.
    const failed = res.json().recalculated.filter((r: { error: string | null }) => r.error)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ productId: PRODUCT_ID })
    expect(failed[0].error).toContain('first product exploded')
  })

  it('the PASS ITSELF failing still answers 200, and SAYS so', async () => {
    // The OUTER catch — a different branch from the one above, and the one
    // that actually shipped broken: the `cellFormula.findMany` that decides
    // which products carry formulas sat outside any try, so a prisma without
    // `cellFormula` turned eight committed writes into 500s. A mutation aimed
    // at this branch survives the test above, which is how the gap was found.
    cellFormulaFindMany.mockRejectedValue(new Error('db down'))
    const res = await patch()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ success: true, updated: 1 })
    // Not swallowed either: a stale dependent cell behind a "saved" response
    // is the failure this reports rather than hides.
    expect(res.json().recalcError).toContain('db down')
  })
})

describe('formula expression and value share a transaction', () => {
  it('includes formula storage with the field write', async () => {
    const { withFormulaWrite } = await import('../services/pim/mapping/formula-write-context.js')
    const mutation = { __stmt: 'formula.upsert' }
    const context = { productId: PRODUCT_ID, writeField: 'manufacturer', operations: () => [mutation] }
    const res = await withFormulaWrite(context, token => patch({ 'x-nexus-formula-cascade': '1', 'x-nexus-formula-write': token }))
    expect(res.statusCode).toBe(200)
    expect($transaction.mock.calls[0][0]).toContain(mutation)
    expect($transaction.mock.calls[0][0]).toContainEqual({ __stmt: 'product.update' })
  })
  it('does not discard a changed expression when its result equals the current value', async () => {
    const { withFormulaWrite } = await import('../services/pim/mapping/formula-write-context.js')
    productFindMany.mockResolvedValue([{ id: PRODUCT_ID, manufacturer: 'XAVIA RACING', version: 26, categoryAttributes: {} }])
    const mutation = { __stmt: 'formula.upsert' }
    const res = await withFormulaWrite({ productId: PRODUCT_ID, writeField: 'manufacturer', operations: () => [mutation] }, token => patch({ 'x-nexus-formula-cascade': '1', 'x-nexus-formula-write': token }))
    expect(res.statusCode).toBe(200)
    expect($transaction.mock.calls[0][0]).toContain(mutation)
  })
})
