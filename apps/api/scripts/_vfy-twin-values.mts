// READ-ONLY: do any twin aspect keys hold DIFFERENT values on the same row?
const { default: prisma } = await import('../src/db.js')
const { buildEbayFamilyRows } = await import('../src/services/ebay-variation-push.service.js')
const { axisSynonymKey } = await import('../src/services/ebay-theme-axes.js')
const out: string[] = []
const parents = await prisma.product.findMany({
  where: { deletedAt: null, isParent: true, children: { some: { deletedAt: null, channelListings: { some: { channel: 'EBAY' } } } } },
  select: { id: true, sku: true },
})
const shells = await prisma.product.findMany({ where: { deletedAt: null, productType: 'EBAY_LISTING_SHELL' }, select: { id: true, sku: true } })
const check = (label: string, rows: Array<Record<string, unknown>>) => {
  for (const r of rows) {
    const byDim = new Map<string, Array<[string, string]>>()
    for (const [k, v] of Object.entries(r)) {
      if (!k.startsWith('aspect_') || typeof v !== 'string' || !v.trim()) continue
      const name = k.slice(7).replace(/_/g, ' ')
      const dim = axisSynonymKey(name)
      if (!dim.startsWith('__dim')) continue
      if (!byDim.has(dim)) byDim.set(dim, [])
      byDim.get(dim)!.push([k, v])
    }
    for (const [dim, pairs] of byDim) {
      const vals = new Set(pairs.map((p) => p[1].trim()))
      if (pairs.length > 1 && vals.size > 1) out.push(`CONFLICT ${label} sku=${r.sku} ${dim}: ${pairs.map((p) => `${p[0]}=${p[1]}`).join(' , ')}`)
    }
  }
}
for (const p of parents) check(`familyRows:${p.sku}`, await buildEbayFamilyRows(p.id))
for (const s of shells) {
  const ms = await prisma.sharedListingMembership.findMany({ where: { parentSku: s.sku! }, select: { sku: true, marketplace: true, flatFileSnapshot: true } })
  check(`snapshots:${s.sku}`, ms.map((m) => ({ ...((m.flatFileSnapshot as any) ?? {}), sku: `${m.sku}@${m.marketplace}` })))
}
out.push(`conflicts found: ${out.length}`)
const { writeFileSync } = await import('node:fs')
writeFileSync('/private/tmp/claude-501/-Users-awais-nexus-commerce/d027119c-29ec-42b4-9052-5dab9e08b3ce/scratchpad/twins.txt', out.join('\n'))
console.log('WROTE')
process.exit(0)
