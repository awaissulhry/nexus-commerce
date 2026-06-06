/**
 * PB.16 — Image-publish audit log helper.
 *
 * Writes append-only rows to the existing AuditLog table on every
 * image-publish action so the operator + future GDPR / SOC2 review
 * can answer "who pushed image X to Amazon IT at 14:32?"
 *
 * Best-effort: an AuditLog write failure must NEVER block the publish
 * itself. We swallow errors here and log to the logger so the operator
 * sees nothing in the success path.
 *
 * Action vocabulary (kept narrow so the FE filter chip works):
 *   imagePublishStarted   route received + dispatched to publish service
 *   imagePublishCompleted publish service returned success
 *   imagePublishFailed    publish service returned failure / threw
 *   imagePublishScheduled scheduled publish row created
 *   imagePublishBulk      bulk publish loop entry (one row per product)
 */

import prisma from '../db.js'
import { logger } from './logger.js'

export type ImagePublishAction =
  | 'imagePublishStarted'
  | 'imagePublishCompleted'
  | 'imagePublishFailed'
  | 'imagePublishScheduled'
  | 'imagePublishBulk'
  | 'imagesAdopted'
  | 'imagesMirrored'

export interface ImagePublishAuditInput {
  productId: string
  action: ImagePublishAction
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'
  marketplace?: string | null
  /** Operator id, when known. Routes today don't carry auth so we
   *  pass null; cron writes also use null. */
  userId?: string | null
  metadata?: Record<string, unknown>
}

export async function recordImagePublishAudit(input: ImagePublishAuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: input.userId ?? null,
        entityType: 'Product',
        entityId: input.productId,
        action: input.action,
        metadata: {
          channel: input.channel,
          marketplace: input.marketplace ?? null,
          ...(input.metadata ?? {}),
        } as object,
      },
    })
  } catch (err) {
    // Audit write is best-effort. Never block the publish path.
    logger.warn('image-publish-audit: write failed', {
      err: err instanceof Error ? err.message : String(err),
      action: input.action,
      productId: input.productId,
    })
  }
}
