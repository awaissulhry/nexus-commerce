import { default as prisma } from '../src/db.js'

const mem = await prisma.sharedListingMembership.groupBy({ by: ['marketplace'], _count: { _all: true } })
console.log('SharedListingMembership by marketplace:', JSON.stringify(mem))

const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { id: true, marketplace: true, flatFileSnapshot: true, productId: true },
})
const byMkt = new Map<string, number>()
const sharedFlag = new Map<string, number>()
const themeByMkt = new Map<string, Set<string>>()
for (const c of cls) {
  const m = String(c.marketplace ?? '?')
  byMkt.set(m, (byMkt.get(m) ?? 0) + 1)
  const s = c.flatFileSnapshot as Record<string, unknown> | null
  if (s && s.shared_sku_listing === true) sharedFlag.set(m, (sharedFlag.get(m) ?? 0) + 1)
  const t = s ? String(s.variation_theme ?? '') : ''
  if (t) {
    if (!themeByMkt.has(m)) themeByMkt.set(m, new Set())
    themeByMkt.get(m)!.add(t)
  }
}
console.log('ChannelListing EBAY by marketplace:', JSON.stringify([...byMkt]))
console.log('shared_sku_listing=true by marketplace:', JSON.stringify([...sharedFlag]))
for (const [m, s] of themeByMkt) console.log('variation_theme values on', m, JSON.stringify([...s]))

// aspect_ keys per marketplace on snapshots
const aspKeys = new Map<string, Map<string, number>>()
for (const c of cls) {
  const s = c.flatFileSnapshot as Record<string, unknown> | null
  if (!s) continue
  const m = String(c.marketplace ?? '?')
  if (!aspKeys.has(m)) aspKeys.set(m, new Map())
  for (const k of Object.keys(s)) {
    if (k.startsWith('aspect_')) aspKeys.get(m)!.set(k, (aspKeys.get(m)!.get(k) ?? 0) + 1)
  }
}
for (const [m, km] of aspKeys) console.log('aspect keys on', m, JSON.stringify([...km].sort()))

await prisma.$disconnect()
