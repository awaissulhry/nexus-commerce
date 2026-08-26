/** SYNC.11 — prove the runtime guard refuses, without risking a write.
 *  Patch status = the campaign's CURRENT status. The guard fires BEFORE the diff, so:
 *    guard working  -> 'engine_may_not_set_campaign_status'
 *    guard bypassed -> 'no_changes'   (diff finds nothing; still writes nothing)
 *  Either way nothing reaches Amazon, and the two answers are distinguishable. */
import prisma from '../src/db.js'
import { updateCampaignWithSync } from '../src/services/advertising/ads-mutation.service.js'

const c = await prisma.campaign.findFirst({ where: { status: 'ENABLED', externalCampaignId: { not: null } }, select: { id: true, name: true, status: true } })
if (!c) { console.log('no ENABLED campaign to test against'); process.exit(0) }
console.log(`target: ${c.name} (currently ${c.status}) — patching status=${c.status} (a no-op by construction)\n`)

for (const actor of ['automation:rank-defend-cmr2699uy02njp7018u2mndsz', 'automation:dayparting-cmq0xape100aio201urf5utiz', 'automation:cms450kg9002rqt019f1outpu', 'user:awais'] as const) {
  const r = await updateCampaignWithSync({ campaignId: c.id, patch: { status: c.status as 'ENABLED' }, actor, reason: 'SYNC.1 guard proof (no-op patch)' } as never)
  const verdict = r.error === 'engine_may_not_set_campaign_status' ? 'REFUSED  <-- guard fired'
    : r.error === 'no_changes' ? 'allowed through to the diff (no-op, nothing written)'
    : `ok=${r.ok} error=${r.error}`
  console.log(`  ${actor.padEnd(46)} ${verdict}`)
}

const after = await prisma.campaign.findUnique({ where: { id: c.id }, select: { status: true } })
console.log(`\nstatus after all four calls: ${after?.status} (was ${c.status})`)
const q = await prisma.outboundSyncQueue.count({ where: { syncType: 'AD_ENTITY_STATE_UPDATE', createdAt: { gt: new Date(Date.now() - 120_000) } } })
console.log(`AD_ENTITY_STATE_UPDATE rows enqueued in the last 2 min: ${q}`)
await prisma.$disconnect()
