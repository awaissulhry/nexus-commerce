/** READ-ONLY: full per-SKU breakdown of latest job. */
const { default: prisma } = await import('../src/db.js')
const j = await prisma.ebayPushJob.findFirst({ orderBy: { submittedAt: 'desc' }, select: { id: true, status: true, perSkuResults: true } })
const per = Array.isArray(j?.perSkuResults) ? (j!.perSkuResults as Array<{ sku: string; status: string; message?: string }>) : []
const byStatus = new Map<string, number>()
for (const p of per) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1)
console.log('JOB', j?.id, j?.status, JSON.stringify([...byStatus]))
for (const p of per.filter((x) => x.status === 'error')) {
  console.log(`ERR ${p.sku}: ${String(p.message ?? '').slice(0, 220)}`)
}
const alt = per.filter((x) => x.sku.includes('ALT'))
for (const p of alt.slice(0, 6)) console.log(`ALT ${p.status} ${p.sku}: ${String(p.message ?? '').slice(0, 180)}`)
await prisma.$disconnect()
