/**
 * P0.5 (docs/channel-connections/FINAL-PLAN.md) — our app secrets' expiry dates: record them, read
 * them (never a secret), and alert at 90 / 30 / 7 days and on expiry, each level once per date.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const apps: Array<Record<string, any>> = []
  const events: Array<Record<string, any>> = []
  const matchesDetail = (event: Record<string, any>, clauses: Array<{ detail: { path: string[]; equals: unknown } }>) =>
    clauses.every((c) => event.detail?.[c.detail.path[0]] === c.detail.equals)
  return {
    apps,
    events,
    createAlert: vi.fn(async () => ({})),
    selects: [] as unknown[],
    prisma: {
      channelApp: {
        findMany: vi.fn(async (args: { where?: { secretExpiresAt?: unknown }; select?: unknown }) => {
          h.selects.push(args.select)
          return apps.filter((a) => !args.where?.secretExpiresAt || a.secretExpiresAt)
        }),
        findUnique: vi.fn(async ({ where }: any) =>
          apps.find((a) => a.channelKey === where.channelKey_environment.channelKey && a.environment === where.channelKey_environment.environment) ?? null),
        update: vi.fn(async ({ where, data }: any) => {
          const row = apps.find((a) => a.channelKey === where.channelKey_environment.channelKey && a.environment === where.channelKey_environment.environment)!
          Object.assign(row, data)
          return row
        }),
      },
      connectionEvent: {
        create: vi.fn(async ({ data }: any) => { events.push(data); return data }),
        findFirst: vi.fn(async ({ where }: any) =>
          events.find((e) => e.channelKey === where.channelKey && e.type === where.type && matchesDetail(e, where.AND ?? [])) ?? null),
      },
    },
  }
})
vi.mock('../db.js', () => ({ default: h.prisma }))
vi.mock('../services/monitoring/alert.service.js', () => ({
  alertService: { createAlert: h.createAlert },
  AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' },
}))
vi.mock('../jobs/cx-heartbeat.job.js', () => ({ runHeartbeatFor: vi.fn() }))
vi.mock('../services/cx/token.service.js', () => ({
  refreshNow: vi.fn(), revoke: vi.fn(), RefreshFailed: class extends Error {}, RefreshContended: class extends Error {},
}))

import { FEATURES as F } from '@nexus/shared/permissions'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { appSecretAlertLevel, runAppSecretExpiryAlerts } from '../services/cx/app-secret-expiry.js'
import cxConnectionsRoutes, { parseExpiryDate } from './cx-connections.routes.js'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 19, 12) // 2026-09-19 12:00 UTC
let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  app.addHook('onRequest', async (request) => { (request as any).authUser = { id: 'owner-1' } })
  await app.register(cxConnectionsRoutes, { prefix: '/api' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  h.apps.length = 0
  h.events.length = 0
  h.selects.length = 0
  h.createAlert.mockClear()
  h.apps.push(
    { id: 'app-sp', channelKey: 'AMAZON_SP', environment: 'production', clientId: 'amzn1.app', clientSecretEnc: 'v2:SECRET', signingKeyEnc: null, secretExpiresAt: null, rotatedAt: null },
    { id: 'app-ebay', channelKey: 'EBAY', environment: 'production', clientId: 'ebay-app', clientSecretEnc: 'v2:SECRET2', signingKeyEnc: 'v2:KEY', secretExpiresAt: null, rotatedAt: null },
  )
})

describe('P0.5 — the date rules', () => {
  it.each([
    ['2027-03-18', '2027-03-18T00:00:00.000Z'],
    ['2026-09-01', '2026-09-01T00:00:00.000Z'], // already passed: allowed, it records an expired secret
  ])('accepts %s', (input, iso) => {
    expect(parseExpiryDate(input, NOW)).toEqual({ date: new Date(iso) })
  })
  it('accepts null (clear the date)', () => { expect(parseExpiryDate(null, NOW)).toEqual({ date: null }) })
  it.each([['2027-02-30'], ['18/03/2027'], ['2031-01-01'], ['2019-12-31'], [20270318], ['']])('refuses %s', (input) => {
    expect(parseExpiryDate(input, NOW)).toHaveProperty('error')
  })
  it.each([
    [200, null], [91, null], [90, 90], [31, 90], [30, 30], [8, 30], [7, 7], [0, 7], [-1, 0],
  ])('%i days left → alert level %s', (daysLeft, level) => {
    expect(appSecretAlertLevel(daysLeft)).toBe(level)
  })
})

describe('P0.5 — the routes', () => {
  it('are mapped to the Channels page permission', () => {
    expect(permissionForRoute('GET', '/api/cx/apps')).toBe(F.settingsIntegrationsManage)
    expect(permissionForRoute('PUT', '/api/cx/apps/AMAZON_SP/secret-expiry')).toBe(F.settingsIntegrationsManage)
  })
  it('GET lists every app with its date and never a secret column', async () => {
    h.apps[0].secretExpiresAt = new Date(Date.now() + 45 * DAY + 3_600_000)
    const response = await app.inject('/api/cx/apps')
    expect(response.statusCode).toBe(200)
    const { apps } = response.json()
    expect(apps).toHaveLength(2)
    expect(apps[0]).toEqual({
      channelKey: 'AMAZON_SP', label: 'Amazon SP-API', environment: 'production',
      secretExpiresAt: h.apps[0].secretExpiresAt.toISOString(), daysLeft: 45, rotatedAt: null, automaticRotation: false,
    })
    expect(apps[1]).toMatchObject({ channelKey: 'EBAY', secretExpiresAt: null, daysLeft: null })
    expect(JSON.stringify(response.json())).not.toMatch(/SECRET|KEY|amzn1|ebay-app/)
    expect(h.selects[0]).toEqual({ channelKey: true, environment: true, secretExpiresAt: true, rotatedAt: true })
  })
  it('PUT records the date, logs who set it (from → to), and answers with the new state', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/cx/apps/amazon_sp/secret-expiry', payload: { expiresAt: '2027-03-18' } })
    expect(response.statusCode).toBe(200)
    expect(h.apps[0].secretExpiresAt).toEqual(new Date('2027-03-18T00:00:00.000Z'))
    expect(response.json().app).toMatchObject({ channelKey: 'AMAZON_SP', secretExpiresAt: '2027-03-18T00:00:00.000Z' })
    expect(h.events).toEqual([expect.objectContaining({
      channelKey: 'AMAZON_SP', type: 'app_secret_expiry_set', actorUserId: 'owner-1',
      detail: expect.objectContaining({ environment: 'production', from: null, to: '2027-03-18T00:00:00.000Z', actorKind: 'operator' }),
    })])
  })
  it('PUT with null clears the date', async () => {
    h.apps[0].secretExpiresAt = new Date('2027-03-18T00:00:00.000Z')
    const response = await app.inject({ method: 'PUT', url: '/api/cx/apps/AMAZON_SP/secret-expiry', payload: { expiresAt: null } })
    expect(response.statusCode).toBe(200)
    expect(h.apps[0].secretExpiresAt).toBeNull()
  })
  it.each([
    [{ expiresAt: '2027-02-30' }, 400],
    [{}, 400],
    [{ expiresAt: '2027-03-18', environment: 'staging' }, 400],
  ])('PUT %j answers %i and changes nothing', async (payload, status) => {
    const response = await app.inject({ method: 'PUT', url: '/api/cx/apps/AMAZON_SP/secret-expiry', payload })
    expect(response.statusCode).toBe(status)
    expect(h.apps[0].secretExpiresAt).toBeNull()
    expect(h.events).toHaveLength(0)
  })
  it('PUT for an app that is not set up answers 404', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/cx/apps/SHOPIFY/secret-expiry', payload: { expiresAt: '2027-03-18' } })
    expect(response.statusCode).toBe(404)
    expect(h.events).toHaveLength(0)
  })
})

describe('P0.5 — the alerts', () => {
  const titles = () => (h.createAlert.mock.calls as unknown as Array<[string, string]>).map((c) => c[1])
  const expireIn = (days: number) => { h.apps[0].secretExpiresAt = new Date(NOW + days * DAY + 3_600_000) }

  it('nothing to say with more than 90 days left, or with no date', async () => {
    expireIn(120)
    expect(await runAppSecretExpiryAlerts(NOW)).toBe(0)
    expect(h.createAlert).not.toHaveBeenCalled()
  })
  it('20 days left raises the 30-day level once; the next sweeps raise nothing', async () => {
    expireIn(20)
    expect(await runAppSecretExpiryAlerts(NOW)).toBe(1)
    expect(await runAppSecretExpiryAlerts(NOW + 15 * 60_000)).toBe(0)
    expect(await runAppSecretExpiryAlerts(NOW + DAY)).toBe(0)
    expect(titles()).toEqual(['Amazon SP-API app secret expires in 20 days (2026-10-09)'])
    expect(h.createAlert.mock.calls[0]).toEqual(['CONNECTION_HEALTH', expect.any(String), expect.stringContaining('every Amazon call stops'), 1, ['app-sp']])
  })
  it('walks 90 → 30 → 7 → expired, one alert per level', async () => {
    expireIn(95)
    const raised = []
    for (const day of [0, 5, 10, 64, 65, 80, 88, 89, 95, 96, 97]) raised.push(await runAppSecretExpiryAlerts(NOW + day * DAY))
    expect(raised.reduce((a, b) => a + b, 0)).toBe(4)
    expect(titles()).toEqual([
      'Amazon SP-API app secret expires in 90 days (2026-12-23)',
      'Amazon SP-API app secret expires in 30 days (2026-12-23)',
      'Amazon SP-API app secret expires in 7 days (2026-12-23)',
      'Amazon SP-API app secret expired on 2026-12-23',
    ])
  })
  it('a new recorded date starts the levels again', async () => {
    expireIn(20)
    await runAppSecretExpiryAlerts(NOW)
    expireIn(25)
    expect(await runAppSecretExpiryAlerts(NOW)).toBe(1)
  })
})
