import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PUBLIC, type RouteManifestEntry } from '../../../core/manifest'
import { SESSION_COOKIE } from '../sessions/cookies'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant, type TestUser } from '../sessions/testing/harness'

/**
 * The user lifecycle on the local stack: suspend (sessions end at once, sign-in refused), reactivate, deactivate
 * (credentials cleared, history kept), the required password reset, the edit-conflict guard, the tenant wall, and no
 * session → 401 on every route that is not public. The clock only moves forward in this file.
 */

let h: Harness
let alpha: TestTenant
let beta: TestTenant
let owner: Browser
let ownerSecret: string
let ownerId: string

interface Listed {
  id: string
  email: string
  status: string
  version: number
}

async function listed(browser: Browser, email: string): Promise<Listed> {
  const users = (await browser.get('/auth/users')).body.users as Listed[]
  const user = users.find((entry) => entry.email === email)
  if (!user) throw new Error(`${email} is not listed`)
  return user
}

async function signedIn(slug: string, user: TestUser, password = user.password): Promise<Browser> {
  const browser = new Browser(h.app)
  const answer = await browser.signIn(slug, user.email, password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${user.email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return browser
}

async function change(email: string, action: string, body: Record<string, unknown> = {}) {
  await stepUp(h, owner, ownerSecret)
  const user = await listed(owner, email)
  return owner.post(`/auth/users/${user.id}/${action}`, { version: user.version, ...body })
}

beforeAll(async () => {
  h = await startHarness('auth_users')
  alpha = await addTenant(h, 'alpha')
  beta = await addTenant(h, 'beta')
  const account = await addUser(h, alpha, { email: 'owner@example.com', role: 'owner' })
  ownerId = account.id
  owner = new Browser(h.app)
  await owner.signIn('alpha', account.email, account.password)
  ownerSecret = await enrolTotp(h, owner)
}, 60_000)

afterAll(async () => {
  await h?.close()
})

describe('suspend and reactivate', () => {
  it('suspending ends every session at once and refuses sign-in; reactivating gives access back', async () => {
    const member = await addUser(h, alpha, { email: 'member@example.com' })
    const first = await signedIn('alpha', member)
    const second = await signedIn('alpha', member)

    const suspended = await change(member.email, 'suspend', { reason: 'Left the project' })
    expect(suspended.status).toBe(200)
    expect(suspended.body).toMatchObject({ id: member.id, status: 'SUSPENDED', sessionsEnded: 2 })
    expect((await first.get('/auth/office/me')).status).toBe(401)
    expect((await second.get('/auth/office/me')).status).toBe(401)
    expect((await new Browser(h.app).signIn('alpha', member.email, member.password)).status).toBe(403)

    const history = await owner.get(`/audit/User/${member.id}`)
    expect(history.body.entries[0]).toMatchObject({ action: 'users.suspend', actorId: ownerId, before: { status: 'ACTIVE' }, after: { status: 'SUSPENDED' }, reason: 'Left the project' })

    expect((await change(member.email, 'reactivate')).body).toMatchObject({ status: 'ACTIVE', sessionsEnded: 0 })
    expect((await new Browser(h.app).signIn('alpha', member.email, member.password)).body.status).toBe('signed_in')
  })

  it('a session that raced the suspension stops too: the user must be active on every request', async () => {
    const member = await addUser(h, alpha, { email: 'raced@example.com' })
    const browser = await signedIn('alpha', member)
    await h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: member.id }, (client) =>
      client.user.update({ where: { id: member.id }, data: { status: 'SUSPENDED' } }),
    )
    expect((await browser.get('/auth/office/me')).status).toBe(401)
  })

  it('refuses a stale version, a move the machine does not allow, and changing one\'s own account', async () => {
    const member = await addUser(h, alpha, { email: 'versioned@example.com' })
    await stepUp(h, owner, ownerSecret)
    const stale = await owner.post(`/auth/users/${member.id}/suspend`, { version: 7 })
    expect(stale.status).toBe(409)
    expect(stale.body.error.issues).toEqual([{ path: 'version', message: 'The current version is 1.' }])
    expect((await change(member.email, 'reactivate')).status).toBe(409)
    await stepUp(h, owner, ownerSecret)
    expect((await owner.post(`/auth/users/${ownerId}/suspend`, { version: 1 })).status).toBe(403)
  })

  it('needs a step-up for every change', async () => {
    const member = await addUser(h, alpha, { email: 'stepup@example.com' })
    h.clock.advance(5 * 60_000)
    const refused = await owner.post(`/auth/users/${member.id}/suspend`, { version: 1 })
    expect(refused.status).toBe(403)
    expect(refused.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
  })
})

describe('deactivate', () => {
  it('ends sessions, clears the credentials and keeps the person on the list and in the history', async () => {
    const member = await addUser(h, alpha, { email: 'leaver@example.com' })
    const browser = await signedIn('alpha', member)
    const answer = await change(member.email, 'deactivate')
    expect(answer.body).toMatchObject({ status: 'DEACTIVATED', sessionsEnded: 1 })
    expect((await browser.get('/auth/office/me')).status).toBe(401)
    const signIn = await new Browser(h.app).signIn('alpha', member.email, member.password)
    expect(signIn.status).toBe(401)
    expect(signIn.body.error.message).toBe('The email or password is wrong.')
    const row = await h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: member.id }, (client) =>
      client.user.findUniqueOrThrow({ where: { id: member.id }, select: { displayName: true, passwordHash: true, totpSecretEnc: true, status: true } }),
    )
    expect(row).toEqual({ displayName: 'leaver', passwordHash: null, totpSecretEnc: null, status: 'DEACTIVATED' })
    expect((await listed(owner, member.email)).status).toBe('DEACTIVATED')
    expect((await owner.get(`/audit/User/${member.id}`)).body.entries.map((entry: { action: string }) => entry.action)).toContain('users.deactivate')
    // Only an invitation brings the person back.
    expect((await change(member.email, 'reactivate')).status).toBe(409)
  })
})

