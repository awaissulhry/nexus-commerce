/** READ-ONLY: the 24 persistent read-back mismatches — are they the SAME SKUs
 *  in every market (⇒ Amazon holds ONE shared EU quantity per SKU) or
 *  market-specific (⇒ quantities are independent and zeroing DE is safe)? */
const { default: prisma } = await import('../src/db.js')
const logs = await prisma.syncHealthLog.findMany({
  where: { channel: 'AMAZON', conflictType: 'CHANNEL_QTY_READBACK', resolutionStatus: 'UNRESOLVED' },
  orderBy: { createdAt: 'desc' }, take: 60,
  select: { errorMessage: true, conflictData: true, createdAt: true, productId: true },
})
console.log(`unresolved readback conflicts: ${logs.length}`)
const bySku = new Map<string, Array<{m:string; live:any; want:any}>>()
for (const l of logs) {
  const m = l.errorMessage ?? ''
  const sku = m.match(/for (\S+) \(/)?.[1] ?? '?'
  const cd = (l.conflictData as any) ?? {}
  const mkt = cd?.remoteData?.marketplace ?? cd?.marketplace ?? '?'
  if (!bySku.has(sku)) bySku.set(sku, [])
  bySku.get(sku)!.push({ m: mkt, live: cd?.remoteData?.amazonQty ?? cd?.amazonQty, want: cd?.localData?.intendedQty ?? cd?.intendedQty })
}
for (const [sku, rows] of bySku) {
  console.log(`  ${sku.padEnd(36)} ${rows.map(r => `${r.m}: live=${r.live} want=${r.want}`).join('  |  ')}`)
}
const multiMarket = [...bySku.values()].filter(r => new Set(r.map(x=>x.m)).size > 1).length
console.log(`\nSKUs mismatching in MORE THAN ONE market: ${multiMarket} of ${bySku.size}`)
console.log(`(same SKU + same live qty in several markets ⇒ shared EU quantity;`)
console.log(` different live qty per market ⇒ independent per-marketplace quantity)`)
await prisma.$disconnect()
