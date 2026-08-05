/** APS.3 — READ-ONLY: pick real ASINs for the prod eligibility probe. */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const kids = await p.productReadCache.findMany({
  where: { deletedAt: null, asin: { not: null }, rollupChannelKeys: { hasSome: ['AMAZON_IT'] }, parentId: { not: null } },
  select: { sku: true, asin: true }, take: 4, orderBy: { sku: 'asc' },
})
const parent = await p.productReadCache.findFirst({
  where: { deletedAt: null, parentId: null, childCount: { gt: 0 }, asin: { not: null }, rollupChannelKeys: { hasSome: ['AMAZON_IT'] } },
  select: { sku: true, asin: true },
})
console.log('CHILDREN=' + kids.map((k: any) => k.asin).join(','))
for (const k of kids) console.log(`   child ${String(k.sku).padEnd(34)} ${k.asin}`)
console.log('PARENT=' + parent?.asin + '  (' + parent?.sku + ')')
await prisma.$disconnect()
