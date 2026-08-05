/** READ-ONLY: locate the 9 non-empty aspect_Variantattributes membership rows and
 *  compare all observed aspect keys against stored CategorySchema aspect ids. */
const { default: prisma } = await import('../src/db.js')

const mem = await prisma.sharedListingMembership.findMany({
  select: { sku: true, marketplace: true, itemId: true, parentSku: true, status: true, flatFileSnapshot: true },
})
for (const m of mem) {
  const snap = (m.flatFileSnapshot ?? {}) as Record<string, unknown>
  for (const [k, v] of Object.entries(snap)) {
    if (!/variantattributes/i.test(k)) continue
    console.log('MEMBERSHIP', JSON.stringify({ sku: m.sku, mp: m.marketplace, itemId: m.itemId, parentSku: m.parentSku, status: m.status, key: k, val: v }))
  }
}

const schemas = await prisma.categorySchema.findMany({ select: { id: true, marketplaceId: true, categoryId: true, aspects: true, updatedAt: true } as never })
console.log('\nstored CategorySchema rows:', schemas.length)
for (const s of schemas as Array<Record<string, unknown>>) {
  const aspects = s.aspects as unknown
  const names: string[] = Array.isArray(aspects)
    ? (aspects as Array<Record<string, unknown>>).map((a) => String(a.name ?? a.localizedAspectName ?? a.id ?? ''))
    : Object.keys((aspects ?? {}) as Record<string, unknown>)
  console.log(`${s.marketplaceId} ${s.categoryId} n=${names.length}: ${JSON.stringify(names)}`)
}
await prisma.$disconnect()
