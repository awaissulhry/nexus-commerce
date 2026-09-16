import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ $queryRaw: vi.fn(), syncHealthLog: { count: vi.fn() }, outboundSyncQueue: { count: vi.fn() }, workspace: { findMany: vi.fn() } }))
const integrity = vi.hoisted(() => vi.fn())
const uploadMarker = vi.hoisted(() => vi.fn())
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), readFileSync: uploadMarker }))
vi.mock('../db.js', () => ({ default: db }))
vi.mock('../lib/queue.js', () => ({ getRedisRuntimeStatus: vi.fn(() => ({ status: 'ready', configured: true })) }))
vi.mock('../services/advertising/ads-sync-integrity.service.js', () => ({ runSyncIntegrityCheck: integrity }))
import healthRoutes from './health.js'
import { WorkspaceError, workspaceContext } from '../lib/workspace-context.js'

describe('deployment readiness', () => {
  const apps: ReturnType<typeof Fastify>[] = []
  beforeEach(() => {
    vi.clearAllMocks()
    uploadMarker.mockImplementation(() => { throw new Error('No upload marker') })
    db.$queryRaw.mockResolvedValue([{ '?column?': 1 }])
  })
  afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.unstubAllEnvs() })

  async function request() {
    const app = Fastify(); apps.push(app)
    await app.register(healthRoutes, { prefix: '/api' })
    return app.inject({ method: 'GET', url: '/api/health/ready' })
  }

  it('reports the serving build once the database responds, without scanning diagnostics', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', '1234567890abcdef')
    const response = await request()
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({ status: 'healthy', build: '12345678', services: { database: 'connected', api: 'operational' } })
    expect(db.$queryRaw).toHaveBeenCalledOnce()
    expect(db.syncHealthLog.count).not.toHaveBeenCalled()
  })

  it('refuses cutover when the database is unavailable and keeps connection details private', async () => {
    db.$queryRaw.mockRejectedValue(new Error('connection failed: postgresql://private-credential@database'))
    const response = await request()
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'unhealthy', error: 'Database is unavailable' })
    expect(response.body).not.toContain('private-credential')
  })

  it('identifies the uploaded source even when no GitHub-trigger SHA exists', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', '')
    uploadMarker.mockReturnValue('abcdef0123456789abcdef0123456789abcdef01\n')
    expect((await request()).json().build).toBe('abcdef01')
    expect(uploadMarker.mock.calls[0][0].pathname).toMatch(/\/apps\/api\/\.release-sha$/)
  })

  it('does not report a malformed upload marker as a release', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', '1234567890abcdef')
    uploadMarker.mockReturnValue('invalid')
    expect((await request()).json().build).toBe('12345678')
  })
})

// 2026-09-16 — production /api/health had NO alarm block: every count below is profile-scoped, this route
// is PUBLIC and runs with no profile, so the counts threw `workspace_required` and the fail-open catch
// dropped the whole block. The mock refuses a scoped count without a profile, as the real client does.
describe('health alarms with business profiles on', () => {
  const apps: ReturnType<typeof Fastify>[] = []
  afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.unstubAllEnvs() })
  const perProfile = (values: Record<string, number>) => async () => {
    const scope = workspaceContext()
    if (!scope) throw new WorkspaceError('workspace_required', 'Select a business profile.', 400)
    return values[scope.workspaceId] ?? 0
  }
  async function health() {
    const app = Fastify(); apps.push(app)
    await app.register(healthRoutes, { prefix: '/api' })
    return (await app.inject({ method: 'GET', url: '/api/health' })).json()
  }
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    db.$queryRaw.mockResolvedValue([{ '?column?': 1 }])
    db.workspace.findMany.mockResolvedValue([{ id: 'profile-a' }, { id: 'profile-b' }])
  })

  it('sums every alarm across active profiles and reports the worst ads integrity', async () => {
    db.syncHealthLog.count.mockImplementation(perProfile({ 'profile-a': 1, 'profile-b': 2 }))
    db.outboundSyncQueue.count.mockImplementation(perProfile({ 'profile-a': 3, 'profile-b': 4 }))
    integrity.mockImplementation(async () => {
      const scope = workspaceContext()
      if (!scope) throw new WorkspaceError('workspace_required', 'Select a business profile.', 400)
      return scope.workspaceId === 'profile-b'
        ? { severity: 'WARN', findings: [{ code: 'STALE', severity: 'WARN', message: 'stale', action: 'check' }], snapshot: {} }
        : { severity: 'OK', findings: [], snapshot: {} }
    })
    const body = await health()
    expect(body.alerts).toEqual({ authFailures: 3, publishFailureRate: 3, qtyMismatches: 3, deadLetters24h: 7, adsDeadLetters24h: 7 })
    expect(body.adsIntegrity).toEqual({ severity: 'WARN', findings: [{ code: 'STALE', severity: 'WARN', message: 'stale', action: 'check' }] })
    expect(body).not.toHaveProperty('alertsError')
  })

  it('says so when the alarms cannot be read, instead of dropping the block', async () => {
    db.syncHealthLog.count.mockRejectedValue(new Error('database busy'))
    db.outboundSyncQueue.count.mockResolvedValue(0)
    const body = await health()
    expect(body.status).toBe('healthy')
    expect(body).not.toHaveProperty('alerts')
    expect(body.alertsError).toBe('Alarm counts could not be read')
  })
})
