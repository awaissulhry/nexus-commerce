import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LOCKOUT } from '@nexus/factory-domain/auth/lockout/lockout'
import { newId } from '@nexus/factory-domain/core/ids'
import { addRole, addTenant, addUser, Browser, startHarness, START, type Harness, type TestTenant } from '../sessions/testing/harness'

/**
 * The signed-in person's own password and language (SCR-007; PLT-070, PLT-127) on the local stack: a new password needs
 * the current one (a wrong one counts towards the lockout), follows the password rules, ends every OTHER session and
 * keeps this one; the language is the person's and `me` answers it from the next request. And `me` lists the companies
 * the person's roles reach, so the sign-in (SCR-001) knows where to open a tenant of several companies.
 */

let h: Harness
let tenant: TestTenant
let group: TestTenant

const audit = (action: string) =>
  h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: tenant.id }, (client) =>
    client.auditLog.findMany({ where: { action }, orderBy: { at: 'asc' }, select: { recordId: true, before: true, after: true } }),
  )

beforeAll(async () => {
  h = await startHarness('auth_account')
  tenant = await addTenant(h, 'gamma')
  group = await addTenant(h, 'delta', 2)
}, 60_000)

afterAll(async () => {
  await h?.close()
})

describe('a new password from the signed-in person (PLT-070)', () => {
  it('needs the current password, keeps this session, ends the others, and only the new password signs in', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'change@example.com' })
    const here = new Browser(h.app)
    const elsewhere = new Browser(h.app)
    await here.signIn('gamma', user.email, user.password)
    await elsewhere.signIn('gamma', user.email, user.password)

    const wrong = await here.post('/auth/office/password', { currentPassword: 'not-the-current-one', password: 'amber-forest-violin-27' })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.issues).toEqual([{ path: 'currentPassword', message: 'Wrong password.' }])
    expect((await audit('auth.passwordCheckFailed')).filter((row) => row.recordId === user.id)).toHaveLength(1)

    const weak = await here.post('/auth/office/password', { currentPassword: user.password, password: 'short' })
    expect(weak.status).toBe(400)
    expect(weak.body.error.issues[0].path).toBe('password')

    const changed = await here.post('/auth/office/password', { currentPassword: user.password, password: 'amber-forest-violin-27' })
    expect(changed.status).toBe(200)
    expect(changed.body).toEqual({ status: 'password_changed', sessionsEnded: 1 })
    expect((await here.get('/auth/office/me')).status).toBe(200)
    expect((await elsewhere.get('/auth/office/me')).status).toBe(401)
    expect((await new Browser(h.app).signIn('gamma', user.email, user.password)).status).toBe(401)
    expect((await new Browser(h.app).signIn('gamma', user.email, 'amber-forest-violin-27')).status).toBe(200)
    const rows = (await audit('auth.passwordChange')).filter((row) => row.recordId === user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.after).toMatchObject({ sessionsEnded: 1 })
    // No password, hash or token in the audit row.
    expect(JSON.stringify(rows[0])).not.toMatch(/amber|scrypt/)
  })

  it('refuses without the CSRF header and without a session', async () => {
    const user = await addUser(h, tenant, { email: 'csrf-change@example.com' })
    const browser = new Browser(h.app)
    await browser.signIn('gamma', user.email, user.password)
    const body = { currentPassword: user.password, password: 'amber-forest-violin-28' }
    expect((await browser.post('/auth/office/password', body, { csrf: false })).status).toBe(403)
    expect((await new Browser(h.app).post('/auth/office/password', body)).status).toBe(401)
  })

  it('accepts nothing while the account is locked by wrong current passwords', async () => {
    h.clock.set(START)
    const user = await addUser(h, tenant, { email: 'locked-change@example.com' })
    const browser = new Browser(h.app)
    await browser.signIn('gamma', user.email, user.password)
    for (let attempt = 0; attempt < LOCKOUT.maxFailures; attempt++) {
      expect((await browser.post('/auth/office/password', { currentPassword: `wrong-${attempt}-password`, password: 'amber-forest-violin-29' })).status).toBe(400)
    }
    const locked = await browser.post('/auth/office/password', { currentPassword: user.password, password: 'amber-forest-violin-29' })
    expect(locked.status).toBe(403)
    h.clock.advance(LOCKOUT.firstLockMs)
    expect((await browser.post('/auth/office/password', { currentPassword: user.password, password: 'amber-forest-violin-29' })).status).toBe(200)
  })
})

describe('the person\'s interface language (PLT-127)', () => {
  it('is set by the person, answered by me from the next request, and audited', async () => {
    const user = await addUser(h, tenant, { email: 'language@example.com' })
    const browser = new Browser(h.app)
    await browser.signIn('gamma', user.email, user.password)
    expect((await browser.get('/auth/office/me')).body.user.locale).toBe('it')

    const set = await browser.post('/auth/office/locale', { locale: 'en' })
    expect(set.status).toBe(200)
    expect(set.body).toEqual({ locale: 'en' })
    expect((await browser.get('/auth/office/me')).body.user.locale).toBe('en')
    expect((await audit('auth.setLocale')).filter((row) => row.recordId === user.id)).toEqual([{ recordId: user.id, before: { locale: 'it' }, after: { locale: 'en' } }])
  })

  it('takes only an interface language, and only from a signed-in person', async () => {
    const user = await addUser(h, tenant, { email: 'language-refused@example.com' })
    const browser = new Browser(h.app)
    await browser.signIn('gamma', user.email, user.password)
    expect((await browser.post('/auth/office/locale', { locale: 'de' })).status).toBe(400)
    expect((await new Browser(h.app).post('/auth/office/locale', { locale: 'en' })).status).toBe(401)
  })
})

describe('the companies a person may open (SCR-001 sign-in, SCR-002 switcher)', () => {
  it('lists the active companies their roles reach, before two-factor is proved too; none without a role', async () => {
    h.clock.set(START)
    // An owner: every company, two-factor required and not set up (their permissions wait; their companies do not).
    const owner = await addUser(h, group, { email: 'owner@example.com' })
    await addRole(h, group, owner.id, 'owner')
    const browser = new Browser(h.app)
    await browser.signIn('delta', owner.email, owner.password)
    const me = await browser.get('/auth/office/me')
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ company: null, mfa: { required: true, satisfied: false }, permissions: [] })
    expect(me.body.companies).toEqual(group.companies.map((company) => ({ id: company.id, code: company.code, name: `Test company ${company.code}` })))

    // One company only.
    const clerk = await addUser(h, group, { email: 'clerk@example.com' })
    await h.database.withScope({ audience: 'office', tenantId: group.id, actorId: clerk.id }, async (client) => {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: group.id, key: 'sales' } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: clerk.id, roleId: role.id, allCompanies: false, companyIds: [group.companies[1]!.id], validFrom: new Date(START) } })
    })
    const one = new Browser(h.app)
    await one.signIn('delta', clerk.email, clerk.password)
    expect((await one.get('/auth/office/me')).body.companies.map((company: { code: string }) => company.code)).toEqual(['C2'])

    // No role: nothing to open.
    const nobody = await addUser(h, group, { email: 'nobody@example.com' })
    const none = new Browser(h.app)
    await none.signIn('delta', nobody.email, nobody.password)
    expect((await none.get('/auth/office/me')).body.companies).toEqual([])
  })
})
