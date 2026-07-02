/**
 * Phase S1 (auth core) — HTTP-level wiring tests via Fastify inject.
 * These exercise the guard/CSRF/route registration WITHOUT a database:
 * every asserted path is rejected by a preHandler (CSRF / auth) before
 * any Prisma call, so the test is hermetic. DB-backed happy paths are
 * covered by the manual prod verification in the S1 gate report.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import authRoutes from './auth.routes.js'
import { csrfCookieName } from '../lib/auth/cookies.js'

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(cookie)
  await app.register(authRoutes)
  await app.ready()
})
afterAll(async () => {
  await app.close()
})

describe('GET /api/auth/csrf', () => {
  it('mints a token and sets the CSRF cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/csrf' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.csrfToken).toBe('string')
    expect(body.csrfToken.length).toBeGreaterThan(10)
    const setCookie = String(res.headers['set-cookie'])
    expect(setCookie).toContain(`${csrfCookieName()}=`)
  })
})

describe('CSRF enforcement on login', () => {
  it('rejects login with no CSRF header/cookie (403), before any DB call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'x@y.com', password: 'whatever-long-enough' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('csrf_failed')
  })

  it('rejects login when header does not match cookie (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-nexus-csrf': 'aaa', cookie: `${csrfCookieName()}=bbb` },
      payload: { email: 'x@y.com', password: 'whatever-long-enough' },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('auth-required endpoints reject anonymous callers', () => {
  it('GET /api/auth/me → 401 without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthenticated')
  })

  it('POST /api/auth/logout-all → 401 without a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout-all' })
    expect(res.statusCode).toBe(401)
  })

  it('POST /api/auth/invitations → 401 without owner session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/invitations',
      payload: { email: 'new@user.com', roleKey: 'OWNER' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('GET /api/auth/invitations → 401 without owner session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/invitations' })
    expect(res.statusCode).toBe(401)
  })
})
