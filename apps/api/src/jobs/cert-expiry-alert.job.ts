/**
 * C5.3 — CE / compliance certificate expiry alert cron.
 *
 * Schedule: '40 6 * * *' UTC (daily 06:40, the operator-morning slot, right
 * after the lot-expiry alert at 06:30). Scans ProductCertificate rows whose
 * expiresAt is within NEXUS_CERT_EXPIRY_HORIZON_DAYS (default 90 — matching the
 * compliance rule's 90-day CE warn) OR already expired.
 *
 * Observability-only for now: counts + a top-5 sample go into the cron
 * observability log (so the operator's morning dashboard shows "3 certificates
 * expiring this quarter, 1 expired"). getCertExpiryAlertStatus() exposes the
 * last run for a status surface. The compliance-status endpoint + ComplianceTab
 * badges already flag expiry per-product on demand; this is the proactive sweep.
 *
 * Default-on; opt out via NEXUS_ENABLE_CERT_EXPIRY_ALERT_CRON=0.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: { withinDays: number; total: number; expired: number; expiring: number; productCount: number } | null = null

export async function runCertExpiryAlertOnce(targetWithinDays?: number): Promise<void> {
  if (process.env.NEXUS_ENABLE_CERT_EXPIRY_ALERT_CRON === '0') {
    logger.info('cert-expiry-alert cron: disabled via NEXUS_ENABLE_CERT_EXPIRY_ALERT_CRON=0')
    return
  }
  const horizonRaw = targetWithinDays ?? Number(process.env.NEXUS_CERT_EXPIRY_HORIZON_DAYS ?? '90')
  const horizon = Number.isFinite(horizonRaw) && horizonRaw > 0 ? Math.min(365, Math.floor(horizonRaw)) : 90
  const now = new Date()
  const cutoff = new Date(now.getTime() + horizon * 86400_000)

  try {
    await recordCronRun('cert-expiry-alert', async () => {
      const certs = await prisma.productCertificate.findMany({
        where: { expiresAt: { not: null, lte: cutoff } },
        orderBy: { expiresAt: 'asc' },
        select: {
          id: true, certType: true, certNumber: true, expiresAt: true,
          productId: true,
          product: { select: { sku: true, name: true } },
        },
      })

      const expired = certs.filter((c) => c.expiresAt! < now).length
      const expiring = certs.length - expired
      const productCount = new Set(certs.map((c) => c.productId)).size

      lastRunAt = new Date()
      lastSummary = { withinDays: horizon, total: certs.length, expired, expiring, productCount }

      if (certs.length > 0) {
        logger.info('cert-expiry-alert cron: certificates within horizon', {
          horizonDays: horizon, total: certs.length, expired, expiring, productCount,
          // Top 5 sample so the log isn't spammy when many certs match.
          sample: certs.slice(0, 5).map((c) => ({
            sku: c.product?.sku,
            certType: c.certType,
            certNumber: c.certNumber,
            expiresAt: c.expiresAt?.toISOString(),
            status: c.expiresAt! < now ? 'expired' : 'expiring',
          })),
        })
      } else {
        logger.info('cert-expiry-alert cron: no certificates expiring within horizon', { horizonDays: horizon })
      }
      return `horizon=${horizon}d certs=${certs.length} expired=${expired} expiring=${expiring}`
    })
  } catch (err) {
    logger.error('cert-expiry-alert cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startCertExpiryAlertCron(): void {
  if (scheduledTask) {
    logger.warn('cert-expiry-alert cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_CERT_EXPIRY_ALERT_CRON_SCHEDULE ?? '40 6 * * *'
  if (!cron.validate(schedule)) {
    logger.error('cert-expiry-alert cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => { void runCertExpiryAlertOnce() })
  logger.info('cert-expiry-alert cron: scheduled', { schedule })
}

export function stopCertExpiryAlertCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getCertExpiryAlertStatus() {
  return { scheduled: scheduledTask !== null, lastRunAt, lastSummary }
}
