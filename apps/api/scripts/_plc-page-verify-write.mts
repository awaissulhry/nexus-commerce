/**
 * PLC.3 — read back what a write actually did. READ-ONLY; it writes nothing itself.
 *
 * Run before and after each UI write on the test campaign, so the report carries the real
 * CampaignBidHistory rows rather than a screenshot of a toast.
 *
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_plc-page-verify-write.mts
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { laneMultipliers, PLC_LANES, KEY_BY_LANE, getPlacementCursor } = await import('../src/services/advertising/placement-grid.service.js')

const NAME = 'ZZ_e2e_single_wwq7s'
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))

const c = await prisma.campaign.findFirst({
  where: { name: NAME },
  select: { id: true, name: true, status: true, marketplace: true, dynamicBidding: true, pinPlacement: true, liveBidWritesEnabled: true, externalCampaignId: true, lastSyncStatus: true, lastSyncedAt: true, lastSyncError: true },
})
if (!c) { console.log(`campaign "${NAME}" not found`); await prisma.$disconnect(); process.exit(0) }

const m = laneMultipliers(c.dynamicBidding)
console.log(`\n═══ ${c.name} ═══`)
console.log(`  id ${c.id} · ${c.marketplace} · ${c.status} · gate ${c.liveBidWritesEnabled ? 'OPEN' : 'shut'} · pin ${c.pinPlacement ? 'ON' : 'off'}`)
console.log(`  amazon id ${c.externalCampaignId ?? '(none — local only)'}`)
console.log(`  lanes NOW: ${PLC_LANES.map((l) => `${KEY_BY_LANE[l]}=${m[l]}%`).join(' · ')}`)
console.log(`  raw placementBidding: ${JSON.stringify(((c.dynamicBidding as { placementBidding?: unknown })?.placementBidding) ?? [])}`)
console.log(`  last push to Amazon: ${c.lastSyncStatus ?? '—'} ${c.lastSyncedAt?.toISOString() ?? ''} ${c.lastSyncError ?? ''}`)

const hist = await prisma.campaignBidHistory.findMany({
  where: { campaignId: c.id, field: { in: [...PLC_LANES] } },
  orderBy: { changedAt: 'desc' }, take: 12,
  select: { field: true, oldValue: true, newValue: true, changedAt: true, changedBy: true, reason: true },
})
console.log(`\n  CampaignBidHistory — placement rows (${hist.length} most recent):`)
if (hist.length === 0) console.log('    (none)')
for (const h of hist) {
  console.log(`    ${h.changedAt.toISOString()}  ${pad(KEY_BY_LANE[h.field as (typeof PLC_LANES)[number]] ?? h.field, 8)} ${pad(`${h.oldValue ?? 'absent'}→${h.newValue}`, 14)} ${pad(h.changedBy, 22)} ${h.reason ?? '(no reason)'}`)
}

const log = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'update_placement_bidding', entityId: c.id },
  orderBy: { createdAt: 'desc' }, take: 5,
  select: { createdAt: true, userId: true, amazonResponseStatus: true, payloadAfter: true },
})
console.log(`\n  AdvertisingActionLog — the audit spine (${log.length} most recent):`)
for (const l of log) {
  console.log(`    ${l.createdAt.toISOString()}  ${pad(String(l.amazonResponseStatus), 8)} ${pad(String(l.userId), 22)} mode=${String((l.payloadAfter as { mode?: unknown })?.mode ?? '?')}`)
}

const cur = await getPlacementCursor(null)
console.log(`\n  the page's poll cursor right now: ${JSON.stringify(cur)}`)
await prisma.$disconnect()
console.log('')
