// READ-ONLY probe: are description themes in use? (theme rows + assignments)
const { default: prisma } = await import('../src/db.js')

const themes = await prisma.ebayDescriptionTheme.findMany({
  select: { id: true, name: true, isDefault: true, active: true, builtIn: true, version: true, html: true },
})
console.log('THEMES:')
for (const t of themes) {
  console.log(
    `  ${t.name} | default=${t.isDefault} active=${t.active} builtIn=${t.builtIn} v${t.version} | tokens: gallery=${/\{\{\s*gallery\s*\}\}/i.test(t.html)} gallery_shared=${/\{\{\s*gallery_shared\s*\}\}/i.test(t.html)}`,
  )
}

const listings = await prisma.$queryRaw<Array<{ theme: string; n: bigint }>>`
  SELECT COALESCE("platformAttributes"->>'descriptionThemeId','(unset)') AS theme, COUNT(*) AS n
  FROM "ChannelListing"
  WHERE channel = 'EBAY'
  GROUP BY 1 ORDER BY 2 DESC`
console.log('EBAY listing assignments by descriptionThemeId:')
for (const r of listings) console.log(`  ${r.theme}: ${r.n}`)

// curation coverage: products with EBAY ListingImage rows + publishStatus mix
const cur = await prisma.$queryRaw<Array<{ status: string; products: bigint; rows: bigint }>>`
  SELECT "publishStatus" AS status, COUNT(DISTINCT "productId") AS products, COUNT(*) AS rows
  FROM "ListingImage" WHERE platform = 'EBAY' AND "mediaType" = 'IMAGE'
  GROUP BY 1 ORDER BY 2 DESC`
console.log('EBAY ListingImage publishStatus:')
for (const r of cur) console.log(`  ${r.status}: ${r.products} products / ${r.rows} rows`)

await prisma.$disconnect()
