import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LOCKOUT } from '@nexus/factory-domain/auth/lockout/lockout'
import { SESSION_COOKIE } from '../sessions/cookies'
import { SESSION_LIFETIME } from '../sessions/session-store'
import { tokenHash } from '../sessions/secrets'
import { newId } from '@nexus/factory-domain/core/ids'
import { addTenant, addUser, Browser, codeAt, enrolTotp, PASSWORD, startHarness, START, type Harness, type TestTenant } from '../sessions/testing/harness'

/**
 * Office sign-in on the local stack (real PostgreSQL, the real app, routes and authenticator): sign-in and sign-out,
 * the lockout, two-factor with replay refused and recovery codes, idle and absolute expiry, CSRF, password resets,
 * the forced reset, the company header and the sign-in rate limit.
 */

let h: Harness
let tenant: TestTenant
let twoCompanies: TestTenant

const audit = (tenantId: string, action: string) =>
  h.database.withScope({ audience: 'office', tenantId, actorId: tenantId }, (client) =>
    client.auditLog.findMany({ where: { action }, orderBy: { at: 'asc' }, select: { recordType: true, recordId: true, actorId: true, after: true } }),
  )

beforeAll(async () => {
  h = await startHarness('auth_office')
  tenant = await addTenant(h, 'alpha')
  twoCompanies = await addTenant(h, 'beta', 2)
}, 60_000)

afterAll(async () => {
  await h?.close()
})

describe('sign-in, me and sign-out', () => {
  it('signs in with email and password, sets __Host- cookies, and answers who the person is', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'ada@example.com' })
    const browser = new Browser(h.app)
    const answer = await browser.signIn('alpha', ' Ada@Example.com ', user.password)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({
      status: 'signed_in',
      user: { id: user.id, email: 'ada@example.com' },
      mfa: { enabled: false, required: false, satisfied: true },
      session: { idleExpiresAt: '2026-10-28T17:00:00.000Z', absoluteExpiresAt: '2026-11-04T09:00:00.000Z' },
    })
    const cookies = answer.response.cookies as { name: string; httpOnly?: boolean; secure?: boolean; sameSite?: string; path?: string; domain?: string }[]
    const session = cookies.find((cookie) => cookie.name === SESSION_COOKIE)!
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })
    expect(session.domain).toBeUndefined()
    expect(answer.body.csrfToken).toBe(browser.csrfToken)

    const me = await browser.get('/auth/office/me')
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({
      user: { id: user.id, email: 'ada@example.com' },
      tenant: { id: tenant.id, slug: 'alpha' },
      company: { id: tenant.companies[0]!.id, code: 'C1' },
      mfa: { enabled: false, required: false, satisfied: true, recoveryCodesLeft: 0 },
      permissions: [],
    })

    // The token is stored only as its hash, with a shortened, hashed client address.
    const stored = await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: user.id }, (client) =>
      client.session.findMany({ where: { userId: user.id }, select: { tokenHash: true, ipHash: true } }),
    )
    expect(stored).toEqual([{ tokenHash: tokenHash(browser.cookies.get(SESSION_COOKIE)!), ipHash: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect((await audit(tenant.id, 'auth.signIn')).some((row) => row.actorId === user.id && row.recordType === 'Session')).toBe(true)

    const out = await browser.post('/auth/office/sign-out')
    expect(out.status).toBe(200)
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false)
    expect((await browser.get('/auth/office/me')).status).toBe(401)
  })

  it('a signed-out cookie opens nothing, even when sent again', async () => {
    const user = await addUser(h, tenant, { email: 'signout@example.com' })
    const browser = new Browser(h.app)
    await browser.signIn('alpha', user.email, user.password)
    const cookie = browser.cookies.get(SESSION_COOKIE)!
    await browser.post('/auth/office/sign-out')
    const replay = new Browser(h.app)
    replay.cookies.set(SESSION_COOKIE, cookie)
    expect((await replay.get('/auth/office/me')).status).toBe(401)
  })

  it('answers an unknown tenant, an unknown email and a wrong password the same way', async () => {
    const user = await addUser(h, tenant, { email: 'same@example.com' })
    const browser = new Browser(h.app)
    const answers = [
      await browser.signIn('nope', user.email, user.password),
      await browser.signIn('alpha', 'nobody@example.com', user.password),
      await browser.signIn('alpha', user.email, 'wrong-password-entirely'),
      await browser.signIn('alpha', 'invited@example.com', 'anything-at-all'),
    ]
    for (const answer of answers) {
      expect(answer.status).toBe(401)
      expect(answer.body.error).toMatchObject({ code: 'unauthenticated', message: 'The email or password is wrong.' })
    }
  })
})

