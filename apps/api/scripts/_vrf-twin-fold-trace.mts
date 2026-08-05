/** READ-ONLY: trace the fold on one real GALE membership snapshot. */
const { default: prisma } = await import('../src/db.js')
const { canonicalizeRowAspects } = await import('../src/services/ebay-theme-axes.js')

const m = await prisma.sharedListingMembership.findFirst({
  where: { parentSku: 'IT-GALE-JACKET' },
  select: { sku: true, flatFileSnapshot: true },
})
const snap = { ...(m!.flatFileSnapshot as Record<string, unknown>) }
console.log('SKU', m!.sku)
const keys = Object.keys(snap).filter(k => k.startsWith('aspect_'))
console.log('BEFORE aspect keys (in order):')
for (const k of keys) console.log(`   ${k} = ${JSON.stringify(snap[k])}`)
const folded = canonicalizeRowAspects(snap)
console.log(`\nfolded=${folded}`)
console.log('AFTER aspect keys:')
for (const k of Object.keys(snap).filter(k => k.startsWith('aspect_'))) console.log(`   ${k} = ${JSON.stringify(snap[k])}`)

await prisma.$disconnect()
