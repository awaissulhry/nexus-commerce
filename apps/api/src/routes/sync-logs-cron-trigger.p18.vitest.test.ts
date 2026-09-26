/**
 * P1.8 review (2026-09-23) — the hub's manual trigger keeps a run's completed status.
 *
 * The trigger route records the run itself (one CronRun row, `recordCronRun(…, { triggeredBy: 'manual' })`)
 * and used to reduce every handler result to its summary string, so a PARTIAL contract run triggered by hand
 * would still have been written as SUCCESS. `recordCronRun` is stood in to capture what the route hands it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ recorded: [] as Array<{ jobName: string; value: unknown; options: unknown }>, results: {} as Record<string, unknown> }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../services/sync-logs-events.service.js', () => ({ subscribeSyncLogEvents: vi.fn() }))
vi.mock('../jobs/cron-registry.js', () => ({
  CRON_REGISTRY: new Proxy({}, { get: (_target, name: string) => async () => h.results[name] }),
  isKnownCron: (name: string) => name in h.results,
  listKnownCrons: () => Object.keys(h.results),
}))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (jobName: string, handler: () => Promise<unknown>, options: unknown) => {
    const value = await handler()
    h.recorded.push({ jobName, value, options })
    return value
  }),
}))
const Fastify = (await import('fastify')).default
const routes = (await import('./sync-logs.routes.js')).default

async function trigger(jobName: string) {
  const app = Fastify()
  await app.register(routes)
  try {
    const res = await app.inject({ method: 'POST', url: `/sync-logs/cron/${jobName}/trigger` })
    await vi.waitFor(() => expect(h.recorded.some((r) => r.jobName === jobName)).toBe(true))
    return { res, recorded: h.recorded.find((r) => r.jobName === jobName)! }
  } finally { await app.close() }
}

beforeEach(() => { h.recorded = []; h.results = {} })

describe('manual trigger → recordCronRun', () => {
  it('a result carrying cronStatus reaches recordCronRun with it (PARTIAL stays PARTIAL)', async () => {
    h.results['channel-contract-run'] = { summary: '5/11 required operations proven — Partial, not green.', cronStatus: 'PARTIAL' }
    const { res, recorded } = await trigger('channel-contract-run')
    expect(res.statusCode).toBe(202)
    expect(recorded.value).toEqual({ summary: '5/11 required operations proven — Partial, not green.', cronStatus: 'PARTIAL' })
    expect(recorded.options).toEqual({ triggeredBy: 'manual' })
  })
  it('every other result shape is unchanged: a string, a {summary}, and nothing at all', async () => {
    h.results['a-string'] = 'did 3 things'
    h.results['a-summary'] = { summary: 'did 4 things', extra: 1 }
    h.results['nothing'] = undefined
    expect((await trigger('a-string')).recorded.value).toBe('did 3 things')
    expect((await trigger('a-summary')).recorded.value).toEqual({ summary: 'did 4 things' })
    expect((await trigger('nothing')).recorded.value).toBe('manual trigger')
  })
})
