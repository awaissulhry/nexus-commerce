/**
 * CX.1 — the connection heartbeat (docs/2026-08-29-cx1-connection-core.md §7).
 *
 * Every 15 minutes, for every live connection:
 *   • run the catalogue's heartbeat call (eBay: identity; Amazon env row:
 *     marketplace participations, which also refreshes ConnectionScope and the
 *     Marketplace participation columns that were stale since June);
 *   • write `lastHeartbeatAt`, feed the authStatus state machine, log latency
 *     to the outbound call ledger;
 *   • proactively refresh access tokens expiring within 2× the interval;
 *   • raise expiry alerts 30 / 7 / 1 days before a refresh token or an app
 *     secret expires;
 *   • sweep expired OAuth sessions and stale refresh leases.
 *
 * Replaces ebay-token-refresh.job.ts (its registry key stays as an alias).
 */

import cron from 'node-cron'
import type { Prisma } from '@prisma/client'
import prisma from '../db.js'
import type { ConnectionRow } from '../services/connection-resolver.service.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import '../services/cx/connectors/index.js'
import { channelKeyOf, getChannelSpec, scopeDriftOf, type ChannelKey } from '../services/cx/catalog.js'
import { recordConnectionEvent, CRON_ACTOR, type Actor } from '../services/cx/events.service.js'
import { getAccessToken, handleOf, transition, type AuthStatus } from '../services/cx/token.service.js'
import { sweepSessions } from '../services/cx/oauth.service.js'
import { alertService, AlertType } from '../services/monitoring/alert.service.js'

const INTERVAL_MIN = 15
const EXPIRY_WARN_DAYS = [30, 7, 1]

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

type Row = ConnectionRow

export interface HeartbeatReport {
  ok: boolean
  connectionId: string
  channelType: string
  latencyMs: number
  authStatus: AuthStatus
  scopeDrift: string[]
  message?: string
  errorClass?: string
}

