import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryClient } from '@nexus/factory-db'
import { usePlaceHeaders } from './place'
import { addRole, addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant, type TestUser } from './testing/harness'

/**
 * Active sessions and session lengths on the local stack (B-W2b-404; PLT-064, PLT-068), through the real app: a session keeps
 * where it runs (device, browser and the place an edge proxy gave, once); each person sees and ends their own; an
 * administrator sees and ends a person's; the company's office lengths apply at the next request (shorter at once, longer
 * only with a fresh code); the portal's never exceed A1's; the floor's stay the site's. Made-up people and places.
 */

let h: Harness
let alpha: TestTenant

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const WINDOWS_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'

async function signedIn(user: TestUser, headers: Record<string, string> = {}): Promise<Browser> {
  const browser = new Browser(h.app)
  await browser.get('/auth/csrf')
  const answer = await browser.post('/auth/office/sign-in', { tenant: 'alpha', email: user.email, password: user.password }, { headers })
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${user.email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return browser
}

const inTenant = <T>(userId: string, work: (client: FactoryClient) => Promise<T>): Promise<T> => h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: userId }, work)

beforeAll(async () => {
  h = await startHarness('auth_sessions_depth')
  alpha = await addTenant(h, 'alpha')
}, 60_000)

afterEach(() => usePlaceHeaders(undefined))

afterAll(async () => {
  await h?.close()
})

describe('where I am signed in (My profile)', () => {
  it('lists my live sessions with device, browser, place and last use; ends one, then every other; never this browser', async () => {
    const user = await addUser(h, alpha, { email: 'traveller@example.com', role: 'planner' })
    usePlaceHeaders(true)
    const laptop = await signedIn(user, { 'user-agent': MAC_CHROME, 'cf-ipcountry': 'IT', 'cf-ipcity': 'Seedville' })
    usePlaceHeaders(false)
    const pc = await signedIn(user, { 'user-agent': WINDOWS_FIREFOX, 'cf-ipcountry': 'DE' })
    h.clock.advance(60_000)
    const third = await signedIn(user)

    const mine = await laptop.get('/auth/sessions')
    expect(mine.status).toBe(200)
    expect(mine.body.sessions).toHaveLength(3)
    const current = mine.body.sessions.find((entry: { current: boolean }) => entry.current)
    expect(current).toMatchObject({ surface: 'OFFICE', deviceKind: 'MAC', deviceLabel: 'Mac', browser: 'Chrome 130', place: { country: 'IT', city: 'Seedville' } })
    // A client cannot write its own place: without the edge proxy's switch the headers are not read.
    expect(mine.body.sessions.find((entry: { deviceKind: string | null }) => entry.deviceKind === 'WINDOWS')).toMatchObject({ browser: 'Firefox 132', place: { country: null, city: null } })
    expect(JSON.stringify(mine.body)).not.toMatch(/127\.0\.0|ipHash|userAgent/)

    const pcId = (await pc.get('/auth/sessions')).body.sessions.find((entry: { current: boolean }) => entry.current).id
    const thisOne = await laptop.post(`/auth/sessions/${current.id}/end`)
    expect(thisOne.status).toBe(409)
    expect(thisOne.body.error.issues[0].path).toBe('sessions/current')
    expect((await laptop.post(`/auth/sessions/${pcId}/end`)).body).toEqual({ ended: 1 })
    expect((await pc.get('/auth/office/me')).status).toBe(401)
    expect((await laptop.post(`/auth/sessions/${pcId}/end`)).status).toBe(404)

    expect((await laptop.post('/auth/sessions/end-others')).body).toEqual({ ended: 1 })
    expect((await third.get('/auth/office/me')).status).toBe(401)
    expect((await laptop.get('/auth/office/me')).status).toBe(200)
    const reasons = await inTenant(user.id, (client) => client.session.findMany({ where: { userId: user.id, revokedAt: { not: null } }, select: { revokedReason: true } }))
    expect(reasons.map((row) => row.revokedReason)).toEqual(['ENDED_BY_USER', 'ENDED_BY_USER'])
  })
})

describe("a person's sessions (Admin › Users › Sessions & sign-ins)", () => {
  it('an administrator sees and ends all of them; never their own here; the read-only role does not see them', async () => {
    const admin = await addUser(h, alpha, { email: 'admin@example.com', role: 'admin' })
    const adminBrowser = await signedIn(admin)
    await enrolTotp(h, adminBrowser)
    const person = await addUser(h, alpha, { email: 'person@example.com', role: 'sales' })
    const personBrowser = await signedIn(person, { 'user-agent': WINDOWS_FIREFOX })
    const reader = await addUser(h, alpha, { email: 'reader@example.com', role: 'read_only' })
    const readerBrowser = await signedIn(reader)

    const seen = await adminBrowser.get(`/auth/users/${person.id}/sessions`)
    expect(seen.status).toBe(200)
    expect(seen.body.sessions).toEqual([expect.objectContaining({ current: false, deviceKind: 'WINDOWS', browser: 'Firefox 132' })])
    expect((await readerBrowser.get(`/auth/users/${person.id}/sessions`)).status).toBe(403)
    const self = await adminBrowser.get(`/auth/users/${admin.id}/sessions`)
    expect(self.status).toBe(409)
    expect(self.body.error.issues[0].path).toBe('sessions/self')

    const ended = await adminBrowser.post(`/auth/users/${person.id}/sessions/end`, { reason: 'Lost laptop' })
    expect(ended.body).toEqual({ ended: 1 })
    expect((await personBrowser.get('/auth/office/me')).status).toBe(401)
    const row = await inTenant(admin.id, (client) => client.session.findFirstOrThrow({ where: { userId: person.id }, select: { revokedReason: true } }))
    expect(row.revokedReason).toBe('ENDED_BY_ADMIN')
    expect((await adminBrowser.get(`/audit/User/${person.id}`)).body.entries[0]).toMatchObject({ action: 'users.endSessions', reason: 'Lost laptop', after: { revokedReason: 'ENDED_BY_ADMIN', sessionsEnded: 1 } })
  })
})

