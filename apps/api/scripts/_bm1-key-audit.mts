/** BM.1 — verify every benchmark key name against EVERY row. READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })

const type = await prisma.$queryRawUnsafe<Array<{ data_type: string }>>(
  `SELECT data_type FROM information_schema.columns
   WHERE table_name='AmazonAdsBrandBuildingMetric' AND column_name='metrics'`)
console.log('metrics column type:', type[0]?.data_type)

const rows = await prisma.amazonAdsBrandBuildingMetric.findMany({ select: { metrics: true } })
const seen = new Map<string, number>()
for (const r of rows) for (const k of Object.keys(r.metrics as object)) seen.set(k, (seen.get(k) ?? 0) + 1)
console.log(`\n${rows.length} rows · ${seen.size} distinct keys across all of them\n`)

const GROUPS: Array<[string, string, string, string]> = [
  // label, own, median, top
  ['Add to carts',            'addToCarts',                        'addToCartsCategoryMedian',                        'addToCartsCategoryPerformers'],
  ['Brand customers',         'brandCustomers',                    'brandCustomersCategoryMedian',                    'brandCustomersCategoryTopPerformers'],
  ['Detail page views',       'viewedDetailPageOnly',              'viewedDetailPageCategoryMedian',                  'viewedDetailPageCategoryTopPerformers'],
  ['High-value customers',    'highValueCustomers',                'highValueCustomersCategoryMedian',                'highValueCustomersCategoryTopPerformers'],
  ['Customer conversion',     'customerConversionRate',            'customerConversionRateCategoryMedian',            'customerConversionRateCategoryTopPerformers'],
  ['New-to-brand rate',       'newToBrandCustomerRate',            'newToBrandCustomerRateCategoryMedian',            'newToBrandCustomerRateCategoryTopPerformers'],
  ['Branded search + DPV',    'brandedSearchesAndDetailPageViews', 'brandedSearchesAndDetailPageViewsCategoryMedian', 'brandedSearchesAndDetailPageViewsCategoryTopPerformers'],
  ['ROE · add to carts',      'addToCartsReturnOnEngagement',      'addToCartsROECategoryMedian',                     'addToCartsROECategoryTopPerformers'],
  ['ROE · brand customers',   'brandCustomersReturnOnEngagement',  'brandCustomersROECategoryMedian',                 'brandCustomersROECategoryTopPerformers'],
  ['ROE · detail page',       'viewedDetailPageOnlyReturnOnEngagement', 'viewedDetailPageROECategoryMedian',          'viewedDetailPageROECategoryTopPerformers'],
  ['ROE · high value',        'highValueCustomersReturnOnEngagement',   'highValueCustomersROECategoryMedian',        'highValueCustomersROECategoryTopPerformers'],
  ['ROE · branded + DPV',     'brandedSearchesAndDetailPageViewsReturnOnEngagement', 'brandedSearchesAndDetailPageViewsROECategoryMedian', 'brandedSearchesAndDetailPageViewsROECategoryTopPerformers'],
]
const BANDS = [
  'engagedShopperRateLowerBound', 'engagedShopperRateUpperBound',
  'engagedShopperRateCategoryMedianLowerBound', 'engagedShopperRateCategoryMedianUpperBound',
  'engagedShopperRateCategoryTopPerformersLowerBound', 'engagedShopperRateCategoryTopPerformersUpperBound',
]
const hit = (k: string) => { const n = seen.get(k) ?? 0; return `${n === 0 ? '✗ MISSING' : String(n).padStart(3)}` }
console.log('label                    own        median     top')
for (const [label, own, med, top] of GROUPS) {
  console.log(`${label.padEnd(24)} ${hit(own).padEnd(10)} ${hit(med).padEnd(10)} ${hit(top)}`)
}
console.log('\nband keys:')
for (const b of BANDS) console.log(`  ${b.padEnd(52)} ${hit(b)}`)

const claimed = new Set([...GROUPS.flatMap(g => g.slice(1)), ...BANDS])
const unclaimed = [...seen.keys()].filter(k => !claimed.has(k)).sort()
console.log(`\nkeys NOT covered by the groups above (${unclaimed.length}):`)
for (const k of unclaimed) console.log(`  ${k}  (${seen.get(k)})`)

// A non-numeric value would make ::numeric throw at query time.
const bad = new Set<string>()
for (const r of rows) for (const [k, v] of Object.entries(r.metrics as Record<string, unknown>)) {
  if (typeof v !== 'string' || !/^-?\d+(\.\d+)?$/.test(v)) bad.add(`${k}=${JSON.stringify(v)}`)
}
console.log(`\nnon-numeric values: ${bad.size === 0 ? 'none — ::numeric is safe' : [...bad].join(', ')}`)
await prisma.$disconnect()
