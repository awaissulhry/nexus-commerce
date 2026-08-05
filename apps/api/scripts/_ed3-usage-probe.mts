/** READ-ONLY: ED v2 P3 — verify the /description-themes/usage aggregation
 *  logic against real data (same grouping as the new route). */
const { default: prisma } = await import('../src/db.js')

const listings = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { platformAttributes: true },
})
const byThemeId: Record<string, number> = {}
let usingDefault = 0
let raw = 0
for (const l of listings) {
  const attrs = (l.platformAttributes ?? {}) as Record<string, unknown>
  const v = typeof attrs.descriptionThemeId === 'string' ? attrs.descriptionThemeId : ''
  if (v === '') usingDefault += 1
  else if (v === 'none') raw += 1
  else byThemeId[v] = (byThemeId[v] ?? 0) + 1
}
console.log('total:', listings.length, '| default:', usingDefault, '| raw:', raw)
const themes = await prisma.ebayDescriptionTheme.findMany({ select: { id: true, name: true, active: true, isDefault: true } })
for (const [id, n] of Object.entries(byThemeId)) {
  const t = themes.find((x) => x.id === id)
  console.log(`  ${id} -> ${n}  (${t ? `${t.name}${t.active ? '' : ' INACTIVE'}${t.isDefault ? ' DEFAULT' : ''}` : 'THEME MISSING'})`)
}
console.log('themes:', themes.map((t) => `${t.name}${t.isDefault ? '*' : ''}${t.active ? '' : ' (inactive)'}`).join(' · '))
await prisma.$disconnect()
