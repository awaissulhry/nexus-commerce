/**
 * CX.1 — connection administration (settingsIntegrationsManage).
 *
 *   POST /api/cx/connections/:id/refresh   force a leased refresh; returns expiry, never the token
 *   POST /api/cx/connections/:id/revoke    revoke at the channel + null credentials (one disconnect path)
 *   POST /api/cx/connections/:id/heartbeat run the catalogue heartbeat now (Diagnostics "Test")
 *   GET  /api/cx/connections/:id/events    the ledger for this connection
 *   GET  /api/cx/channels                  the catalogue as the UI sees it
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { listChannelSpecs, scopeDriftOf, tryGetChannelSpec, channelKeyOf } from '../services/cx/catalog.js'
import { listConnectionEvents } from '../services/cx/events.service.js'
import { refreshNow, revoke, RefreshFailed, RefreshContended } from '../services/cx/token.service.js'
import { runHeartbeatFor } from '../jobs/cx-heartbeat.job.js'

export default async function cxConnectionsRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: unknown) => ({ kind: 'operator' as const, userId: (request as { authUser?: { id?: string } }).authUser?.id ?? null })

  app.get('/cx/channels', async () => ({
    channels: listChannelSpecs().map((s) => ({
      key: s.key,
      channelType: s.channelType,
      displayName: s.displayName,
      available: s.available,
      authMode: s.auth.mode,
      requiredScopes: s.auth.requiredScopes,
      reviewGatedScopes: s.auth.reviewGatedScopes ?? [],
      regions: s.regions?.map((r) => ({ key: r.key, label: r.label })) ?? [],
      defaultRegion: s.defaultRegion ?? null,
      refreshTokenLifetimeSec: s.auth.refreshTokenLifetimeSec ?? null,
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
}
