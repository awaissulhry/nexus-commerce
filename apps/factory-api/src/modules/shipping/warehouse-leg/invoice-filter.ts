import type { Prisma } from '@nexus/factory-db'

/**
 * What deferred invoicing and the invoice candidates may bill (owb- order workflow, S3 ss1 step 1.3; settle L5): never the TRANSFER
 * DDT of goods sent to our own warehouse (the goods stay ours: nothing is sold), and nothing of a shipment whose leg through our
 * warehouse was not sent on yet — the sale DDT of Send on bills the goods once they went on to the customer. A shipment straight to
 * the customer (no leg) is billed as before. One Prisma fragment, added to modules/invoicing/from-shipment/{queue,deferred,candidates}.ts.
 */
export const BILLABLE_DDT: Prisma.DdtWhereInput = {
  reason: { not: 'TRANSFER' },
  shipment: { OR: [{ warehouseLeg: { is: null } }, { warehouseLeg: { is: { forwardedAt: { not: null } } } }] },
}
