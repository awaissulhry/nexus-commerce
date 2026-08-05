/** READ-ONLY: what did Amazon answer our recent quantity PATCHes? */
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.channelPublishAttempt.findMany({
  where: { channel: 'AMAZON', attemptedAt: { gte: new Date(Date.now() - 90 * 60e3) } },
  orderBy: { attemptedAt: 'desc' },
  take: 400,
  select: { outcome: true, mode: true, errorMessage: true, errorCode: true, submissionId: true, sku: true, marketplace: true, attemptedAt: true },
})
const agg: Record<string, number> = {}
for (const r of rows) agg[`${r.mode}/${r.outcome}`] = (agg[`${r.mode}/${r.outcome}`] ?? 0) + 1
console.log(`attempts last 90min: ${rows.length}`, JSON.stringify(agg))
const errs = rows.filter((r) => r.errorMessage)
console.log(`with errorMessage: ${errs.length}`)
for (const e of errs.slice(0, 6)) console.log(`  ${e.sku}@${e.marketplace} ${e.outcome}: ${e.errorMessage?.slice(0, 160)}`)
const ok = rows.filter((r) => r.outcome === 'success').slice(0, 4)
for (const o of ok) console.log(`  OK sample: ${o.sku}@${o.marketplace} mode=${o.mode}`)
await prisma.$disconnect()
process.exit(0)
