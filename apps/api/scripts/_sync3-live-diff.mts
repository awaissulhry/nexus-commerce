/** SYNC.3 — the decisive test. Ask Amazon what each campaign's state IS, compare to our row.
 *  Covers SP (v3 list) AND the SD/SB campaigns the SP endpoint can never return. */
import prisma from '../src/db.js'
import { listCampaignsV3 } from '../src/services/advertising/ads-api-client.js'

const conns = await prisma.amazonAdsConnection.findMany({ select: { profileId: true, region: true, marketplace: true, mode: true } })
const locals = await prisma.campaign.findMany({
  where: { externalCampaignId: { not: null } },
  select: { id: true, name: true, status: true, marketplace: true, adProduct: true, externalCampaignId: true, settingsSyncedAt: true },
})
const byExt = new Map(locals.map((c) => [c.externalCampaignId!, c]))

let seenTotal = 0
const seenIds = new Set<string>()
const mismatches: string[] = []

for (const conn of conns) {
  const region = (conn.region === 'NA' || conn.region === 'FE' ? conn.region : 'EU') as 'EU' | 'NA' | 'FE'
  let list: any[] = []
  try {
    list = await listCampaignsV3({ profileId: conn.profileId, region }, { states: ['ENABLED', 'PAUSED', 'ARCHIVED'] })
  } catch (e) {
    console.log(`  ${conn.marketplace} (${conn.mode}) FETCH FAILED: ${(e as Error).message.slice(0, 120)}`)
    continue
  }
  console.log(`  ${conn.marketplace} (${conn.mode}) profile=${conn.profileId} -> Amazon returned ${list.length} SP campaigns`)
  seenTotal += list.length
  for (const c of list) {
    if (!c.campaignId) continue
    seenIds.add(c.campaignId)
    const loc = byExt.get(c.campaignId)
    const amz = String(c.state ?? '').toUpperCase()
    if (!loc) { mismatches.push(`  NOT-IN-DB   ${c.campaignId} amazon=${amz} name=${String(c.name).slice(0, 40)}`); continue }
    if (loc.status !== amz) {
      mismatches.push(`  MISMATCH    ${String(loc.name).slice(0, 40).padEnd(40)} ${loc.marketplace} ours=${String(loc.status).padEnd(9)} amazon=${amz}`)
    }
  }
}

console.log(`\n=== Amazon SP total: ${seenTotal} unique=${seenIds.size} | local SP w/ ext id: ${locals.filter((l) => l.adProduct === 'SPONSORED_PRODUCTS').length} ===`)

console.log('\n=== STATE MISMATCHES (local vs Amazon, SP) ===')
if (!mismatches.length) console.log('  (none - every SP campaign agrees with Amazon)')
else mismatches.forEach((m) => console.log(m))

console.log('\n=== Local ACTIVE campaigns Amazon never returned (invisible to the sync) ===')
const unseen = locals.filter((l) => !seenIds.has(l.externalCampaignId!) && l.status !== 'ARCHIVED')
if (!unseen.length) console.log('  (none)')
for (const l of unseen) console.log(`  ${String(l.name).slice(0, 46).padEnd(46)} ${l.marketplace} ${String(l.adProduct).padEnd(19)} ours=${l.status} v3SyncedAt=${l.settingsSyncedAt ? 'yes' : 'NEVER'}`)

await prisma.$disconnect()
