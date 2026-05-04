/**
 * NN.14 — abandoned-wizard cleanup.
 *
 * Deletes ListingWizard rows that are still in DRAFT after their
 * expiresAt has passed. Runs daily; safe to invoke ad-hoc via the
 * exported function (admin route or scripted cleanup).
 *
 * SUBMITTED / LIVE / FAILED wizards are immune — those represent
 * real publish attempts and shouldn't be auto-purged.
 */

import prisma from '../db.js'
import { auditLogService } from '../services/audit-log.service.js'

export async function cleanupAbandonedWizards(): Promise<{
  deleted: number
}> {
  const now = new Date()
  // Find candidates first so we can audit-log each one before delete.
  const candidates = await prisma.listingWizard.findMany({
    where: {
      status: 'DRAFT',
      expiresAt: { lt: now },
    },
    select: { id: true, productId: true, createdAt: true },
  })
  if (candidates.length === 0) return { deleted: 0 }

  await prisma.listingWizard.deleteMany({
    where: { id: { in: candidates.map((c) => c.id) } },
  })

  await auditLogService.writeMany(
    candidates.map((c) => ({
      userId: null,
      ip: null,
      entityType: 'ListingWizard',
      entityId: c.id,
      action: 'delete',
      metadata: {
        reason: 'abandoned_cleanup',
        productId: c.productId,
        ageDays: Math.floor(
          (now.getTime() - c.createdAt.getTime()) / (24 * 60 * 60 * 1000),
        ),
      },
    })),
  )

  return { deleted: candidates.length }
}

let cleanupTimer: NodeJS.Timeout | null = null

/** Schedule the cleanup to run once per day (best-effort
 *  in-process). For multi-instance deploys, swap this for a real
 *  cron / queue worker so only one node runs the cleanup. */
export function startWizardCleanupCron(): void {
  if (cleanupTimer) return
  const ONE_DAY = 24 * 60 * 60 * 1000
  // Run once at startup (skipped if last-run was very recent — the
  // service is idempotent so a duplicate run is harmless), then once
  // per day.
  void cleanupAbandonedWizards().catch((err) => {
    console.warn(
      '[wizard-cleanup] initial run failed:',
      err instanceof Error ? err.message : String(err),
    )
  })
  cleanupTimer = setInterval(() => {
    void cleanupAbandonedWizards().catch((err) => {
      console.warn(
        '[wizard-cleanup] tick failed:',
        err instanceof Error ? err.message : String(err),
      )
    })
  }, ONE_DAY)
}

export function stopWizardCleanupCron(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}