describe('lockout', () => {
  it('locks after five wrong passwords, refuses even the right one while locked, and opens after the lock', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'locked@example.com' })
    const browser = new Browser(h.app)
    for (let attempt = 0; attempt < LOCKOUT.maxFailures; attempt++) {
      expect((await browser.signIn('alpha', user.email, `wrong-${attempt}-password`)).status).toBe(401)
    }
    const locked = await browser.signIn('alpha', user.email, user.password)
    expect(locked.status).toBe(401)
    expect(locked.body.error.message).toBe('The email or password is wrong.')
    const rows = await audit(tenant.id, 'auth.signInFailed')
    expect(rows.filter((row) => row.recordId === user.id).map((row) => (row.after as { failedAttempts: number }).failedAttempts)).toEqual([1, 2, 3, 4, 5])

    h.clock.advance(60_000)
    expect((await browser.signIn('alpha', user.email, user.password)).status).toBe(200)
    const state = await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: user.id }, (client) =>
      client.user.findUniqueOrThrow({ where: { id: user.id }, select: { failedAttempts: true, lockedUntil: true, passwordHash: true } }),
    )
    expect(state).toMatchObject({ failedAttempts: 0, lockedUntil: null })
    // The weaker test hash was replaced by one with the production parameters.
    expect(state.passwordHash).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$/)
  })

  it('doubles the lock with each further wrong password', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'doubling@example.com' })
    const browser = new Browser(h.app)
    for (let attempt = 0; attempt < 5; attempt++) await browser.signIn('alpha', user.email, 'not-the-password-1')
    h.clock.advance(60_000)
    await browser.signIn('alpha', user.email, 'not-the-password-2')
    h.clock.advance(60_000)
    expect((await browser.signIn('alpha', user.email, user.password)).status).toBe(401)
    h.clock.advance(60_000)
    expect((await browser.signIn('alpha', user.email, user.password)).status).toBe(200)
  })

  it('tells a suspended person so only once the password is right', async () => {
    const user = await addUser(h, tenant, { email: 'suspended@example.com', status: 'SUSPENDED' })
    const browser = new Browser(h.app)
    expect((await browser.signIn('alpha', user.email, 'not-the-password')).status).toBe(401)
    const right = await browser.signIn('alpha', user.email, user.password)
    expect(right.status).toBe(403)
    expect(right.body.error.message).toMatch(/suspended/)
  })
})

