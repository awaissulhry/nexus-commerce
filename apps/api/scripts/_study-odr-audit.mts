/** READ-ONLY ODR audit: the EU ODR platform closed 2025-07-20 — any link to it
 * in theme/body content must be flagged for removal. */
const { default: prisma } = await import('../src/db.js')
const themes = await prisma.ebayDescriptionTheme.findMany({ select: { id: true, name: true, html: true } })
let hits = 0
for (const t of themes) if (/ec\.europa\.eu\/odr|odr/i.test(t.html)) { hits++; console.log(`THEME "${t.name}" contains ODR reference`) }
const cls = await prisma.channelListing.findMany({ where: { channel: 'EBAY', description: { contains: 'odr', mode: 'insensitive' } }, select: { id: true }, take: 20 }).catch(() => [])
console.log(`themes: ${themes.length}, ODR hits: ${hits}; listing descriptions with 'odr': ${cls.length}`)
await prisma.$disconnect()
