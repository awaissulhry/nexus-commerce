/**
 * `POST /api/amazon/listings/fill-asins` — its permission, what it accepts, and that a dry
 * run reaches the filler as a dry run. The filler's own rules are in listing-asin-fill.service.vitest.test.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { SYSTEM_ROLES, expandPermissions } from '@nexus/shared/permissions'

const m = vi.hoisted(() => ({ fill: vi.fn(), unfilled: vi.fn() }))
vi.mock('../services/amazon/listing-asin-fill.service.js', () => ({ ASIN_FILL_MAX: 200, fillAmazonListingAsins: m.fill, unfilledAmazonListingIds: m.unfilled }))

import { parseFillAsinsBody } from './amazon-listing-asin.routes.js'

const PATH = '/api/amazon/listings/fill-asins'
const report = (dryRun: boolean) => ({ dryRun, rows: [], counts: { filled: 0, not_visible_yet: 0, already_had_asin: 0, error: 0 } })

describe('fill-asins route', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify()
    const { default: routes } = await import('./amazon-listing-asin.routes.js')
    await app.register(routes, { prefix: '/api' })
    await app.ready()
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => {
    vi.resetAllMocks()
    m.fill.mockImplementation(async (_ids: string[], options: { dryRun: boolean }) => report(options.dryRun))
    m.unfilled.mockResolvedValue(['default-1', 'default-2'])
  })

  it('needs listings.publish, which the publishing roles hold and the others do not', () => {
    expect(permissionForRoute('POST', PATH)).toBe('listings.publish')
    const allowed = (['ADMIN', 'OPS_MANAGER', 'FULFILLMENT', 'FINANCE', 'VIEWER'] as const)
      .filter(role => expandPermissions(SYSTEM_ROLES[role].permissions).has('listings.publish'))
    expect(allowed).toEqual(['ADMIN', 'OPS_MANAGER'])
    // The rest of /api/amazon keeps its own rule.
    expect(permissionForRoute('POST', '/api/amazon/something-else')).toBe('channels.sync')
  })

  it('is not a keyed web command: no web screen calls it, and a repeat is harmless (an ASIN is never replaced)', () => {
    // COMMAND_SCOPES holds exactly the routes the web sends an Idempotency-Key to (web `command-key.vitest.test.ts`).
    const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'command-idempotency.ts'), 'utf8')
    expect(source).not.toContain(PATH)
  })

  it('holds no Prisma call — the route parses and hands off', () => {
    const source = readFileSync(join(import.meta.dirname, 'amazon-listing-asin.routes.ts'), 'utf8')
    expect(source).not.toMatch(/prisma\./)
    expect(source).toContain('fillAmazonListingAsins(')
  })

  it('passes a dry run through as a dry run, for the named listings', async () => {
    const res = await app.inject({ method: 'POST', url: PATH, payload: { listingIds: ['a', ' b ', 'a'], dryRun: true } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ dryRun: true })
    expect(m.fill).toHaveBeenCalledWith(['a', 'b'], { dryRun: true })
    expect(m.unfilled).not.toHaveBeenCalled()
  })

  it('reads every unfilled listing when none are named', async () => {
    const res = await app.inject({ method: 'POST', url: PATH, payload: { dryRun: false } })
    expect(res.statusCode).toBe(200)
    expect(m.unfilled).toHaveBeenCalledOnce()
    expect(m.fill).toHaveBeenCalledWith(['default-1', 'default-2'], { dryRun: false })
  })

  it.each([
    ['no body', undefined],
    ['no dryRun', { listingIds: ['a'] }],
    ['a string dryRun', { dryRun: 'true' }],
    ['an empty list', { listingIds: [], dryRun: true }],
    ['a non-list', { listingIds: 'a', dryRun: true }],
    ['a blank id', { listingIds: ['a', ' '], dryRun: true }],
    ['more than 200 ids', { listingIds: Array.from({ length: 201 }, (_, i) => `id-${i}`), dryRun: true }],
  ])('refuses %s with 400 and reads nothing', async (_why, payload) => {
    const res = await app.inject({ method: 'POST', url: PATH, ...(payload === undefined ? {} : { payload }) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toEqual(expect.any(String))
    expect(m.fill).not.toHaveBeenCalled()
    expect(m.unfilled).not.toHaveBeenCalled()
  })

  it('reports a failure as a 500 with its sentence', async () => {
    m.fill.mockRejectedValue(new Error('Amazon account unavailable'))
    const res = await app.inject({ method: 'POST', url: PATH, payload: { listingIds: ['a'], dryRun: true } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'Amazon account unavailable' })
  })
})

describe('parseFillAsinsBody', () => {
  it('requires dryRun to be stated, so a write is never the default', () => {
    expect(parseFillAsinsBody({})).toHaveProperty('error')
    expect(parseFillAsinsBody({ dryRun: true })).toEqual({ dryRun: true })
    expect(parseFillAsinsBody({ dryRun: false, listingIds: ['x'] })).toEqual({ dryRun: false, listingIds: ['x'] })
  })
})
