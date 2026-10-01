/**
 * Two-factor and the session that turned it on (2026-10-01, production): setting up two-factor stamped the login but
 * left the session that did it "second factor not done", and every business page then refused it ("Complete
 * two-factor authentication") with no way forward on the profiles page. Now the code that completes the setup counts
 * as the second factor for that session, and `/api/auth/me` says whether the session still lacks it (`mfaIncomplete`,
 * the business pages' own rule).
 *
 * Real PostgreSQL in-process (PGlite); the session cache is replaced by a recorder (it must be dropped, or the old
 * state is served from it).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { generateSecret, generateSync } from 'otplib'

const state = vi.hoisted(() => ({ db: null as any, dropped: [] as string[] }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('./session-cache.js', () => ({
  getCachedSession: async () => null,
  setCachedSession: async () => undefined,
  dropCachedSessions: async (hashes: readonly string[]) => { state.dropped.push(...hashes) },
}))

import prisma from '../../db.js'
import { markSessionMfaSatisfied, validateSession } from './session.js'
import { hashToken } from './tokens.js'
import { csrfCookieName, sessionCookieName } from './cookies.js'
import authRoutes from '../../routes/auth.routes.js'
import mfaRoutes from '../../routes/mfa.routes.js'

const HOUR = 3_600_000
const db = prisma as any
let ownerId = ''
let otherId = ''
const sessionIds: Record<string, string> = {}
const newSession = async (raw: string, userId: string, data: Record<string, unknown> = {}) => (await db.userSession.create({
  data: { userId, sessionTokenHash: hashToken(raw), tokenPrefix: raw.slice(0, 8), lastSeenAt: new Date(), idleExpiry: new Date(Date.now() + HOUR), absoluteExpiry: new Date(Date.now() + 24 * HOUR), mfaSatisfied: false, ...data },
})).id as string

beforeAll(async () => {
  ownerId = (await db.userProfile.create({ data: { email: 'owner@example.test', displayName: 'Owner', status: 'active' } })).id
  otherId = (await db.userProfile.create({ data: { email: 'other@example.test', displayName: 'Other', status: 'active' } })).id
  sessionIds.owner = await newSession('owner-session-token', ownerId)
  sessionIds.other = await newSession('other-session-token', otherId)
  sessionIds.revoked = await newSession('revoked-session-token', ownerId, { revokedAt: new Date() })
}, 120_000)
afterAll(async () => { await state.db?.close() })

describe('marking a session as two-factor done', () => {
  it('marks only a live session of that user, and drops its cached copy', async () => {
    expect(await markSessionMfaSatisfied(sessionIds.other, ownerId)).toBe(false) // another person's session
    expect(await markSessionMfaSatisfied(sessionIds.revoked, ownerId)).toBe(false) // a signed-out session
    expect((await validateSession('other-session-token'))?.mfaSatisfied).toBe(false)
    state.dropped.length = 0
    expect(await markSessionMfaSatisfied(sessionIds.owner, ownerId)).toBe(true)
    expect((await validateSession('owner-session-token'))?.mfaSatisfied).toBe(true)
    expect(state.dropped).toContain(hashToken('owner-session-token'))
    await db.userSession.update({ where: { id: sessionIds.owner }, data: { mfaSatisfied: false } })
  })
})

describe('turning two-factor on, then /api/auth/me', () => {
  let app: FastifyInstance
  const csrf = 'csrf-token-for-the-test'
  const signedIn = { [sessionCookieName()]: 'owner-session-token', [csrfCookieName()]: csrf }
  beforeAll(async () => {
    app = Fastify()
    await app.register(cookie)
    // Stand-in for the RBAC gate, which sets who is asking and on which session for /api/auth/2fa/*.
    app.addHook('preHandler', async (req) => {
      const s = await validateSession(req.cookies[sessionCookieName()] ?? '')
      if (s) Object.assign(req, { authUser: s.user, authSessionId: s.sessionId, authMfaSatisfied: s.mfaSatisfied })
    })
    await app.register(authRoutes)
    await app.register(mfaRoutes)
    await app.ready()
  })
  afterAll(async () => { await app.close() })
  const me = async () => (await app.inject({ method: 'GET', url: '/api/auth/me', cookies: signedIn })).json().user

  it('before: no two-factor, nothing is incomplete', async () => {
    expect(await me()).toMatchObject({ mfaEnabled: false, mfaSatisfied: false, mfaIncomplete: false })
  })

  it('a wrong code changes nothing; the right code turns two-factor on AND completes it for this session', async () => {
    const secret = generateSecret()
    await db.userProfile.update({ where: { id: ownerId }, data: { twoFactorSecret: secret, twoFactorEnabledAt: null } })
    const post = (code: string) => app.inject({ method: 'POST', url: '/api/auth/2fa/enroll/verify', cookies: signedIn, headers: { 'x-nexus-csrf': csrf }, payload: { code } })
    expect((await post('000000')).statusCode).toBe(401)
    expect((await validateSession('owner-session-token'))?.mfaSatisfied).toBe(false)
    const ok = await post(generateSync({ secret, digits: 6, period: 30 }))
    expect(ok.statusCode).toBe(200)
    expect(ok.json().recoveryCodes).toHaveLength(10)
    expect((await validateSession('owner-session-token'))?.mfaSatisfied).toBe(true)
    expect(await me()).toMatchObject({ mfaEnabled: true, mfaSatisfied: true, mfaIncomplete: false })
  })

  it('a sign-in made without the code is reported incomplete — the profiles page then offers "Sign in again"', async () => {
    await db.userSession.update({ where: { id: sessionIds.owner }, data: { mfaSatisfied: false } })
    expect(await me()).toMatchObject({ mfaEnabled: true, mfaSatisfied: false, mfaIncomplete: true })
  })

  it('a login that must use two-factor but has not set it up is incomplete too — the page then offers "Set up"', async () => {
    await db.userProfile.update({ where: { id: otherId }, data: { mfaRequired: true } })
    const other = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [sessionCookieName()]: 'other-session-token' } })
    expect(other.json().user).toMatchObject({ mfaEnabled: false, mfaRequired: true, mfaSatisfied: false, mfaIncomplete: true })
  })
})
