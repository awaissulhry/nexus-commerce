import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ $queryRaw: vi.fn(), syncHealthLog: { count: vi.fn() } }))
const uploadMarker = vi.hoisted(() => vi.fn())
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), readFileSync: uploadMarker }))
vi.mock('../db.js', () => ({ default: db }))
vi.mock('../lib/queue.js', () => ({ getRedisRuntimeStatus: vi.fn(() => ({ status: 'ready', configured: true })) }))
import healthRoutes from './health.js'

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
