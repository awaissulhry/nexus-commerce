/** READ-ONLY: quantify eBay variation/axis drift across ALL shared-listing families.
 * Blast-radius scan for: case-twin columns, axis-value encoding inflation, stray axes,
 * stale corpses, and Lane-A/Lane-B dead links. No writes. */
import prisma from '../src/db.js'

const isObj = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)
const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ')
const bump = <T>(m: Map<string, Set<T>>, k: string): Set<T> => {
  let s = m.get(k); if (!s) { s = new Set<T>(); m.set(k, s) } return s
}

const memb = await prisma.sharedListingMembership.findMany({
  select: { itemId: true, parentSku: true, marketplace: true, status: true, variationSpecifics: true, flatFileSnapshot: true },
})
console.log('TOTAL memberships:', memb.length)
const byStatus: Record<string, number> = {}
for (const m of memb) byStatus[m.status] = (byStatus[m.status] || 0) + 1
console.log('by status:', JSON.stringify(byStatus))

interface Fam { mp: string; parent: string; items: Set<string>; statuses: Set<string>; axisVals: Map<string, Set<string>>; snapKeys: Set<string> }
const fams = new Map<string, Fam>()
for (const m of memb) {
  const key = `${m.marketplace}|${m.parentSku}`
  let f = fams.get(key)
  if (!f) { f = { mp: m.marketplace, parent: m.parentSku, items: new Set(), statuses: new Set(), axisVals: new Map(), snapKeys: new Set() }; fams.set(key, f) }
  f.items.add(m.itemId); f.statuses.add(m.status)
  for (const [k, v] of Object.entries(isObj(m.variationSpecifics) ? m.variationSpecifics : {})) bump(f.axisVals, k).add(String(v))
  for (const k of Object.keys(isObj(m.flatFileSnapshot) ? m.flatFileSnapshot : {})) if (k.startsWith('aspect_')) f.snapKeys.add(k)
}
console.log('families (marketplace|parentSku):', fams.size)

// [A] case-twin aspect columns (differ only by case)
const twinFams: string[] = []
for (const [key, f] of fams) {
  const byNorm = new Map<string, Set<string>>()
  for (const k of f.snapKeys) bump(byNorm, k.toLowerCase()).add(k)
  const twins = [...byNorm.values()].filter((s) => s.size > 1).map((s) => [...s])
  if (twins.length) twinFams.push(`${key}  ${JSON.stringify(twins)}`)
}
console.log(`\n[A] families with CASE-TWIN aspect columns: ${twinFams.length}`)
twinFams.slice(0, 8).forEach((x) => console.log('    ', x))

// [B] axis-value inflation (raw vs case-insensitive) + mixed pipe-encoding
const infl: { key: string; axis: string; raw: number; ci: number; mixedPipe: boolean; vals: string[] }[] = []
for (const [key, f] of fams) {
  for (const [axis, set] of f.axisVals) {
    const raw = set.size, ci = new Set([...set].map(norm)).size
    const withPipe = [...set].filter((v) => v.includes('|')).length
    const mixedPipe = withPipe > 0 && withPipe < raw
    if (raw > ci || mixedPipe) infl.push({ key, axis, raw, ci, mixedPipe, vals: [...set].sort() })
  }
}
infl.sort((a, b) => (b.raw - b.ci) - (a.raw - a.ci) || Number(b.mixedPipe) - Number(a.mixedPipe))
console.log(`\n[B] axis value inflation OR mixed pipe-encoding: ${infl.length}`)
infl.slice(0, 12).forEach((x) => console.log(`     ${x.key} axis=${x.axis} raw=${x.raw} ci=${x.ci} mixedPipe=${x.mixedPipe} :: ${JSON.stringify(x.vals)}`))

// [C] stray axes: families whose live-store variationSpecifics keys > 2
const stray: { key: string; keys: string[] }[] = []
for (const [key, f] of fams) { const ks = [...f.axisVals.keys()]; if (ks.length > 2) stray.push({ key, keys: ks }) }
console.log(`\n[C] families with >2 variationSpecifics axis keys (stray live axes): ${stray.length}`)
stray.slice(0, 12).forEach((x) => console.log('     ', x.key, '=>', JSON.stringify(x.keys)))

// [D] stale corpse families: no ACTIVE membership
const corpse: string[] = []
for (const [key, f] of fams) if (!f.statuses.has('ACTIVE')) corpse.push(`${key} statuses=${JSON.stringify([...f.statuses])} items=${f.items.size}`)
console.log(`\n[D] families with NO active membership (stale corpses): ${corpse.length}`)
corpse.slice(0, 10).forEach((x) => console.log('     ', x))

// [E]/[F] ChannelListing Lane-A divergence
const cls = await prisma.channelListing.findMany({ where: { channel: 'EBAY', externalListingId: { not: null } }, select: { externalListingId: true, productId: true, marketplace: true } })
const byItem = new Map<string, Set<string>>()
for (const c of cls) bump(byItem, `${c.marketplace}|${c.externalListingId}`).add(c.productId)
const multi = [...byItem.entries()].filter(([, s]) => s.size > 1)
console.log(`\n[E] eBay itemIds mapped to MULTIPLE productIds in ChannelListing: ${multi.length} (of ${byItem.size} itemIds)`)
multi.slice(0, 8).forEach(([k, s]) => console.log('     ', k, '=>', s.size, 'products'))

const activeItemIds = new Set(memb.filter((m) => m.status === 'ACTIVE').map((m) => m.itemId))
const membItemIds = new Set(memb.map((m) => m.itemId))
const deadEx = new Set<string>(); let deadCl = 0
for (const c of cls) if (membItemIds.has(c.externalListingId!) && !activeItemIds.has(c.externalListingId!)) { deadCl++; deadEx.add(c.externalListingId!) }
console.log(`\n[F] eBay ChannelListings pointing to a pooled itemId with NO active membership (dead links): ${deadCl} rows across ${deadEx.size} itemIds`)
console.log('     dead itemIds:', JSON.stringify([...deadEx].slice(0, 12)))

console.log('\n=== END (no writes) ===')
await prisma.$disconnect()
