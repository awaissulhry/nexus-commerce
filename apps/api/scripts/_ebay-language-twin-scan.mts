/** READ-ONLY: how many families store LANGUAGE-twin aspect keys (English beside
 * Italian) in their snapshots — the residual the case-twin heal didn't fold.
 * Detect via canonicalizeRowAspects (folds case AND language): any key it
 * removes now (case-twins already healed → 0) is a language twin. */
const { default: prisma } = await import('../src/db.js')
const { canonicalizeRowAspects } = await import('../src/services/ebay-theme-axes.js')
const isObj = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)
const aspectKeys = (o: unknown) => new Set((isObj(o) ? Object.keys(o) : []).filter((k) => k.startsWith('aspect_')))

const memb = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { parentSku: true, marketplace: true, flatFileSnapshot: true } })
const cls = await prisma.channelListing.findMany({ where: { channel: 'EBAY', flatFileSnapshot: { not: undefined } }, select: { externalListingId: true, marketplace: true, flatFileSnapshot: true, product: { select: { sku: true, isParent: true } } } })

const fam = new Map<string, Set<string>>()
const note = (key: string, removed: string[]) => { const s = fam.get(key) ?? new Set(); removed.forEach((r) => s.add(r)); fam.set(key, s) }

for (const m of memb) {
  if (!isObj(m.flatFileSnapshot)) continue
  const before = aspectKeys(m.flatFileSnapshot)
  const copy = { ...m.flatFileSnapshot }; canonicalizeRowAspects(copy)
  const after = aspectKeys(copy)
  const removed = [...before].filter((k) => !after.has(k))
  if (removed.length) note(`${m.marketplace}|${m.parentSku}`, removed)
}
let clFams = 0
for (const c of cls) {
  if (!isObj(c.flatFileSnapshot)) continue
  const before = aspectKeys(c.flatFileSnapshot)
  const copy = { ...c.flatFileSnapshot }; canonicalizeRowAspects(copy)
  const after = aspectKeys(copy)
  const removed = [...before].filter((k) => !after.has(k))
  if (removed.length) { clFams++; note(`${c.marketplace}|CL:${c.product?.sku ?? c.externalListingId}`, removed) }
}

console.log('=== LANGUAGE-twin aspect keys still stored (would fold to Italian) ===')
console.log('affected families/listings:', fam.size, '· CL rows with twins:', clFams)
for (const [k, s] of [...fam.entries()].sort()) console.log('  ', k, '→ English/twin keys:', JSON.stringify([...s]))
await prisma.$disconnect()
