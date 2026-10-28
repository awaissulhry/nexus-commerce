import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { createCatalogue } from '@nexus/factory-domain/events/catalogue'
import { defineEvent } from '@nexus/factory-domain/events/define'
import type { LiveMessage } from '@nexus/factory-domain/events/envelope'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { defineManifest, defineRoutes } from '../../core/manifest'
import { liveChannel, LiveFeed, publishLive, serveLiveStream, useLiveFeed } from '../../core/sse'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { openEventStream, testRedis, type TestRedis } from './testing'

/**
 * GET /live on the local Redis (no database: the stream reads only the session and the feed). Live messages are
 * published straight on the tenant channels, also tampered ones, to prove what the API lets through per viewer:
 * only the viewer's tenant, only what its grants reach, the floor only its site's floor events, never a money field.
 */

const tenantA = newId()
const tenantB = newId()
const companyA = newId()
const otherCompany = newId()
const plant = newId()
const otherPlant = newId()
const user = newId()

const siteRenamed = defineEvent({
  type: 'site.renamed',
  context: 'sites',
  description: 'test',
  payload: z.strictObject({ name: z.string() }),
  live: { permission: 'sites.read', floor: true, fields: ['name'] },
})
const quotePriced = defineEvent({
  type: 'quote.priced',
  context: 'sales',
  description: 'test',
  payload: z.strictObject({ quoteId: z.string(), totalMinor: z.number() }),
  live: { permission: 'sites.read', floor: true, fields: ['quoteId'] },
})
const officeOnly = defineEvent({ type: 'quote.sent', context: 'sales', description: 'test', payload: z.strictObject({}), live: { permission: 'sites.read' } })
const CATALOGUE = createCatalogue([siteRenamed, quotePriced, officeOnly])

const grant = (companies: Grant['companies'] = 'all'): Grant => ({ permissions: ['sites.read'], companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  'office-a': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant()] },
  'office-a-other-company': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant([otherCompany])] },
  'office-b': { audience: 'office', tenantId: tenantB, actorId: user, grants: [grant()] },
  'floor-a': { audience: 'floor', tenantId: tenantA, actorId: user, siteId: plant, deviceId: newId(), grants: [grant()] },
  'floor-a-other-site': { audience: 'floor', tenantId: tenantA, actorId: user, siteId: otherPlant, deviceId: newId(), grants: [grant()] },
  partner: { audience: 'partner', tenantId: tenantA, actorId: user, partyId: newId(), grants: [grant()] },
}

let redis: TestRedis
let publisher: Redis
let feed: LiveFeed
let app: FastifyInstance
let base: string

const message = (tenantId: string, type: string, fields: Record<string, unknown>, scope: Partial<LiveMessage> = {}): LiveMessage => ({
  tenantId,
  eventId: newId(),
  type,
  version: 1,
  subject: 'subject',
  companyId: companyA,
  siteId: plant,
  occurredAt: '2026-10-28T09:00:00.000Z',
  fields,
  ...scope,
})

const testManifest = defineManifest({ 'GET /test-live': { audiences: ['office', 'floor'], permission: 'signed-in', scope: 'tenant' } })

beforeAll(async () => {
  redis = testRedis()
  publisher = redis.connect()
  feed = new LiveFeed({ connect: () => redis.connect(), prefix: redis.prefix })
  useLiveFeed(feed)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      // The same stream with a fast heartbeat and the test catalogue.
      routes: [defineRoutes('test-live', testManifest, async (routes) => {
        const open = new Set<() => void>()
        routes.addHook('preClose', async () => {
          for (const close of [...open]) close()
        })
        routes.get('/test-live', async (request, reply) =>
          serveLiveStream(request, reply, { feed, catalogue: CATALOGUE, heartbeatMs: 50, track: (close) => (open.add(close), () => open.delete(close)) }),
        )
      })],
    },
  )
  base = await app.listen({ host: '127.0.0.1', port: 0 })
}, 30_000)

afterAll(async () => {
  await app?.close()
  useLiveFeed(undefined)
  await feed?.close()
  await redis?.cleanup()
})

async function open(session: string, path = '/test-live') {
  const { status, stream } = await openEventStream(`${base}${path}`, { 'x-test-session': session })
  expect(status).toBe(200)
  await stream.next((event) => event.event === 'ready')
  return stream
}

