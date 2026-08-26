import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT COUNT(DISTINCT asin) AS asins, COUNT(*) AS rows FROM "SearchQueryPerformance"
  WHERE marketplace='IT' AND asin LIKE 'B0F4%' OR asin='B0F7RTV2BD'`)
console.log('AIREON SQP rows:', r)
await prisma.$disconnect()
