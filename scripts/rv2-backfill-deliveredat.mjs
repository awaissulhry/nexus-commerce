#!/usr/bin/env node
/**
 * RV.2.3 — Backfill deliveredAt on existing Amazon orders using the FBA
 * 3-business-day heuristic.
 *
 * Why: the production DB has 3361 Amazon orders with status=SHIPPED going
 * back 2 years; SP-API rarely returns OrderStatus=Delivered for FBA, so
 * deliveredAt has never been written. The review-request pipeline schedules
 * off deliveredAt → it has nothing to do until this backfill runs.
 *
 * Strategy:
 *   - Find Amazon FBA orders where:
 *       deliveredAt IS NULL
 *       AND status IN ('SHIPPED', 'PARTIALLY_SHIPPED')
 *       AND shippedAt IS NOT NULL
 *       AND shippedAt + 3 business days <= now
 *   - Write deliveredAt = shippedAt + 3 business days
 *   - Write deliveredAtSource = 'HEURISTIC_FBA_3D'
 *   - Never overwrites existing values; only fills NULLs.
 *
 * Idempotent: re-running is safe (deliveredAt is no longer NULL on filled
 * rows, so they're excluded).
 *
 * Run via:
 *   npm run --workspace=@nexus/api exec -- node ../../scripts/rv2-backfill-deliveredat.mjs
 *
 * Or directly with DATABASE_URL set:
 *   node scripts/rv2-backfill-deliveredat.mjs
 */

import { PrismaClient } from '@prisma/client'

function addBusinessDays(date, days) {
  const out = new Date(date.getTime())
  let added = 0
  while (added < days) {
    out.setDate(out.getDate() + 1)
    const dow = out.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return out
}

async function main() {
  const prisma = new PrismaClient()
  const now = Date.now()
  const threeBusinessDaysAgoApprox = new Date(now - 5 * 24 * 60 * 60 * 1000) // covers worst-case weekend

  // Find candidate orders. We over-fetch slightly (shippedAt at least 5 days
  // ago — guaranteed >= 3 business days) and filter precisely in JS.
  const candidates = await prisma.order.findMany({
    where: {
      channel: 'AMAZON',
      fulfillmentMethod: 'FBA',
      deliveredAt: null,
      status: { in: ['SHIPPED', 'PARTIALLY_SHIPPED'] },
      shippedAt: { not: null, lte: threeBusinessDaysAgoApprox },
    },
    select: { id: true, channelOrderId: true, shippedAt: true, marketplace: true },
    orderBy: { shippedAt: 'asc' },
  })
  console.log(`[rv2-backfill] candidates: ${candidates.length}`)

  let updated = 0
  let stillTooSoon = 0
  const sample = []
  for (const o of candidates) {
    if (!o.shippedAt) continue
    const projected = addBusinessDays(o.shippedAt, 3)
    if (projected.getTime() > now) {
      stillTooSoon++
      continue
    }
    await prisma.order.update({
      where: { id: o.id },
      data: {
        deliveredAt: projected,
        deliveredAtSource: 'HEURISTIC_FBA_3D',
      },
    })
    updated++
    if (sample.length < 5) {
      sample.push({
        id: o.id,
        channelOrderId: o.channelOrderId,
        marketplace: o.marketplace,
        shippedAt: o.shippedAt.toISOString(),
        projectedDeliveredAt: projected.toISOString(),
      })
    }
  }

  console.log(`[rv2-backfill] updated: ${updated}`)
  console.log(`[rv2-backfill] still too soon (skipped): ${stillTooSoon}`)
  if (sample.length > 0) {
    console.log('[rv2-backfill] first 5 samples:')
    for (const s of sample) console.log(JSON.stringify(s))
  }
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('[rv2-backfill] FAILED:', err)
  process.exit(1)
})
