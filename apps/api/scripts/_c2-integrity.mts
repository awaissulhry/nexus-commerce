import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const [groups, schedules] = await Promise.all([
  p.rankScheduleGroup.findMany({ select: { id: true, name: true } }),
  p.adSchedule.findMany({ select: { id: true, campaignId: true, groupId: true, enabled: true } }),
])
const byGroup = new Map<string, number>()
for (const s of schedules) if (s.groupId) byGroup.set(s.groupId, (byGroup.get(s.groupId) ?? 0) + 1)
const empty = groups.filter(g => !byGroup.get(g.id))
const seen = new Map<string, number>()
for (const s of schedules) seen.set(s.campaignId, (seen.get(s.campaignId) ?? 0) + 1)
const dbl = [...seen.entries()].filter(([,v]) => v > 1)
const ungrouped = schedules.filter(s => !s.groupId)
const ids = [...new Set(schedules.map(s => s.campaignId))]
const camps = await p.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, status: true } })
const by = new Map(camps.map(c => [c.id, c]))
const archived = schedules.filter(s => s.enabled && by.get(s.campaignId)?.status === 'ARCHIVED')
const missing = schedules.filter(s => !by.has(s.campaignId))
console.log(`checked ${groups.length} groups · ${schedules.length} schedules\n`)
console.log(`  empty groups        ${empty.length}${empty.length ? '  → ' + empty.slice(0,5).map(g=>g.name).join(', ') : ''}`)
console.log(`  double-held         ${dbl.length}`)
console.log(`  ungrouped schedules ${ungrouped.length}`)
console.log(`  archived+enabled    ${archived.length}${archived.length ? '  → ' + archived.slice(0,5).map(s=>by.get(s.campaignId)?.name).join(', ') : ''}`)
console.log(`  missing campaign    ${missing.length}`)
console.log(`\n  TOTAL ISSUES: ${empty.length + dbl.length + ungrouped.length + archived.length + missing.length}`)
await p.$disconnect()
