/**
 * VT.F2 — delete BOTH disposable fixture families, LAST, with a read-back that addresses them two ways.
 *
 * LOCAL `nexus_development` only, asserted from the server (`current_database()`) before a single DELETE, with
 * the URL stated explicitly. The dependent tables are DERIVED from `information_schema` rather than remembered
 * (`reference_a_list_of_members_is_a_set_claim`), and the read-back addresses the families by SKU PREFIX and by
 * their ids, so a row missed by one address is caught by the other (`reference_clean_up_by_value_not_by_row`).
 */
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'
const url = parse(readFileSync(new URL('../.env', import.meta.url).pathname, 'utf8')).DATABASE_URL!
if (!/nexus_development/.test(url) || !/127\.0\.0\.1|localhost/.test(url)) throw new Error('REFUSED: not the local database')
const prisma = new PrismaClient({ datasources: { db: { url } } })

const db = await prisma.$queryRawUnsafe<Array<{ db: string }>>(`SELECT current_database()::text AS db`)
if (db[0].db !== 'nexus_development') throw new Error(`REFUSED: current_database() = ${db[0].db}`)
const galeBefore = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { version: true } })
const productsBefore = await prisma.product.count()
console.log('DISCRIMINATOR', JSON.stringify({ current_database: db[0].db, products: productsBefore, galeVersion: galeBefore?.version }))

const mine = await prisma.product.findMany({ where: { sku: { startsWith: 'VTF2-TEST' } }, select: { id: true, sku: true } })
const ids = mine.map((m) => m.id)
console.log('FAMILY ROWS', JSON.stringify(mine))

/** Every foreign key that points at `Product.id` — derived, never remembered. */
const fks = await prisma.$queryRawUnsafe<Array<{ tbl: string; col: string }>>(`
  SELECT tc.table_name::text AS tbl, kcu.column_name::text AS col
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
  JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'Product' AND ccu.column_name = 'id'
  ORDER BY 1, 2`)
console.log('FOREIGN KEYS POINTING AT Product.id:', fks.length)

const countsFor = async () => {
  const out: Record<string, number> = {}
  for (const fk of fks) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "${fk.tbl}" WHERE "${fk.col}" = ANY($1::text[])`, ids).catch(() => null)
    const n = rows ? Number(rows[0].n) : -1
    if (n !== 0) out[`${fk.tbl}.${fk.col}`] = n
  }
  return out
}
console.log('DRY RUN — dependent rows BEFORE:', JSON.stringify(await countsFor()))

await prisma.$transaction(async (tx) => {
  const listings = await tx.channelListing.deleteMany({ where: { productId: { in: ids } } })
  const cats = await tx.productCategory.deleteMany({ where: { productId: { in: ids } } })
  const kids = await tx.product.deleteMany({ where: { parentId: { in: ids } } })
  const parents = await tx.product.deleteMany({ where: { sku: { startsWith: 'VTF2-TEST' } } })
  console.log('DELETED', JSON.stringify({ channelListing: listings.count, productCategory: cats.count, childProduct: kids.count, parentProduct: parents.count }))
})

const bySku = await prisma.product.count({ where: { sku: { startsWith: 'VTF2-TEST' } } })
const byId = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "Product" WHERE id = ANY($1::text[])`, ids)
const galeAfter = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { version: true } })
const productsAfter = await prisma.product.count()
const shapes = await prisma.$queryRawUnsafe<Array<{ shape: string; n: bigint }>>(`
  SELECT CASE WHEN "variationMapping" IS NULL THEN 'sql-null'
              WHEN jsonb_typeof("variationMapping"::jsonb) = 'null' THEN 'json-null'
              WHEN jsonb_typeof(("variationMapping"::jsonb) -> 'axes') = 'array' THEN 'ordered'
              ELSE 'flat' END AS shape, COUNT(*)::bigint AS n FROM "ChannelListing" GROUP BY 1 ORDER BY 2 DESC`)
console.log('READ-BACK', JSON.stringify({
  bySkuPrefix: bySku, byIds: Number(byId[0].n),
  dependentRowsLeftAcrossAllForeignKeys: await countsFor(),
  foreignKeysChecked: fks.length,
  products: `${productsBefore} → ${productsAfter}`,
  galeVersion: `${galeBefore?.version} → ${galeAfter?.version}`,
  variationMappingShapes: shapes.map(r => [r.shape, Number(r.n)]),
}, null, 1))
await prisma.$disconnect()
