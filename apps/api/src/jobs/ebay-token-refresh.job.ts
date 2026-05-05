/**
 * Proactive eBay access-token refresh cron.
 *
 * eBay user access tokens last 2 hours; refresh tokens last ~18 months
 * (eBay rotates per-grant). The reactive `EbayAuthService.getValidToken`
 * already refreshes if a sync hits an expiring token, but if no sync runs
 * for 2+ hours the token expires silently and the next sync fails the
 * first time before recovering on retry. Worse, our audit on 2026-05-06
 * showed every active connection's `ebayTokenExpiresAt` had drifted into
 * the past — meaning the only working channel was a re-auth away from
 * silent breakage.
 *
 * This cron walks every active ChannelConnection that has a refresh
 * token, calls `getValidToken` (which is a no-op if the access token
 * has > 5 min remaining), and logs the result. With the default
 * schedule (every 30 min), no token is ever served stale.
 *
 * Default-ON. Set NEXUS_ENABLE_EBAY_TOKEN_REFRESH_CRON=0 to opt out
 * (the wiring lives in apps/api/src/index.ts where the cron starts).
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { ebayAuthService } from '../services/ebay-auth.service.js'
import { logger } from '../utils/logger.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

async function runRefreshSweep(): Promise<void> {
  const startedAt = Date.now()

  let connections: Array<{ id: string; ebaySignInName: string | null }>
  try {
    connections = await prisma.channelConnection.findMany({
      where: {
        isActive: true,
        ebayRefreshToken: { not: null },
      },
      select: { id: true, ebaySignInName: true },
    })
  } catch (err) {
    logger.error('ebay-token-refresh cron: query failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (connections.length === 0) {
    logger.debug('ebay-token-refresh cron: no active eBay connections')
    return
  }

  let refreshed = 0
  let stillValid = 0
  let failed = 0

  for (const conn of connections) {
    try {
      // Read once before, once after — if expiresAt advanced, a refresh happened.
      const before = await prisma.channelConnection.findUnique({
        where: { id: conn.id },
        select: { ebayTokenExpiresAt: true },
      })

      await ebayAuthService.getValidToken(conn.id)

      const after = await prisma.channelConnection.findUnique({
        where: { id: conn.id },
        select: { ebayTokenExpiresAt: true },
      })

      const advanced =
        before?.ebayTokenExpiresAt &&
        after?.ebayTokenExpiresAt &&
        after.ebayTokenExpiresAt.getTime() > before.ebayTokenExpiresAt.getTime()

      if (advanced) {
        refreshed++
      } else {
        stillValid++
      }
    } catch (err) {
      failed++
      logger.warn('ebay-token-refresh cron: refresh failed for connection', {
        connectionId: conn.id,
        signInName: conn.ebaySignInName ?? null,
        error: err instanceof Error ? err.message : String(err),
      })
      // getValidToken already wrote lastSyncStatus/lastSyncError to the
      // connection — surfaces in the channels UI.
    }
  }

  logger.info('ebay-token-refresh cron: complete', {
    durationMs: Date.now() - startedAt,
    connections: connections.length,
    refreshed,
    stillValid,
    failed,
  })
}

export function startEbayTokenRefreshCron(): void {
  if (scheduledTask) {
    logger.warn('ebay-token-refresh cron already started — skipping')
    return
  }

  // Default every 30 min. eBay tokens last 2 hours, the reactive
  // refresh kicks in within 5 min of expiry — so a 30-min sweep
  // gives 4 attempts per token lifetime, plenty of headroom for
  // transient eBay 5xx.
  const schedule = process.env.NEXUS_EBAY_TOKEN_REFRESH_SCHEDULE ?? '*/30 * * * *'

  if (!cron.validate(schedule)) {
    logger.error('ebay-token-refresh cron: invalid schedule expression', { schedule })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void runRefreshSweep()
  })

  logger.info('ebay-token-refresh cron: scheduled', { schedule })
}

export function stopEbayTokenRefreshCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export { runRefreshSweep }
