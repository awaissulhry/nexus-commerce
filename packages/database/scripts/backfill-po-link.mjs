#!/usr/bin/env node
// H.0a backfill — link existing InboundShipmentItem rows to their
// corresponding PurchaseOrderItem via sku match within the same PO,
// then recompute PurchaseOrderItem.quantityReceived as SUM(linked
// InboundShipmentItem.quantityReceived) and PO.status based on totals.
//
// Idempotent: derived from current state. Re-runs converge.
//
// Production state at design time: 4 DRAFT POs (262 items), 1 FBA
// InboundShipment (no PO link possible). Backfill is a near-no-op.
//
//   node packages/database/scripts/backfill-po-link.mjs --dry-run
//   node packages/database/scripts/backfill-po-link.mjs

import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '..', '..', '.env') })

const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')

const STATUS_ORDER = { DRAFT: 0, SUBMITTED: 1, CONFIRMED: 2, PARTIAL: 3, RECEIVED: 4, CANCELLED: -1 }

async function main() {
  console.log(`[backfill-po-link] starting (DRY_RUN=${DRY_RUN})`)

  // Step 1: link orphan InboundShipmentItem rows to PurchaseOrderItem
  // via shipment.purchaseOrderId + sku match.
  const orphanItems = await prisma.inboundShipmentItem.findMany({
    where: { purchaseOrderItemId: null },
    select: {
      id: true, sku: true,
      inboundShipment: { select: { purchaseOrderId: true } },
    },
  })
  let linked = 0
  let skipped = 0
  for (const item of orphanItems) {
    const poId = item.inboundShipment.purchaseOrderId
    if (!poId) { skipped++; continue }
    const poi = await prisma.purchaseOrderItem.findFirst({
      where: { purchaseOrderId: poId, sku: item.sku },
      select: { id: true },
    })
    if (!poi) { skipped++; continue }
    if (!DRY_RUN) {
      await prisma.inboundShipmentItem.update({
        where: { id: item.id },
        data: { purchaseOrderItemId: poi.id },
      })
    }
    linked++
  }
  console.log(`[backfill-po-link] InboundShipmentItem linkage: linked=${linked} skipped=${skipped}`)

  // Step 2: recompute PurchaseOrderItem.quantityReceived for every
  // PO line item with at least one linked InboundShipmentItem.
  const groups = await prisma.inboundShipmentItem.groupBy({
    by: ['purchaseOrderItemId'],
    where: { purchaseOrderItemId: { not: null } },
    _sum: { quantityReceived: true },
  })
  let recomputed = 0
  for (const r of groups) {
    if (!r.purchaseOrderItemId) continue
    const expected = r._sum.quantityReceived ?? 0
    const cur = await prisma.purchaseOrderItem.findUnique({
      where: { id: r.purchaseOrderItemId },
      select: { quantityReceived: true },
    })
    if (cur && cur.quantityReceived !== expected) {
      if (!DRY_RUN) {
        await prisma.purchaseOrderItem.update({
          where: { id: r.purchaseOrderItemId },
          data: { quantityReceived: expected },
        })
      }
      recomputed++
    }
  }
  console.log(`[backfill-po-link] PurchaseOrderItem.quantityReceived recomputed: ${recomputed}`)

  // Step 3: transition PO.status for every touched PO. Same no-downgrade
  // rules as the runtime helper.
  const touchedPoIds = new Set()
  for (const r of groups) {
    if (!r.purchaseOrderItemId) continue
    const poi = await prisma.purchaseOrderItem.findUnique({
      where: { id: r.purchaseOrderItemId },
      select: { purchaseOrderId: true },
    })
    if (poi) touchedPoIds.add(poi.purchaseOrderId)
  }
  let transitioned = 0
  for (const poId of touchedPoIds) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: { select: { quantityOrdered: true, quantityReceived: true } } },
    })
    if (!po || po.status === 'CANCELLED') continue
    const totalOrdered = po.items.reduce((a, it) => a + it.quantityOrdered, 0)
    const totalReceived = po.items.reduce((a, it) => a + (it.quantityReceived ?? 0), 0)
    if (totalReceived === 0) continue
    const next = totalReceived >= totalOrdered ? 'RECEIVED' : 'PARTIAL'
    if (STATUS_ORDER[next] <= STATUS_ORDER[po.status]) continue
    if (!DRY_RUN) {
      await prisma.purchaseOrder.update({
        where: { id: po.id },
        data: { status: next, version: { increment: 1 } },
      })
    }
    transitioned++
  }
  console.log(`[backfill-po-link] PurchaseOrder.status transitioned: ${transitioned}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
