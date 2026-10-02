/**
 * MCP full control I4 — G4 (a product SKU may not be an extra listing's own SKU) and G5 (a barcode save is checked
 * with validateGtin and names another product carrying the same code), through the real product bulk writer's dry
 * run (`applyProductBulkEdits`, the writer behind the sheet and the set-* tools) on PGlite with the production schema.
 *
 * The listing-SKU column (ProductListingAlias.sku) is not in this schema yet: G4 finds nothing without it, and refuses
 * once the column exists (added here as the eBay import's migration adds it).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { applyProductBulkEdits } from '../products/bulk-edit.service.js'
import { skusUsedByListings } from './identity-write-guards.js'

const A = LEGACY_WORKSPACE_ID
const B = 'ws_identity_guards_bravo'
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)

function withCheckDigit(base: string): string {
  let sum = 0
  for (let i = base.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(base[i]) * w
  return base + ((10 - (sum % 10)) % 10)
}
const TAKEN = withCheckDigit('400638133393')
const FREE = withCheckDigit('400638133394')
const BAD = TAKEN.slice(0, -1) + ((Number(TAKEN.at(-1)) + 1) % 10)

const ids: Record<string, string> = {}

type DryRun = { errors?: Array<{ id: string; field: string; error: string }>; warnings?: Array<{ id: string; field: string; warning: string }>; wouldUpdate?: number }
const dryRun = (changes: Array<{ id: string; field: string; value: unknown }>, workspaceId = A) =>
  inside(workspaceId, () => applyProductBulkEdits({ changes, dryRun: true }, { formulaCascade: false, logger: { warn: () => {}, error: () => {} } }) as Promise<DryRun>)

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, 'Bravo', 'active', 'identity', $1, CURRENT_TIMESTAMP)`, [B])
  await inside(A, async () => {
    const db = database.client
    const make = async (sku: string, extra: Record<string, unknown> = {}) => {
      ids[sku] = (await db.product.create({ data: { sku, name: sku, basePrice: '10.00', ...extra } })).id
    }
    await make('WG-HOLDER', { ean: `0${TAKEN}` })
    await make('WG-EDIT')
    await make('WG-GONE', { gtin: FREE, deletedAt: new Date() })
    await make('WG-ROOT')
    const alias = await db.productListingAlias.create({ data: { productId: ids['WG-ROOT'], channel: 'EBAY', marketplace: 'IT', label: 'second listing', position: 2 } })
    ids.alias = alias.id
  })
  // The same barcode in another business is legal and never named.
  await inside(B, () => database.client.product.create({ data: { sku: 'WG-BRAVO', name: 'Bravo', basePrice: '1.00', gtin: FREE } }))
  // Integration (ids × eBay import by SKU): this schema already has ProductListingAlias.sku (20261001c). The tests below
  // start from the state before that migration and add the column themselves, so drop it once the seed is in.
  await database.db.query(`ALTER TABLE "ProductListingAlias" DROP COLUMN IF EXISTS "sku"`)
}, 120_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('I4 / G5 — a barcode save is checked and a duplicate is named', () => {
  it('a GTIN another product of this business carries (leading zero ignored): stored, with a warning naming it', async () => {
    const out = await dryRun([{ id: ids['WG-EDIT'], field: 'gtin', value: TAKEN }])
    expect(out.errors ?? []).toEqual([])
    expect(out.wouldUpdate).toBe(1)
    expect(out.warnings).toEqual([{ id: ids['WG-EDIT'], field: 'gtin', warning: expect.stringContaining('WG-HOLDER already carries this barcode') }])
  })

  it('a bad check digit, on GTIN, EAN or UPC: stored, with validateGtin\'s reason', async () => {
    for (const field of ['gtin', 'ean', 'upc']) {
      const out = await dryRun([{ id: ids['WG-EDIT'], field, value: BAD }])
      expect(out.errors ?? []).toEqual([])
      expect(out.warnings).toEqual([{ id: ids['WG-EDIT'], field, warning: expect.stringContaining('Not a valid barcode: check digit mismatch') }])
    }
  })

  it('a valid code no other live product of this business carries (a deleted one and another business do): no warning', async () => {
    const out = await dryRun([{ id: ids['WG-EDIT'], field: 'gtin', value: FREE }])
    expect(out).toMatchObject({ wouldUpdate: 1 })
    expect(out.warnings ?? []).toEqual([])
    expect(out.errors ?? []).toEqual([])
  })

  it('a product keeping its own code is not its own duplicate; clearing a code is not checked', async () => {
    const own = await dryRun([{ id: ids['WG-HOLDER'], field: 'gtin', value: TAKEN }])
    expect(own.warnings ?? []).toEqual([])
    const cleared = await dryRun([{ id: ids['WG-EDIT'], field: 'ean', value: '' }])
    expect(cleared.warnings ?? []).toEqual([])
  })
})

describe('I4 / G4 — a product SKU may not be an extra listing\'s own SKU', () => {
  it('without the listing-SKU column there is nothing to compare: the rename is judged as before', async () => {
    expect(await inside(A, () => skusUsedByListings(['WG-LISTING-SKU']))).toEqual([])
    const out = await dryRun([{ id: ids['WG-EDIT'], field: 'sku', value: 'WG-LISTING-SKU' }])
    expect(out).toMatchObject({ wouldUpdate: 1 })
    expect(out.errors ?? []).toEqual([])
  })

  it('with the column: a rename to an extra listing\'s SKU (any case) is refused, naming the listing; another SKU is not', async () => {
    await database.db.query(`ALTER TABLE "ProductListingAlias" ADD COLUMN "sku" TEXT`)
    await database.db.query(`UPDATE "ProductListingAlias" SET sku = 'WG-LISTING-SKU' WHERE id = $1`, [ids.alias])
    expect(await inside(A, () => skusUsedByListings(['wg-listing-sku ']))).toEqual([{ sku: 'wg-listing-sku ', listingSku: 'WG-LISTING-SKU', label: 'second listing', productSku: 'WG-ROOT' }])
    const refused = await dryRun([{ id: ids['WG-EDIT'], field: 'sku', value: 'wg-listing-sku' }])
    expect(refused.wouldUpdate).toBe(0)
    expect(refused.errors).toEqual([{ id: ids['WG-EDIT'], field: 'sku', error: expect.stringContaining('already the SKU of an extra listing ("second listing" of WG-ROOT)') }])
    const fine = await dryRun([{ id: ids['WG-EDIT'], field: 'sku', value: 'WG-NEW-NAME' }])
    expect(fine).toMatchObject({ wouldUpdate: 1 })
    // Another business's extra listings are not this business's.
    expect(await inside(B, () => skusUsedByListings(['WG-LISTING-SKU']))).toEqual([])
  })
})
