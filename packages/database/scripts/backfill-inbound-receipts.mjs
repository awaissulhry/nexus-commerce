#!/usr/bin/env node
// H.0b backfill — synthesize one InboundReceipt event per existing
// InboundShipmentItem with quantityReceived > 0, so the audit trail
// is complete from the start of the event-log era.
//
// Production state: 1 InboundShipmentItem with quantityReceived=0.
// Backfill is a no-op as expected. Re-runnable safely as new data lands.

import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '..', '..', '.env') })

const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')
const BACKFILL_NOTE = 'H.0b backfill: synthetic event from pre-event-log quantityReceived'

async function main() {
  console.log(`[backfill-inbound-receipts] starting (DRY_RUN=${DRY_RUN})`)

  const candidates = await prisma.inboundShipmentItem.findMany({
    where: { quantityReceived: { gt: 0 } },
    select: {
      id: true,
      quantityReceived: true,
      qcStatus: true,
      qcNotes: true,
      receipts: { select: { id: true }, take: 1 },
    },
  })
  let backfilled = 0
  let skipped = 0
  for (const it of candidates) {
    if (it.receipts.length > 0) { skipped++; continue }
    if (!DRY_RUN) {
      await prisma.inboundReceipt.create({
        data: {
          inboundShipmentItemId: it.id,
          quantity: it.quantityReceived,
          qcStatus: it.qcStatus,
          qcNotes: it.qcNotes,
          notes: BACKFILL_NOTE,
          receivedBy: 'system:h0b-backfill',
        },
      })
    }
    backfilled++
  }
  console.log(`[backfill-inbound-receipts] backfilled=${backfilled} skipped=${skipped}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
