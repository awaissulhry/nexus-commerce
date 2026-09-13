const url = process.argv[2]
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
const q = <T = any>(s: string, ...a: unknown[]) => p.$queryRawUnsafe<T[]>(s, ...a)
const gale = (await q(`SELECT id, version, "variationAxes" FROM "Product" WHERE sku='GALE-JACKET'`))[0]
const kids = await q<{ id: string; sku: string }>(`SELECT id, sku FROM "Product" WHERE "parentId"=$1 AND "deletedAt" IS NULL ORDER BY sku`, gale.id)
console.log('children:', kids.length)
console.log('childIds:', JSON.stringify(kids.map(k => k.id)))
for (const mk of ['IT','DE']) {
  const r = (await q<{ themes: any; def: any; fetchedAt: Date }>(`SELECT "variationThemes" themes, "schemaDefinition" def, "fetchedAt" FROM "CategorySchema" WHERE channel='AMAZON' AND "productType"='OUTERWEAR' AND "marketplace"=$1 ORDER BY "fetchedAt" DESC LIMIT 1`, mk))[0]
  const themes: string[] = Array.isArray(r.themes) ? r.themes : (r.themes?.themes ?? [])
  const widest = themes.reduce((m, t) => Math.max(m, t.split('/').length), 0)
  const props = r.def?.properties ?? {}
  console.log(`${mk}: ${themes.length} themes · widest ${widest} · fetchedAt ${r.fetchedAt.toISOString()}`)
  console.log(`  titles: color="${props.color?.title}" size="${props.size?.title}" style="${props.style?.title}" material="${props.material?.title}"`)
  const nm = r.def?.properties?.variation_theme?.items?.properties?.name
  const en: string[] = nm?.enum ?? [], names: string[] = nm?.enumNames ?? []
  for (const t of ['COLOR/SIZE','COLOR_NAME/SIZE_NAME','SIZE/COLOR']) console.log(`  ${t} enumName="${names[en.indexOf(t)] ?? '(none)'}" present=${en.includes(t)}`)
  const dep = nm?.enumDeprecated ?? nm?.deprecated ?? null
  console.log('  deprecation key on name node:', JSON.stringify(Object.keys(nm ?? {})))
}
await p.$disconnect()
