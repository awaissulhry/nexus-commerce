import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryClient } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { databaseNow } from '../../audit/security-events/record'
import { addTenant, addUser, Browser, codeAt, enrolTotp, startHarness, stepUp, type Harness, type TestTenant, type TestUser } from '../sessions/testing/harness'

/**
 * Step-up in depth on the local stack (B-W2b-404; PLT-063; GDPR art. 32), through the real app: every try is a StepUpAttempt,
 * a code works once, repeated wrong codes lock step-up (never the sign-in: the account's lockout is untouched) and the try
 * that reaches the lock writes STEP_UP_LOCKED; the lock ends by itself; the company switches an action off (a wider change
 * asks a fresh code first) and a fixed one never. Made-up people; the harness clock only moves forward.
 */

let h: Harness
let alpha: TestTenant

async function signedIn(user: TestUser): Promise<Browser> {
  const browser = new Browser(h.app)
  const answer = await browser.signIn('alpha', user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${user.email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return browser
}

/** A code that is not the one now (and not one step before or after). */
const wrongCode = (secret: string): string => {
  const right = new Set([codeAt(h.clock, secret, -1), codeAt(h.clock, secret), codeAt(h.clock, secret, 1)])
  for (let value = 0; ; value += 1) {
    const code = String(value).padStart(6, '0')
    if (!right.has(code)) return code
  }
}

const inTenant = <T>(userId: string, work: (client: FactoryClient) => Promise<T>): Promise<T> => h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: userId }, work)

const triesOf = (userId: string) =>
  inTenant(userId, (client) => client.stepUpAttempt.findMany({ where: { userId }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { result: true, codeFingerprint: true, sessionId: true } }))

beforeAll(async () => {
  h = await startHarness('auth_step_up_depth')
  alpha = await addTenant(h, 'alpha')
}, 60_000)

afterAll(async () => {
  await h?.close()
})

describe('each code once, every try recorded', () => {
  it('records a success with a keyed fingerprint (never the code), a wrong code and a reused one', async () => {
    const user = await addUser(h, alpha, { email: 'stepper@example.com', role: 'owner' })
    const browser = await signedIn(user)
    const secret = await enrolTotp(h, browser)

    const wrong = await browser.post('/auth/office/step-up', { code: wrongCode(secret) })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.issues).toEqual([{ path: 'code/wrong', message: 'The code is wrong.' }])

    const code = codeAt(h.clock, secret)
    const ok = await browser.post('/auth/office/step-up', { code })
    expect(ok.status).toBe(200)
    const again = await browser.post('/auth/office/step-up', { code })
    expect(again.status).toBe(400)
    expect(again.body.error.issues[0].path).toBe('code/reused')

    const tries = await triesOf(user.id)
    expect(tries.map((entry) => entry.result)).toEqual(['WRONG_CODE', 'SUCCESS', 'REUSED_CODE'])
    expect(tries[1]!.codeFingerprint).toMatch(/^su1\.[0-9a-f]{64}$/)
    expect(tries[1]!.codeFingerprint).not.toContain(code)
    expect(tries.every((entry) => entry.sessionId !== null)).toBe(true)
    // A wrong step-up code no longer counts towards the account's sign-in lockout.
    expect(await inTenant(user.id, (client) => client.user.findUniqueOrThrow({ where: { id: user.id }, select: { failedAttempts: true, lockedUntil: true } }))).toEqual({ failedAttempts: 0, lockedUntil: null })
    h.clock.advance(30_000)
  })
})