describe('GET /live', () => {
  it('needs an office or floor session', async () => {
    expect((await app.inject({ method: 'GET', url: '/live' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/live', headers: { 'x-test-session': 'partner' } })).statusCode).toBe(403)
  })

  it('answers an event stream with the stream headers and a heartbeat', async () => {
    const { headers, stream } = await openEventStream(`${base}/test-live`, { 'x-test-session': 'office-a' })
    expect(headers).toMatchObject({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'close',
      'x-content-type-options': 'nosniff',
    })
    await stream.next((event) => event.event === 'ready')
    await new Promise((resolve) => setTimeout(resolve, 180))
    expect(stream.pings()).toBeGreaterThanOrEqual(2)
    await stream.close()
  })

  it('sends each viewer only what it may see: its tenant, its grants, the floor its own site, never money', async () => {
    const names = Object.keys(SESSIONS).filter((name) => name !== 'partner')
    const screens = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await open(name)] as const)))
    try {
      const renamedA = message(tenantA, 'site.renamed', { name: 'North' })
      const pricedA = message(tenantA, 'quote.priced', { quoteId: 'Q-1', totalMinor: 990, unitPrice: '9.900000' })
      const sentA = message(tenantA, 'quote.sent', {})
      const renamedB = message(tenantB, 'site.renamed', { name: 'South' }, { companyId: null, siteId: null })
      const undeclared = message(tenantA, 'quote.unknown', {})
      // A tenant-A message pushed onto tenant B's channel (a bug or tampering): it reaches nobody.
      const misrouted = message(tenantA, 'site.renamed', { name: 'Misrouted' })
      for (const sent of [renamedA, pricedA, sentA, renamedB, undeclared]) await publishLive(publisher, redis.prefix, sent)
      await publisher.publish(liveChannel(redis.prefix, tenantB), JSON.stringify(misrouted))
      await publisher.publish(liveChannel(redis.prefix, tenantA), 'not json')
      // A marker last: once a screen has it, everything before it was delivered or dropped.
      const markers: Record<string, string> = {}
      for (const tenantId of [tenantA, tenantB]) {
        const marker = message(tenantId, 'site.renamed', { name: 'marker' }, { companyId: null, siteId: null })
        markers[tenantId] = marker.eventId
        await publishLive(publisher, redis.prefix, marker)
      }
      const received = async (name: string): Promise<{ id: string; fields: unknown }[]> => {
        const tenant = SESSIONS[name]!.audience === 'office' || SESSIONS[name]!.audience === 'floor' ? (SESSIONS[name] as { tenantId: string }).tenantId : ''
        const screen = screens[name]!
        // The floor never gets the marker (no site): wait a moment instead.
        if (name.startsWith('floor')) await new Promise((resolve) => setTimeout(resolve, 300))
        else await screen.next((event) => (event.data as { eventId?: string }).eventId === markers[tenant])
        return screen.events
          .filter((event) => event.event === 'change' && (event.data as { eventId: string }).eventId !== markers[tenant])
          .map((event) => ({ id: (event.data as { eventId: string }).eventId, fields: (event.data as { fields: unknown }).fields }))
      }
      expect(await received('office-a')).toEqual([
        { id: renamedA.eventId, fields: { name: 'North' } },
        { id: pricedA.eventId, fields: { quoteId: 'Q-1' } },
        { id: sentA.eventId, fields: {} },
      ])
      expect(await received('office-b')).toEqual([{ id: renamedB.eventId, fields: { name: 'South' } }])
      expect(await received('office-a-other-company')).toEqual([])
      expect(await received('floor-a')).toEqual([
        { id: renamedA.eventId, fields: { name: 'North' } },
        { id: pricedA.eventId, fields: { quoteId: 'Q-1' } },
      ])
      expect(await received('floor-a-other-site')).toEqual([])
      for (const screen of Object.values(screens)) {
        expect(JSON.stringify(screen.events)).not.toMatch(/totalMinor|unitPrice|Misrouted|tenantId/)
      }
    } finally {
      await Promise.all(Object.values(screens).map((screen) => screen.close()))
    }
  })

  it('answers 503 when Redis does not answer, instead of hanging the screen', async () => {
    const down = new LiveFeed({ prefix: redis.prefix, readyTimeoutMs: 200, connect: () => new Redis('redis://127.0.0.1:1', { lazyConnect: false, maxRetriesPerRequest: null, retryStrategy: () => null }) })
    const app503 = await buildApp(
      { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
      {
        authenticate: testAuthenticator(() => SESSIONS['office-a']!),
        routes: [defineRoutes('test-live', testManifest, async (routes) => {
          routes.get('/test-live', async (request, reply) => serveLiveStream(request, reply, { feed: down, catalogue: CATALOGUE }))
        })],
      },
    )
    try {
      const response = await app503.inject({ method: 'GET', url: '/test-live' })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({ error: { code: 'not_ready' } })
    } finally {
      await app503.close()
      await down.close()
    }
  })

  it('subscribes a tenant\'s channel while one of its screens is open, and ends open streams when the app closes', async () => {
    const screen = await open('office-b', '/live')
    expect(feed.tenants()).toContain(tenantB)
    await screen.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(feed.tenants()).not.toContain(tenantB)

    const other = await buildApp(
      { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
      { routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator(() => SESSIONS['office-a']!) },
    )
    const address = await other.listen({ host: '127.0.0.1', port: 0 })
    const { stream } = await openEventStream(`${address}/live`)
    await stream.next((event) => event.event === 'ready')
    const begun = Date.now()
    await other.close()
    expect(Date.now() - begun).toBeLessThan(2_000)
    await stream.close()
  })
})
