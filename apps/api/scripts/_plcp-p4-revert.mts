/**
 * PLC-P4 — REVERT the unintended local placement change on `Regal Product Trageting`.
 *
 * `_plcp-p4-refusal-live.mts` assumed a campaign with `liveBidWritesEnabled: false` would be
 * refused by the write gate. It was not: `checkAdsWriteGate` short-circuits to
 * `{ allowed: true, mode: 'sandbox' }` when `NEXUS_AMAZON_ADS_MODE` is unset (it is, locally),
 * BEFORE the halt check, the connection check and the campaign allowlist. `updateCampaign` then
 * also short-circuited, so Amazon was never contacted — but `updatePlacementBidding` still wrote
 * the LOCAL (production) database, because sandbox means "do not call Amazon", not "do not write
 * locally". PLACEMENT_TOP went 43% → 25% and one CampaignBidHistory row was created.
 *
 * Reverted THROUGH `updatePlacementBidding` rather than by patching the row, so the ledger records
 * the correction as its own entry (25 → 43) and the two rows together tell the truth. Nothing is
 * deleted: an audit trail that hides a mistake is worse than the mistake.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { updatePlacementBidding } = await import('../src/services/advertising/ads-create.service.js')
const ID = 'cmpee2fmt09o7oj01v9jjttyy'

/** The exact profile read from prod at 00:09, before the probe touched it. */
const ORIGINAL = [
  { placement: 'PLACEMENT_TOP', percentage: 43 },
  { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 3 },
  { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 12 },
]

const now = await prisma.campaign.findUnique({ where: { id: ID }, select: { name: true, status: true, dynamicBidding: true } })
console.log(`campaign: "${now?.name}" (${now?.status})`)
console.log(`current:  ${JSON.stringify((now?.dynamicBidding as { placementBidding?: unknown })?.placementBidding)}`)

const res = await updatePlacementBidding({
  campaignId: ID,
  adjustments: ORIGINAL,
  actor: 'user:awais',
  reason: 'PLC-P4 revert — restoring the profile a verification probe changed by mistake',
})
console.log(`revert:   ${JSON.stringify(res)}`)

const after = await prisma.campaign.findUnique({ where: { id: ID }, select: { dynamicBidding: true } })
const pb = ((after?.dynamicBidding as { placementBidding?: Array<{ placement: string; percentage: number }> })?.placementBidding) ?? []
const map = Object.fromEntries(pb.map((a) => [a.placement, a.percentage]))
const ok = map.PLACEMENT_TOP === 43 && map.PLACEMENT_PRODUCT_PAGE === 3 && map.PLACEMENT_REST_OF_SEARCH === 12
console.log(`after:    ${JSON.stringify(pb)}`)
console.log(ok ? '\n✓ RESTORED to the exact prior profile (43 / 3 / 12)' : '\n✗ NOT restored — inspect by hand')

const hist = await prisma.campaignBidHistory.findMany({
  where: { campaignId: ID, field: { startsWith: 'PLACEMENT' } },
  orderBy: { changedAt: 'asc' },
  select: { field: true, oldValue: true, newValue: true, changedBy: true, reason: true, changedAt: true },
})
console.log(`\nledger (${hist.length} rows) — both halves of the mistake are on the record:`)
for (const h of hist) console.log(`  ${h.changedAt.toISOString()} ${h.field} ${h.oldValue}→${h.newValue} by ${h.changedBy}\n      ${h.reason}`)

await prisma.$disconnect()
process.exit(ok ? 0 : 1)
