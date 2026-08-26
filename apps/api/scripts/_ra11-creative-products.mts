/** RA.GRAIN — does creativeJson.products really hold 2–3 ASINs per ad, or is my query lying? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const rows = await prisma.adProductAd.findMany({
  where: { creativeJson: { not: null } },
  select: { id: true, asin: true, sku: true, adType: true, creativeJson: true },
  take: 4,
})
console.log('\n═══ raw creativeJson, 4 rows ═══')
for (const r of rows) {
  console.log(`\n-- flat asin=${r.asin} sku=${r.sku} adType=${r.adType}`)
  console.log(`   creativeJson = ${JSON.stringify(r.creativeJson).slice(0, 500)}`)
}

// Is `products` an array of ASIN-bearing objects, or something else entirely?
const shapes = await prisma.$queryRawUnsafe<Array<{ shape: string; n: number }>>(`
  SELECT jsonb_typeof("creativeJson"->'products') shape, COUNT(*)::int n
  FROM "AdProductAd" WHERE "creativeJson" IS NOT NULL GROUP BY 1`)
console.log(`\n═══ typeof creativeJson->'products' ═══\n${JSON.stringify(shapes)}`)

const keys = await prisma.$queryRawUnsafe<Array<{ k: string; n: number }>>(`
  SELECT k, COUNT(*)::int n FROM "AdProductAd", jsonb_object_keys("creativeJson") k
  WHERE "creativeJson" IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 12`)
console.log(`\n═══ top-level keys of creativeJson ═══\n${JSON.stringify(keys)}`)

// The question that matters: how many DISTINCT asins does the products array actually name,
// and does it name any the flat column does not?
const extra = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  WITH exploded AS (
    SELECT pa.id, pa.asin flat_asin, e->>'asin' creative_asin
    FROM "AdProductAd" pa, jsonb_array_elements(pa."creativeJson"->'products') e
    WHERE pa."creativeJson" IS NOT NULL AND jsonb_typeof(pa."creativeJson"->'products') = 'array'
  )
  SELECT COUNT(*)::int exploded_rows,
         COUNT(creative_asin)::int with_asin_key,
         COUNT(DISTINCT creative_asin)::int distinct_creative_asins,
         COUNT(*) FILTER (WHERE creative_asin IS NOT NULL AND creative_asin <> flat_asin)::int differs_from_flat
  FROM exploded`)
console.log(`\n═══ exploding the products array ═══\n${JSON.stringify(extra[0])}`)

const sampleEl = await prisma.$queryRawUnsafe<Array<{ el: unknown }>>(`
  SELECT e el FROM "AdProductAd" pa, jsonb_array_elements(pa."creativeJson"->'products') e
  WHERE pa."creativeJson" IS NOT NULL AND jsonb_typeof(pa."creativeJson"->'products') = 'array' LIMIT 5`)
console.log(`\n═══ sample elements of the products array ═══`)
for (const s of sampleEl) console.log(`   ${JSON.stringify(s.el)}`)

console.log('\n(read-only — nothing was written)')
await prisma.$disconnect()
