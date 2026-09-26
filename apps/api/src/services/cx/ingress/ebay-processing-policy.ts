import type { Prisma } from '@prisma/client'
import { tokenServiceEnabled } from '../token.service.js'

/** Deploy everywhere with processing off; retire old workers before activation. */
export const ebayInboundProcessingEnabled = () => process.env.NEXUS_ENABLE_EBAY_INBOUND_PROCESSING === '1'
export const ebayInboundProcessingReady = () => ebayInboundProcessingEnabled() && tokenServiceEnabled()

/** Only pristine receipts admitted by this protocol can be activated automatically. */
export function heldEbayInboundWhere(): Prisma.WebhookEventWhereInput {
  return {
    channel: 'EBAY', signatureOk: true, verifiedBy: 'ebay_ecdsa', archivedAt: null,
    status: 'pending', attempts: 0, isProcessed: false, processedAt: null,
    nextAttemptAt: null, leaseToken: null, leaseUntil: null, processingToken: null, processingUntil: null, connectionId: { not: null },
    OR: [{ externalId: { startsWith: 'ebay:production:' } }, { externalId: { startsWith: 'ebay:sandbox:' } }],
    NOT: { externalId: { in: ['ebay:production:', 'ebay:sandbox:'] } },
  }
}