describe('session lengths per audience (Admin › Security)', () => {
  it('reads the defaults; a shorter office idle time ends an idle session at its next request, with no fresh code', async () => {
    const owner = await addUser(h, alpha, { email: 'owner@example.com', role: 'owner' })
    const ownerBrowser = await signedIn(owner)
    const secret = await enrolTotp(h, ownerBrowser)
    const settings = await ownerBrowser.get('/auth/security-settings')
    expect(settings.status).toBe(200)
    expect(settings.body).toMatchObject({
      version: 0,
      sessions: { office: { idleMinutes: 480, longestHours: 168 }, portal: { idleMinutes: 30, longestHours: 12 }, floor: [] },
      stepUp: { maxFailures: 5, lockMinutes: 15, validMinutes: 5 },
      bounds: { officeIdleMinutes: { min: 15, max: 1440, default: 480 }, portalLongestHours: { min: 1, max: 12, default: 12 } },
      canChange: true,
    })

    const idle = await addUser(h, alpha, { email: 'idle@example.com', role: 'planner' })
    const idleBrowser = await signedIn(idle)
    h.clock.advance(5 * 60_000)
    expect((await ownerBrowser.get('/auth/office/me')).status).toBe(200)
    h.clock.advance(5 * 60_000)
    const shorter = await ownerBrowser.put('/auth/security-settings/sessions', { version: 0, officeIdleMinutes: 15, officeLongestHours: 168, portalIdleMinutes: 20, portalLongestHours: 8 })
    expect(shorter.status).toBe(200)
    expect(shorter.body).toMatchObject({ version: 1, sessions: { office: { idleMinutes: 15 }, portal: { idleMinutes: 20, longestHours: 8 } } })
    h.clock.advance(6 * 60_000)
    // Idle for 16 minutes: ended by the shorter rule at once; the owner, active 6 minutes ago, goes on.
    expect((await idleBrowser.get('/auth/office/me')).status).toBe(401)
    const me = await ownerBrowser.get('/auth/office/me')
    expect(me.status).toBe(200)
    expect(new Date(me.body.session.idleExpiresAt).getTime() - h.clock.now().getTime()).toBe(15 * 60_000)

    // Longer is wider: a fresh code first; out of bounds and a stale version are refused in codes.
    const longer = { version: 1, officeIdleMinutes: 600, officeLongestHours: 336, portalIdleMinutes: 30, portalLongestHours: 12 }
    const asked = await ownerBrowser.put('/auth/security-settings/sessions', longer)
    expect(asked.status).toBe(403)
    expect(asked.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    const outside = await ownerBrowser.put('/auth/security-settings/sessions', { ...longer, portalIdleMinutes: 45, officeIdleMinutes: 600, officeLongestHours: 8 })
    expect(outside.status).toBe(400)
    expect(outside.body.error.issues.map((issue: { path: string }) => issue.path)).toEqual(['body/portalIdleMinutes/range'])
    await stepUp(h, ownerBrowser, secret)
    expect((await ownerBrowser.put('/auth/security-settings/sessions', { ...longer, version: 0 })).status).toBe(409)
    const saved = await ownerBrowser.put('/auth/security-settings/sessions', { ...longer, reason: 'Long shifts in the office' })
    expect(saved.status).toBe(200)
    expect(saved.body.version).toBe(2)

    // A new sign-in starts under the new lengths (and its cookie lives as long).
    const fresh = new Browser(h.app)
    await fresh.get('/auth/csrf')
    const answer = await fresh.post('/auth/office/sign-in', { tenant: 'alpha', email: idle.email, password: idle.password })
    expect(new Date(answer.body.session.absoluteExpiresAt).getTime() - h.clock.now().getTime()).toBe(336 * 60 * 60_000)
    expect(new Date(answer.body.session.idleExpiresAt).getTime() - h.clock.now().getTime()).toBe(600 * 60_000)
    expect(answer.response.cookies.find((cookie: { name: string }) => cookie.name === '__Host-factory_session')).toMatchObject({ maxAge: 336 * 60 * 60 })
    const events = await inTenant(owner.id, (client) => client.outboxEvent.findMany({ where: { type: 'security.settings_changed' }, orderBy: [{ occurredAt: 'asc' }], select: { payload: true } }))
    expect(events.map((event) => event.payload)).toEqual([{ part: 'SESSIONS', version: 1 }, { part: 'SESSIONS', version: 2 }])
  })

  it('the Security page states the tenant lengths; Security & health readers see them, only security.settings.manage changes them', async () => {
    const reader = await addUser(h, alpha, { email: 'viewer@example.com', role: 'read_only' })
    await addRole(h, alpha, reader.id, 'planner')
    const browser = await signedIn(reader)
    const page = await browser.get('/admin/security')
    expect(page.status).toBe(200)
    expect(page.body.signIn.sessions).toMatchObject({ idleHours: 10, absoluteDays: 14 })
    const settings = await browser.get('/auth/security-settings')
    expect(settings.status).toBe(200)
    expect(settings.body.canChange).toBe(false)
    expect((await browser.put('/auth/security-settings/sessions', { version: 2, officeIdleMinutes: 15, officeLongestHours: 24, portalIdleMinutes: 5, portalLongestHours: 1 })).status).toBe(403)
  })
})
