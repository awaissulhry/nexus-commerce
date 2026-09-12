/** READ-ONLY. RPX — is the business-context COGS caveat still true? */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(s)
for (const [t, sql] of [
  ['Product cost price', `SELECT COUNT(*)::int AS products, COUNT(*) FILTER (WHERE "costPrice" IS NOT NULL AND "costPrice" <> 0)::int AS with_cost FROM "Product"`],
  ['ProductProfitDaily cogs', `SELECT COUNT(*)::int AS rows, COUNT(*) FILTER (WHERE "cogsCents" <> 0)::int AS nonzero FROM "ProductProfitDaily"`],
  ['AmazonEconomicsDaily cogs', `SELECT COUNT(*)::int AS rows, COUNT(*) FILTER (WHERE "costOfGoodsSold" IS NOT NULL AND "costOfGoodsSold" <> 0)::int AS nonzero FROM "AmazonEconomicsDaily"`],
] as const) {
  try { console.log(t, JSON.stringify((await q(sql))[0])) } catch (e) { console.log(t, 'ERR', (e as Error).message.slice(0, 90)) }
}
await prisma.$disconnect()
