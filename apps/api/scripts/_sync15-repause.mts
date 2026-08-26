/** SYNC.15 — restore the operator's 2026-08-21 intent: re-pause the 20 campaigns the rank
 *  engine re-enabled. Operator action (user: actor), audited, applyImmediately.
 *  DRY RUN unless --apply is passed. */
import prisma from '../src/db.js'
import { updateCampaignWithSync } from '../src/services/advertising/ads-mutation.service.js'

const APPLY = process.argv.includes('--apply')
const ACTOR = 'user:awais' as const
const REASON = 'restore operator intent — re-pause after rank-defend re-enabled it on 2026-08-21 (SYNC.1)'

const ids = [...new Set((await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_ENTITY_STATE_UPDATE', entityType: 'CAMPAIGN', createdAt: { gte: new Date('2026-08-21T19:25:00Z'), lte: new Date('2026-08-21T19:40:00Z') } },
  select: { entityId: true },
})).map((r) => r.entityId))]

const camps = await prisma.campaign.findMany({
  where: { id: { in: ids } },
  select: { id: true, name: true, status: true, marketplace: true, externalCampaignId: true },
  orderBy: { name: 'asc' },
})

console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — re-pause ${camps.length} campaigns as ${ACTOR}\n`)
let ok = 0, skipped = 0, failed = 0
for (const c of camps) {
  if (c.status !== 'ENABLED') { console.log(`  SKIP    ${String(c.name).slice(0,42).padEnd(42)} already ${c.status}`); skipped++; continue }
  if (!APPLY) { console.log(`  would pause ${String(c.name).slice(0,42).padEnd(42)} ${c.marketplace} ext=${c.externalCampaignId}`); continue }
  const r = await updateCampaignWithSync({ campaignId: c.id, patch: { status: 'PAUSED' }, actor: ACTOR, reason: REASON, applyImmediately: true } as never)
  if (r.ok) { console.log(`  QUEUED  ${String(c.name).slice(0,42).padEnd(42)} ${c.marketplace} queueId=${r.outboundQueueId ?? '-'}`); ok++ }
  else { console.log(`  FAILED  ${String(c.name).slice(0,42).padEnd(42)} error=${r.error}`); failed++ }
}
console.log(`\n${APPLY ? `queued=${ok} skipped=${skipped} failed=${failed}` : `${camps.length - skipped} would be paused`}`)
if (APPLY) console.log('NOTE: queued != delivered. Verify against Amazon before reporting success.')
await prisma.$disconnect()
