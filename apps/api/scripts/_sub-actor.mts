/**
 * SUB — resolve the audit spine's actor strings. READ-ONLY.
 *
 * `automation:rank-defend-<id>` is written by ad-rank-defend.job.ts. 33 distinct ids appear in
 * 48h but there are only 16 RankScheduleGroup rows and the sampled id is not one of them.
 * Three pages (Placement, Rank & Dayparting, Bid) need ONE name and ONE link target for this
 * engine, so the spec has to say what the id actually is.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const d2 = new Date(Date.now() - 2 * 86_400_000)
const actors = await prisma.advertisingActionLog.groupBy({
  by: ['userId'], where: { createdAt: { gte: d2 }, userId: { startsWith: 'automation:' } }, _count: { _all: true },
})
const ids = actors.map((a) => String(a.userId).replace(/^automation:rank-defend-/, '')).filter((s) => !s.startsWith('automation:'))
console.log(`distinct automation actors in 48h: ${actors.length}`)

const sample = ids.slice(0, 6)
for (const id of sample) {
  const tries: Array<[string, unknown]> = [
    ['Campaign', await prisma.campaign.findUnique({ where: { id }, select: { id: true, name: true, marketplace: true } }).catch(() => null)],
    ['RankScheduleGroup', await prisma.rankScheduleGroup.findUnique({ where: { id }, select: { id: true, name: true } }).catch(() => null)],
    ['ProductRankPlan', await prisma.productRankPlan.findUnique({ where: { id }, select: { id: true } }).catch(() => null)],
    ['AdGroup', await prisma.adGroup.findUnique({ where: { id }, select: { id: true, name: true } }).catch(() => null)],
  ]
  const hit = tries.find(([, v]) => v)
  console.log(`  ${id.slice(0, 26)}… → ${hit ? `${hit[0]}: ${JSON.stringify(hit[1])}` : 'NO MATCH in Campaign/RankScheduleGroup/ProductRankPlan/AdGroup'}`)
}

// How the audit spine names each engine, cleanly.
console.log('\nactor prefixes seen in 60d:')
const all = await prisma.advertisingActionLog.groupBy({
  by: ['userId'], where: { createdAt: { gte: new Date(Date.now() - 60 * 86_400_000) } }, _count: { _all: true },
})
const byPrefix = new Map<string, number>()
for (const a of all) {
  const u = String(a.userId ?? '(null)')
  const p = u === '(null)' ? '(null)'
    : u.startsWith('automation:rank-defend-') ? 'automation:rank-defend-<id>'
    : u.startsWith('automation:') ? (/^automation:[a-z-]+$/.test(u) ? u : 'automation:<opaque-id>')
    : u
  byPrefix.set(p, (byPrefix.get(p) ?? 0) + a._count._all)
}
for (const [p, n] of [...byPrefix.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${p.padEnd(34)} ${n.toLocaleString('en-IE').padStart(8)}`)
}

await prisma.$disconnect()
