import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
for (const t of ['AdProductAd','AdTarget','AdGroup','AmazonAdsPortfolio']) {
  const r = await prisma.$queryRawUnsafe<Record<string,unknown>[]>(
    `SELECT string_agg(column_name::text, ', ' ORDER BY ordinal_position) AS c
     FROM information_schema.columns WHERE table_name=$1`, t)
  console.log(`${t}: ${r[0]?.c}`)
}
await prisma.$disconnect()
