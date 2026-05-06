#!/usr/bin/env node
// H.1 backfill: seed StockLocation rows + create StockLevel entries
// from existing Product.totalStock + zero out parent product stock.
//
// Idempotent: uses upserts on the unique `code` of StockLocation, and
// a findFirst+create guard for StockLevel rows. Re-running the script
// after partial success is safe.
//
// Usage:
//   node packages/database/scripts/backfill-stocklevel.mjs --dry-run
//   node packages/database/scripts/backfill-stocklevel.mjs
//
// Requires DATABASE_URL in environment. Run via Railway shell so the
// production URL is injected without crossing process boundaries.

import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '..', '..', '.env') })
dotenv.config({ path: path.join(here, '..', '.env') })

const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')
const ACTOR = 'system:migration_h1_stock_locations'

const RICCIONE_MARKETS = ['IT', 'DE', 'FR', 'ES', 'GB', 'NL', 'BE', 'PL', 'SE']
const FBA_EU_MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'PL', 'SE']

async function main() {
  console.log(`[backfill] starting (DRY_RUN=${DRY_RUN})`)
  const startedAt = Date.now()

  await prisma
    .$transaction(
      async (tx) => {
        // ── 1. Seed StockLocation rows ──────────────────────────────
        const riccione = await tx.stockLocation.upsert({
          where: { code: 'IT-MAIN' },
          create: {
            type: 'WAREHOUSE',
            code: 'IT-MAIN',
            name: 'Italy Main Warehouse (Riccione)',
            warehouseId: 'wh_default_it',
            servesMarketplaces: RICCIONE_MARKETS,
            isActive: true,
          },
          update: {},
        })
        console.log(`[backfill] location: ${riccione.code} (${riccione.id})`)

        const fbaEu = await tx.stockLocation.upsert({
          where: { code: 'AMAZON-EU-FBA' },
          create: {
            type: 'AMAZON_FBA',
            code: 'AMAZON-EU-FBA',
            name: 'Amazon EU FBA',
            servesMarketplaces: FBA_EU_MARKETS,
            isActive: true,
          },
          update: {},
        })
        console.log(`[backfill] location: ${fbaEu.code} (${fbaEu.id})`)

        // ── 2. Zero out parent product stock with audit row ─────────
        const parentsWithStock = await tx.product.findMany({
          where: { isParent: true, totalStock: { gt: 0 } },
          select: { id: true, sku: true, totalStock: true },
        })
        console.log(
          `[backfill] parents with stock to zero: ${parentsWithStock.length}`,
        )

        for (const p of parentsWithStock) {
          await tx.stockMovement.create({
            data: {
              productId: p.id,
              change: -p.totalStock,
              balanceAfter: 0,
              quantityBefore: p.totalStock,
              reason: 'PARENT_PRODUCT_CLEANUP',
              referenceType: 'PARENT_PRODUCT_CLEANUP',
              notes: `Parent ${p.sku} totalStock=${p.totalStock} zeroed during multi-location migration. Non-buyable parents do not hold inventory.`,
              actor: ACTOR,
            },
          })
          await tx.product.update({
            where: { id: p.id },
            data: { totalStock: 0 },
          })
        }

        // ── 3. Backfill StockLevel from Product.totalStock ──────────
        // All current stock → IT-MAIN (Riccione). Documented assumption:
        // no signal exists in current data to distinguish FBA-cron writes
        // from manual entry, and all 8 ChannelListing rows are DRAFT
        // (FBA cron has been functionally dormant). First post-migration
        // cron run will create separate AMAZON-EU-FBA StockLevel rows.
        const buyables = await tx.product.findMany({
          where: { isParent: false, totalStock: { gt: 0 } },
          select: { id: true, sku: true, totalStock: true },
        })
        console.log(`[backfill] buyable products to seed: ${buyables.length}`)

        let seeded = 0
        let skipped = 0
        for (const p of buyables) {
          const existing = await tx.stockLevel.findFirst({
            where: {
              productId: p.id,
              locationId: riccione.id,
              variationId: null,
            },
          })
          if (existing) {
            skipped++
            continue
          }
          await tx.stockLevel.create({
            data: {
              locationId: riccione.id,
              productId: p.id,
              variationId: null,
              quantity: p.totalStock,
              reserved: 0,
              available: p.totalStock,
              syncStatus: 'SYNCED',
            },
          })
          await tx.stockMovement.create({
            data: {
              productId: p.id,
              warehouseId: 'wh_default_it',
              locationId: riccione.id,
              change: p.totalStock,
              balanceAfter: p.totalStock,
              quantityBefore: 0,
              reason: 'STOCKLEVEL_BACKFILL',
              referenceType: 'STOCKLEVEL_BACKFILL',
              notes: `Initial StockLevel seeded from Product.totalStock for ${p.sku} during multi-location migration.`,
              actor: ACTOR,
            },
          })
          seeded++
        }
        console.log(
          `[backfill] StockLevel seeded=${seeded} skipped=${skipped}`,
        )

        // ── 4. Recompute Product.totalStock = SUM(StockLevel.quantity)
        // No-op for buyables we just seeded (sum equals original total).
        // Necessary for any buyable with totalStock=0 (sum=0, set=0).
        // Necessary for parents we zeroed (sum=0, already at 0 — safe).
        await tx.$executeRawUnsafe(`
          UPDATE "Product" p
          SET "totalStock" = COALESCE((
            SELECT SUM(sl.quantity)::int
            FROM "StockLevel" sl
            WHERE sl."productId" = p.id
          ), 0)
        `)

        if (DRY_RUN) {
          console.log('[backfill] DRY_RUN — rolling back transaction')
          throw new Error('DRY_RUN_ABORT')
        }
      },
      { timeout: 120000 },
    )
    .catch((e) => {
      if (e?.message === 'DRY_RUN_ABORT') {
        return // expected — re-throw guard handled below
      }
      throw e
    })

  console.log(`[backfill] complete in ${Date.now() - startedAt}ms`)
}

main()
  .catch((e) => {
    console.error('[backfill] failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
