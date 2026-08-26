/**
 * SUB — write cadence + actor identity. READ-ONLY.
 *
 * Two questions the sync decision turns on:
 *   1. Is the write stream BURSTY (a cron tick) or CONTINUOUS? A bursty stream is
 *      polled at the tick; a continuous one wants a push.
 *   2. What does `automation:rank-defend-<id>` resolve to? Three pages need one
 *      name for one engine; the audit spine stores an opaque id.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))

const now = new Date()
const d2 = new Date(now.getTime() - 2 * 86_400_000)

console.log('\n=== A · Is the write stream bursty? — writes per MINUTE-OF-HOUR, last 48h ===')
const rows = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: d2 } },
  select: { createdAt: true, actionType: true, userId: true },
  orderBy: { createdAt: 'asc' },
})
console.log(`sample: ${int(rows.length)} writes in 48h`)

const byMin = new Map<number, number>()
for (const r of rows) byMin.set(r.createdAt.getUTCMinutes(), (byMin.get(r.createdAt.getUTCMinutes()) ?? 0) + 1)
const buckets: string[] = []
for (let m = 0; m < 60; m += 5) {
  let n = 0
  for (let k = m; k < m + 5; k++) n += byMin.get(k) ?? 0
  buckets.push(`:${String(m).padStart(2, '0')}-${String(m + 4).padStart(2, '0')} ${String(n).padStart(5)}`)
}
console.log(buckets.join('   '))

// Inter-arrival: how long between consecutive writes?
const gaps: number[] = []
for (let i = 1; i < rows.length; i++) gaps.push(rows[i]!.createdAt.getTime() - rows[i - 1]!.createdAt.getTime())
gaps.sort((a, b) => a - b)
const pct = (p: number) => (gaps.length ? (gaps[Math.floor(gaps.length * p)] ?? 0) / 1000 : 0)
console.log(`\ngap between consecutive writes (s): p50 ${pct(0.5).toFixed(1)} · p90 ${pct(0.9).toFixed(1)} · p99 ${pct(0.99).toFixed(1)} · max ${((gaps.at(-1) ?? 0) / 1000 / 60).toFixed(1)} min`)

// How many DISTINCT minutes had any write at all? (the "would a 60s poll ever be empty" question)
const minuteKeys = new Set(rows.map((r) => Math.floor(r.createdAt.getTime() / 60_000)))
console.log(`distinct minutes with ≥1 write, of 2880: ${minuteKeys.size}  (${((minuteKeys.size / 2880) * 100).toFixed(0)}%)`)

console.log('\n=== B · Which entity does each actor touch? (48h) ===')
const kind = (u: string | null) =>
  !u ? '(null)' : u.startsWith('automation:rank-defend') ? 'automation:rank-defend-*' : u.startsWith('automation:') ? u.split('-')[0]! : u
const agg = new Map<string, Map<string, number>>()
for (const r of rows) {
  const k = kind(r.userId)
  if (!agg.has(k)) agg.set(k, new Map())
  const m = agg.get(k)!
  m.set(r.actionType, (m.get(r.actionType) ?? 0) + 1)
}
for (const [k, m] of [...agg.entries()].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
  const tot = [...m.values()].reduce((x, y) => x + y, 0)
  console.log(`  ${pad(k, 28)} ${String(tot).padStart(6)}   ${[...m.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}:${n}`).join(' · ')}`)
}

console.log('\n=== C · What does automation:rank-defend-<id> point at? ===')
const one = await prisma.advertisingActionLog.findFirst({
  where: { userId: { startsWith: 'automation:rank-defend-' } },
  orderBy: { createdAt: 'desc' },
  select: { userId: true, entityType: true, entityId: true, actionType: true },
})
const id = one?.userId?.replace('automation:rank-defend-', '') ?? ''
console.log(`  sample actor: ${one?.userId}`)
const grp = await prisma.rankScheduleGroup.findUnique({ where: { id }, select: { id: true, name: true, enabled: true, marketplace: true } }).catch(() => null)
console.log(`  RankScheduleGroup(${id}) → ${grp ? `"${grp.name}" enabled=${grp.enabled} market=${grp.marketplace ?? 'null'}` : 'NOT FOUND'}`)
const plan = grp ? null : await prisma.productRankPlan.findUnique({ where: { id }, select: { id: true } }).catch(() => null)
if (plan) console.log(`  ProductRankPlan(${id}) → found`)

const distinctActors = await prisma.advertisingActionLog.groupBy({
  by: ['userId'], where: { createdAt: { gte: d2 }, userId: { startsWith: 'automation:rank-defend-' } }, _count: { _all: true },
})
console.log(`  distinct rank-defend actor ids in 48h: ${distinctActors.length} (of ${await prisma.rankScheduleGroup.count()} RankScheduleGroup rows)`)

console.log('\n=== D · Does anything OTHER than a rule publish to the SSE bus? ===')
console.log('  publishAdsExecution callers (grep, code): automation-rule.service.ts only — 2 call sites.')
console.log('  ⇒ engines (ad-rank-defend, budget-manager-cron, auto-harvest) publish NOTHING.')

console.log('\n=== E · Cost of a naive refetch: rows the 11 pages would re-pull ===')
console.log(`  GET /advertising/campaigns?limit=500 → ${int(await prisma.campaign.count())} campaigns (cached 300s server-side)`)
console.log(`  GET /advertising/automation-rules   → ${int(await prisma.automationRule.count({ where: { domain: 'advertising' } }))} rules — fetched by the TAB BAR on every one of the 11 pages`)

await prisma.$disconnect()
