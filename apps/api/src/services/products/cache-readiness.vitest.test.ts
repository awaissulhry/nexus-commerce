import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const pg = new PGlite()
vi.mock('../../db.js', () => ({ default: { $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
  (await pg.query(strings.reduce((sql, part, i) => sql + (i ? `$${i}` : '') + part, ''), values)).rows } }))
vi.mock('../advertising/ads-cache.js', () => ({ cached: (_key: string, _ttl: number, load: () => unknown) => load() }))
import { isCacheReady, resolveProductsScope } from './list-products.service.js'

beforeAll(async () => {
  await pg.exec(`CREATE TABLE "Product" (id text PRIMARY KEY, "updatedAt" timestamp, "deletedAt" timestamp, "parentId" text, version int);
    CREATE TABLE "ProductReadCache" (LIKE "Product" INCLUDING ALL);`)
}, 30_000)
beforeEach(async () => {
  await pg.exec(`TRUNCATE "Product", "ProductReadCache";
    INSERT INTO "Product" VALUES ('one', '2026-09-15', NULL, NULL, 1);
    INSERT INTO "ProductReadCache" SELECT * FROM "Product";`)
})
afterAll(() => pg.close())

describe('product cache eligibility against PostgreSQL', () => {
  it('reads grid relations live and retains products without a type', async () => {
    const scope = await resolveProductsScope({ includeSales: 'true' })
    expect(scope.useCache).toBe(false)
    expect(scope.where.AND).toContainEqual({ OR: [{ productType: null }, { productType: { not: 'EBAY_LISTING_SHELL' } }] })
  })
  it('searches product truth so GTIN matches cannot disappear through a cache without GTIN', async () => {
    const scope = await resolveProductsScope({ search: '1234567890' })
    expect(scope.useCache).toBe(false)
    expect(scope.where.OR).toContainEqual({ gtin: { contains: '1234567890' } })
  })
  it('applies the missing-photo tile to both the source relation and cached flag', async () => {
    const scope = await resolveProductsScope({ photos: 'none' })
    expect(scope.where.images).toEqual({ none: { mediaType: 'IMAGE' } })
    expect(scope.cacheWhere.hasPhotos).toBe(false)
    expect(JSON.stringify(scope.where)).not.toContain('photoCount')
  })
  it('accepts a matching projection, then immediately detects a deletion', async () => {
    expect(await isCacheReady()).toBe(true)
    await pg.exec(`UPDATE "Product" SET "deletedAt"='2026-09-15'`)
    expect(await isCacheReady()).toBe(false)
  })
  it.each([
    `INSERT INTO "Product" VALUES ('missing', '2026-09-15', NULL, NULL, 1)`,
    `INSERT INTO "ProductReadCache" VALUES ('ghost', '2026-09-15', NULL, NULL, 1)`,
    `UPDATE "ProductReadCache" SET "updatedAt"='2026-09-14'`,
    `UPDATE "ProductReadCache" SET "parentId"='old-family'`,
    `UPDATE "ProductReadCache" SET version=0`,
    `TRUNCATE "ProductReadCache"`,
  ])('falls back to product truth when cache membership or metadata drifts: %s', async sql => {
    await pg.exec(sql)
    expect(await isCacheReady()).toBe(false)
  })
  it('accepts repaired projections without waiting for a process cache to expire', async () => {
    await pg.exec(`UPDATE "Product" SET "deletedAt"='2026-09-15'`)
    expect(await isCacheReady()).toBe(false)
    await pg.exec(`UPDATE "ProductReadCache" SET "deletedAt"='2026-09-15'`)
    expect(await isCacheReady()).toBe(true)
  })
})
