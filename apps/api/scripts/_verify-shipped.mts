import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const ok = (b: boolean) => (b ? 'PASS' : 'FAIL')
const since24 = new Date(Date.now() - 24 * 3600 * 1000)

console.log('\n=== A1 · does the engine write its own receipts? ===')
const sched = await p.adSchedule.findMany({ select: { id: true, lastEvaluatedAt: true, lastApplied: true, enabled: true, groupId: true } })
const stamped = sched.filter((s) => s.lastEvaluatedAt)
const fresh = sched.filter((s) => s.lastEvaluatedAt && s.lastEvaluatedAt > new Date(Date.now() - 40 * 60 * 1000))
console.log(`  ${ok(stamped.length > 0)}  ${stamped.length}/${sched.length} schedules stamped · ${fresh.length} within the last 40 min`)
const keys = new Map<string, number>()
for (const s of stamped) keys.set(String(s.lastApplied), (keys.get(String(s.lastApplied)) ?? 0) + 1)
console.log(`        lastApplied values: ${JSON.stringify([...keys])}`)

console.log('\n=== HX.2 · are placement writes on the audit spine, with an actor? ===')
const pf = await p.campaignBidHistory.groupBy({
  by: ['field'], where: { field: { startsWith: 'PLACEMENT_' } }, _count: true,
})
console.log(`  ${ok(pf.length > 0)}  placement rows in CampaignBidHistory: ${JSON.stringify(pf.map((x) => [x.field, x._count]))}`)
const anon = await p.campaignBidHistory.count({ where: { field: { startsWith: 'PLACEMENT_' }, changedBy: { in: ['', 'system'] } } })
console.log(`  ${ok(anon === 0)}  unattributed placement rows: ${anon}`)

console.log('\n=== HX.1 · is the action log telling the truth about outcomes? ===')
const st = await p.advertisingActionLog.groupBy({ by: ['amazonResponseStatus'], where: { createdAt: { gte: since24 } }, _count: true })
console.log(`  status spread (24h): ${JSON.stringify(st.map((x) => [x.amazonResponseStatus, x._count]))}`)

console.log('\n=== DL.1 · did the routing fix hold? ===')
const failed24 = await p.adMutation.count({ where: { entityType: 'AD_TARGET', state: 'FAILED', updatedAt: { gte: since24 } } })
const applied24 = await p.adMutation.count({ where: { entityType: 'AD_TARGET', state: 'APPLIED', updatedAt: { gte: since24 } } })
console.log(`  ${ok(failed24 === 0)}  AD_TARGET writes in 24h — applied ${applied24}, failed ${failed24}`)

console.log('\n=== A2 · what would the Health column show right now? ===')
const groups = await p.rankScheduleGroup.findMany({ select: { id: true, name: true, enabled: true } })
const members = await p.adSchedule.findMany({ where: { groupId: { not: null } }, select: { id: true, groupId: true, lastEvaluatedAt: true } })
const actors = members.map((m) => `automation:rank-defend-${m.id}`)
const fails = actors.length
  ? await p.adMutation.groupBy({ by: ['actor'], where: { state: 'FAILED', actor: { in: actors }, updatedAt: { gte: since24 } }, _count: true })
  : []
const failByGroup = new Map<string, number>()
for (const f of fails) {
  const m = members.find((x) => `automation:rank-defend-${x.id}` === f.actor)
  if (m?.groupId) failByGroup.set(m.groupId, (failByGroup.get(m.groupId) ?? 0) + f._count)
}
for (const g of groups.slice(0, 8)) {
  const ms = members.filter((m) => m.groupId === g.id)
  const newest = ms.map((m) => m.lastEvaluatedAt).filter(Boolean).sort().pop()
  const f = failByGroup.get(g.id) ?? 0
  const health = f > 0 ? `${f} writes failing` : !g.enabled ? 'Paused' : !newest ? 'Never run' : (Date.now() - new Date(newest).getTime() > 40 * 60_000 ? 'Stale' : 'OK')
  console.log(`  ${g.name.slice(0, 28).padEnd(29)} ${String(ms.length).padStart(2)} members  →  ${health}`)
}

console.log('\n=== HX.8 · plan-edit history ===')
const vers = await p.rankScheduleVersion.count()
console.log(`  ${vers} versions recorded (0 expected until a schedule is next saved)`)

console.log('\n=== HX.4 · actor strings the feed must classify ===')
const acts = await p.campaignBidHistory.groupBy({ by: ['changedBy'], where: { changedAt: { gte: since24 } }, _count: true })
for (const a of acts.slice(0, 8)) console.log(`  ${String(a._count).padStart(5)}×  ${a.changedBy}`)
await p.$disconnect()
