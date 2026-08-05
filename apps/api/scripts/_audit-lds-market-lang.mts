/**
 * READ-ONLY audit: per-market aspect_* key language state.
 * Dimension: LIVE DATA STATE per MARKET.
 */
const { default: prisma } = await import('../src/db.js')

const ITALIAN = new Set(['colore','taglia','stile','materiale','genere','marca','stagione','paese di fabbricazione','tipo di giacca','tipo di prodotto','adatto a','livello di protezione','reparto','vestibilità','vestibilita','condizione','colori','misura'])
const ENGLISH = new Set(['color','colour','color name','color_name','size','size name','size_name','style','style name','material','material name','gender','department','target audience','brand','season','country/region of manufacture','country of manufacture','made in','jacket type','product type','suitable for','protection level','fit','condition','made in'])
const GERMAN = new Set(['farbe','größe','grosse','marke'])
const FRENCH = new Set(['couleur','taille','marque'])

function lang(name: string): string {
  const lk = name.toLowerCase().trim()
  if (GERMAN.has(lk)) return 'DE'
  if (FRENCH.has(lk)) return 'FR'
  if (ITALIAN.has(lk)) return 'IT'
  if (ENGLISH.has(lk)) return 'EN'
  return 'other'
}

function aspectKeys(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object') return []
  return Object.keys(obj as Record<string, unknown>).filter(k => k.startsWith('aspect_') && k !== 'aspect_')
}
function keyName(k: string) { return k.slice('aspect_'.length).replace(/_/g, ' ').trim() }

type Bucket = { market: string; source: string; key: string; lang: string; count: number }
const tally = new Map<string, Bucket>()
function add(market: string, source: string, key: string) {
  const nm = keyName(key)
  const id = `${market}|${source}|${key}`
  const b = tally.get(id)
  if (b) b.count++
  else tally.set(id, { market, source, key, lang: lang(nm), count: 1 })
}

// ── Lane B: SharedListingMembership.flatFileSnapshot ──────────────────
const mems = await prisma.sharedListingMembership.findMany({
  select: { id: true, marketplace: true, sku: true, itemId: true, parentSku: true, status: true, flatFileSnapshot: true, variationSpecifics: true },
})
console.log(`\n=== SharedListingMembership: ${mems.length} rows ===`)
for (const m of mems) {
  for (const k of aspectKeys(m.flatFileSnapshot)) add(m.marketplace, 'SLM.flatFileSnapshot', k)
}

// ── Lane A: ChannelListing (EBAY) ─────────────────────────────────────
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: {
    id: true, productId: true, marketplace: true, region: true, channelMarket: true,
    externalListingId: true, variationTheme: true, flatFileSnapshot: true, platformAttributes: true,
    product: { select: { sku: true, variationTheme: true, parentId: true, isMaster: true, masterSku: true, status: true } },
  },
})
console.log(`=== ChannelListing(EBAY): ${cls.length} rows ===`)
for (const c of cls) {
  for (const k of aspectKeys(c.flatFileSnapshot)) add(c.marketplace, 'CL.flatFileSnapshot', k)
  const pa = c.platformAttributes as Record<string, unknown> | null
  const isp = pa && typeof pa === 'object' ? (pa as any).itemSpecifics : null
  if (isp && typeof isp === 'object' && !Array.isArray(isp)) {
    for (const k of Object.keys(isp)) add(c.marketplace, 'CL.platformAttributes.itemSpecifics', `aspect_${k.replace(/ /g,'_')}`)
  }
}

// ── Output table ──────────────────────────────────────────────────────
const rows = [...tally.values()].sort((a,b) => a.market.localeCompare(b.market) || a.source.localeCompare(b.source) || a.key.localeCompare(b.key))
console.log('\n=== PER-MARKET ASPECT KEY TABLE ===')
console.log('MARKET | SOURCE | KEY | LANG | COUNT')
for (const r of rows) console.log(`${r.market} | ${r.source} | ${r.key} | ${r.lang} | ${r.count}`)

// ── Language summary per market ───────────────────────────────────────
console.log('\n=== LANGUAGE MIX PER MARKET (distinct keys / row-hits) ===')
const byMarket = new Map<string, Map<string, { keys: Set<string>; hits: number }>>()
for (const r of rows) {
  if (!byMarket.has(r.market)) byMarket.set(r.market, new Map())
  const m = byMarket.get(r.market)!
  if (!m.has(r.lang)) m.set(r.lang, { keys: new Set(), hits: 0 })
  m.get(r.lang)!.keys.add(r.key)
  m.get(r.lang)!.hits += r.count
}
for (const [mk, langs] of [...byMarket.entries()].sort()) {
  const parts = [...langs.entries()].sort().map(([l, v]) => `${l}=${v.keys.size}keys/${v.hits}hits`)
  console.log(`${mk}: ${parts.join('  ')}`)
}

await prisma.$disconnect()