describe('two-factor', () => {
  it('requires the code once set up, refuses a replayed code, and accepts the next one', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'totp@example.com' })
    const browser = new Browser(h.app)
    await browser.signIn('alpha', user.email, user.password)
    const secret = await enrolTotp(h, browser)

    const second = new Browser(h.app)
    expect((await second.signIn('alpha', user.email, user.password)).body).toEqual({ status: 'totp_required' })
    const code = codeAt(h.clock, secret)
    const signedIn = await second.signIn('alpha', user.email, user.password, code)
    expect(signedIn.status).toBe(200)
    expect(signedIn.body.mfa).toEqual({ enabled: true, required: false, satisfied: true })

    const replay = await new Browser(h.app).signIn('alpha', user.email, user.password, code)
    expect(replay.status).toBe(401)
    expect(replay.body.error.message).toMatch(/already used/)
    expect((await new Browser(h.app).signIn('alpha', user.email, user.password, '000000')).body.error.message).toBe('The code is wrong.')

    h.clock.advance(30_000)
    expect((await new Browser(h.app).signIn('alpha', user.email, user.password, codeAt(h.clock, secret))).status).toBe(200)
  })

  it('accepts a code one step early or late (clock drift), not two', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'drift@example.com' })
    const browser = new Browser(h.app)
    await browser.signIn('alpha', user.email, user.password)
    const secret = await enrolTotp(h, browser)
    h.clock.advance(5 * 30_000)
    expect((await new Browser(h.app).signIn('alpha', user.email, user.password, codeAt(h.clock, secret, 2))).status).toBe(401)
    expect((await new Browser(h.app).signIn('alpha', user.email, user.password, codeAt(h.clock, secret, -1))).status).toBe(200)
    expect((await new Browser(h.app).signIn('alpha', user.email, user.password, codeAt(h.clock, secret, 1))).status).toBe(200)
  })

  it('takes each recovery code once', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'recovery@example.com' })
    const browser = new Browser(h.app)
    await browser.signIn('alpha', user.email, user.password)
    const setup = await browser.post('/auth/office/totp/setup')
    const confirm = await browser.post('/auth/office/totp/confirm', { code: codeAt(h.clock, setup.body.secret) })
    const codes = confirm.body.recoveryCodes as string[]
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)

    const used = codes[3]!.toLowerCase().replace('-', ' ')
    expect((await new Browser(h.app).signIn('alpha', user.email, user.password, used)).status).toBe(200)
    expect((await new Browser(h.app).signIn('alpha', user.email, user.password, codes[3])).status).toBe(401)
    const me = await (await signedInAs(user.email, user.password, codes[4]!)).get('/auth/office/me')
    expect(me.body.mfa.recoveryCodesLeft).toBe(8)
  })

  it('an owner holds no permission until two-factor is set up and proved on the session', async () => {
    h.clock.set(START)
    const owner = await addUser(h, tenant, { email: 'first.owner@example.com', role: 'owner' })
    const browser = new Browser(h.app)
    const answer = await browser.signIn('alpha', owner.email, owner.password)
    expect(answer.body.mfa).toEqual({ enabled: false, required: true, satisfied: false })
    expect((await browser.get('/auth/office/me')).body.permissions).toEqual([])
    expect((await browser.get('/auth/users')).status).toBe(403)

    await enrolTotp(h, browser)
    const me = await browser.get('/auth/office/me')
    expect(me.body.mfa).toMatchObject({ enabled: true, required: true, satisfied: true })
    expect(me.body.permissions).toContain('users.invite')
    expect((await browser.get('/auth/users')).status).toBe(200)
  })

  it('switches off with the password, unless two-factor is required', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'switchoff@example.com' })
    const browser = new Browser(h.app)
    await browser.signIn('alpha', user.email, user.password)
    await enrolTotp(h, browser)
    expect((await browser.post('/auth/office/totp/disable', { password: 'not-my-password' })).status).toBe(400)
    expect((await browser.post('/auth/office/totp/disable', { password: user.password })).body).toEqual({ status: 'off' })
    expect((await new Browser(h.app).signIn('alpha', user.email, user.password)).body.status).toBe('signed_in')

    const required = await addUser(h, tenant, { email: 'required@example.com', requireMfa: true })
    const other = new Browser(h.app)
    await other.signIn('alpha', required.email, required.password)
    await enrolTotp(h, other)
    expect((await other.post('/auth/office/totp/disable', { password: required.password })).status).toBe(409)
  })
})

