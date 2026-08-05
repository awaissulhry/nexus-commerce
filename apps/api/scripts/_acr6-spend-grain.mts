/** ACR.6 — the account spends money. At which grain does that spend actually land? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const since = new Date(); since.setUTCDate(since.getUTCDate() - 30)

const rows = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['entityType'],
  where: { date: { gte: since } },
  _sum: { costMicros: true, clicks: true },
  _count: true,
})

console.log('\nAmazonAdsDailyPerformance, last 30d, by entityType:')
console.log('  entityType'.padEnd(28) + 'rows'.padStart(8) + 'spend'.padStart(14) + 'clicks'.padStart(10))
for (const r of rows.sort((a, b) => Number(b._sum.costMicros ?? 0n) - Number(a._sum.costMicros ?? 0n))) {
  const eur = Number(r._sum.costMicros ?? 0n) / 1_000_000 // Amazon micros: 1e6 = one currency unit
  console.log(`  ${String(r.entityType).padEnd(26)}${String(r._count).padStart(8)}${('€' + eur.toFixed(2)).padStart(14)}${String(r._sum.clicks ?? 0).padStart(10)}`)
}

// The denormalised per-entity columns every bid engine reads.
const t = await prisma.adTarget.aggregate({ _sum: { spendCents: true, clicks: true, salesCents: true }, _count: true })
const g = await prisma.adGroup.aggregate({ _sum: { spendCents: true, salesCents: true }, _count: true })
console.log('\nthe columns the engines actually read:')
console.log(`  AdTarget  rows=${t._count}  spendCents=${t._sum.spendCents ?? 0}  clicks=${t._sum.clicks ?? 0}  salesCents=${t._sum.salesCents ?? 0}`)
console.log(`  AdGroup   rows=${g._count}   spendCents=${g._sum.spendCents ?? 0}  salesCents=${g._sum.salesCents ?? 0}`)

// Is there target-grain data upstream that simply never gets written down?
const kw = rows.find((r) => /KEYWORD|TARGET/i.test(String(r.entityType)))
console.log(kw
  ? `\n→ target-grain rows DO exist upstream (${kw.entityType}: ${kw._count} rows) but AdTarget.spendCents is ${t._sum.spendCents ?? 0}.`
  : '\n→ no target-grain rows upstream either — the report that would carry them is not being ingested.')

await prisma.$disconnect()
