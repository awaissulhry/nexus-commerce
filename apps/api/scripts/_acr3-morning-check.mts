import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const t = await prisma.adTarget.findUnique({ where: { id: 'cmpsr2j4j01r7ry01lenuh91c' }, select: { bidCents: true } })
console.log('1. floor target bid (want 5):', t?.bidCents)
const s = await prisma.keywordCoverageSet.findFirst({
  where: { portfolioId: '255127157311072' },
  select: { enabled: true, terms: { where: { targetSharePct: { not: null } }, select: { id: true } } },
})
console.log('2. GALE set enabled:', s?.enabled, '· terms with target set:', s?.terms.length)
const tos = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT COUNT(*) AS with_tos FROM "AmazonAdsPlacementReport" WHERE "topOfSearchIS" IS NOT NULL`)
console.log('3. placement rows with topOfSearchIS:', tos)
const wk = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT "startDate"::text AS week, COUNT(DISTINCT asin) AS asins, COUNT(*) AS rows
  FROM "SearchQueryPerformance" WHERE marketplace='IT' AND "startDate" >= '2026-07-19'
  GROUP BY 1 ORDER BY 1`)
console.log('4. SQP weeks stored from 07-19 on:', wk)
const obs = await prisma.advertisingActionLog.count({ where: { actionType: 'coverage_engine_observe', createdAt: { gte: new Date('2026-08-06T00:00:00Z') } } })
console.log('5. engine observe rows today:', obs)
await prisma.$disconnect()
process.exit(0)
