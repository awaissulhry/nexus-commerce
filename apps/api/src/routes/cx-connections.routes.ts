/**
 * CX.1 — connection administration (settingsIntegrationsManage).
 *
 *   POST /api/cx/connections/:id/refresh   force a leased refresh; returns expiry, never the token
 *   POST /api/cx/connections/:id/revoke    revoke at the channel + null credentials (one disconnect path)
 *   POST /api/cx/connections/:id/heartbeat run the catalogue heartbeat now (Diagnostics "Test")
 *   GET  /api/cx/connections/:id/events    the ledger for this connection
 *   GET  /api/cx/channels                  the catalogue as the UI sees it
 *   GET  /api/cx/apps                      P0.5: each app's secret expiry date (never a secret)
 *   PUT  /api/cx/apps/:channelKey/secret-expiry   P0.5: record or clear that date
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { listChannelSpecs, scopeDriftOf, tryGetChannelSpec, channelKeyOf } from '../services/cx/catalog.js'
import { listConnectionEvents } from '../services/cx/events.service.js'
import { refreshNow, revoke, RefreshFailed, RefreshContended } from '../services/cx/token.service.js'
import { runHeartbeatFor } from '../jobs/cx-heartbeat.job.js'
import { listAppSecrets, setAppSecretExpiry } from '../services/cx/app-secret-expiry.js'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const MAX_AHEAD_DAYS = 400

/** A real calendar date `yyyy-mm-dd` (midnight UTC), or a reason it is not one we accept. */
export function parseExpiryDate(value: unknown, now: number = Date.now()): { date: Date | null } | { error: string } {
  if (value === null) return { date: null }
  if (typeof value !== 'string') return { error: 'Send expiresAt as yyyy-mm-dd, or null to clear it.' }
  const m = ISO_DATE.exec(value.trim())
  if (!m) return { error: 'Send expiresAt as yyyy-mm-dd, or null to clear it.' }
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (date.getUTCFullYear() !== Number(m[1]) || date.getUTCMonth() !== Number(m[2]) - 1 || date.getUTCDate() !== Number(m[3])) {
    return { error: `${value} is not a real date.` }
  }
  if (date.getTime() > now + MAX_AHEAD_DAYS * 86_400_000) {
    return { error: `An app secret expiry more than ${MAX_AHEAD_DAYS} days ahead is not plausible (Amazon's secrets last 180 days).` }
  }
  if (date.getUTCFullYear() < 2020) return { error: 'That date is too far in the past.' }
  return { date }
}

export default async function cxConnectionsRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: unknown) => ({ kind: 'operator' as const, userId: (request as { authUser?: { id?: string } }).authUser?.id ?? null })

  app.get('/cx/channels', async () => ({
    channels: listChannelSpecs().map((s) => ({
      key: s.key,
      channelType: s.channelType,
      displayName: s.displayName,
      available: s.available,
      authMode: s.auth.mode,
      connectMode: s.key === 'AMAZON_SP' && process.env.AMAZON_SP_AUTH_MODE === 'self'
        ? 'self_authorization'
        : 'website_oauth',
      permissionModel: s.auth.permissionModel ?? 'oauth_scopes',
      requiredScopes: s.auth.requiredScopes,
      reviewGatedScopes: s.auth.reviewGatedScopes ?? [],
      regions: s.regions?.map((r) => ({ key: r.key, label: r.label })) ?? [],
      defaultRegion: s.defaultRegion ?? null,
      refreshTokenLifetimeSec: s.key === 'AMAZON_SP' && process.env.AMAZON_SP_AUTH_MODE === 'self' ? null : s.auth.refreshTokenLifetimeSec ?? null,
      rotatesRefreshToken: s.auth.rotatesRefreshToken,
      webhooks: s.webhooks,
      sandbox: s.sandbox,
      connectException: s.connectException ?? null,
      apiVersion: s.apiVersion,
    })),
  }))

  app.post<{ Params: { id: string } }>('/cx/connections/:id/refresh', async (request, reply) => {
    try {
      const r = await refreshNow(request.params.id, actorOf(request), true)
      return reply.send({ success: true, ...r, accessTokenExpiresAt: r.accessTokenExpiresAt?.toISOString() ?? null })
    } catch (err) {
      if (err instanceof RefreshFailed) return reply.code(502).send({ success: false, code: err.code, errorClass: err.errorClass, error: err.message })
      if (err instanceof RefreshContended) return reply.code(409).send({ success: false, code: err.code, error: err.message })
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[cx-connections] refresh failed', { id: request.params.id, error: message })
      return reply.code(500).send({ success: false, error: message })
    }
  })

  app.post<{ Params: { id: string } }>('/cx/connections/:id/revoke', async (request, reply) => {
    try {
      const r = await revoke(request.params.id, actorOf(request), 'operator')
      return reply.send({ success: true, ...r })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ success: false, error: message })
    }
  })

  app.post<{ Params: { id: string } }>('/cx/connections/:id/heartbeat', async (request, reply) => {
    const row = await prisma.channelConnection.findUnique({ where: { id: request.params.id } })
    if (!row) return reply.code(404).send({ success: false, error: 'Connection not found' })
    const result = await runHeartbeatFor(row, actorOf(request))
    return reply.send({ success: result.ok, ...result })
  })

  app.get<{ Params: { id: string }; Querystring: { take?: string } }>('/cx/connections/:id/events', async (request, reply) => {
    const row = await prisma.channelConnection.findUnique({
      where: { id: request.params.id },
      select: { id: true, channelType: true, authStatus: true, grantedScopes: true, region: true, identity: true, lastRefreshAt: true, lastHeartbeatAt: true, lastInboundAt: true, lastOutboundAt: true, lastErrorAt: true, lastError: true, consecutiveFailures: true, accessTokenExpiresAt: true, refreshTokenExpiresAt: true },
    })
    if (!row) return reply.code(404).send({ error: 'Connection not found' })
    const key = channelKeyOf(row.channelType)
    const spec = key ? tryGetChannelSpec(key) : null
    const events = await listConnectionEvents(row.id, Math.min(Number(request.query.take ?? 50) || 50, 200))
    const scopes = await prisma.connectionScope.findMany({ where: { connectionId: row.id }, orderBy: { externalId: 'asc' } })
    return {
      connection: { ...row, scopeDrift: spec ? scopeDriftOf(spec, row.grantedScopes) : [] },
      scopes,
      events,
    }
  })

  // ── P0.5 — our app secrets' expiry dates ────────────────────────────────────────────────────
  app.get('/cx/apps', async () => ({ apps: await listAppSecrets() }))

  app.put<{ Params: { channelKey: string }; Body: { expiresAt?: unknown; environment?: unknown } }>(
    '/cx/apps/:channelKey/secret-expiry',
    async (request, reply) => {
      const body = request.body ?? {}
      const environment = body.environment === undefined ? 'production' : body.environment
      if (environment !== 'production' && environment !== 'sandbox') {
        return reply.code(400).send({ error: 'environment must be production or sandbox.' })
      }
      if (!('expiresAt' in body)) return reply.code(400).send({ error: 'Send expiresAt as yyyy-mm-dd, or null to clear it.' })
      const parsed = parseExpiryDate(body.expiresAt)
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error })
      const saved = await setAppSecretExpiry({
        channelKey: request.params.channelKey.toUpperCase(),
        environment,
        expiresAt: parsed.date,
        actor: actorOf(request),
      })
      if (!saved) return reply.code(404).send({ error: `No ${environment} app is set up for ${request.params.channelKey}.` })
      return { app: saved }
    },
  )
}
