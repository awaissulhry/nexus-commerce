#!/usr/bin/env tsx
/**
 * Phase 0 — one-time inventory drift baseline (READ-ONLY).
 *
 *   Amazon: existing reconcile service (orders + FBA units vs our DB).
 *   eBay:   DB-side drift — ChannelListing.quantity (last pushed) vs ATP
 *           (what it should be now). Channel API read-back is Phase 5.
 *
 * Run: npx tsx scripts/inventory-drift-baseline.ts
 */
import { reconcileAllAmazonMarketplaces } from '../apps/api/src/services/channel-reconciliation.service.js'
import prisma from '../apps/api/src/db.js'

async function main() {
  console.log('\n=== Phase 0 drift baseline ===\n')

  // ── Amazon ───────────────────────────────────────────────
  console.log('--- Amazon reconcile (last 30d) ---')
  try {
    const amazon = await reconcileAllAmazonMarketplaces({ daysBack: 30 })
    console.log(JSON.stringify(amazon, null, 2))
  } catch (err) {
    console.error('Amazon reconcile failed:', err instanceof Error ? err.message : err)
  }

  // ── eBay (coarse DB-side; mirrors sync-drift-detection job) ──
  // expected = max(0, totalStock - stockBuffer); drift = pushed qty - expected.
  // Coarse on purpose (ignores reservations / per-location ATP) — Phase 5 adds
  // the ATP-accurate channel-API read-back.
  console.log('\n--- eBay DB-side drift (pushed qty vs max(0, totalStock - buffer)) ---')
  const ebayListings = await prisma.channelListing.findMany({
    where: { channel: 'EBAY', listingStatus: 'ACTIVE', followMasterQuantity: true },
    select: {
      id: true,
      marketplace: true,
      quantity: true,
      stockBuffer: true,
      product: { select: { sku: true, totalStock: true } },
    },
  })

  const drifted = ebayListings
    .map((l) => {
      const expected = Math.max(0, (l.product.totalStock ?? 0) - (l.stockBuffer ?? 0))
      const pushed = l.quantity ?? 0
      return { sku: l.product.sku, marketplace: l.marketplace, pushed, expected, drift: pushed - expected }
    })
    .filter((r) => r.drift !== 0)
    .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))

  console.log(`eBay followMaster ACTIVE listings checked: ${ebayListings.length}, drifted: ${drifted.length}`)
  for (const r of drifted.slice(0, 50)) {
    console.log(`  ${r.sku} [${r.marketplace}] pushed=${r.pushed} expected=${r.expected} drift=${r.drift > 0 ? '+' : ''}${r.drift}`)
  }
  const totalUnits = drifted.reduce((s, r) => s + Math.abs(r.drift), 0)
  console.log(`\neBay drift totals: ${drifted.length} SKUs, ${totalUnits} units of absolute drift.`)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
