import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const a = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT COUNT(DISTINCT asin) AS asins, COUNT(*) AS rows, COALESCE(SUM("impressionsBrand"),0) AS impr
  FROM "SearchQueryPerformance" WHERE marketplace='IT' AND asin IN (
  'B0F4N85JRP','B0F4NC6G2N','B0F4NCN8ZG','B0F4N9WHTM','B0F4ND2WKZ','B0F4NB6PLN',
  'B0F4NTLGFP','B0F4NVKDP9','B0F4NT18GQ','B0F4NV3YNQ','B0F4NVZB6N','B0F4NTV47B','B0F7RTV2BD')`)
console.log('AIREON SQP:', a)
const t = await prisma.adTarget.findUnique({ where: { id: 'cmpsr2j4j01r7ry01lenuh91c' }, select: { bidCents: true } })
console.log('last consolidation target bid:', t?.bidCents)
await prisma.$disconnect()
process.exit(0)
