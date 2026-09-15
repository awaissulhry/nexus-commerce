import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { Prisma } from '@prisma/client'
import { salesRollupCte } from './sales-rollup.js'
import { stockRollupCte } from './list-products.service.js'

const pg = new PGlite()
const since = new Date('2026-09-08T00:00:00Z'), until = new Date('2026-09-15T00:00:00Z')
beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE "Product" (id text PRIMARY KEY, "parentId" text, "deletedAt" timestamp);
    CREATE TABLE "Order" (id text PRIMARY KEY, "purchaseDate" timestamp, "createdAt" timestamp, status text, "currencyCode" text);
    CREATE TABLE "OrderItem" ("orderId" text, "productId" text, quantity int, price numeric(12,2));
    CREATE TABLE "StockLevel" ("productId" text, quantity int, available int);
    INSERT INTO "Product" VALUES ('family',NULL,NULL),('live','family',NULL),('deleted','family','2026-09-14'),('foreign',NULL,NULL),('empty',NULL,NULL);
    INSERT INTO "Order" VALUES
      ('old-import','2026-09-01','2026-09-14','SHIPPED','EUR'),
      ('recent','2026-09-10','2026-09-14','SHIPPED','EUR'),
      ('cancelled','2026-09-10','2026-09-10','CANCELLED','EUR'),
      ('future','2026-09-16','2026-09-14','SHIPPED','EUR'),
      ('legacy',NULL,'2026-09-11','SHIPPED',NULL),
      ('foreign','2026-09-10','2026-09-10','SHIPPED','USD');
    INSERT INTO "OrderItem" VALUES
      ('old-import','live',20,50),('recent','live',2,12.34),('recent','deleted',1,0.01),
      ('cancelled','live',100,50),('future','live',100,50),('legacy','family',1,2.22),('foreign','foreign',3,10);
    INSERT INTO "StockLevel" VALUES ('family',2,2),('live',5,3),('deleted',100,100);
  `)
}, 30_000)
afterAll(() => pg.close())
const query = async (sql: Prisma.Sql) => (await pg.query(sql.text, sql.values)).rows as Array<Record<string, unknown>>

describe('product measures against PostgreSQL', () => {
  it('uses purchase time, excludes cancellations and future sales, and falls back only for legacy dates', async () => {
    const rows = await query(Prisma.sql`WITH ${salesRollupCte(['family', 'live', 'deleted', 'empty'], since, until)} SELECT id, units::int, "revenueCents"::int FROM salesq ORDER BY id`)
    expect(rows).toEqual([
      { id: 'deleted', units: 1, revenueCents: 1 },
      { id: 'empty', units: 0, revenueCents: 0 },
      { id: 'family', units: 4, revenueCents: 2691 },
      { id: 'live', units: 2, revenueCents: 2468 },
    ])
  })
  it('preserves units but refuses to label foreign-currency revenue as euros', async () => {
    const rows = await query(Prisma.sql`WITH ${salesRollupCte(['foreign'], since, until)} SELECT units::int, "revenueCents"::int FROM salesq`)
    expect(rows).toEqual([{ units: 3, revenueCents: null }])
  })
  it('keeps deleted variant sales history while excluding deleted and reserved stock from the active family', async () => {
    const rows = await query(Prisma.sql`WITH ${stockRollupCte(['family', 'live', 'empty'])} SELECT * FROM stockq ORDER BY id`)
    expect(rows).toEqual([{ id: 'empty', qty: 0 }, { id: 'family', qty: 5 }, { id: 'live', qty: 3 }])
  })
})
