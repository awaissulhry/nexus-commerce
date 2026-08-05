/**
 * ACR.1.2b — prove the pin BINDS, on the real prod row. READ-ONLY (the gate only reads).
 *
 * NEXUS_AMAZON_ADS_MODE is forced to `live` for this process: in sandbox the gate
 * short-circuits to allowed on its very first line, so a sandbox run would "pass" without
 * evaluating a single check — exactly the kind of green that proves nothing.
 */
process.env.NEXUS_AMAZON_ADS_MODE = 'live'
import '../src/env.js'
process.env.NEXUS_AMAZON_ADS_MODE = 'live'

const prisma = (await import('../src/db.js')).default
const { checkAdsWriteGate } = await import('../src/services/advertising/ads-write-gate.js')

const c = await prisma.campaign.findFirst({
  where: { name: 'DE_Auto_Close' },
  select: {
    id: true, name: true, marketplace: true, minBidCents: true, maxBidCents: true,
    pinBids: true, pinBudget: true, pinPlacement: true, pinnedBy: true, liveBidWritesEnabled: true,
  },
})
if (!c) { console.log('campaign not found'); process.exit(1) }
console.log('\nSTORED ROW:', JSON.stringify(c))

const base = { marketplace: c.marketplace, payloadValueCents: 100, campaignId: c.id }
const show = async (label: string, ctx: Record<string, unknown>) => {
  const r = await checkAdsWriteGate({ ...base, ...ctx } as never)
  const verdict = r.allowed ? `ALLOWED (${(r as { mode: string }).mode})` : `DENIED [${(r as { deniedAt: string }).deniedAt}]`
  console.log(`  ${label.padEnd(50)} ${verdict}`)
  if (!r.allowed) console.log(`      ↳ ${(r as { reason: string }).reason}`)
}

console.log('\nGATE DECISIONS on the pinned campaign:')
await show('bid write            → expect DENY (bids pinned)', { field: 'bid', intendedValueCents: 100 })
await show('SUPPRESSION to 2c    → expect ALLOW (exempt)', { field: 'bid', intendedValueCents: 2, isSuppression: true })
await show('budget write         → expect ALLOW (not pinned)', { field: 'dailyBudget', intendedValueCents: 1000 })
await show('placement push       → expect ALLOW (not pinned)', { dimension: 'placement', payloadValueCents: 0 })
await show('status change        → expect ALLOW (no dimension)', { field: 'status' })
await show('multi-field bid+bgt  → expect DENY (bids in list)', { field: 'dailyBudget', fields: ['dailyBudget', 'bid'], intendedValueCents: 1000 })

await prisma.$disconnect()
