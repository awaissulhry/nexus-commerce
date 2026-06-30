#!/usr/bin/env tsx
/**
 * Phase 0 — synthetic inventory canary. Perturbs ONE designated SKU by
 * ±delta (net zero) and measures stock-change → channel syncedAt per
 * channel. Reused as the regression harness in later phases.
 *
 * Dry-run by default. Writes only with --confirm.
 *
 *   npx tsx scripts/inventory-canary.ts --sku CANARY-001            # dry-run
 *   npx tsx scripts/inventory-canary.ts --sku CANARY-001 --confirm  # live ±1
 */
import { applyStockMovement } from '../apps/api/src/services/stock-movement.service.js'
import prisma from '../apps/api/src/db.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(`--${name}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const sku = arg('sku')
  if (!sku) { console.error('Missing --sku <SKU>'); process.exit(1) }
  const delta = Number(arg('delta') ?? '1')
  const waitS = Number(arg('wait') ?? '90')
  const confirm = has('confirm')

  const product = await prisma.product.findUnique({ where: { sku }, select: { id: true, sku: true, totalStock: true } })
  if (!product) { console.error(`No product with sku ${sku}`); process.exit(1) }

  if (!confirm) {
    console.log(`[dry-run] would +${delta} then -${delta} on ${product.sku} (current totalStock=${product.totalStock}) and measure round-trip. Re-run with --confirm.`)
    await prisma.$disconnect()
    return
  }

  const t0 = new Date()
  console.log(`Canary: +${delta} on ${product.sku} at ${t0.toISOString()}`)
  console.log('NOTE: round-trip includes the ~30s manual undo-grace (MANUAL_ADJUSTMENT is not order-driven). Real sales skip it.')
  await applyStockMovement({ productId: product.id, change: delta, reason: 'MANUAL_ADJUSTMENT' })

  const deadline = Date.now() + waitS * 1000
  const seen = new Map<string, number>()
  while (Date.now() < deadline) {
    const rows = await prisma.outboundSyncQueue.findMany({
      where: { productId: product.id, createdAt: { gte: t0 }, syncType: 'QUANTITY_UPDATE' },
      select: { targetChannel: true, createdAt: true, syncedAt: true },
    })
    for (const r of rows) {
      if (r.syncedAt && !seen.has(r.targetChannel)) {
        seen.set(r.targetChannel, r.syncedAt.getTime() - r.createdAt.getTime())
        console.log(`  ${r.targetChannel}: round-trip ${seen.get(r.targetChannel)}ms`)
      }
    }
    if (rows.length > 0 && rows.every((r) => r.syncedAt)) break
    await sleep(2000)
  }

  console.log(`Canary: restoring -${delta} on ${product.sku}`)
  await applyStockMovement({ productId: product.id, change: -delta, reason: 'MANUAL_ADJUSTMENT' })

  console.log('\nRound-trip summary:', Object.fromEntries(seen))
  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
