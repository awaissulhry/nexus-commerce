/** READ-ONLY: latest push job status. */
const { default: prisma } = await import('../src/db.js')
const j = await prisma.ebayPushJob.findFirst({
  orderBy: { submittedAt: 'desc' },
  select: { id: true, status: true, submittedAt: true, completedAt: true, pushed: true, failed: true, errorMessage: true, perSkuResults: true },
})
const per = Array.isArray(j?.perSkuResults) ? (j!.perSkuResults as Array<{ sku: string; status: string; listingId?: string; message?: string }>) : []
const errs = per.filter((p) => p.status !== 'success').slice(0, 6)
const ok = per.filter((p) => p.status === 'success')
console.log(JSON.stringify({
  id: j?.id, status: j?.status, submitted: j?.submittedAt, completed: j?.completedAt, pushed: j?.pushed, failed: j?.failed,
  err: j?.errorMessage?.slice(0, 300) ?? null,
  okCount: ok.length,
  listingIds: [...new Set(ok.map((p) => p.listingId).filter(Boolean))],
  sampleErrors: errs.map((e) => `${e.sku}: ${String(e.message ?? '').slice(0, 160)}`),
}, null, 1))
await prisma.$disconnect()