async function signedInAs(email: string, password: string, code?: string, slug = 'alpha'): Promise<Browser> {
  const browser = new Browser(h.app)
  const answer = await browser.signIn(slug, email, password, code)
  if (answer.status !== 200 || answer.body.status !== 'signed_in') throw new Error(`sign-in ${email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return browser
}

describe('session expiry', () => {
  it('ends after 8 hours without use; use slides the idle expiry', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'idle@example.com' })
    const browser = await signedInAs(user.email, user.password)
    h.clock.advance(7 * 60 * 60_000)
    const me = await browser.get('/auth/office/me')
    expect(me.status).toBe(200)
    expect(me.body.session.idleExpiresAt).toBe('2026-10-29T00:00:00.000Z')
    h.clock.advance(8 * 60 * 60_000 - 1)
    expect((await browser.get('/auth/office/me')).status).toBe(200)
    h.clock.advance(8 * 60 * 60_000)
    expect((await browser.get('/auth/office/me')).status).toBe(401)
  })

  it('ends 7 days after sign-in, however busy', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'absolute@example.com' })
    const browser = await signedInAs(user.email, user.password)
    for (let hours = 0; hours < 7 * 24 - 4; hours += 4) {
      h.clock.advance(4 * 60 * 60_000)
      expect((await browser.get('/auth/office/me')).status).toBe(200)
    }
    const refresh = await browser.post('/auth/sessions/refresh')
    expect(refresh.status).toBe(200)
    expect(refresh.body).toEqual({ idleExpiresAt: '2026-11-04T09:00:00.000Z', absoluteExpiresAt: '2026-11-04T09:00:00.000Z' })
    h.clock.set(new Date(new Date(START).getTime() + SESSION_LIFETIME.absoluteMs))
    expect((await browser.get('/auth/office/me')).status).toBe(401)
  })

  it('refresh moves the idle expiry without another request', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'refresh@example.com' })
    const browser = await signedInAs(user.email, user.password)
    h.clock.advance(30_000)
    expect((await browser.post('/auth/sessions/refresh')).body.idleExpiresAt).toBe('2026-10-28T17:00:30.000Z')
  })
})

describe('CSRF double submit', () => {
  it('refuses an unsafe request of a cookie session without the token, or with another one', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'csrf@example.com' })
    const browser = await signedInAs(user.email, user.password)
    const missing = await browser.post('/auth/sessions/refresh', {}, { csrf: false })
    expect(missing.status).toBe(403)
    expect(missing.body.error.message).toMatch(/CSRF/)
    expect((await browser.post('/auth/sessions/refresh', {}, { csrf: false, headers: { 'x-csrf-token': 'A'.repeat(43) } })).status).toBe(403)
    expect((await browser.post('/auth/sessions/refresh')).status).toBe(200)
    // Reads need no token.
    expect((await browser.get('/auth/office/me')).status).toBe(200)
  })

  it('refuses sign-in and sign-out without the token', async () => {
    const user = await addUser(h, tenant, { email: 'csrf.signin@example.com' })
    const browser = new Browser(h.app)
    expect((await browser.post('/auth/office/sign-in', { tenant: 'alpha', email: user.email, password: user.password })).status).toBe(403)
    await browser.signIn('alpha', user.email, user.password)
    expect((await browser.post('/auth/office/sign-out', {}, { csrf: false })).status).toBe(403)
    expect((await browser.get('/auth/office/me')).status).toBe(200)
  })

  it('keeps an existing CSRF cookie and makes a new one at sign-in', async () => {
    const browser = new Browser(h.app)
    const first = (await browser.get('/auth/csrf')).body.csrfToken
    expect((await browser.get('/auth/csrf')).body.csrfToken).toBe(first)
    const user = await addUser(h, tenant, { email: 'csrf.rotate@example.com' })
    await browser.signIn('alpha', user.email, user.password)
    expect(browser.csrfToken).not.toBe(first)
  })
})

describe('password reset', () => {
  it('mails a link for a known address only, answers the same for any address, and the link works once', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'reset@example.com' })
    const session = await signedInAs(user.email, user.password)
    const browser = new Browser(h.app)
    for (const email of ['reset@example.com', 'unknown@example.com']) {
      const answer = await browser.post('/auth/office/password/reset-request', { tenant: 'alpha', email })
      expect(answer.body).toEqual({ status: 'requested' })
    }
    await h.auth.settled()
    expect(h.mailer.last('password_reset', 'unknown@example.com')).toBeUndefined()
    const message = h.mailer.last('password_reset', user.email)!
    expect(message.link).toMatch(/^http:\/\/localhost:3200\/reset-password#token=/)
    const token = decodeURIComponent(message.link.split('#token=')[1]!)

    expect((await browser.post('/auth/office/password/reset', { token, password: 'short' })).status).toBe(400)
    expect((await browser.post('/auth/office/password/reset', { token, password: 'calm-meadow-river-77' })).body).toEqual({ status: 'password_set' })
    expect((await browser.post('/auth/office/password/reset', { token, password: 'calm-meadow-river-78' })).status).toBe(404)
    // Every session ended; the new password signs in, the old one does not.
    expect((await session.get('/auth/office/me')).status).toBe(401)
    expect((await new Browser(h.app).signIn('alpha', user.email, PASSWORD)).status).toBe(401)
    expect((await new Browser(h.app).signIn('alpha', user.email, 'calm-meadow-river-77')).status).toBe(200)
  })

  it('expires after an hour, and does not mail twice within 5 minutes', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'reset.expiry@example.com' })
    const browser = new Browser(h.app)
    await browser.post('/auth/office/password/reset-request', { tenant: 'alpha', email: user.email })
    await browser.post('/auth/office/password/reset-request', { tenant: 'alpha', email: user.email })
    await h.auth.settled()
    expect(h.mailer.messages.filter((message) => message.to === user.email)).toHaveLength(1)
    const token = decodeURIComponent(h.mailer.last('password_reset', user.email)!.link.split('#token=')[1]!)
    h.clock.advance(60 * 60_000)
    expect((await browser.post('/auth/office/password/reset', { token, password: 'calm-meadow-river-79' })).status).toBe(404)
    expect((await browser.post('/auth/office/password/reset', { token: 'not-a-token', password: 'calm-meadow-river-79' })).status).toBe(404)
  })

  it('an administrator-required reset turns the next sign-in into a reset', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'forced@example.com' })
    await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: user.id }, (client) =>
      client.user.update({ where: { id: user.id }, data: { mustChangePassword: true } }),
    )
    const browser = new Browser(h.app)
    const answer = await browser.signIn('alpha', user.email, user.password)
    expect(answer.body).toMatchObject({ status: 'password_change_required', expiresAt: '2026-10-28T09:15:00.000Z' })
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false)
    expect((await browser.post('/auth/office/password/reset', { token: answer.body.resetToken, password: 'calm-meadow-river-80' })).status).toBe(200)
    expect((await browser.signIn('alpha', user.email, 'calm-meadow-river-80')).body.status).toBe('signed_in')
  })
})

describe('company context', () => {
  it('starts in the only company; the x-factory-company header picks one (by code or id) of the tenant only', async () => {
    h.clock.set(START)
    const user = await addUser(h, twoCompanies, { email: 'two@example.com' })
    const browser = await signedInAs(user.email, user.password, undefined, 'beta')
    expect((await browser.get('/auth/office/me')).body.company).toBeNull()
    const [first, second] = twoCompanies.companies
    expect((await browser.get('/auth/office/me', { headers: { 'x-factory-company': 'C2' } })).body.company).toMatchObject({ id: second!.id })
    expect((await browser.get('/auth/office/me', { headers: { 'x-factory-company': first!.id } })).body.company).toMatchObject({ code: 'C1' })
    // Another tenant's company is unknown here.
    expect((await browser.get('/auth/office/me', { headers: { 'x-factory-company': tenant.companies[0]!.id } })).status).toBe(403)
    expect((await browser.get('/auth/office/me', { headers: { 'x-factory-company': 'NOPE' } })).status).toBe(403)
  })

  it('B-W2b-05: lists the screen company\'s active sites the person reaches — every one without a site limit, else those named', async () => {
    h.clock.set(START)
    const [first, second] = twoCompanies.companies
    const site = { north: newId(), south: newId(), closed: newId(), other: newId() }
    const wide = await addUser(h, twoCompanies, { email: 'sites.wide@example.com', role: 'warehouse' })
    const narrow = await addUser(h, twoCompanies, { email: 'sites.narrow@example.com' })
    await h.database.withScope({ audience: 'office', tenantId: twoCompanies.id, actorId: twoCompanies.id }, async (client) => {
      await client.site.create({ data: { id: site.north, companyId: first!.id, code: 'N1', name: 'North plant', kind: 'PLANT' } })
      await client.site.create({ data: { id: site.south, companyId: first!.id, code: 'S1', name: 'South store', kind: 'WAREHOUSE' } })
      await client.site.create({ data: { id: site.closed, companyId: first!.id, code: 'X1', name: 'Closed site', kind: 'PLANT', status: 'ARCHIVED' } })
      await client.site.create({ data: { id: site.other, companyId: second!.id, code: 'O1', name: 'Other plant', kind: 'PLANT' } })
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: twoCompanies.id, key: 'warehouse' } }, select: { id: true } })
      await client.roleAssignment.create({
        data: { id: newId(), userId: narrow.id, roleId: role.id, allCompanies: false, companyIds: [first!.id], siteIds: [site.south], validFrom: new Date(START) },
      })
    })
    const sitesOf = async (browser: Browser, company: string) => {
      const me = await browser.get('/auth/office/me', { headers: { 'x-factory-company': company } })
      return { sites: (me.body.sites as { code: string }[]).map((entry) => entry.code), allSites: me.body.allSites }
    }
    const everywhere = await signedInAs(wide.email, wide.password, undefined, 'beta')
    expect(await sitesOf(everywhere, 'C1')).toEqual({ sites: ['N1', 'S1'], allSites: true })
    expect(await sitesOf(everywhere, 'C2')).toEqual({ sites: ['O1'], allSites: true })
    const limited = await signedInAs(narrow.email, narrow.password, undefined, 'beta')
    expect(await sitesOf(limited, 'C1')).toEqual({ sites: ['S1'], allSites: false })
    expect(await sitesOf(limited, 'C2')).toEqual({ sites: [], allSites: false })
    // No company on the screen: no sites.
    expect((await limited.get('/auth/office/me')).body).toMatchObject({ company: null, sites: [], allSites: false })
  })
})

describe('rate limit', () => {
  it('limits sign-in attempts per client address', async () => {
    const app = await h.app2({ signIn: { max: 3, timeWindowMs: 60_000 } })
    const browser = new Browser(app)
    await browser.get('/auth/csrf')
    const statuses: number[] = []
    for (let attempt = 0; attempt < 4; attempt++) {
      statuses.push((await browser.post('/auth/office/sign-in', { tenant: 'alpha', email: 'x@example.com', password: 'whatever-it-is' })).status)
    }
    expect(statuses).toEqual([401, 401, 401, 429])
  })
})
