#!/usr/bin/env node
// H.2 reconciliation — sets Product.totalStock = SUM(StockLevel.quantity)
// for every buyable product, emitting SYNC_RECONCILIATION audit rows
// for any non-zero drift. Runs once after Commit 2 deploy.
//
// Expected outcome with no fulfillment activity between Commit 1 and
// Commit 2: zero drift, zero audit rows emitted.
//
//   node packages/database/scripts/reconcile-stocklevel.mjs --dry-run
//   node packages/database/scripts/reconcile-stocklevel.mjs

import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '..', '..', '.env') })

const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')
const ACTOR = 'system:reconcile_h2_stocklevel'

async function main() {
  console.log(`[reconcile] starting (DRY_RUN=${DRY_RUN})`)
  const startedAt = Date.now()

  const products = await prisma.product.findMany({
    where: { isParent: false },
    select: { id: true, sku: true, totalStock: true },
  })

  let drift = 0
  let driftUnits = 0
  for (const p of products) {
    const sum = await prisma.stockLevel.aggregate({
      where: { productId: p.id },
      _sum: { quantity: true },
    })
    const sumQty = sum._sum.quantity ?? 0
    if (p.totalStock === sumQty) continue

    drift++
    const delta = sumQty - p.totalStock
    driftUnits += Math.abs(delta)
    console.log(
      `[reconcile] DRIFT ${p.sku}: totalStock=${p.totalStock} sum(StockLevel)=${sumQty} delta=${delta}`,
    )

    if (!DRY_RUN) {
      // The legacy path drove totalStock above SUM by writing increments
      // that didn't reach StockLevel. We restore the invariant by
      // pulling totalStock down to SUM and emitting an audit row that
      // captures the loss for forensic review.
      await prisma.$transaction(async (tx) => {
        await tx.product.update({
          where: { id: p.id },
          data: { totalStock: sumQty },
        })
        await tx.stockMovement.create({
          data: {
            productId: p.id,
            change: delta,
            quantityBefore: p.totalStock,
            balanceAfter: sumQty,
            reason: 'SYNC_RECONCILIATION',
            referenceType: 'H2_RECONCILE',
            notes: `Commit 2 reconciliation: Product.totalStock=${p.totalStock} → SUM(StockLevel)=${sumQty} (delta=${delta})`,
            actor: ACTOR,
          },
        })
      })
    }
  }

  console.log(
    `[reconcile] complete in ${Date.now() - startedAt}ms — ` +
      `products=${products.length} drift=${drift} drift_units=${driftUnits}`,
  )
}

main()
  .catch((e) => {
    console.error('[reconcile] failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
