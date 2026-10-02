/**
 * MCP full control P3 — the audit log reads moved from audit-log.routes.ts and settings-audit.routes.ts into
 * audit-search.service.ts. GET /api/audit-log/search, GET /api/audit-log/:id, GET /api/settings/audit and
 * GET /api/settings/audit/keys answer byte for byte what they answered before (goldens recorded on the routes as they
 * were), with business profiles off and on.
 */
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})

import { expectGolden, freezeGoldenClock, goldenApp, GOLDEN_NOW, inGoldenBusiness } from '../../test-support/route-golden.js'
import auditLogRoutes from '../../routes/audit-log.routes.js'
import settingsAuditRoutes from '../../routes/settings-audit.routes.js'

const GOLDEN = './__golden__'
const DAY = 24 * 60 * 60_000
const at = (minutesAgo: number) => new Date(GOLDEN_NOW.getTime() - minutesAgo * 60_000)

/** id, entityType, entityId, action, userId, minutes ago — distinct counts per type and action keep the facet order fixed. */
const ROWS: Array<[string, string, string, string, string | null, number]> = [
  ['golden-audit-01', 'Product', 'golden-product-1', 'update', 'golden-user-a', 10],
  ['golden-audit-02', 'Product', 'golden-product-2', 'update', 'golden-user-b', 20],
  ['golden-audit-03', 'Product', 'golden-product-1', 'create', 'golden-user-a', 30],
  ['golden-audit-04', 'Product', 'golden-product-3', 'update', null, 40],
  ['golden-audit-05', 'ChannelListing', 'golden-listing-1', 'update', 'golden-user-a', 50],
  ['golden-audit-06', 'ChannelListing', 'golden-listing-2', 'create', 'golden-user-b', 60],
  ['golden-audit-07', 'ChannelListing', 'golden-listing-1', 'update', 'golden-user-b', 70],
  ['golden-audit-08', 'ListingWizard', 'golden-wizard-1', 'submit', 'golden-user-a', 80],
  ['golden-audit-old', 'Product', 'golden-product-1', 'create', 'golden-user-a', 40 * 24 * 60],
]

/** Settings rows: id, key, action, minutes ago. */
const SETTINGS: Array<[string, string, string, number]> = [
  ['golden-settings-1', 'company', 'update', 5],
  ['golden-settings-2', 'account', 'update', 15],
  ['golden-settings-3', 'company', 'update', 25],
  ['golden-settings-4', 'profile', 'update', 35],
  ['golden-settings-5', 'notifications', 'create', 45],
  ['golden-settings-old', 'company', 'update', 35 * 24 * 60],
]

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  await inGoldenBusiness(async () => {
    for (const [id, entityType, entityId, action, userId, minutes] of ROWS) {
      await db.auditLog.create({
        data: {
          id, entityType, entityId, action, userId, ip: '192.0.2.10',
          before: { name: `before ${id}`, costPrice: 4.2 }, after: { name: `after ${id}`, costPrice: 4.5 },
          metadata: { source: 'golden' }, createdAt: at(minutes),
        },
      })
    }
    for (const [id, key, action, minutes] of SETTINGS) {
      await db.auditLog.create({
        data: { id, entityType: 'Settings', entityId: key, action, userId: 'golden-user-a', before: { field: `old ${id}` }, after: { field: `new ${id}` }, metadata: null, createdAt: at(minutes) },
      })
    }
  })
  app = await goldenApp([
    { plugin: auditLogRoutes, prefix: '/api' },
    { plugin: settingsAuditRoutes, prefix: '/api' },
  ])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P3 — audit search: the routes answer exactly as before', () => {
  it('GET /api/audit-log/search, unfiltered and with every filter', async () => {
    const since = encodeURIComponent(at(65).toISOString())
    const until = encodeURIComponent(at(15).toISOString())
    const old = encodeURIComponent(new Date(GOLDEN_NOW.getTime() - 60 * DAY).toISOString())
    await expectGolden(app, 'audit-search', '/api/audit-log/search', GOLDEN)
    await expectGolden(app, 'audit-search-type', '/api/audit-log/search?entityType=Product', GOLDEN)
    await expectGolden(app, 'audit-search-entity', '/api/audit-log/search?entityId=golden-product-1&entityIds=golden-listing-1', GOLDEN)
    await expectGolden(app, 'audit-search-entities', '/api/audit-log/search?entityIds=golden-listing-1,%20golden-product-2,', GOLDEN)
    await expectGolden(app, 'audit-search-user-action', '/api/audit-log/search?userId=golden-user-b&action=update', GOLDEN)
    await expectGolden(app, 'audit-search-text', '/api/audit-log/search?search=CHANNEL', GOLDEN)
    await expectGolden(app, 'audit-search-window', `/api/audit-log/search?since=${since}&until=${until}`, GOLDEN)
    await expectGolden(app, 'audit-search-old-facets', `/api/audit-log/search?since=${old}&limit=1`, GOLDEN)
    await expectGolden(app, 'audit-search-page-1', '/api/audit-log/search?limit=3', GOLDEN)
    await expectGolden(app, 'audit-search-page-2', '/api/audit-log/search?limit=3&cursor=golden-audit-03', GOLDEN)
    await expectGolden(app, 'audit-search-limit-bounds', '/api/audit-log/search?limit=0', GOLDEN)
  })

  it('GET /api/audit-log/:id, found and not found', async () => {
    await expectGolden(app, 'audit-entry', '/api/audit-log/golden-audit-05', GOLDEN)
    await expectGolden(app, 'audit-entry-missing', '/api/audit-log/golden-audit-none', GOLDEN)
  })

  it('GET /api/settings/audit, unfiltered and filtered', async () => {
    const since = encodeURIComponent(at(40).toISOString())
    const until = encodeURIComponent(at(10).toISOString())
    await expectGolden(app, 'settings-audit', '/api/settings/audit', GOLDEN)
    await expectGolden(app, 'settings-audit-key', '/api/settings/audit?key=company', GOLDEN)
    await expectGolden(app, 'settings-audit-keys-list', '/api/settings/audit?key=account,%20profile', GOLDEN)
    await expectGolden(app, 'settings-audit-key-all', '/api/settings/audit?key=all&action=update', GOLDEN)
    await expectGolden(app, 'settings-audit-window', `/api/settings/audit?since=${since}&until=${until}`, GOLDEN)
    await expectGolden(app, 'settings-audit-bad-dates', '/api/settings/audit?since=nope&until=nope', GOLDEN)
    await expectGolden(app, 'settings-audit-page', '/api/settings/audit?limit=2&offset=1', GOLDEN)
  })

  it('GET /api/settings/audit/keys', async () => {
    await expectGolden(app, 'settings-audit-key-counts', '/api/settings/audit/keys', GOLDEN)
  })
})
