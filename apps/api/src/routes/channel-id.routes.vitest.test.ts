/**
 * Item ID control (step I1) — `POST /api/listings/:id/channel-id/{check,link,unlink}`: its permission, its idempotency,
 * what it accepts, that the signed-in person is the actor, and how a refusal reads. The rules themselves are proven in
 * services/identity/identity-fix.vitest.test.ts (PGlite, eBay stubbed); here the service is stood in.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { COMMAND_SCOPE_ROUTES } from '../lib/command-idempotency.js'
import { SYSTEM_ROLES, expandPermissions } from '@nexus/shared/permissions'

const m = vi.hoisted(() => ({ check: vi.fn(), link: vi.fn(), unlink: vi.fn() }))
vi.mock('../services/identity/channel-id.service.js', () => ({ checkSheetChannelId: m.check, linkSheetChannelId: m.link, unlinkSheetChannelId: m.unlink }))
// The refusal class only (the real module reaches the database and the event bus; the rules are tested beside it).
vi.mock('../services/identity/identity-fix.service.js', () => ({
  IdentityFixRefusal: class IdentityFixRefusal extends Error {
    constructor(message: string, readonly code: 'refused' | 'conflict' | 'not_found' = 'refused') { super(message) }
  },
}))

import { IdentityFixRefusal } from '../services/identity/identity-fix.service.js'
import { parseCheckBody, parseLinkBody, parseUnlinkBody } from './channel-id.routes.js'

const URL = (verb: string, id = 'L-MAIN') => `/api/listings/${id}/channel-id/${verb}`
const PATTERN = (verb: string) => `/api/listings/:id/channel-id/${verb}`

describe('channel id routes', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify()
    app.addHook('onRequest', async (request) => { (request as { authUser?: unknown }).authUser = { id: 'user-ida' } })
    const { default: routes } = await import('./channel-id.routes.js')
    await app.register(routes, { prefix: '/api' })
    await app.ready()
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => {
    vi.resetAllMocks()
    m.check.mockResolvedValue({ ok: true, itemId: '520000000001' })
    m.link.mockResolvedValue({ ok: true, externalId: '520000000001', rows: [] })
    m.unlink.mockResolvedValue({ ok: true, externalId: '520000000001', rows: [] })
  })

  it('needs listings.recover (Claude\'s link and unlink need it too) — not the /api/listings catch-all', () => {
    for (const verb of ['check', 'link', 'unlink']) {
      expect(permissionForRoute('POST', PATTERN(verb))).toBe('listings.recover')
      expect(permissionForRoute('POST', URL(verb))).toBe('listings.recover')
    }
    const allowed = (['ADMIN', 'OPS_MANAGER', 'FULFILLMENT', 'FINANCE', 'VIEWER'] as const)
      .filter((role) => expandPermissions(SYSTEM_ROLES[role].permissions).has('listings.recover'))
    expect(allowed).toEqual(['ADMIN', 'OPS_MANAGER'])
    // The rest of /api/listings keeps its rule.
    expect(permissionForRoute('PATCH', '/api/listings/:id')).toBe('listings.edit')
  })

  it('a double press of Link or Clear runs once (durable Idempotency-Key receipts); Check writes nothing and is not keyed', () => {
    expect(COMMAND_SCOPE_ROUTES).toEqual(expect.arrayContaining([PATTERN('link'), PATTERN('unlink')]))
    expect(COMMAND_SCOPE_ROUTES).not.toContain(PATTERN('check'))
  })

  it('holds no Prisma call — the route parses and hands off', () => {
    const source = readFileSync(join(import.meta.dirname, 'channel-id.routes.ts'), 'utf8')
    expect(source).not.toMatch(/prisma/)
  })

  it('check: the typed id (or none) reaches the service; its finding is the answer', async () => {
    const res = await app.inject({ method: 'POST', url: URL('check'), payload: { externalId: ' 520000000001 ' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(m.check).toHaveBeenCalledWith('L-MAIN', { externalId: '520000000001' })
    await app.inject({ method: 'POST', url: URL('check'), payload: {} })
    expect(m.check).toHaveBeenLastCalledWith('L-MAIN', { externalId: null })
  })

  it('link and unlink: the fence and the signed-in person reach the service', async () => {
    const link = await app.inject({ method: 'POST', url: URL('link'), payload: { externalId: '520000000001', expectedExternalId: null, expectedVersion: 4 } })
    expect(link.statusCode).toBe(200)
    expect(m.link).toHaveBeenCalledWith('L-MAIN', { externalId: '520000000001', expectedExternalId: null, expectedVersion: 4 }, 'user-ida')
    const unlink = await app.inject({ method: 'POST', url: URL('unlink'), payload: { expectedExternalId: '520000000001', expectedVersion: 5 } })
    expect(unlink.statusCode).toBe(200)
    expect(m.unlink).toHaveBeenCalledWith('L-MAIN', { expectedExternalId: '520000000001', expectedVersion: 5 }, 'user-ida')
  })

  it.each([
    ['link without an id', 'link', { expectedVersion: 1 }],
    ['link without the version it read', 'link', { externalId: '520000000001', expectedExternalId: null }],
    ['link with a negative version', 'link', { externalId: '520000000001', expectedVersion: -1 }],
    ['link with a number for an id', 'link', { externalId: 520000000001, expectedVersion: 1 }],
    ['unlink without the id it clears', 'unlink', { expectedVersion: 1 }],
    ['an over-long id', 'check', { externalId: '1'.repeat(41) }],
  ])('refuses %s with 400 and calls nothing', async (_why, verb, payload) => {
    const res = await app.inject({ method: 'POST', url: URL(verb), payload })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'invalid_request' })
    expect(m.check).not.toHaveBeenCalled(); expect(m.link).not.toHaveBeenCalled(); expect(m.unlink).not.toHaveBeenCalled()
  })

  it('a refusal is a status with its plain sentence: 404 not found, 409 changed meanwhile, 422 the rule', async () => {
    m.link.mockRejectedValueOnce(new IdentityFixRefusal('Listing not found', 'not_found'))
    m.link.mockRejectedValueOnce(new IdentityFixRefusal('This listing changed after it was read.', 'conflict'))
    m.link.mockRejectedValueOnce(new IdentityFixRefusal('Set on the main row: one eBay Item ID carries the whole variation family.'))
    const body = { externalId: '520000000001', expectedExternalId: null, expectedVersion: 1 }
    for (const [status, error] of [[404, 'not_found'], [409, 'conflict'], [422, 'refused']] as const) {
      const res = await app.inject({ method: 'POST', url: URL('link'), payload: body })
      expect(res.statusCode).toBe(status)
      expect(res.json()).toMatchObject({ error, message: expect.any(String) })
    }
  })

  it('an unexpected failure says nothing was assumed (500), never the error text', async () => {
    m.unlink.mockRejectedValueOnce(new Error('secret internals'))
    const res = await app.inject({ method: 'POST', url: URL('unlink'), payload: { expectedExternalId: '520000000001', expectedVersion: 1 } })
    expect(res.statusCode).toBe(500)
    expect(res.json().message).not.toContain('secret')
  })

  it('the parsers', () => {
    expect(parseCheckBody(undefined)).toEqual({ externalId: null })
    expect(parseLinkBody({ externalId: '1', expectedExternalId: ' 2 ', expectedVersion: 0 })).toEqual({ externalId: '1', expectedExternalId: '2', expectedVersion: 0 })
    expect(parseUnlinkBody({ expectedExternalId: '2', expectedVersion: 3 })).toEqual({ expectedExternalId: '2', expectedVersion: 3 })
  })
})
