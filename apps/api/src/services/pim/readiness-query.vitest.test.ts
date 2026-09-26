import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * P7 (docs/attributes/PLAN.md §4.6, §10.8) — "which products miss a required field HERE" is one query on the stored
 * index. Rows are written directly (the writer is `readiness-required-by.vitest.test.ts`), so each case names exactly
 * the facts it filters on: the coordinate, the field, the source, a pending row, a deleted product, paging.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => { const { formulaDatabase } = await import('../../test-support/formula-database.js'); state.db = await formulaDatabase(); return { default: state.db.client } })
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { productsMissingRequired } from './readiness-query.service.js'
import { readinessCoordinateKey } from './readiness-model.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const EBAY_DE = { channel: 'EBAY', market: 'DE', accountId: 'acc-1', aliasId: null }
const SHARED = { channel: null, market: null, accountId: null, aliasId: null }
const empty = (field: string, requiredBy: string[]) => ({ productId: 'x', field, label: field, reason: 'Required and empty', requiredEmpty: true, requiredBy })

async function row(productId: string, coordinate: typeof EBAY_DE | typeof SHARED, language: string, missing: unknown[], pending = false) {
  await prisma.readinessIndex.create({ data: { productId, ...coordinate, coordinateKey: readinessCoordinateKey(coordinate), language, label: 'x',
    pct: null, state: missing.length ? 'blocked' : 'ready', requiredFilled: 0, requiredTotal: missing.length, missing: missing as never, computedAt: new Date(),
    ...(pending ? { pendingSince: new Date() } : {}) } })
}

beforeAll(() => scoped(async () => {
  for (const id of ['q-a', 'q-b', 'q-c', 'q-d', 'q-e', 'q-deleted']) {
    await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 1, ...(id === 'q-deleted' ? { deletedAt: new Date() } : {}) } })
  }
  await row('q-a', EBAY_DE, 'de', [empty('color', ['eBay · DE'])])                                   // missing colour on eBay DE
  await row('q-b', EBAY_DE, 'de', [empty('fit', ['Family: Jackets']), empty('color', ['eBay · DE'])]) // missing two
  await row('q-c', EBAY_DE, 'de', [{ productId: 'q-c', field: 'color', label: 'Colour', reason: 'Colour is too long' }]) // an issue, nothing EMPTY
  await row('q-d', EBAY_DE, 'de', [empty('fit', ['Family: Jackets'])], true)                         // pending rebuild
  await row('q-e', SHARED, 'it', [empty('fit', ['Family: Jackets'])])                                // shared product only
  await row('q-deleted', EBAY_DE, 'de', [empty('color', ['eBay · DE'])])                             // deleted product
}), 60_000)
afterAll(async () => { await state.db?.close() })

describe('productsMissingRequired', () => {
  it('lists every product with a required-and-empty field at the coordinate, never a deleted one, and says how many were checked', () => scoped(async () => {
    expect(await productsMissingRequired({ channel: 'EBAY', market: 'DE' })).toEqual({
      productIds: ['q-a', 'q-b', 'q-d'], pendingProductIds: ['q-d'], checkedProducts: 4, pendingProducts: 1, nextCursor: null,
    })
  }))
  it('narrows to one field', () => scoped(async () => {
    expect((await productsMissingRequired({ channel: 'EBAY', market: 'DE', field: 'color' })).productIds).toEqual(['q-a', 'q-b'])
  }))
  it('narrows to one source', () => scoped(async () => {
    expect((await productsMissingRequired({ channel: 'EBAY', market: 'DE', requiredBy: 'Family: Jackets' })).productIds).toEqual(['q-b', 'q-d'])
    expect((await productsMissingRequired({ channel: 'EBAY', market: 'DE', field: 'color', requiredBy: 'Family: Jackets' })).productIds).toEqual([])
  }))
  it('answers the shared product with channel and market null, and keeps coordinates apart', () => scoped(async () => {
    expect(await productsMissingRequired({ channel: null, market: null })).toMatchObject({ productIds: ['q-e'], checkedProducts: 1 })
    expect((await productsMissingRequired({ channel: 'EBAY', market: 'IT' }))).toMatchObject({ productIds: [], checkedProducts: 0 })
  }))
  it('filters by account and language when asked', () => scoped(async () => {
    expect((await productsMissingRequired({ channel: 'EBAY', market: 'DE', accountId: 'acc-1', language: 'de' })).productIds).toEqual(['q-a', 'q-b', 'q-d'])
    expect((await productsMissingRequired({ channel: 'EBAY', market: 'DE', accountId: 'acc-2' })).productIds).toEqual([])
    expect((await productsMissingRequired({ channel: 'EBAY', market: 'DE', language: 'en' })).productIds).toEqual([])
  }))
  it('pages by product id', () => scoped(async () => {
    const first = await productsMissingRequired({ channel: 'EBAY', market: 'DE', take: 2 })
    expect(first).toMatchObject({ productIds: ['q-a', 'q-b'], nextCursor: 'q-b' })
    expect(await productsMissingRequired({ channel: 'EBAY', market: 'DE', take: 2, after: first.nextCursor })).toMatchObject({ productIds: ['q-d'], nextCursor: null })
    // A page that is exactly full is the last page: no cursor to an empty one.
    expect(await productsMissingRequired({ channel: 'EBAY', market: 'DE', take: 3 })).toMatchObject({ productIds: ['q-a', 'q-b', 'q-d'], nextCursor: null })
  }))
})
