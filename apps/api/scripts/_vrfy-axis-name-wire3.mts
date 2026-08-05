/** READ-ONLY: (a) synthetic repro of the claimed 25013 block on an unmapped axis,
 *  (b) does any eBay parent listing store _axisNameLabels today? */
const { default: prisma } = await import('../src/db.js')
const { resolveVariationAxes } = await import('../src/services/ebay-variation-push.service.js')
const { axisSynonymKey, canonicalizeRowAspects } = await import('../src/services/ebay-theme-axes.js')

// (a) unmapped dimension, theme casing != row-key casing
const rows = [
  { sku: 'A', aspect_Chiusura: 'Zip', aspect_Colore: 'Nero' },
  { sku: 'B', aspect_Chiusura: 'Bottoni', aspect_Colore: 'Nero' },
]
for (const theme of [['Chiusura'], ['chiusura'], ['CHIUSURA']]) {
  const r = resolveVariationAxes(rows.map((x) => ({ ...x })), theme)
  const names = r.validSpecs.map((s) => `${s.name}<-${s.rawName}`)
  const missing: string[] = []
  for (const row of rows) {
    for (const spec of r.validSpecs) {
      const dimKey = axisSynonymKey(spec.name)
      const k1 = `aspect_${spec.name.replace(/\s+/g, '_')}`
      const k2 = `aspect_${spec.name.toLowerCase().replace(/\s+/g, '_')}`
      const v = String(((row as Record<string, unknown>)[k1] ?? (row as Record<string, unknown>)[k2]) ?? '').trim()
      if (!v) missing.push(`${row.sku}:${spec.name}(dim=${dimKey})`)
    }
  }
  console.log(`theme=${JSON.stringify(theme)} specs=${JSON.stringify(names)} preCheckMissing=${JSON.stringify(missing)}`)
}
// does canonicalizeRowAspects (applied on GET /rows) change the stored key?
const probe: Record<string, unknown> = { aspect_Chiusura: 'Zip' }
canonicalizeRowAspects(probe)
console.log('after canonicalizeRowAspects:', JSON.stringify(Object.keys(probe)))

// (b) stored operator renames
const all = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { marketplace: true, platformAttributes: true, product: { select: { sku: true } } },
})
const withLabels = all.filter((c) => {
  const pa = (c.platformAttributes ?? {}) as Record<string, unknown>
  return pa._axisNameLabels && Object.keys(pa._axisNameLabels as object).length > 0
})
console.log(`eBay CLs=${all.length} with _axisNameLabels=${withLabels.length}`)
for (const c of withLabels.slice(0, 10)) {
  console.log(`   ${c.product.sku} [${c.marketplace}] ${JSON.stringify((c.platformAttributes as Record<string, unknown>)._axisNameLabels)}`)
}
await prisma.$disconnect()
