import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_COOKIE_SECRET } from '../env'
import { buildApp } from './app'
import { isSecretKey, REDACTED, redact } from './logger'
import { defineManifest, defineRoutes, PUBLIC } from './manifest'

describe('isSecretKey()', () => {
  it('finds secrets word by word, in any case style', () => {
    for (const key of [
      'password',
      'newPassword',
      'password_hash',
      'pin',
      'pinCode',
      'otp',
      'totpSecret',
      'resetToken',
      'access_token',
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'apiKey',
      'privateKey',
      'credentialsEnc',
      'secretEnc',
      'tokenHash',
      'iban',
      'recoveryCodesHash',
      'x-csrf-token',
      'unitCost',
      'standardCost',
      'marginPct',
      'unitPrice',
      'amountMinor',
      'lineTotal',
      'pieceWage',
    ]) {
      expect(isSecretKey(key), key).toBe(true)
    }
  })

  it('leaves ordinary keys alone', () => {
    for (const key of ['id', 'email', 'shipping', 'mapping', 'authorId', 'idempotencyKey', 'tenantId', 'status', 'quantity', 'method', 'route']) {
      expect(isSecretKey(key), key).toBe(false)
    }
  })

  it('takes extra secret keys', () => {
    expect(isSecretKey('vatNumber', new Set(['vatnumber']))).toBe(true)
  })
})

describe('redact()', () => {
  it('replaces secrets at any depth and keeps the rest', () => {
    const input = {
      user: { email: 'a@example.com', password: 'hunter2', sessions: [{ token: 'abc', id: 1 }] },
      headers: { authorization: 'Bearer xyz', 'content-type': 'application/json' },
      line: { qty: '2', unitCost: '12.50' },
    }
    expect(redact(input)).toEqual({
      user: { email: 'a@example.com', password: REDACTED, sessions: [{ token: REDACTED, id: 1 }] },
      headers: { authorization: REDACTED, 'content-type': 'application/json' },
      line: { qty: '2', unitCost: REDACTED },
    })
    expect(input.user.password).toBe('hunter2')
  })

  it('handles null-prototype objects (Node headers), cycles and depth', () => {
    const headers = Object.assign(Object.create(null) as Record<string, string>, { cookie: 'sid=1', accept: '*/*' })
    expect(redact({ headers })).toEqual({ headers: { cookie: REDACTED, accept: '*/*' } })
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop
    expect(redact(loop)).toEqual({ name: 'loop', self: '[circular]' })
    let deep: Record<string, unknown> = { password: 'x' }
    for (let level = 0; level < 12; level++) deep = { next: deep }
    expect(JSON.stringify(redact(deep))).not.toContain('"x"')
  })

  it('redacts objects of any prototype, and values in their JSON form', () => {
    class Session {
      constructor(
        readonly id: string,
        readonly token: string,
      ) {}
    }
    expect(redact({ session: new Session('s1', 'abc') })).toEqual({ session: { id: 's1', token: REDACTED } })
    expect(redact({ at: new Date(0) })).toEqual({ at: '1970-01-01T00:00:00.000Z' })
    expect(redact({ map: new Map([['password', 'x']]), blob: Buffer.from('secret') })).toEqual({
      map: { password: REDACTED },
      blob: '[binary]',
    })
  })

  it('keeps only the type and message of a nested error', () => {
    const error = Object.assign(new Error('duplicate key'), { detail: 'Key (email)=(a@example.com) already exists.' })
    expect(redact({ cause: error })).toEqual({ cause: { type: 'Error', message: 'duplicate key' } })
  })
})

describe('the app logger', () => {
  const apps: FastifyInstance[] = []
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close()
  })

  it('writes no secret from headers, cookies, bodies, URLs or logged objects', async () => {
    const lines: string[] = []
    const routes = defineRoutes(
      'probe',
      defineManifest({
        'POST /l/:token': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
      }),
      async (app) => {
        app.post('/l/:token', async (request) => {
          request.log.info({ body: request.body, headers: request.headers, params: request.params }, 'probe')
          throw new Error('boom')
        })
      },
    )
    const app = await buildApp(
      { environment: 'test', webOrigin: 'http://localhost:3200', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
      { routes: [routes], logger: { level: 'info', stream: { write: (line) => void lines.push(line) } } },
    )
    apps.push(app)
    const response = await app.inject({
      method: 'POST',
      url: '/l/tok_SECRETLINKTOKEN0123456789?code=QUERYSECRET',
      headers: { authorization: 'Bearer SECRETBEARER', cookie: 'sid=SECRETCOOKIE', 'x-api-key': 'SECRETAPIKEY' },
      payload: { password: 'SECRETPASSWORD', pin: '123456', unitCost: '9.99', note: 'plain note' },
    })
    expect(response.statusCode).toBe(500)
    const log = lines.join('')
    for (const secret of ['SECRETLINKTOKEN', 'QUERYSECRET', 'SECRETBEARER', 'SECRETCOOKIE', 'SECRETAPIKEY', 'SECRETPASSWORD', '123456', '9.99']) {
      expect(log, secret).not.toContain(secret)
    }
    expect(log).toContain('plain note')
    expect(log).toContain('"route":"/l/:token"')
    expect(log).toContain('"requestId"')
    // The error is logged in full on the server, with its stack: only the answer leaves it out.
    expect(log).toMatch(/"message":"boom".*"stack"/)
  })
})