describe('the step-up lock', () => {
  it('locks after five wrong codes in a row: the next try is LOCKED, even the right code; the sign-in and other work go on', async () => {
    const user = await addUser(h, alpha, { email: 'locked-stepper@example.com', role: 'owner' })
    const browser = await signedIn(user)
    const secret = await enrolTotp(h, browser)
    for (let index = 0; index < 4; index += 1) expect((await browser.post('/auth/office/step-up', { code: wrongCode(secret) })).status).toBe(400)
    expect((await browser.get('/auth/office/me')).body.session).toMatchObject({ stepUpLockedUntil: null, stepUpFailuresLeft: 1 })
    expect((await browser.post('/auth/office/step-up', { code: wrongCode(secret) })).status).toBe(400)

    const locked = await browser.post('/auth/office/step-up', { code: codeAt(h.clock, secret) })
    expect(locked.status).toBe(403)
    expect(locked.body.error.issues[0].path).toBe('stepUp/locked')
    const me = await browser.get('/auth/office/me')
    expect(me.status).toBe(200)
    expect(me.body.session.stepUpLockedUntil).toEqual(expect.any(String))
    expect(me.body.session.stepUpFailuresLeft).toBe(0)

    expect((await triesOf(user.id)).map((entry) => entry.result)).toEqual(['WRONG_CODE', 'WRONG_CODE', 'WRONG_CODE', 'WRONG_CODE', 'WRONG_CODE', 'LOCKED'])
    const events = await inTenant(user.id, (client) => client.securityEvent.findMany({ where: { kind: 'STEP_UP_LOCKED', actorId: user.id }, select: { surface: true, details: true, recordType: true } }))
    expect(events).toEqual([{ surface: 'OFFICE', recordType: 'User', details: { result: 'WRONG_CODE', lockedUntil: me.body.session.stepUpLockedUntil } }])
    // A wrong code locked no account: a new sign-in works.
    expect((await new Browser(h.app).signIn('alpha', user.email, user.password, codeAt(h.clock, secret, 1))).body.status).toBe('signed_in')
    h.clock.advance(60_000)
  })

  it('ends by itself: failures older than the lock time no longer count', async () => {
    const user = await addUser(h, alpha, { email: 'past-stepper@example.com', role: 'owner' })
    const browser = await signedIn(user)
    const secret = await enrolTotp(h, browser)
    // Five wrong codes twenty minutes ago (as if typed then): the 15-minute lock they set is over.
    const sessionId = (await browser.get('/auth/office/me')).body.session.id as string
    await inTenant(user.id, async (client) => {
      const now = await databaseNow(client)
      for (let index = 0; index < 5; index += 1) {
        await client.stepUpAttempt.create({ data: { id: newId(), userId: user.id, sessionId, at: new Date(now.getTime() - 20 * 60_000 + index * 1000), result: 'WRONG_CODE' } })
      }
    })
    expect((await browser.get('/auth/office/me')).body.session.stepUpLockedUntil).toBeNull()
    expect((await browser.post('/auth/office/step-up', { code: codeAt(h.clock, secret) })).status).toBe(200)
    h.clock.advance(30_000)
  })
})

describe('on or off per action (Admin › Security)', () => {
  it('switches bank details off with a fresh code; a fixed action is refused; switching it on again asks nothing', async () => {
    const owner = await addUser(h, alpha, { email: 'owner@example.com', role: 'owner' })
    const browser = await signedIn(owner)
    const secret = await enrolTotp(h, browser)
    const company = alpha.companies[0]!.id
    const bankUrl = `/companies/${company}/bank-details`
    const bank = (await browser.get(bankUrl)).body
    const details = { accountHolder: 'Test company C1', iban: 'DE89370400440532013000', bic: null, bankName: null }
    h.clock.advance(5 * 60_000)
    const asked = await browser.send('PUT', bankUrl, { version: bank.version, ...details })
    expect(asked.status).toBe(403)
    expect(asked.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])

    const settings = (await browser.get('/auth/security-settings')).body
    expect(settings.stepUp.actions.find((entry: { key: string }) => entry.key === 'bankDetails.change')).toMatchObject({ on: true, canSwitchOff: true, permissions: ['companies.bank.manage', 'purchasing.bank.propose', 'purchasing.bank.verify', 'purchasing.bank.reveal'] })
    const body = { version: settings.version, off: ['bankDetails.change'], maxFailures: 5, lockMinutes: 15 }
    expect((await browser.put('/auth/security-settings/step-up', body)).status).toBe(403)
    const fixed = await browser.put('/auth/security-settings/step-up', { ...body, off: ['access.change'] })
    expect(fixed.status).toBe(400)
    expect(fixed.body.error.issues.map((issue: { path: string }) => issue.path)).toEqual(['body/stepUpOff/0/fixedAction'])
    await stepUp(h, browser, secret)
    const off = await browser.put('/auth/security-settings/step-up', { ...body, reason: 'Small office: one person keeps the bank' })
    expect(off.status).toBe(200)
    expect(off.body.version).toBe(1)
    expect(off.body.stepUp.actions.find((entry: { key: string }) => entry.key === 'bankDetails.change').on).toBe(false)

    // The next request: bank details without a fresh code; giving rights still asks one.
    h.clock.advance(6 * 60_000)
    expect((await browser.send('PUT', bankUrl, { version: bank.version, ...details })).status).toBe(200)
    const helper = await addUser(h, alpha, { email: 'helper@example.com' })
    const roles = (await browser.get('/auth/roles')).body.roles as { id: string; key: string }[]
    expect((await browser.post(`/auth/users/${helper.id}/roles`, { roleId: roles.find((role) => role.key === 'sales')!.id, allCompanies: true })).status).toBe(403)

    // Switching it on again is stricter: no fresh code.
    const on = await browser.put('/auth/security-settings/step-up', { version: 1, off: [], maxFailures: 5, lockMinutes: 30 })
    expect(on.status).toBe(200)
    const audit = (await browser.get(`/audit/SecuritySettings/${alpha.id}`)).body.entries
    expect(audit.map((entry: { action: string }) => entry.action)).toEqual(['security.setStepUpRules', 'security.setStepUpRules'])
    expect(audit[1]).toMatchObject({ reason: 'Small office: one person keeps the bank', before: { stepUpOff: [] }, after: { stepUpOff: ['bankDetails.change'], wider: true } })
  })
})
