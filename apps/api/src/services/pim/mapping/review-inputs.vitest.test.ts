import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import type { Prisma } from '@prisma/client'
vi.mock('../../../db.js', () => ({ default: {} }))
import { mappingInputToken } from './review-inputs.js'

const pg = new PGlite(), queries: Prisma.Sql[] = []
const db = { $queryRaw: async (query: Prisma.Sql) => {
  queries.push(query)
  return (await pg.query(query.text, query.values)).rows
} }
const token = () => mappingInputToken('EBAY', 'IT', db as never)
beforeAll(async () => {
  await pg.exec(`CREATE TABLE "Product" (id text PRIMARY KEY, name text, version int);
    CREATE TABLE "ProductCategory" ("productId" text, "categoryId" text, "isPrimary" boolean);
    CREATE TABLE "CategoryClosure" ("ancestorId" text, "descendantId" text, depth int);
    CREATE TABLE "ChannelConnection" (id text, "channelType" text, marketplace text, "isActive" boolean, "isPrimary" boolean, "externalAccountId" text, credential text);`)
  for (const table of ['ChannelListing', 'CategoryChannelMapping', 'ChannelSchema', 'CategorySchema', 'FieldValueMap']) {
    await pg.exec(`CREATE TABLE "${table}" (id text PRIMARY KEY, channel text, marketplace text, payload jsonb);`)
  }
  for (const table of ['Category', 'FieldLinkGroup', 'SizeScaleMap', 'CustomAttribute', 'AttributeOption', 'ProductFamily', 'FamilyAttribute', 'EbayDescriptionTheme']) {
    await pg.exec(`CREATE TABLE "${table}" (id text PRIMARY KEY, payload jsonb);`)
  }
  await pg.exec(`INSERT INTO "Product" SELECT lpad(i::text, 6, '0'), 'Old', 1 FROM generate_series(0,2599) i;
    INSERT INTO "ProductCategory" SELECT 'same-product', lpad(i::text, 6, '0'), false FROM generate_series(0,599) i;
    INSERT INTO "ChannelConnection" VALUES ('account', 'EBAY', 'IT', true, true, 'seller', 'private');`)
}, 30_000)
afterAll(() => pg.close())

describe('review input invalidation through PostgreSQL', () => {
  it('detects unversioned changes and deletions using bounded keyset pages and full row hashes', async () => {
    const first = await token()
    expect(first).toMatch(/^v2:[a-f0-9]{64}$/)
    expect(queries.every(q => q.text.includes('LIMIT 250') && !q.text.includes('OFFSET'))).toBe(true)
    await pg.exec(`UPDATE "Product" SET name='Changed without a version increment' WHERE id='001200'`)
    const second = await token()
    expect(second).not.toBe(first)
    await pg.exec(`DELETE FROM "Product" WHERE id='002599'`)
    expect(await token()).not.toBe(second)
  })
  it('walks composite keys without skipping later memberships and excludes unrelated markets', async () => {
    const first = await token()
    await pg.exec(`UPDATE "ProductCategory" SET "isPrimary"=true WHERE "categoryId"='000500'`)
    const second = await token()
    expect(second).not.toBe(first)
    await pg.exec(`INSERT INTO "ChannelListing" VALUES ('other-market', 'EBAY', 'DE', '{"value":1}')`)
    expect(await token()).toBe(second)
    await pg.exec(`INSERT INTO "ChannelListing" VALUES ('this-market', 'EBAY', 'IT', '{"value":1}')`)
    expect(await token()).not.toBe(second)
  })
  it('does not transfer product payloads or hash connection secrets, but catches account selection changes', async () => {
    const first = await token()
    await pg.exec(`UPDATE "ChannelConnection" SET credential='rotated'`)
    expect(await token()).toBe(first)
    await pg.exec(`UPDATE "ChannelConnection" SET "isPrimary"=false`)
    const models: Record<string, string> = {}
    expect(await mappingInputToken('EBAY', 'IT', db as never, (model, digest) => { models[model] = digest })).not.toBe(first)
    expect(Object.keys(models)).toHaveLength(17)
    const sample = await db.$queryRaw(queries.find(q => q.text.includes('"public"."Product"'))!)
    expect(Object.keys(sample[0] as object).sort()).toEqual(['digest', 'id'])
  })
})
