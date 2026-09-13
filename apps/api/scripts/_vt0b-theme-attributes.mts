/**
 * VT.0 (b) — what does an Amazon product-type schema BIND a theme spelling to? Read-only.
 *   npx tsx scripts/_vt0b-theme-attributes.mts <DATABASE_URL>
 */
const url = process.argv[2]
if (!url) { console.error('usage: tsx _vt0b-theme-attributes.mts <DATABASE_URL>'); process.exit(2) }
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url: url.replace('-pooler', '') } } })
const q = <T = Record<string, unknown>>(s: string, ...args: unknown[]) => p.$queryRawUnsafe<T[]>(s, ...args)
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))

// 1. the Amazon listing rows that carry a theme today, and the one mapping row
console.log('=== ChannelListing rows with a variationTheme on AMAZON, plus the one with a variationMapping')
console.log(j(await q(`SELECT cl.channel, cl."marketplace", pr.sku, pr."parentId" IS NULL AS is_root, cl."variationTheme", cl."variationMapping", cl."listingStatus"
  FROM "ChannelListing" cl JOIN "Product" pr ON pr.id = cl."productId"
  WHERE (cl.channel = 'AMAZON' AND cl."variationTheme" IS NOT NULL) OR cl."variationMapping" IS NOT NULL ORDER BY cl.channel, pr.sku`)))
console.log('\n=== distinct Product.variationTheme values (the eBay SET store), with counts')
console.log(j(await q(`SELECT "variationTheme", count(*)::bigint AS n, sum(CASE WHEN "parentId" IS NULL THEN 1 ELSE 0 END)::bigint AS roots FROM "Product" GROUP BY 1 ORDER BY 2 DESC LIMIT 12`)))

// 2. the OUTERWEAR schema on IT and DE: which attributes exist, and what the variation_theme block looks like
for (const mk of ['IT', 'DE']) {
  const rows = await q<{ schemaDefinition: any }>(`SELECT "schemaDefinition" FROM "CategorySchema" WHERE channel='AMAZON' AND "productType"='OUTERWEAR' AND "marketplace"=$1 ORDER BY "fetchedAt" DESC LIMIT 1`, mk)
  const s = rows[0]?.schemaDefinition
  const props = s?.properties ?? {}
  const names = Object.keys(props)
  console.log(`\n=== OUTERWEAR · ${mk}: ${names.length} top-level properties · schema $id ${s?.$id ?? '(none)'} · provenance ${j(s?.__schemaProvenance ?? null)}`)
  for (const k of ['color', 'color_name', 'size', 'size_name', 'style', 'style_name', 'material', 'material_type', 'variation_theme', 'parentage_level', 'child_parent_sku_relationship', 'color_map', 'size_map']) {
    const v = props[k]
    if (!v) { console.log(`  ${k}: ABSENT`); continue }
    const item = v.items?.properties ?? v.properties ?? {}
    const sub = Object.keys(item)
    console.log(`  ${k}: present · title "${v.title ?? ''}" · ${v.type} · item keys ${j(sub)}`)
  }
  const vt = props.variation_theme
  const name = vt?.items?.properties?.name
  console.log(`  variation_theme.items.properties.name keys: ${j(Object.keys(name ?? {}))}`)
  if (name?.enumNames) {
    const en: string[] = name.enum ?? [], nm: string[] = name.enumNames ?? []
    const pick = (t: string) => `${t} → "${nm[en.indexOf(t)] ?? '(no label)'}"`
    console.log(`  localized labels (${mk}): ${['COLOR/SIZE', 'COLOR_NAME/SIZE_NAME', 'SIZE/COLOR', 'SIZE_NAME/COLOR_NAME', 'COLOR', 'COLOR_NAME'].map(pick).join(' · ')}`)
  }
  // does the schema say anywhere which attribute a theme segment selects? look for 'COLOR_NAME' outside the enum
  const text = JSON.stringify(s)
  const hits = (re: RegExp) => (text.match(re) ?? []).length
  console.log(`  mentions: "COLOR_NAME" ${hits(/COLOR_NAME/g)} · "color_name" ${hits(/"color_name"/g)} · "SIZE_NAME" ${hits(/SIZE_NAME/g)} · "size_name" ${hits(/"size_name"/g)} · "variation_theme" ${hits(/variation_theme/g)}`)
  // the description on the theme, verbatim
  console.log(`  variation_theme description: ${j(vt?.description ?? vt?.items?.description ?? null)}`)
  console.log(`  name.description: ${j(name?.description ?? null)}`)
}
await p.$disconnect()
