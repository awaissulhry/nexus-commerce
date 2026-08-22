/** PLC-P4 — inspect the e2e test campaign BEFORE attempting any write. Read-only. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const ID = 'cmqr28uno001ak4011kei84su'
const c = await prisma.campaign.findUnique({
  where: { id: ID },
  select: { id: true, name: true, status: true, marketplace: true, adProduct: true, externalCampaignId: true, liveBidWritesEnabled: true, dynamicBidding: true, dailyBudget: true },
})
console.log(JSON.stringify(c, null, 2))
const st = await prisma.adsAutomationState.findFirst({ select: { halted: true, autonomy: true } })
console.log(`automation state: ${JSON.stringify(st)}`)
const sched = await prisma.adSchedule.count({ where: { enabled: true, campaignId: ID } })
console.log(`enabled AdSchedule on it: ${sched}`)
await prisma.$disconnect()
