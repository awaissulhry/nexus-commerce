/** READ-ONLY proof: run a REAL DE row's aspect keys through canonicalizeRowAspects
 * with market DE vs IT, and show the difference. No writes. */
const { default: prisma } = await import('../src/db.js')
const { canonicalizeRowAspects } = await import('../src/services/ebay-theme-axes.js')
const isObj = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)

const de = await prisma.channelListing.findFirst({
  where: { channel: 'EBAY', marketplace: 'DE', flatFileSnapshot: { not: undefined } },
  select: { product: { select: { sku: true } }, flatFileSnapshot: true },
})
if (!de || !isObj(de.flatFileSnapshot)) { console.log('no DE snapshot found'); } else {
  const src = Object.fromEntries(Object.entries(de.flatFileSnapshot).filter(([k]) => k.startsWith('aspect_')))
  console.log('DE listing:', de.product?.sku)
  console.log('stored aspect keys :', JSON.stringify(Object.keys(src)))
  const asDE = { ...src }; const nDE = canonicalizeRowAspects(asDE, 'DE')
  const asIT = { ...src }; const nIT = canonicalizeRowAspects(asIT, 'IT')
  console.log(`\nfolded as DE (n=${nDE}):`, JSON.stringify(Object.keys(asDE)))
  console.log(`folded as IT (n=${nIT}):`, JSON.stringify(Object.keys(asIT)))
  const lost = Object.keys(src).filter((k) => !(k in asDE))
  console.log('\nkeys DE-fold removed:', JSON.stringify(lost))
  // simulate a German-named cell the operator might type
  const german = { aspect_Farbe: 'Schwarz', aspect_Größe: 'M', aspect_Marke: 'Xavia Racing' }
  const g1 = { ...german }; canonicalizeRowAspects(g1, 'DE')
  const g2 = { ...german }; canonicalizeRowAspects(g2, 'IT')
  console.log('\nGerman cells folded as DE:', JSON.stringify(g1))
  console.log('German cells folded as IT:', JSON.stringify(g2), ' <- what would have happened before the fix')
}
await prisma.$disconnect()
