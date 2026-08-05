/** READ-ONLY: takeover verification — pushed values + current queue state per family. */
const { default: prisma } = await import('../src/db.js')
const since = new Date(Date.now() - 40 * 60e3)
const rows = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', targetChannel: 'AMAZON', createdAt: { gte: since } },
  select: { syncStatus: true, payload: true, channelListing: { select: { marketplace: true, product: { select: { sku: true } } } } },
})
const fam = (s: string) => (s.match(/^([A-Za-z]+)/)?.[1] ?? s).toUpperCase()
const agg = new Map<string, { total: number; success: number; pending: number; posQty: number; zeroQty: number }>()
for (const r of rows) {
  const f = fam(r.channelListing?.product?.sku ?? '?')
  const a = agg.get(f) ?? { total: 0, success: 0, pending: 0, posQty: 0, zeroQty: 0 }
  a.total++
  if (r.syncStatus === 'SUCCESS') a.success++
  if (r.syncStatus === 'PENDING' || r.syncStatus === 'IN_PROGRESS') a.pending++
  const q = Number((r.payload as { quantity?: number } | null)?.quantity ?? 0)
  if (q > 0) a.posQty++
  else a.zeroQty++
  agg.set(f, a)
}
console.log('== Amazon qty pushes last 40min by family (total/success/pending | qty>0 vs 0) ==')
for (const [f, a] of [...agg.entries()].sort((x, y) => y[1].total - x[1].total).slice(0, 14)) {
  console.log(`  ${f.padEnd(12)} total=${String(a.total).padEnd(4)} ok=${String(a.success).padEnd(4)} pend=${String(a.pending).padEnd(4)} qty+=${a.posQty} qty0=${a.zeroQty}`)
}
const samples = rows.filter((r) => ['MOSS', 'AIRMESH'].includes(fam(r.channelListing?.product?.sku ?? '')) && r.syncStatus === 'SUCCESS').slice(0, 8)
console.log('== MOSS/AIRMESH SUCCESS samples ==')
for (const s of samples) console.log(`  ${s.channelListing?.product?.sku}@${s.channelListing?.marketplace} qty=${(s.payload as { quantity?: number } | null)?.quantity}`)
await prisma.$disconnect()
process.exit(0)
