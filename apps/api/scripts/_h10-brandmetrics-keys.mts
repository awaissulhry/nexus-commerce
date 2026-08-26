/** H10 cross-check — what the Brand Metrics payload actually carries. READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })

const n = await prisma.amazonAdsBrandBuildingMetric.count()
const spread = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "marketplace", COUNT(*)::int rows, COUNT(DISTINCT "brandName")::int brands,
         COUNT(DISTINCT "categoryNodeName")::int nodes,
         MIN("computationDate")::text first, MAX("computationDate")::text last
  FROM "AmazonAdsBrandBuildingMetric" GROUP BY 1 ORDER BY 2 DESC`)
console.log('rows', n); console.log('spread', JSON.stringify(spread))

const one = await prisma.amazonAdsBrandBuildingMetric.findFirst({
  orderBy: { computationDate: 'desc' },
  select: { brandName: true, marketplace: true, computationDate: true, categoryNodeName: true, metrics: true },
})
console.log('\nnewest row:', one?.brandName, one?.marketplace, one?.computationDate?.toISOString().slice(0,10))
console.log('category:', one?.categoryNodeName)
console.log('\nRAW metrics JSON:')
console.log(JSON.stringify(one?.metrics, null, 2))
await prisma.$disconnect()
