import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const a = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT COUNT(DISTINCT asin) AS asins, COUNT(*) AS rows, COALESCE(SUM("impressionsBrand"),0) AS impr
  FROM "SearchQueryPerformance" WHERE marketplace='IT' AND asin IN (
  'B0FX724138','B0FX678614','B0FXFE1AE0','B0FXC8EB4F','B0FX6D1D3B','B0FX9AF581',
  'B0FX0ADF9B','B0FX18028B','B0FX9CD580','B0FX89E095','B0FXEC394C','B0FXA82507','B0FX10086B')`)
console.log('AIREON SQP:', a)
const t = await prisma.adTarget.findUnique({ where: { id: 'cmpsr2j4j01r7ry01lenuh91c' }, select: { bidCents: true } })
console.log('last consolidation target bid:', t?.bidCents)
await prisma.$disconnect()
process.exit(0)
