/**
 * ACR Stage 5 — 36 IT SB keywords were re-ARCHIVED 25 minutes after the reconcile.
 * Decide who is right NOW by asking Amazon again. READ-ONLY.
 *
 * If Amazon still says enabled, something in our stack re-broke them and the drift RECURS —
 * which would mean the reconcile is not durable and the root cause is still live.
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const { listSbKeywords } = await import('../src/services/advertising/ads-api-client.js')

const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: 'IT', isActive: true }, select: { profileId: true, region: true } })
if (!conn) { console.log('no IT connection'); process.exit(1) }
const ids = (await prisma.campaign.findMany({
  where: { marketplace: 'IT', adProduct: 'SPONSORED_BRANDS' }, select: { externalCampaignId: true },
})).map(c => c.externalCampaignId!).filter(Boolean)

const remote = await listSbKeywords({ profileId: conn.profileId, region: (conn.region as 'EU') ?? 'EU' }, { externalCampaignIds: ids })
const byState = new Map<string, number>()
for (const k of remote) byState.set(String(k.state), (byState.get(String(k.state)) ?? 0) + 1)
console.log(`\nAMAZON IT right now: ${remote.length} keywords → ${JSON.stringify(Object.fromEntries(byState))}`)

const locals = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false, adGroup: { campaign: { adProduct: 'SPONSORED_BRANDS', marketplace: 'IT' } } },
  select: { externalTargetId: true, status: true, expressionValue: true, updatedAt: true },
})
const localByExt = new Map(locals.filter(l => l.externalTargetId).map(l => [l.externalTargetId!, l]))

let agree = 0, disagree = 0
const samples: string[] = []
for (const k of remote) {
  const l = localByExt.get(String(k.keywordId))
  if (!l) continue
  const want = { enabled: 'ENABLED', paused: 'PAUSED', archived: 'ARCHIVED' }[String(k.state).toLowerCase()]
  if (want === l.status) agree += 1
  else {
    disagree += 1
    if (samples.length < 6) samples.push(`  "${l.expressionValue}" local=${l.status} amazon=${k.state}  (local touched ${l.updatedAt.toISOString().slice(11, 19)}Z)`)
  }
}
console.log(`\nagree=${agree}  disagree=${disagree}`)
if (samples.length) { console.log('\nsamples:'); samples.forEach(s => console.log(s)) }
console.log(disagree > 0
  ? '\n🔴 THE DRIFT RECURRED. Something in our stack re-archived rows Amazon still serves —\n   the reconcile is not durable and the root cause is still live.'
  : '\n✅ Local and Amazon agree — Amazon itself changed, not our stack.')
await prisma.$disconnect(); process.exit(0)
