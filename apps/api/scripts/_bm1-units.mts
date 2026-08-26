import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })
const rows = await prisma.amazonAdsBrandBuildingMetric.findMany({ select: { metrics: true } })
const range = (k: string) => {
  const v = rows.map(r => (r.metrics as Record<string, string>)[k]).filter(Boolean).map(Number)
  return v.length ? `min ${Math.min(...v)}  max ${Math.max(...v)}  n=${v.length}` : 'absent'
}
for (const k of [
  'engagedShopperRateLowerBound','engagedShopperRateUpperBound',
  'engagedShopperRateCategoryMedianUpperBound','engagedShopperRateCategoryTopPerformersUpperBound',
  'customerConversionRate','customerConversionRateCategoryTopPerformers',
  'newToBrandCustomerRate','newToBrandCustomerRateCategoryTopPerformers',
  'awarenessIndex','salesIndex',
  'addToCartsReturnOnEngagement','addToCartsROECategoryTopPerformers',
]) console.log(k.padEnd(52), range(k))
await prisma.$disconnect()
