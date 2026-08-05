/** READ-ONLY P0: why are Amazon FBM listings at zero? Per-family truth table. */
const { default: prisma } = await import('../src/db.js')

const listings = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: {
    id: true, marketplace: true, quantity: true, listingStatus: true,
    followMasterQuantity: true, fulfillmentMethod: true, productId: true,
    flatFileSnapshot: true, updatedAt: true,
    product: { select: { sku: true, totalStock: true, fulfillmentMethod: true } },
  },
})
const fbm = listings.filter(
  (l) => !((l.fulfillmentMethod === 'FBA') || (l.fulfillmentMethod == null && l.product?.fulfillmentMethod === 'FBA')),
)
const pools = await prisma.stockLevel.groupBy({
  by: ['productId'], where: { location: { type: 'WAREHOUSE' } }, _sum: { available: true }, _count: { _all: true },
})
const poolBy = new Map(pools.map((p) => [p.productId, { avail: p._sum.available ?? 0, rows: p._count._all }]))

const famOf = (sku: string) => (sku.match(/^([A-Za-z]+)/)?.[1] ?? sku).toUpperCase()
type Agg = { n: number; zero: number; pos: number; poolZero: number; noLedger: number; snapQty: number; snapSum: number }
const fams = new Map<string, Agg>()
for (const l of fbm) {
  const f = famOf(l.product?.sku ?? '?')
  const a = fams.get(f) ?? { n: 0, zero: 0, pos: 0, poolZero: 0, noLedger: 0, snapQty: 0, snapSum: 0 }
  a.n++
  if ((l.quantity ?? 0) === 0) a.zero++
  else a.pos++
  const p = poolBy.get(l.productId)
  if (!p) a.noLedger++
  else if (p.avail === 0) a.poolZero++
  const snap = l.flatFileSnapshot as Record<string, unknown> | null
  const sq = Number(snap?.['fulfillment_availability__quantity'] ?? snap?.['quantity'] ?? NaN)
  if (!Number.isNaN(sq) && sq > 0) { a.snapQty++; a.snapSum += sq }
  fams.set(f, a)
}
console.log('== Amazon FBM (non-ENDED) by family: n / qty=0 / qty>0 / pool=0 / no-ledger / snapshots-with-qty (sum) ==')
for (const [f, a] of [...fams.entries()].sort((x, y) => y[1].n - x[1].n)) {
  console.log(`  ${f.padEnd(12)} n=${String(a.n).padEnd(3)} zero=${String(a.zero).padEnd(3)} pos=${String(a.pos).padEnd(3)} pool0=${String(a.poolZero).padEnd(3)} noLedger=${String(a.noLedger).padEnd(3)} snapQty=${a.snapQty} (Σ${a.snapSum})`)
}

for (const fam of ['MOSS', 'AIRMESH', 'GALE']) {
  const rows = fbm.filter((l) => famOf(l.product?.sku ?? '') === fam).slice(0, 4)
  console.log(`== ${fam} samples ==`)
  for (const l of rows) {
    const p = poolBy.get(l.productId)
    const snap = l.flatFileSnapshot as Record<string, unknown> | null
    console.log(`  ${l.product?.sku}@${l.marketplace} status=${l.listingStatus} qty=${l.quantity} follow=${l.followMasterQuantity} pool=${p ? p.avail : 'NO-LEDGER'} totalStock=${l.product?.totalStock} snapQty=${snap?.['fulfillment_availability__quantity'] ?? '—'}`)
  }
}

// Push provenance for MOSS/AIRMESH: last few QUANTITY_UPDATE rows
const probeIds = fbm.filter((l) => ['MOSS', 'AIRMESH'].includes(famOf(l.product?.sku ?? ''))).map((l) => l.id).slice(0, 60)
const pushes = await prisma.outboundSyncQueue.findMany({
  where: { channelListingId: { in: probeIds }, syncType: 'QUANTITY_UPDATE' },
  orderBy: { createdAt: 'desc' },
  take: 12,
  select: { createdAt: true, syncStatus: true, payload: true, channelListing: { select: { product: { select: { sku: true } }, marketplace: true } } },
})
console.log('== recent MOSS/AIRMESH qty pushes ==')
for (const r of pushes) {
  const pl = r.payload as { quantity?: number; source?: string } | null
  console.log(`  ${r.createdAt.toISOString().slice(5, 16)} ${r.channelListing?.product?.sku}@${r.channelListing?.marketplace} ${r.syncStatus} qty=${pl?.quantity} src=${pl?.source}`)
}
await prisma.$disconnect()
process.exit(0)
