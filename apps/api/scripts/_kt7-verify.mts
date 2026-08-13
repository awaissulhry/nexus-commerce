/** _kt7-verify.mts — did the write and its undo actually land, in the DB and at Amazon? READ-ONLY. */
import '../src/env.js'
import prisma from '../src/db.js'
const line = (s = '') => console.log(s)
const eur = (c: number | null) => (c == null ? 'null' : `€${(c / 100).toFixed(2)}`)
async function main() {
  const logs = await prisma.advertisingActionLog.findMany({
    where: { userId: { contains: 'kt7-gate' } }, orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true, actionType: true, entityId: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true, rolledBackAt: true, rollbackReason: true, executionId: true, userId: true },
  })
  line(`action-log rows by the gate actor: ${logs.length}`)
  for (const l of logs) {
    line(`  ${l.createdAt.toISOString().slice(5, 19)} ${l.actionType} target=${l.entityId}`)
    line(`     before=${JSON.stringify(l.payloadBefore)} after=${JSON.stringify(l.payloadAfter)}`)
    line(`     amazon=${l.amazonResponseStatus} rolledBackAt=${l.rolledBackAt?.toISOString().slice(11, 19) ?? 'no'} reason=${l.rollbackReason ?? '—'}`)
    line(`     actor=${l.userId} changeSet=${l.executionId}`)
  }
  const tgt = logs[0]?.entityId
  if (tgt) {
    const t = await prisma.adTarget.findUnique({ where: { id: tgt }, select: { bidCents: true, expressionValue: true, lastSyncedAt: true, lastSyncStatus: true, lastSyncError: true, suppressedFromBidCents: true, adGroup: { select: { campaign: { select: { name: true, marketplace: true } } } } } })
    line()
    line(`the target NOW: "${t?.expressionValue}" in ${t?.adGroup?.campaign.name} (${t?.adGroup?.campaign.marketplace})`)
    line(`   bidCents = ${eur(t?.bidCents ?? null)}`)
    line(`   lastSyncedAt=${t?.lastSyncedAt?.toISOString().slice(5, 19)} status=${t?.lastSyncStatus} err=${t?.lastSyncError ?? '—'}`)
    line(`   suppressedFromBidCents = ${t?.suppressedFromBidCents ?? 'null'}  ← KT.7 must NEVER have written this`)
  }
  const q = await prisma.outboundSyncQueue.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 2 * 3600_000) }, syncType: 'AD_BID_UPDATE' },
    orderBy: { createdAt: 'desc' }, take: 6,
    select: { createdAt: true, syncStatus: true, errorMessage: true, syncedAt: true, payload: true },
  })
  line()
  line(`OutboundSyncQueue AD_BID_UPDATE rows in 2h: ${q.length}`)
  for (const x of q) line(`   ${x.createdAt.toISOString().slice(11, 19)} ${x.syncStatus} synced=${x.syncedAt?.toISOString().slice(11, 19) ?? '—'} payload=${JSON.stringify(x.payload).slice(0, 90)} err=${(x.errorMessage ?? '').slice(0, 60)}`)
  line()
  const p = await prisma.keywordBidProposal.findMany({ select: { id: true, term: true, status: true, actionableTargets: true, commitmentCents: true, executionId: true, decidedBy: true } })
  line(`KeywordBidProposal: ${p.length}`)
  for (const x of p) line(`   ${x.term} ${x.status} targets=${x.actionableTargets} commit=${eur(x.commitmentCents)} by=${x.decidedBy ?? '—'}`)
  line(`AdSpendCeiling: ${await prisma.adSpendCeiling.count()}`)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(String(e).slice(0, 300)); await prisma.$disconnect(); process.exit(1) })
