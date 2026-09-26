import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

/**
 * POST /attributes/concepts/options — the colour/size concept options (2026-09-26). A write happens only on an explicit
 * `dryRun: false`; a concept without a value list is a 400 with the reason. The service itself is proven on PostgreSQL
 * in `services/pim/attribute-concept-options.vitest.test.ts`.
 */
const svc = vi.hoisted(() => ({ apply: vi.fn() }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../services/pim/attribute-concepts.service.js', async importOriginal => ({
  ...await importOriginal<object>(), applyConceptOptions: svc.apply,
}))
import attributesRoutes from './attributes.routes.js'
import { ConceptOptionsError } from '../services/pim/attribute-concepts.service.js'

const post = async (payload?: object) => {
  const app = Fastify(); await app.register(attributesRoutes)
  return app.inject({ method: 'POST', url: '/attributes/concepts/options', ...(payload ? { payload } : {}) })
}
beforeEach(() => { svc.apply.mockReset(); svc.apply.mockResolvedValue({ applied: false, entries: [], counts: {} }) })

describe('POST /attributes/concepts/options', () => {
  it('is a dry run unless dryRun is false', async () => {
    expect((await post()).statusCode).toBe(200)
    expect((await post({ dryRun: true, concepts: ['color'] })).statusCode).toBe(200)
    expect(svc.apply.mock.calls.map(([options]) => options)).toEqual([
      { concepts: undefined, dryRun: true },
      { concepts: ['color'], dryRun: true },
    ])
    // POSITIVE CONTROL: only an explicit false writes.
    await post({ dryRun: false, concepts: ['size', 7] })
    expect(svc.apply).toHaveBeenLastCalledWith({ concepts: ['size'], dryRun: false })
  })

  it('answers 400 with the reason for a concept without a value list', async () => {
    svc.apply.mockRejectedValue(new ConceptOptionsError('"title" is not a concept with a value list.'))
    const res = await post({ concepts: ['title'] })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: '"title" is not a concept with a value list.' })
  })
})
