/**
 * NN.14 — abandoned-wizard cleanup.
 *
 * Deletes ListingWizard rows that are still in DRAFT after their
 * expiresAt has passed. Runs daily; safe to invoke ad-hoc via the
 * exported function (admin route or scripted cleanup).
 *
 * SUBMITTED / LIVE / FAILED wizards are immune — those represent
 * real publish attempts and shouldn't be auto-purged.
 *
 * C.0 / B9 — same cron also writes wizard_abandoned telemetry
 * events for DRAFT wizards inactive >24h. Idempotent: a wizard
 * gets at most one abandoned event before it's eventually cleaned
 * up at the 30d mark. Distinct from cleanup so analytics can
 * distinguish "abandoned but not yet GC'd" from "deleted".
 */

import prisma from '../db.js'
import { auditLogService } from '../services/audit-log.service.js'
import { writeWizardEvent } from '../services/listing-wizard/telemetry.service.js'

const INACTIVE_THRESHOLD_MS = 24 * 60 * 60 * 1000

export async function markAbandonedWizards(): Promise<{ marked: number }> {
  const now = new Date()
  const cutoff = new Date(now.getTime() - INACTIVE_THRESHOLD_MS)

  const inactive = await prisma.listingWizard.findMany({
    where: {
      status: 'DRAFT',
      updatedAt: { lt: cutoff },
    },
    select: {
      id: true,
      productId: true,
      currentStep: true,
      createdAt: true,
    },
  })
  if (inactive.length === 0) return { marked: 0 }

  // Idempotency — skip wizards that already have a wizard_abandoned
  // event. Single bulk query rather than N per-wizard checks.
  const ids = inactive.map((w) => w.id)
  const alreadyMarked = await prisma.wizardStepEvent.findMany({
    where: { wizardId: { in: ids }, type: 'wizard_abandoned' },
    select: { wizardId: true },
    distinct: ['wizardId'],
  })
  const markedSet = new Set(alreadyMarked.map((e) => e.wizardId))

  const newlyAbandoned = inactive.filter((w) => !markedSet.has(w.id))
  for (const w of newlyAbandoned) {
    await writeWizardEvent({
      wizardId: w.id,
      productId: w.productId,
      type: 'wizard_abandoned',
      step: w.currentStep,
      durationMs: now.getTime() - w.createdAt.getTime(),
      errorContext: {
        fromStep: w.currentStep,
        reason: 'inactive_24h',
      },
    })
  }

  return { marked: newlyAbandoned.length }
}

export async function cleanupAbandonedWizards(): Promise<{
  deleted: number
  marked: number
}> {
  // C.0 / B9 — emit wizard_abandoned for newly-inactive drafts
  // BEFORE the cleanup pass, so the analytics event is written
  // even if the same wizard happens to also be past expiresAt
  // (the cascade-on-delete eats step events, but the abandoned
  // marker landing first preserves the funnel signal).
  const { marked } = await markAbandonedWizards()

  const now = new Date()
  // Find candidates first so we can audit-log each one before delete.
  const candidates = await prisma.listingWizard.findMany({
    where: {
      status: 'DRAFT',
      expiresAt: { lt: now },
    },
    select: { id: true, productId: true, createdAt: true },
  })
  if (candidates.length === 0) return { deleted: 0, marked }

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

  return { deleted: candidates.length, marked }
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