describe('required password reset', () => {
  it('ends the sessions; the next sign-in answers with a reset token instead of a session', async () => {
    const member = await addUser(h, alpha, { email: 'forgetful@example.com' })
    const browser = await signedIn('alpha', member)
    expect((await change(member.email, 'require-password-reset')).body).toMatchObject({ status: 'ACTIVE', sessionsEnded: 1 })
    expect((await browser.get('/auth/office/me')).status).toBe(401)
    const next = await new Browser(h.app).signIn('alpha', member.email, member.password)
    expect(next.body.status).toBe('password_change_required')
    expect(next.response.cookies.find((cookie: { name: string }) => cookie.name === SESSION_COOKIE)).toBeUndefined()
  })
})

describe('tenant wall', () => {
  it('another tenant\'s owner neither sees nor changes this tenant\'s users, and a cookie cannot be moved across', async () => {
    const betaOwner = await addUser(h, beta, { email: 'owner@example.com', role: 'owner', password: 'other-tenant-lantern-31' })
    const other = new Browser(h.app)
    await other.signIn('beta', betaOwner.email, betaOwner.password)
    const betaSecret = await enrolTotp(h, other)
    const users = (await other.get('/auth/users')).body.users as Listed[]
    expect(users.map((user) => user.id)).toEqual([betaOwner.id])

    // The same email in two tenants is two people with two passwords: beta's opens nothing in alpha.
    expect((await new Browser(h.app).signIn('alpha', 'owner@example.com', betaOwner.password)).status).toBe(401)

    await stepUp(h, other, betaSecret)
    const member = await addUser(h, alpha, { email: 'walled@example.com' })
    expect((await other.post(`/auth/users/${member.id}/suspend`, { version: 1 })).status).toBe(404)
    expect((await other.get(`/audit/User/${member.id}`)).body.entries).toEqual([])

    const cookie = owner.cookies.get(SESSION_COOKIE)!
    const moved = new Browser(h.app)
    moved.cookies.set(SESSION_COOKIE, cookie.replace(alpha.id, beta.id))
    expect((await moved.get('/auth/office/me')).status).toBe(401)
  })
})

describe('a suspended tenant', () => {
  it('stops its sessions and its sign-ins until it is active again', async () => {
    const delta = await addTenant(h, 'delta')
    const member = await addUser(h, delta, { email: 'delta.member@example.com' })
    const browser = await signedIn('delta', member)
    const setStatus = (status: 'ACTIVE' | 'SUSPENDED') =>
      h.database.withScope({ audience: 'platform' }, (client) => client.tenant.update({ where: { id: delta.id }, data: { status } }))
    await setStatus('SUSPENDED')
    expect((await browser.get('/auth/office/me')).status).toBe(401)
    expect((await new Browser(h.app).signIn('delta', member.email, member.password)).status).toBe(401)
    await setStatus('ACTIVE')
    expect((await browser.get('/auth/office/me')).status).toBe(200)
  })
})

describe('without a session', () => {
  it('every route that is not public answers 401, before reading the body', async () => {
    const routes = h.app.factoryRouteManifest.routes().filter(([, entry]: [string, RouteManifestEntry]) => entry.audiences !== PUBLIC)
    expect(routes.length).toBeGreaterThanOrEqual(12)
    const stranger = new Browser(h.app)
    stranger.cookies.set(SESSION_COOKIE, 'not-a-session')
    for (const [key] of routes) {
      const [method, path] = key.split(' ') as ['GET' | 'POST', string]
      const url = path.replace(/:[A-Za-z]+/g, '00000000-0000-7000-8000-00000000abcd').replace('/User/00000000-0000-7000-8000-00000000abcd', `/User/${ownerId}`)
      for (const browser of [new Browser(h.app), stranger]) {
        const answer = await browser.send(method, url, method === 'POST' ? { anything: true } : undefined)
        expect(answer.status, `${key}`).toBe(401)
        expect(answer.body.error.code).toBe('unauthenticated')
      }
    }
  })
})
