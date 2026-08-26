/** SYNC.9 — live blast radius of the rank-defend resume. */
import prisma from '../src/db.js'

console.log('=== AdSchedule (rank-defend) — enabled schedules and the campaigns they govern ===')
const scheds = await prisma.adSchedule.findMany({
  select: { id: true, name: true, enabled: true, dryRun: true, campaignIds: true, lastEvaluatedAt: true, kind: true } as any,
}).catch(async () => {
  const cols = await prisma.$queryRawUnsafe<any[]>(`SELECT column_name FROM information_schema.columns WHERE table_name='AdSchedule' ORDER BY ordinal_position`)
  console.log('  AdSchedule columns:', cols.map((c) => c.column_name).join(', '))
  return null
})
if (scheds) {
  for (const s of scheds as any[]) console.log(`  ${String(s.id).slice(0,24).padEnd(24)} ${String(s.name ?? '').slice(0,28).padEnd(28)} enabled=${s.enabled} dryRun=${s.dryRun} kind=${s.kind ?? '-'} campaigns=${Array.isArray(s.campaignIds) ? s.campaignIds.length : '?'} lastEval=${s.lastEvaluatedAt?.toISOString?.().slice(0,16) ?? '-'}`)
}
await prisma.$disconnect()
