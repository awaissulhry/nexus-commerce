import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const t = await prisma.adTarget.findUnique({ where: { id: 'cmpsr2j4j01r7ry01lenuh91c' }, select: { bidCents: true } })
const s = await prisma.keywordCoverageSet.findFirst({ where: { portfolioId: '255127157311072' }, select: { enabled: true } })
const sb = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT "adProduct", COUNT(*) AS n, COUNT(*) FILTER (WHERE status='ENABLED') AS enabled
  FROM "Campaign" WHERE "adProduct" IN ('SPONSORED_BRANDS','SPONSORED_DISPLAY') GROUP BY 1`)
console.log('floor target bid:', t?.bidCents, '· GALE set enabled:', s?.enabled)
console.log('SB/SD campaigns:', sb)
await prisma.$disconnect()
process.exit(0)
