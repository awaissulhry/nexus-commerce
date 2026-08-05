/** READ-ONLY: flat-file push jobs (EbayPushJob) — the OTHER inventory_item writer. */
const { default: prisma } = await import('../src/db.js')
const jobs = await prisma.ebayPushJob.findMany({
  orderBy: { createdAt: 'desc' }, take: 10,
  select: { id: true, status: true, createdAt: true, completedAt: true, summary: true, error: true },
}).catch(async () => {
  // field names may differ — dump one row raw
  const raw = await prisma.$queryRawUnsafe(`SELECT * FROM "EbayPushJob" ORDER BY "createdAt" DESC LIMIT 5`)
  console.log('RAW:', JSON.stringify(raw).slice(0, 1200)); return []
})
for (const j of jobs as Array<Record<string, unknown>>) {
  console.log(`${(j.createdAt as Date).toISOString?.() ?? j.createdAt}  ${j.status}  done=${(j.completedAt as Date | null)?.toISOString?.() ?? '—'}  ${String(j.summary ?? j.error ?? '').slice(0, 100)}`)
}
await prisma.$disconnect()