export async function runHeartbeatFor(row: Row, actor: Actor = CRON_ACTOR): Promise<HeartbeatReport> {
  const key = channelKeyOf(row.channelType)
  if (!key) {
    return { ok: false, connectionId: row.id, channelType: row.channelType, latencyMs: 0, authStatus: row.authStatus as AuthStatus, scopeDrift: [], message: 'no catalogue entry' }
  }
  const spec = getChannelSpec(key)
  const handle = handleOf(row)
  const result = await spec.heartbeat(handle)
  const drift = scopeDriftOf(spec, row.grantedScopes)

  // `=== true`, not truthiness: apps/api compiles WITHOUT strictNullChecks, and
  // truthiness narrowing of a discriminant only exists under it. Equality narrows.
  if (result.ok === true) {
    const data: Prisma.ChannelConnectionUpdateInput = { lastHeartbeatAt: new Date(), consecutiveFailures: 0, lastError: null, lastErrorAt: null }
    if (result.identity && !row.identity) data.identity = result.identity as unknown as Prisma.InputJsonValue
    if (result.scopes?.length) data.grantedScopes = result.scopes
    await prisma.channelConnection.update({ where: { id: row.id }, data })
    await transition(row, 'connected', 'heartbeat ok', actor)
    await recordConnectionEvent({ connectionId: row.id, channelKey: key, type: 'heartbeat_ok', actor, detail: { latencyMs: result.latencyMs } })
    if (spec.discoverScopes) {
      try {
        const scopes = await spec.discoverScopes(handle)
        /**
         * MERGE the metadata, never replace it.
         *
         * Discovery knows what the CHANNEL says about a scope (market, currency,
         * account). It does not know what WE decided about it — the Amazon Ads
         * mode/writesEnabledAt/lastWriteAt a migration or an operator recorded. A
         * replacing upsert silently erased those on the very first heartbeat
         * (measured on prod 2026-08-29, CX.3a). Discovery must not delete what
         * discovery cannot see.
         */
        const existing = new Map(
          (
            await prisma.connectionScope.findMany({
              where: { connectionId: row.id },
              select: { kind: true, externalId: true, metadata: true },
            })
          ).map((e) => [`${e.kind}:${e.externalId}`, (e.metadata ?? {}) as Record<string, unknown>]),
        )
        for (const s of scopes) {
          const merged = { ...(existing.get(`${s.kind}:${s.externalId}`) ?? {}), ...(s.metadata ?? {}) }
          await prisma.connectionScope.upsert({
            where: { connectionId_kind_externalId: { connectionId: row.id, kind: s.kind, externalId: s.externalId } },
            create: { connectionId: row.id, kind: s.kind, externalId: s.externalId, label: s.label ?? null, region: s.region ?? null, isActive: s.isActive ?? true, metadata: merged as Prisma.InputJsonValue },
            update: { label: s.label ?? null, region: s.region ?? null, isActive: s.isActive ?? true, metadata: merged as Prisma.InputJsonValue },
          })
        }
      } catch (err) {
        logger.warn('[cx-heartbeat] scope discovery failed', { connectionId: row.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    const fresh = await prisma.channelConnection.findUnique({ where: { id: row.id }, select: { authStatus: true } })
    return { ok: true, connectionId: row.id, channelType: row.channelType, latencyMs: result.latencyMs, authStatus: (fresh?.authStatus ?? 'connected') as AuthStatus, scopeDrift: drift }
  }

  const failures = row.consecutiveFailures + 1
  await prisma.channelConnection.update({
    where: { id: row.id },
    data: { lastHeartbeatAt: new Date(), consecutiveFailures: failures, lastError: `${result.errorClass}: ${result.message}`.slice(0, 500), lastErrorAt: new Date() },
  })
  await recordConnectionEvent({ connectionId: row.id, channelKey: key, type: 'heartbeat_failed', actor, detail: { errorClass: result.errorClass, status: result.status ?? null, message: result.message, failures } })
  const next: AuthStatus =
    result.errorClass === 'auth_revoked' || result.errorClass === 'auth_expired' ? 'needs_reauth' : failures >= 10 ? 'needs_reauth' : failures >= 3 ? 'degraded' : (row.authStatus as AuthStatus)
  await transition({ ...row, consecutiveFailures: failures }, next, result.message, actor)
  return { ok: false, connectionId: row.id, channelType: row.channelType, latencyMs: result.latencyMs, authStatus: next, scopeDrift: drift, message: result.message, errorClass: result.errorClass }
}

async function expiryAlerts(row: Row): Promise<void> {
  if (!row.refreshTokenExpiresAt) return
  const daysLeft = Math.floor((row.refreshTokenExpiresAt.getTime() - Date.now()) / 86_400_000)
  for (const d of EXPIRY_WARN_DAYS) {
    if (daysLeft !== d) continue
    const key = channelKeyOf(row.channelType) ?? row.channelType
    // Once per day per threshold: skip if an identical event exists in the last 20 h.
    const recent = await prisma.connectionEvent.findFirst({
      where: { connectionId: row.id, type: 'status_change', createdAt: { gt: new Date(Date.now() - 20 * 3_600_000) }, detail: { path: ['expiryWarnDays'], equals: d } },
      select: { id: true },
    })
    if (recent) return
    await recordConnectionEvent({ connectionId: row.id, channelKey: key, type: 'status_change', detail: { expiryWarnDays: d, refreshTokenExpiresAt: row.refreshTokenExpiresAt.toISOString() } })
    await alertService.createAlert(
      AlertType.CONNECTION_HEALTH,
      `${row.channelType} account "${row.displayName ?? row.id}" must be reconnected within ${d} day${d === 1 ? '' : 's'}`,
      `Its refresh token expires on ${row.refreshTokenExpiresAt.toISOString().slice(0, 10)}. Reconnect it in Settings → Channels before then to avoid an outage.`,
      1,
      [row.id],
    )
  }
}

export async function runHeartbeatSweep(): Promise<string> {
  return recordCronRun('cx-heartbeat', async () => {
    const rows = await prisma.channelConnection.findMany({
      where: { managedBy: { in: ['oauth', 'env'] }, authStatus: { notIn: ['disconnected', 'revoked'] }, isActive: true },
    })
    let ok = 0
    let failed = 0
    let refreshed = 0
    for (const row of rows) {
      const key = channelKeyOf(row.channelType)
      if (!key) continue
      // Proactive refresh: anything expiring inside 2 sweeps.
      if (row.managedBy === 'oauth' && row.accessTokenExpiresAt && row.accessTokenExpiresAt.getTime() < Date.now() + 2 * INTERVAL_MIN * 60_000) {
        try {
          await getAccessToken(row.id)
          refreshed++
        } catch (err) {
          logger.warn('[cx-heartbeat] proactive refresh failed', { connectionId: row.id, error: err instanceof Error ? err.message : String(err) })
        }
      }
      const r = await runHeartbeatFor(row)
      if (r.ok) ok++
      else failed++
      await expiryAlerts(row)
    }
    // App-secret expiry (SP-API LWA secrets rotate every 180 days).
    const apps = await prisma.channelApp.findMany({ where: { secretExpiresAt: { not: null } } })
    for (const a of apps) {
      const daysLeft = Math.floor(((a.secretExpiresAt as Date).getTime() - Date.now()) / 86_400_000)
      if (EXPIRY_WARN_DAYS.includes(daysLeft)) {
        await alertService.createAlert(AlertType.CONNECTION_HEALTH, `${a.channelKey} app secret expires in ${daysLeft} day(s)`, 'Rotate the client secret in the channel developer console and update the ChannelApp row.', 1)
      }
    }
    const swept = await sweepSessions()
    await prisma.channelConnection.updateMany({ where: { refreshLeaseUntil: { lt: new Date(Date.now() - 5 * 60_000) } }, data: { refreshLeaseUntil: null, refreshLeaseOwner: null } })
    return `connections=${rows.length} ok=${ok} failed=${failed} refreshed=${refreshed} sessionsSwept=${swept}`
  })
}

export function startCxHeartbeatCron(): void {
  if (scheduledTask) return
  const schedule = process.env.NEXUS_CX_HEARTBEAT_SCHEDULE ?? `*/${INTERVAL_MIN} * * * *`
  if (!cron.validate(schedule)) {
    logger.error('[cx-heartbeat] invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runHeartbeatSweep().catch((err) => logger.error('[cx-heartbeat] sweep failed', { error: err instanceof Error ? err.message : String(err) }))
  })
  logger.info('[cx-heartbeat] cron started', { schedule })
  // First pass shortly after boot so a fresh deploy reports real state within a minute.
  setTimeout(() => void runHeartbeatSweep().catch(() => undefined), 45_000).unref()
}

export type { ChannelKey }
