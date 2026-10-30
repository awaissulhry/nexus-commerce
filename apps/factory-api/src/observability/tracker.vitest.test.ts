import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { buildApp, type AppConfig } from '../core/app'
import { runTick, type CronJob } from '../core/cron'
import { defineManifest, defineRoutes, PUBLIC } from '../core/manifest'
import { LOCAL_COOKIE_SECRET } from '../env'
import { memorySink } from './fake'
import { createErrorTracker, errorTrackingMode, reportError, useErrorTracker, type ErrorSink } from './tracker'

/**
 * Error tracking with redaction (PLT-218) through the real error handler: an unexpected error (500) reaches the fake
 * sink as a redacted report (route pattern, status, request id; no person, no secret, no money), a domain refusal
 * (4xx) does not, a failed cron tick does, a failing sink never breaks the answer. Made-up values only.
 */

const CONFIG: AppConfig = { environment: 'test', webOrigin: 'http://localhost:3200', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET }

const routes = defineRoutes(
  'probe',
  defineManifest({
    'GET /boom/:partyId': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
    'GET /refuse': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  }),
  async (app) => {
    app.get('/boom/:partyId', async () => {
      throw Object.assign(new Error('Unique failed: Key ("email")=(giulia@example.com) price: 12.50 token=made-up-token-9'), { code: 'P2002', email: 'giulia@example.com' })
    })
    app.get('/refuse', async () => {
      throw new NotFoundError('Quote Q-7 does not exist.')
    })
  },
)

const apps: FastifyInstance[] = []
afterEach(async () => {
  useErrorTracker(undefined)
  for (const app of apps.splice(0)) await app.close()
})

async function boot(): Promise<FastifyInstance> {
  const app = await buildApp(CONFIG, { routes: [routes] })
  apps.push(app)
  return app
}

describe('reports of unexpected errors', () => {
  it('a 500 reaches the fake sink, redacted, with the route pattern and the request id', async () => {
    const sink = memorySink()
    useErrorTracker(createErrorTracker({ sink, source: 'api', release: 'test-1', environment: 'test' }))
    const app = await boot()
    const answer = await app.inject({ method: 'GET', url: '/boom/0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0b?email=giulia@example.com' })
    expect(answer.statusCode).toBe(500)
    expect(answer.body).not.toContain('giulia')
    const [report] = sink.reports()
    expect(sink.reports()).toHaveLength(1)
    expect(report).toMatchObject({ source: 'api', name: 'Error', code: 'P2002', context: { route: '/boom/:partyId', method: 'GET', statusCode: 500, release: 'test-1', environment: 'test' } })
    expect(report!.context.requestId).toBe(answer.headers['x-request-id'])
    const text = JSON.stringify(report)
    for (const secret of ['giulia', '12.50', 'made-up-token-9', '0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0b']) expect(text, secret).not.toContain(secret)
  })

  it('a domain refusal is not an error to track', async () => {
    const sink = memorySink()
    useErrorTracker(createErrorTracker({ sink, source: 'api' }))
    const app = await boot()
    expect((await app.inject({ method: 'GET', url: '/refuse' })).statusCode).toBe(404)
    expect(sink.reports()).toHaveLength(0)
  })

  it('a failed cron tick is reported with the cron name', async () => {
    const sink = memorySink()
    useErrorTracker(createErrorTracker({ sink, source: 'scheduler' }))
    const job: CronJob = { name: 'probe.tick', schedule: '* * * * *', timezone: 'Europe/Rome', lockTtlMs: 1_000, run: async () => Promise.reject(new Error('the tick failed for mario@example.com')) }
    const redis = { set: async () => 'OK' } as never
    const outcome = await runTick(job, new Date('2026-10-30T10:00:00.000Z'), { redis, prefix: 'w2a42-test', log: { info() {}, warn() {}, error() {} } })
    expect(outcome).toBe('failed')
    expect(sink.reports()).toMatchObject([{ source: 'scheduler', context: { cron: 'probe.tick' } }])
    expect(JSON.stringify(sink.reports())).not.toContain('mario@example.com')
  })

  it('a sink that throws or rejects never breaks what it reports', async () => {
    const throwing: ErrorSink = { kind: 'fake', send: () => { throw new Error('sink down') } }
    const rejecting: ErrorSink = { kind: 'fake', send: () => Promise.reject(new Error('sink down')) }
    for (const sink of [throwing, rejecting]) {
      useErrorTracker(createErrorTracker({ sink, source: 'api' }))
      expect(reportError(new Error('x'))).toMatchObject({ message: 'x' })
      const app = await boot()
      expect((await app.inject({ method: 'GET', url: '/boom/x' })).statusCode).toBe(500)
    }
  })

  it('off keeps nothing', () => {
    useErrorTracker(createErrorTracker({ sink: { kind: 'off', send: () => { throw new Error('never called') } }, source: 'api' }))
    expect(reportError(new Error('x'))).toBeNull()
  })

  it('keeps the newest 200 reports in memory', () => {
    const sink = memorySink(3)
    for (const n of [1, 2, 3, 4, 5]) sink.send({ id: `r${n}`, at: '2026-10-30T10:00:00.000Z', source: 'api', name: 'Error', code: null, message: String(n), stack: [], causes: [], context: {} })
    expect(sink.reports().map((report) => report.id)).toEqual(['r3', 'r4', 'r5'])
  })
})

describe('the mode', () => {
  it('is fake by default locally, off elsewhere; fake is refused in staging and production', () => {
    expect(errorTrackingMode('local', undefined)).toBe('fake')
    expect(errorTrackingMode('test', 'off')).toBe('off')
    expect(errorTrackingMode('production', undefined)).toBe('off')
    expect(errorTrackingMode('staging', 'off')).toBe('off')
    expect(() => errorTrackingMode('production', 'fake')).toThrow(/GATE-SPEND/)
    expect(() => errorTrackingMode('local', 'sentry')).toThrow(/off or fake/)
  })
})
