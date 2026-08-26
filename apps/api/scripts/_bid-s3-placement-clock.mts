import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const now = new Date()
// the campaign S2 measured at +400%
const c = await prisma.campaign.findFirst({ where: { name: { contains: 'GALE | IT | Phrase | Category' } }, select: { id: true, name: true, dynamicBidding: true } })
console.log(`\ncampaign: ${c?.name}  now: ${JSON.stringify((c?.dynamicBidding as any)?.placementBidding ?? [])}`)
if (c) {
  const h = await prisma.campaignBidHistory.findMany({
    where: { entityId: c.id, field: { in: ['PLACEMENT_TOP','PLACEMENT_REST_OF_SEARCH','PLACEMENT_PRODUCT_PAGE'] } },
    select: { field: true, oldValue: true, newValue: true, changedAt: true, changedBy: true, reason: true },
    orderBy: { changedAt: 'desc' }, take: 12,
  })
  console.log(`\n🔴 audited placement changes on THIS campaign (newest first): ${h.length}`)
  for (const r of h) console.log(`  ${r.changedAt.toLocaleString('en-GB',{timeZone:'Europe/Rome'})}  ${r.field.padEnd(24)} ${String(r.oldValue).padStart(4)} → ${String(r.newValue).padStart(4)}  ${(r.reason??'').slice(0,44)}`)
}
// how far does the bias swing account-wide in 24h?
const day = await prisma.campaignBidHistory.findMany({
  where: { field: { in: ['PLACEMENT_TOP','PLACEMENT_REST_OF_SEARCH'] }, changedAt: { gte: new Date(now.getTime()-24*3600_000) } },
  select: { newValue: true, changedAt: true },
})
const vals = day.map(d=>Number(d.newValue)).filter(Number.isFinite)
console.log(`\nplacement writes in 24 h: ${day.length} · values seen ${Math.min(...vals)}..${Math.max(...vals)}`)
const hrs = new Map<number,number>()
for (const d of day) { const h = Number(d.changedAt.toLocaleString('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',hour12:false})); hrs.set(h,(hrs.get(h)??0)+1) }
console.log(`by hour (Rome): ${[...hrs.entries()].sort((a,b)=>a[0]-b[0]).map(([h,n])=>`${String(h).padStart(2,'0')}:${n}`).join(' ')}`)
await prisma.$disconnect()
