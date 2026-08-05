/** READ-ONLY review probe: distinct aspect_* key names across eBay listing
 *  flatFileSnapshots — does the Specifiche section ever contain measurements? */
const { default: prisma } = await import('../src/db.js')

const rows = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', flatFileSnapshot: { not: null } },
  select: { flatFileSnapshot: true, region: true, product: { select: { sku: true } } },
})

const counts = new Map<string, number>()
let withSnapshot = 0
for (const r of rows) {
  const snap = r.flatFileSnapshot as Record<string, unknown> | null
  if (!snap || typeof snap !== 'object') continue
  withSnapshot++
  const seen = new Set<string>()
  for (const [key, val] of Object.entries(snap)) {
    if (!key.startsWith('aspect_') || typeof val !== 'string' || !val.trim()) continue
    const display = key.slice('aspect_'.length).replace(/_/g, ' ').toLowerCase()
    if (seen.has(display)) continue
    seen.add(display)
    counts.set(display, (counts.get(display) ?? 0) + 1)
  }
}
console.log('eBay listings with snapshot:', withSnapshot, 'of', rows.length)
console.log('distinct aspect names (lowercased) with listing counts:')
for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${name}`)
}
// Any measurement-looking aspects?
const measureish = [...counts.keys()].filter((k) =>
  /misur|cm\b|lunghezza|larghezza|circonferenza|torace|vita|petto|spalle|manica|measure|length|width|chest|waist|sleeve|size chart|guida/i.test(k),
)
console.log('\nmeasurement-like aspect names:', JSON.stringify(measureish))
await prisma.$disconnect()
