import { default as prisma } from '../src/db.js'

const foreign = ['farbe', 'couleur', 'größe', 'grosse', 'taille', 'marke', 'marque', 'kleur', 'maat', 'condition', 'condizione', 'color_name', 'size_name', 'colori', 'koko', 'maten']

async function scan(label: string, rows: Array<{ id: string; sku?: string | null; snap: unknown }>) {
  const hits = new Map<string, number>()
  for (const r of rows) {
    const s = r.snap as Record<string, unknown> | null
    if (!s || typeof s !== 'object') continue
    for (const k of Object.keys(s)) {
      if (!k.startsWith('aspect_')) continue
      const name = k.slice('aspect_'.length).replace(/_/g, ' ').toLowerCase().trim()
      if (foreign.includes(name)) hits.set(k, (hits.get(k) ?? 0) + 1)
    }
  }
  console.log(`\n== ${label}: ${rows.length} rows scanned`)
  if (hits.size === 0) console.log('   no foreign-language / condition aspect keys')
  for (const [k, n] of [...hits].sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${n}`)
}

const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { id: true, flatFileSnapshot: true, marketplace: true },
})
await scan('ChannelListing.flatFileSnapshot', cls.map((c) => ({ id: c.id, snap: c.flatFileSnapshot })))

const mems = await prisma.sharedListingMembership.findMany({
  select: { id: true, sku: true, flatFileSnapshot: true },
})
await scan('SharedListingMembership.flatFileSnapshot', mems.map((m) => ({ id: m.id, sku: m.sku, snap: m.flatFileSnapshot })))

// all distinct aspect_ keys overall, to see the real vocabulary
const all = new Map<string, number>()
for (const c of cls) {
  const s = c.flatFileSnapshot as Record<string, unknown> | null
  if (s && typeof s === 'object') for (const k of Object.keys(s)) if (k.startsWith('aspect_')) all.set(k, (all.get(k) ?? 0) + 1)
}
for (const m of mems) {
  const s = m.flatFileSnapshot as Record<string, unknown> | null
  if (s && typeof s === 'object') for (const k of Object.keys(s)) if (k.startsWith('aspect_')) all.set(k, (all.get(k) ?? 0) + 1)
}
console.log('\n== distinct aspect_ keys across both lanes')
for (const [k, n] of [...all].sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${n}`)
await prisma.$disconnect()
