/**
 * READ-ONLY audit: row-level detail of English twins + DE market state.
 */
const { default: prisma } = await import('../src/db.js')

const TWIN_EN = ['aspect_Color','aspect_Size','aspect_Brand','aspect_Colour','aspect_Season','aspect_Style','aspect_Material','aspect_Gender','aspect_Department','aspect_Fit','aspect_Condition','aspect_Jacket_type','aspect_Product_type']

function aspectKeys(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object') return []
  return Object.keys(obj as Record<string, unknown>).filter(k => k.startsWith('aspect_') && k !== 'aspect_')
}
function pick(obj: any, keys: string[]) {
  const o: Record<string, unknown> = {}
  for (const k of keys) if (obj && k in obj) o[k] = obj[k]
  return o
}

// ═══ 1. ChannelListing rows with English twins ═══
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: {
    id: true, productId: true, marketplace: true, region: true, channelMarket: true,
    externalListingId: true, platformProductId: true, variationTheme: true, listingStatus: true, isPublished: true,
    flatFileSnapshot: true, platformAttributes: true, offerActive: true, updatedAt: true,
    product: { select: { sku: true, variationTheme: true, status: true, isMaster: true, masterSku: true, parentId: true } },
  },
  orderBy: [{ marketplace: 'asc' }],
})

console.log('\n═══ CHANNELLISTING rows carrying ENGLISH twin aspect keys ═══')
let clTwinCount = 0
for (const c of cls) {
  const snapKeys = aspectKeys(c.flatFileSnapshot)
  const pa = c.platformAttributes as any
  const isp = pa?.itemSpecifics && typeof pa.itemSpecifics === 'object' && !Array.isArray(pa.itemSpecifics) ? pa.itemSpecifics : null
  const ispKeys = isp ? Object.keys(isp).map(k => `aspect_${k.replace(/ /g,'_')}`) : []
  const snapTwins = snapKeys.filter(k => TWIN_EN.includes(k))
  const ispTwins = ispKeys.filter(k => TWIN_EN.includes(k))
  if (!snapTwins.length && !ispTwins.length) continue
  clTwinCount++
  const s = c.flatFileSnapshot as any
  console.log(`\n[CL] mkt=${c.marketplace} sku=${c.product?.sku} itemId=${c.externalListingId ?? '(EMPTY)'} status=${c.listingStatus}/pub=${c.isPublished} offerActive=${c.offerActive} CL.variationTheme=${JSON.stringify(c.variationTheme)} P.variationTheme=${JSON.stringify(c.product?.variationTheme)} P.status=${c.product?.status}`)
  console.log(`     snap.variation_theme=${JSON.stringify(s?.variation_theme)} snapTwins=${JSON.stringify(snapTwins)} ispTwins=${JSON.stringify(ispTwins)}`)
  if (snapTwins.length) console.log(`     snapVALS EN=${JSON.stringify(pick(s, snapTwins))} IT=${JSON.stringify(pick(s, ['aspect_Colore','aspect_Taglia','aspect_Marca']))}`)
  if (ispTwins.length) console.log(`     ispVALS  EN=${JSON.stringify(pick(isp, ispTwins.map(k=>k.slice(7).replace(/_/g,' '))))} IT=${JSON.stringify(pick(isp, ['Colore','Taglia','Marca']))}`)
}
console.log(`\nTOTAL ChannelListing rows with EN twins: ${clTwinCount}`)

// ═══ 2. ALL DE ChannelListing rows (draft vs live) ═══
console.log('\n\n═══ ALL non-IT ChannelListing(EBAY) rows ═══')
for (const c of cls.filter(x => x.marketplace !== 'IT')) {
  const s = c.flatFileSnapshot as any
  const pa = c.platformAttributes as any
  const isp = pa?.itemSpecifics ?? null
  console.log(`mkt=${c.marketplace} region=${c.region} cm=${c.channelMarket} sku=${c.product?.sku} itemId=${JSON.stringify(c.externalListingId)} ppid=${JSON.stringify(c.platformProductId)} status=${c.listingStatus}/pub=${c.isPublished} offerActive=${c.offerActive} CLtheme=${JSON.stringify(c.variationTheme)} Ptheme=${JSON.stringify(c.product?.variationTheme)} snapTheme=${JSON.stringify(s?.variation_theme)} upd=${c.updatedAt.toISOString().slice(0,10)}`)
  console.log(`   snapAspects=${JSON.stringify(aspectKeys(s))}`)
  console.log(`   isp=${JSON.stringify(isp)}`)
}

// ═══ 3. SharedListingMembership rows with English twins ═══
const mems = await prisma.sharedListingMembership.findMany({
  select: { id: true, marketplace: true, sku: true, itemId: true, parentSku: true, status: true, flatFileSnapshot: true, variationSpecifics: true, productId: true },
  orderBy: [{ marketplace: 'asc' }, { parentSku: 'asc' }, { sku: 'asc' }],
})
console.log('\n\n═══ SharedListingMembership rows carrying ENGLISH twin aspect keys ═══')
const byParent = new Map<string, { mkt: string; itemIds: Set<string>; skus: string[]; keys: Set<string>; sample: any; status: Set<string> }>()
let memTwinCount = 0
for (const m of mems) {
  const ks = aspectKeys(m.flatFileSnapshot)
  const twins = ks.filter(k => TWIN_EN.includes(k))
  if (!twins.length) continue
  memTwinCount++
  const id = `${m.marketplace}::${m.parentSku}`
  if (!byParent.has(id)) byParent.set(id, { mkt: m.marketplace, itemIds: new Set(), skus: [], keys: new Set(), sample: m.flatFileSnapshot, status: new Set() })
  const g = byParent.get(id)!
  g.itemIds.add(m.itemId); g.skus.push(m.sku); twins.forEach(t => g.keys.add(t)); g.status.add(m.status)
}
console.log(`TOTAL SharedListingMembership rows with EN twins: ${memTwinCount}`)
for (const [id, g] of [...byParent.entries()].sort()) {
  const s = g.sample
  console.log(`\n[SLM-FAMILY] ${id}  mems=${g.skus.length} itemIds=${[...g.itemIds].join(',')} status=${[...g.status].join(',')}`)
  console.log(`   twinKeys=${JSON.stringify([...g.keys])} snapTheme=${JSON.stringify(s?.variation_theme)}`)
  console.log(`   sampleVALS EN={Color:${JSON.stringify(s?.aspect_Color)},Size:${JSON.stringify(s?.aspect_Size)},Brand:${JSON.stringify(s?.aspect_Brand)}} IT={Colore:${JSON.stringify(s?.aspect_Colore)},Taglia:${JSON.stringify(s?.aspect_Taglia)},Marca:${JSON.stringify(s?.aspect_Marca)}}`)
  console.log(`   skus=${g.skus.slice(0,10).join(', ')}${g.skus.length>10?' …':''}`)
}

await prisma.$disconnect()
