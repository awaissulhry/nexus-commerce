/** _kt6-final.mts — KT.6 close-out: nothing left behind, nothing armed. READ-ONLY. */
import '../src/env.js'
import prisma from '../src/db.js'
async function main() {
  console.log(`AdSpendCeiling rows: ${await prisma.adSpendCeiling.count()} (0 = the click-verification ceiling is gone)`)
  console.log(`KeywordBidProposal rows: ${await prisma.keywordBidProposal.count()} (0 = no proposal left behind)`)
  const t = await prisma.rankTarget.count({ where: { maxBiasPct: { not: null } } })
  console.log(`RankTarget with maxBiasPct set: ${t} (0 = the rank engine still cannot chase)`)
  console.log(`Campaign liveBidWritesEnabled: ${await prisma.campaign.count({ where: { liveBidWritesEnabled: true } })} of ${await prisma.campaign.count()} (82 = unchanged)`)
  console.log(`Campaign minBidCents set: ${await prisma.campaign.count({ where: { minBidCents: { not: null } } })} (0 = still no floor but KT.6's own)`)
  const q = await prisma.outboundSyncQueue.count({ where: { createdAt: { gte: new Date(Date.now() - 3600_000) } } })
  console.log(`OutboundSyncQueue rows in the last hour: ${q} (KT.6 queues nothing; any rows here are other engines)`)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(String(e).slice(0,200)); await prisma.$disconnect(); process.exit(1) })
