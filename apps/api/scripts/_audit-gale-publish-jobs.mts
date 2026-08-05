/** READ-ONLY: what did the most recent eBay image-publish jobs for GALE record? */
const { default: prisma } = await import('../src/db.js')
const p = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true } })
const jobs = await prisma.channelImagePublishJob.findMany({
  where: { productId: p!.id, channel: 'EBAY' },
  orderBy: { submittedAt: "desc" },
  take: 5,
  select: { id: true, status: true, submittedAt: true, completedAt: true, errorMessage: true, response: true },
})
console.log('recent EBAY image-publish jobs:', jobs.length)
for (const j of jobs) {
  console.log(`\n● ${j.submittedAt.toISOString()}  status=${j.status}  completed=${j.completedAt?.toISOString() ?? '—'}`)
  if (j.errorMessage) console.log(`   error: ${String(j.errorMessage).slice(0, 300)}`)
  const r = j.response as Record<string, unknown> | null
  if (r) {
    const res = (r.results ?? []) as Array<{ sku?: string; status?: string; message?: string }>
    const errs = res.filter((x) => x.status === 'ERROR')
    console.log(`   markets=${JSON.stringify(r.markets)} results=${res.length} errors=${errs.length}`)
    if (r.warnings && Array.isArray(r.warnings) && r.warnings.length) console.log(`   warnings: ${JSON.stringify((r.warnings as string[]).slice(0, 2))}`)
    for (const e of errs.slice(0, 3)) console.log(`   ERR ${e.sku}: ${String(e.message).slice(0, 200)}`)
    for (const ok of res.filter((x) => x.status === 'PUSHED').slice(0, 2)) console.log(`   OK  ${ok.sku}: ${String(ok.message).slice(0, 120)}`)
  }
}
await prisma.$disconnect()
