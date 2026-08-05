const { default: prisma } = await import('../src/db.js')

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, followMasterQuantity: true, syncPaused: true,
            fulfillmentMethod: true, sourceLocationCodes: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const memberships = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, marketplace: true, productId: true, followPool: true },
})
const pids = [...new Set([...listings.map(l=>l.productId), ...memberships.map(m=>m.productId).filter(Boolean)])] as string[]
const levels = await prisma.stockLevel.findMany({
  where: { productId: { in: pids }, location: { type: 'WAREHOUSE' } },
  select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } },
})
const led = new Map<string, {code:string;avail:number;routes:string[]}[]>()
for (const l of levels) {
  const a = led.get(l.productId) ?? []; a.push({ code: l.location?.code ?? '?', avail: l.available, routes: l.location?.syncRoutes ?? [] }); led.set(l.productId, a)
}
const norm = (s:string)=> (s??'').trim().toUpperCase()
function normalizeMarket(ch:string, mk:string){ const m=norm(mk); const c=norm(ch); return m.startsWith(c+'_')? m.slice(c.length+1): m }
function serves(routes:string[], ch:string, mk:string){ if(!routes||routes.length===0) return true;
  const c=norm(ch), m=normalizeMarket(ch,mk)
  for (const raw of routes){ const t=norm(raw); if(!t) continue; const p=t.split(':')
    if(p.length===1){ if(p[0]===c) return true; if(p[0]===m) return true }
    else if(p.length===2){ if(p[0]===c && (p[1]==='*'||p[1]===m)) return true } }
  return false
}
type Cat = 'no-rows'|'rows-all-zero-unrouted'|'stock-unrouted'|'override-miss'
const buckets: Record<string, {n:number; ex:string[]}> = {}
function add(cat:string, ex:string){ const b = buckets[cat] ??= {n:0,ex:[]}; b.n++; if(b.ex.length<6) b.ex.push(ex) }

for (const cl of listings) {
  const isFba = cl.fulfillmentMethod === 'FBA' || (cl.fulfillmentMethod==null && cl.product?.fulfillmentMethod==='FBA') || cl.product?.fulfillmentMethod==='FBA'
  if (isFba || cl.syncPaused || !cl.followMasterQuantity) continue
  const rows = led.get(cl.productId) ?? []
  const override = new Set((cl.sourceLocationCodes??[]).map(norm).filter(Boolean))
  const routed = rows.filter(r => serves(r.routes, cl.channel, cl.marketplace) && (override.size===0 || override.has(norm(r.code))))
  if (routed.length) continue
  const routedIgnoringOverride = rows.filter(r => serves(r.routes, cl.channel, cl.marketplace))
  const stockAnywhere = rows.reduce((s,r)=>s+r.avail,0)
  const tag = rows.length===0 ? 'A:no-warehouse-rows-at-all'
    : override.size>0 && routedIgnoringOverride.length>0 ? 'D:override-points-elsewhere'
    : stockAnywhere>0 ? 'C:HAS-STOCK-but-unrouted'
    : 'B:rows-exist-but-zero-stock-and-unrouted'
  add(tag, `${cl.product?.sku} ${cl.channel}:${cl.marketplace} stock=${stockAnywhere} locs=${rows.map(r=>r.code+ (r.avail?`(${r.avail})`:'')).join(',')}`)
}
for (const m of memberships) {
  if (m.followPool === false) continue
  const rows = m.productId ? (led.get(m.productId) ?? []) : []
  const routed = rows.filter(r => serves(r.routes, 'EBAY', m.marketplace))
  if (routed.length) continue
  const stockAnywhere = rows.reduce((s,r)=>s+r.avail,0)
  const tag = !m.productId ? 'E:membership-unlinked'
    : rows.length===0 ? 'A:no-warehouse-rows-at-all'
    : stockAnywhere>0 ? 'C:HAS-STOCK-but-unrouted'
    : 'B:rows-exist-but-zero-stock-and-unrouted'
  add(tag, `${m.sku} EBAY:${m.marketplace} stock=${stockAnywhere} locs=${rows.map(r=>r.code+(r.avail?`(${r.avail})`:'')).join(',')}`)
}
console.log('UNCOUNTED cause breakdown:')
for (const [k,v] of Object.entries(buckets).sort()) { console.log(` ${k}: ${v.n}`); for(const e of v.ex) console.log(`    ${e}`) }
const locs = await prisma.stockLocation.findMany({ where: { type:'WAREHOUSE' }, select:{ code:true, syncRoutes:true } })
console.log('WAREHOUSE locations:', JSON.stringify(locs))
await prisma.$disconnect()
