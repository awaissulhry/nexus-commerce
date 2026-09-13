const url = process.argv[2]
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
const q = <T = any>(s: string, ...a: unknown[]) => p.$queryRawUnsafe<T[]>(s, ...a)
const j = (v: unknown) => JSON.stringify(v)
for (const [mk, pt] of [['IT','OUTERWEAR'],['UK','OUTERWEAR'],['DE','SUIT']]) {
  const sch = await q(`SELECT "fetchedAt", "schemaVersion", "schemaDefinition"->'properties'->'purchasable_offer'->'items'->'properties' AS props FROM "CategorySchema" WHERE channel='AMAZON' AND "productType"=$1 AND marketplace=$2 AND "isActive" ORDER BY "fetchedAt" DESC LIMIT 1`, pt, mk)
  const pr = sch[0]?.props
  console.log(`\n=== ${mk}/${pt} fetched ${sch[0]?.fetchedAt?.toISOString?.()} v${sch[0]?.schemaVersion}`)
  console.log('discounted_price:', j(pr?.discounted_price))
  console.log('start_at:', j(pr?.start_at)); console.log('end_at:', j(pr?.end_at))
  console.log('our_price.items.properties.schedule.items.properties keys:', pr?.our_price ? Object.keys(pr.our_price.items?.properties?.schedule?.items?.properties ?? {}) : null)
  console.log('currency:', j(pr?.currency)?.slice(0, 300))
}
console.log('\nvariationExcluded declared in DB?', j(await q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='ChannelListing' AND column_name IN ('variationExcluded','salePriceStart','salePriceEnd','salePrice')`)))
console.log('_prisma_migrations tail:', j(await q(`SELECT migration_name, finished_at IS NOT NULL AS done FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5`)))
await p.$disconnect()
