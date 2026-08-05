import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const AXIS = [
  ['colore','color','colour','color name','color_name','couleur','farbe','kleur','colour name','colori'],
  ['taglia','size','size name','size_name','misura','größe','grosse','taille','maat','maten','koko'],
  ['stile','style','style name','style_name'],
  ['materiale','material','material name','material_name'],
  ['genere','gender','department','target audience','target_audience'],
]
const ASPECT = [...AXIS,
  ['marca','brand','marke','marque'],
  ['stagione','season'],
  ['paese di fabbricazione','country/region of manufacture','country of manufacture','made in'],
  ['tipo di giacca','jacket type'],
  ['tipo di prodotto','product type'],
  ['adatto a','suitable for'],
  ['livello di protezione','protection level'],
  ['reparto','department'],
  ['vestibilità','vestibilita','fit'],
  ['condizione','condition'],
]
const known = new Set(ASPECT.flat())

const ms = await prisma.sharedListingMembership.findMany({ select: { marketplace: true, itemId: true, sku: true, flatFileSnapshot: true } })
const cls = await prisma.channelListing.findMany({ where: { channel: 'EBAY' }, select: { marketplace: true, externalListingId: true, flatFileSnapshot: true } })

const counts = new Map<string, number>()
const unmapped = new Map<string, number>()
const themes = new Map<string, number>()
let condCols = 0
const bump = (m: Map<string,number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)

const scan = (snap: any, mkt: string) => {
  if (!snap || typeof snap !== 'object') return
  for (const k of Object.keys(snap)) {
    if (!k.startsWith('aspect_')) continue
    const name = k.slice(7).replace(/_/g, ' ').trim().toLowerCase()
    bump(counts, `${mkt}|${name}`)
    if (!known.has(name)) bump(unmapped, name)
    if (name === 'condizione' || name === 'condition') condCols++
  }
  const t = snap.variation_theme
  if (typeof t === 'string' && t.trim()) bump(themes, `${mkt}|${t.trim()}`)
}
for (const m of ms) scan(m.flatFileSnapshot as any, m.marketplace)
for (const c of cls) scan(c.flatFileSnapshot as any, c.marketplace)

console.log('memberships', ms.length, 'channelListings', cls.length)
console.log('\n== aspect key counts (market|name) ==')
for (const [k, v] of [...counts.entries()].sort((a,b)=>b[1]-a[1])) console.log(v, k)
console.log('\n== UNMAPPED (operator-authored, pass through) ==')
for (const [k, v] of [...unmapped.entries()].sort((a,b)=>b[1]-a[1])) console.log(v, k)
console.log('\n== condition-group aspect columns stored:', condCols)
console.log('\n== declared variation_theme values ==')
for (const [k, v] of [...themes.entries()].sort((a,b)=>b[1]-a[1])) console.log(v, k)

// distinct axis VALUES per market for dim0/dim4 to test value-synonym coverage
const vals = new Map<string, Set<string>>()
const scanVals = (snap: any, mkt: string) => {
  if (!snap || typeof snap !== 'object') return
  for (const [k, v] of Object.entries(snap)) {
    if (!k.startsWith('aspect_') || typeof v !== 'string') continue
    const name = k.slice(7).replace(/_/g,' ').trim().toLowerCase()
    if (!AXIS[0].includes(name) && !AXIS[4].includes(name)) continue
    const key = `${mkt}|${name}`
    if (!vals.has(key)) vals.set(key, new Set())
    vals.get(key)!.add(v)
  }
}
for (const m of ms) scanVals(m.flatFileSnapshot as any, m.marketplace)
for (const c of cls) scanVals(c.flatFileSnapshot as any, c.marketplace)
console.log('\n== colour/gender values seen ==')
for (const [k, s] of vals) console.log(k, '=>', [...s].slice(0, 40).join(' ; '))
await prisma.$disconnect()
