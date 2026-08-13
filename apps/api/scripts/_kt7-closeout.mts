/** _kt7-closeout.mts — KT.7 close-out: nothing left armed, nothing left changed. READ-ONLY. */
import '../src/env.js'
import prisma from '../src/db.js'
const line = (s = '') => console.log(s)
const eur = (c: number | null) => (c == null ? 'null' : `€${(c / 100).toFixed(2)}`)
async function main() {
  const t = await prisma.adTarget.findFirst({
    where: { expressionValue: { equals: 'motorradjacke herren sommer', mode: 'insensitive' }, adGroup: { campaign: { marketplace: 'DE', liveBidWritesEnabled: true } } },
    select: { bidCents: true, suppressedFromBidCents: true, lastSyncStatus: true, lastSyncedAt: true },
  })
  line(`the written target: bid ${eur(t?.bidCents ?? null)} · suppressedFromBidCents ${t?.suppressedFromBidCents ?? 'null'} · sync ${t?.lastSyncStatus} at ${t?.lastSyncedAt?.toISOString().slice(11,19)}`)
  line(`  ⇒ ${t?.bidCents === 50 ? '✓ back at its original €0.50' : '🔴 NOT at €0.50 — a change was left live'}`)
  line(`  ⇒ ${t?.suppressedFromBidCents == null ? '✓ KT.7 never wrote the suppression column' : '🔴 the suppression column was written'}`)
  const logs = await prisma.advertisingActionLog.count({ where: { entityType: 'AD_TARGET', rolledBackAt: null, userId: { startsWith: 'user:' }, createdAt: { gte: new Date(Date.now() - 6 * 3600_000) } } })
  line()
  line(`operator AD_TARGET writes in 6h NOT rolled back: ${logs}`)
  line(`KeywordBidProposal: ${await prisma.keywordBidProposal.count()} (true history — applied then reversed)`)
  line(`AdSpendCeiling: ${await prisma.adSpendCeiling.count()}`)
  line(`AdTarget.suppressedFromBidCents NOT NULL, account-wide: ${await prisma.adTarget.count({ where: { suppressedFromBidCents: { not: null } } })}`)
  line(`RankTarget.maxBiasPct set: ${await prisma.rankTarget.count({ where: { maxBiasPct: { not: null } } })} of ${await prisma.rankTarget.count()}`)
  line(`Campaign liveBidWritesEnabled: ${await prisma.campaign.count({ where: { liveBidWritesEnabled: true } })} of ${await prisma.campaign.count()}`)
  line(`Campaign minBidCents set: ${await prisma.campaign.count({ where: { minBidCents: { not: null } } })}`)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(String(e).slice(0,300)); await prisma.$disconnect(); process.exit(1) })
