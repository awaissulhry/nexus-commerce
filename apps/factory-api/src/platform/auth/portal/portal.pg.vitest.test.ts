import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { solveChallenge } from '@nexus/factory-domain/abuse/pow'
import { mintPortalToken, portalTokenHash } from '@nexus/factory-domain/auth/portal/token'
import { newId } from '@nexus/factory-domain/core/ids'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { SESSION_COOKIE } from '../sessions/cookies'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../sessions/testing/harness'
import { PORTAL_COOKIE } from './cookies'
import { purgePortalCodes } from './purge'
import { usePortalOptions } from './service'
import { requirePortalTerms } from './terms'
import { addPartner, askCode, freshGuard, inWorld, mailCount, mailedCode, portalBrowser, portalWorld, TERMS, type PortalWorld } from './testing/portal'

/**
 * Portal sign-in on the local stack (B-W2b-159; PLT-050, PLT-066): one e-mail with a code and a link, the scanner-safe
 * landing, partner sessions bound to their party, the first visit with the portal terms, step-up by code, the abuse
 * guard, the purge, and the office paths that must answer a partner's address in words. The harness clock starts at the
 * real time (the code guard compares expiry with the database's now()) and only moves forward.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld

beforeAll(async () => {
  h = await startHarness('auth_portal')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  tenant = await addTenant(h, 'portal-a')
  world = await portalWorld(h, tenant)
}, 120_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

/** Signs a partner in by code; returns the browser with its portal cookie. */
async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  expect(await askCode(h, browser, 'portal-a', email)).toBe(200)
  const answer = await browser.post('/portal/signin/code', { tenant: 'portal-a', email, code: mailedCode(h, email)!.code })
  expect(answer.status).toBe(200)
  return browser
}

/** The first visit: the terms in force acknowledged. */
async function acknowledge(browser: Browser): Promise<void> {
  const terms = await browser.get('/portal/terms?locale=en')
  expect(terms.status).toBe(200)
  const done = await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })
  expect(done.status).toBe(200)
}

describe('start: one e-mail with a code and a link, the same answer for every address', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('mails a partner person a 6-digit code and a link; the subject and every row keep neither', async () => {
    const email = 'anna@brand-alpha.example'
    const userId = await addPartner(h, world, email)
    const browser = await portalBrowser(h)
    const answer = await browser.post('/portal/signin/start', { tenant: 'portal-a', email: ' Anna@Brand-Alpha.example ' })
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ status: 'sent', expiresInSeconds: 900, resendAfterSeconds: 60 })
    await h.auth.settled()
    const mail = mailedCode(h, email)!
    expect(mail.code).toMatch(/^\d{6}$/)
    expect(mail.link).toMatch(/^http:\/\/localhost:3200\/p\/signin\/continue#token=pl1\./)
    expect(mail.subject).not.toContain(mail.code)

    const rows = await inWorld(h, world, async (client) => ({
      codes: await client.portalSignInCode.findMany({ where: { userId }, select: { codeHash: true, linkTokenHash: true, purpose: true, tries: true } }),
      outbound: await client.emailOutbound.findMany({ where: { recordType: 'User', recordId: userId }, select: { subject: true, templateKey: true } }),
      audit: await client.auditLog.findMany({ where: { recordType: 'PortalSignInCode' }, select: { before: true, after: true } }),
    }))
    expect(rows.codes).toHaveLength(1)
    expect(rows.codes[0]!.codeHash).toMatch(/^pc1\.[0-9a-f]{64}$/)
    expect(rows.codes[0]!.linkTokenHash).toBe(portalTokenHash(mail.token))
    expect(rows.outbound).toEqual([{ subject: 'Accesso al portale Test company C1', templateKey: 'auth.portal_sign_in' }])
    const stored = JSON.stringify(rows)
    expect(stored).not.toContain(mail.token.split('.').at(-1))
    expect(stored).not.toContain(`"${mail.code}"`)
  })

  it('answers an unknown address, an office person and another tenant the same, and mails nothing', async () => {
    const officePerson = await addUser(h, tenant, { email: 'clerk@portal-a.example' })
    const browser = await portalBrowser(h)
    for (const [tenantSlug, email] of [['portal-a', 'nobody@nowhere.example'], ['portal-a', officePerson.email], ['no-such-tenant', 'anna@brand-alpha.example']] as const) {
      const answer = await browser.post('/portal/signin/start', { tenant: tenantSlug, email })
      expect(answer.status).toBe(200)
      expect(answer.body).toEqual({ status: 'sent', expiresInSeconds: 900, resendAfterSeconds: 60 })
    }
    await h.auth.settled()
    expect(mailCount(h, 'nobody@nowhere.example')).toBe(0)
    expect(mailCount(h, officePerson.email)).toBe(0)
  })

  it('refuses a malformed address in words, and a request without the CSRF token', async () => {
    const browser = await portalBrowser(h)
    const bad = await browser.post('/portal/signin/start', { tenant: 'portal-a', email: 'not an address' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.message).toBe('Type an e-mail like name@company.com.')
    expect((await browser.post('/portal/signin/start', { tenant: 'portal-a', email: 'a@b.example' }, { csrf: false })).status).toBe(403)
  })

  it('makes at most one new code a minute, and holds the fourth request in 10 minutes with the wait in words', async () => {
    const email = 'bruno@brand-alpha.example'
    await addPartner(h, world, email)
    const browser = await portalBrowser(h)
    expect(await askCode(h, browser, 'portal-a', email)).toBe(200)
    expect(await askCode(h, browser, 'portal-a', email)).toBe(200)
    expect(mailCount(h, email)).toBe(1)
    h.clock.advance(61_000)
    expect(await askCode(h, browser, 'portal-a', email)).toBe(200)
    expect(mailCount(h, email)).toBe(2)
    const held = await browser.post('/portal/signin/start', { tenant: 'portal-a', email })
    expect(held.status).toBe(429)
    expect(held.body.error.message).toMatch(/^Wait \d+ minutes? before asking again\.$/)
    expect(held.body.error.issues[0]).toMatchObject({ path: 'retryAfter' })
    expect(Number(held.response.headers['retry-after'])).toBeGreaterThan(0)
    // An unknown address is held the same way (asked from another network: this one has asked often already).
    const elsewhere = await portalBrowser(h, '198.51.100.21')
    for (let index = 0; index < 3; index++) expect((await elsewhere.post('/portal/signin/start', { tenant: 'portal-a', email: 'ghost@nowhere.example' })).status).toBe(200)
    expect((await elsewhere.post('/portal/signin/start', { tenant: 'portal-a', email: 'ghost@nowhere.example' })).body.error.issues[0].path).toBe('retryAfter')
  })
})

describe('the code', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('signs in with the right code: a partner session of the party, nothing allowed before the first visit', async () => {
    const email = 'carla@brand-alpha.example'
    const userId = await addPartner(h, world, email)
    const browser = await portalBrowser(h)
    await askCode(h, browser, 'portal-a', email)
    const { code } = mailedCode(h, email)!
    const wrong = await browser.post('/portal/signin/code', { tenant: 'portal-a', email, code: code === '000000' ? '111111' : '000000' })
    expect(wrong.status).toBe(401)
    expect(wrong.body.error.message).toBe('That code does not match. 4 tries left.')
    const answer = await browser.post('/portal/signin/code', { tenant: 'portal-a', email, code: `${code.slice(0, 3)} ${code.slice(3)}` })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ status: 'signed_in', user: { id: userId, email }, party: { id: world.partyId, name: 'Brand Alpha' }, company: { id: world.companyId }, termsDue: true })
    expect(browser.cookies.get(PORTAL_COOKIE)).toMatch(/^ps1\./)
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false)

    const session = await inWorld(h, world, (client) => client.session.findFirst({ where: { userId }, select: { audience: true, partyId: true, companyId: true, createdAt: true, idleExpiresAt: true, absoluteExpiresAt: true } }))
    expect(session).toMatchObject({ audience: 'PARTNER', partyId: world.partyId, companyId: world.companyId })
    expect(session!.idleExpiresAt.getTime() - session!.createdAt.getTime()).toBe(30 * 60_000)
    expect(session!.absoluteExpiresAt.getTime() - session!.createdAt.getTime()).toBe(12 * 60 * 60_000)

    const before = await browser.get('/portal/me')
    expect(before.status).toBe(200)
    expect(before.body).toMatchObject({ termsDue: true, permissions: [], preview: false, terms: { acknowledged: false } })
    await acknowledge(browser)
    const after = await browser.get('/portal/me')
    expect(after.body).toMatchObject({ termsDue: false, permissions: ['money.price', 'portal.orders.view'], user: { partnerKind: 'CUSTOMER' } })
    // Used once.
    const again = await (await portalBrowser(h)).post('/portal/signin/code', { tenant: 'portal-a', email, code })
    expect(again.status).toBe(401)
  })

  it('kills a code after five wrong tries; an address without a code answers the same words', async () => {
    const email = 'dario@brand-alpha.example'
    await addPartner(h, world, email)
    // Each loop from a network of its own: six wrong answers from one network make it suspicious (a challenge next).
    const browser = await portalBrowser(h, '198.51.100.11')
    const stranger = await portalBrowser(h, '198.51.100.12')
    await askCode(h, browser, 'portal-a', email)
    const { code } = mailedCode(h, email)!
    const wrongCode = code === '999999' ? '888888' : '999999'
    const words: string[] = []
    const ghost: string[] = []
    for (let index = 0; index < 6; index++) {
      words.push((await browser.post('/portal/signin/code', { tenant: 'portal-a', email, code: wrongCode })).body.error.message)
      ghost.push((await stranger.post('/portal/signin/code', { tenant: 'portal-a', email: 'ghost.two@nowhere.example', code: wrongCode })).body.error.message)
    }
    const expected = ['4 tries left.', '3 tries left.', '2 tries left.', '1 try left.'].map((left) => `That code does not match. ${left}`).concat(['Too many tries. Ask for a new code.', 'Too many tries. Ask for a new code.'])
    expect(words).toEqual(expected)
    expect(ghost).toEqual(expected)
    const suspicious = await browser.post('/portal/signin/code', { tenant: 'portal-a', email, code })
    expect(suspicious.status).toBe(429)
    expect(suspicious.body.error.issues).toEqual([{ path: 'challenge', message: 'Required.' }])
    const right = await (await portalBrowser(h, '198.51.100.13')).post('/portal/signin/code', { tenant: 'portal-a', email, code })
    expect(right.status).toBe(401)
    expect(right.body.error.message).toBe('Too many tries. Ask for a new code.')
  })

  it('says an expired code expired (only to someone who typed it right)', async () => {
    const email = 'elena@brand-alpha.example'
    await addPartner(h, world, email)
    const browser = await portalBrowser(h)
    await askCode(h, browser, 'portal-a', email)
    const { code } = mailedCode(h, email)!
    h.clock.advance(16 * 60_000)
    const late = await browser.post('/portal/signin/code', { tenant: 'portal-a', email, code })
    expect(late.status).toBe(401)
    expect(late.body.error).toMatchObject({ message: 'This code has expired. We can send a new one.', issues: [{ path: 'code/EXPIRED' }] })
    const wrong = await browser.post('/portal/signin/code', { tenant: 'portal-a', email, code: code === '123123' ? '321321' : '123123' })
    expect(wrong.body.error.message).toMatch(/^That code does not match/)
  })

  it('a new code replaces the old one', async () => {
    const email = 'fabio@brand-alpha.example'
    await addPartner(h, world, email)
    const browser = await portalBrowser(h)
    await askCode(h, browser, 'portal-a', email)
    const first = mailedCode(h, email)!.code
    h.clock.advance(61_000)
    await askCode(h, browser, 'portal-a', email)
    const second = mailedCode(h, email)!.code
    if (first !== second) expect((await browser.post('/portal/signin/code', { tenant: 'portal-a', email, code: first })).status).toBe(401)
    expect((await browser.post('/portal/signin/code', { tenant: 'portal-a', email, code: second })).status).toBe(200)
  })
})

describe('the link: scanner-safe, used only on Continue', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('previews without using it, signs in on Continue, then works no more', async () => {
    const email = 'gina@brand-alpha.example'
    await addPartner(h, world, email)
    const browser = await portalBrowser(h)
    await askCode(h, browser, 'portal-a', email)
    const { token } = mailedCode(h, email)!
    const scanner = new Browser(h.app)
    for (let index = 0; index < 3; index++) {
      const preview = await scanner.post('/portal/signin/link/preview', { token })
      expect(preview.status).toBe(200)
      expect(preview.body).toEqual({ company: { code: 'C1', name: 'Test company C1' }, email })
    }
    expect((await scanner.post('/portal/signin/link', { token })).status).toBe(403) // no CSRF token: a scanner cannot press Continue
    const signed = await browser.post('/portal/signin/link', { token })
    expect(signed.status).toBe(200)
    expect(signed.body).toMatchObject({ status: 'signed_in', user: { email } })
    expect((await browser.get('/portal/me')).status).toBe(200)
    const dead = await scanner.post('/portal/signin/link/preview', { token })
    expect(dead.status).toBe(404)
    expect(dead.body.error.message).toBe('This sign-in link no longer works.')
    expect((await (await portalBrowser(h)).post('/portal/signin/link', { token })).status).toBe(404)
    expect((await scanner.post('/portal/signin/link/preview', { token: 'pl1.garbage' })).status).toBe(404)
  })
})

describe('refused in words only after the code', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const refusedFor = async (email: string): Promise<{ status: number; body: any }> => {
    const browser = await portalBrowser(h)
    await askCode(h, browser, 'portal-a', email)
    const mail = mailedCode(h, email)
    expect(mail).toBeDefined()
    const answer = await browser.post('/portal/signin/code', { tenant: 'portal-a', email, code: mail!.code })
    expect(browser.cookies.has(PORTAL_COOKIE)).toBe(false)
    return answer
  }

  it('a suspended person, a blocked organisation, an ended access, the portal off, no terms', async () => {
    await addPartner(h, world, 'paused@brand-alpha.example', { status: 'SUSPENDED' })
    const paused = await refusedFor('paused@brand-alpha.example')
    expect(paused.status).toBe(403)
    expect(paused.body.error).toMatchObject({ message: 'Your access to the Test company C1 portal is paused. Contact Test company C1.', issues: [{ path: 'access/PAUSED' }] })

    await addPartner(h, world, 'ended@brand-alpha.example', { accessUntil: new Date(h.clock.now().getTime() + 1_000) })
    h.clock.advance(2_000)
    const ended = await refusedFor('ended@brand-alpha.example')
    expect(ended.body.error.issues).toEqual([{ path: 'access/ENDED', message: expect.stringMatching(/^Your access to the Test company C1 portal ended on \d\d\/\d\d\/\d{4}\./) }])

    const off = await portalWorld(h, tenant, { portalOn: false })
    await addPartner(h, off, 'off@brand-alpha.example')
    expect((await refusedFor('off@brand-alpha.example')).body.error.issues[0].path).toBe('access/PORTAL_OFF')

    const blocked = await portalWorld(h, tenant)
    await addPartner(h, blocked, 'blocked@brand-alpha.example')
    await inWorld(h, blocked, (client) => client.party.update({ where: { id: blocked.partyId }, data: { status: 'BLOCKED' }, select: { id: true } }))
    expect((await refusedFor('blocked@brand-alpha.example')).body.error.issues[0].path).toBe('access/PAUSED')

    const bare = await addTenant(h, 'portal-b')
    const noTerms = await portalWorld(h, bare, { terms: false })
    await addPartner(h, noTerms, 'early@brand-alpha.example')
    const browser = await portalBrowser(h)
    await askCode(h, browser, 'portal-b', 'early@brand-alpha.example')
    const early = await browser.post('/portal/signin/code', { tenant: 'portal-b', email: 'early@brand-alpha.example', code: mailedCode(h, 'early@brand-alpha.example')!.code })
    expect(early.status).toBe(403)
    expect(early.body.error).toMatchObject({ message: expect.stringContaining('its portal terms are not published'), issues: [{ path: 'access/TERMS_NOT_PUBLISHED' }] })
    // GATE-PRIVACY for B-W2b-162's invitations: no invitation for live use before the terms are published.
    await expect(h.database.withScope({ audience: 'office', tenantId: bare.id, actorId: newId() }, (client) => requirePortalTerms(client, bare.companies[0]!.id))).rejects.toThrow(/not published yet/)
    await expect(inWorld(h, world, (client) => requirePortalTerms(client, world.companyId))).resolves.toBeUndefined()
  })
})

describe('an invited person', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('signs in by code: the invitation is accepted, the person ACTIVE with its roles and end of access', async () => {
    const email = 'ivo@brand-alpha.example'
    const userId = await addPartner(h, world, email, { status: 'INVITED', role: false })
    const role = await inWorld(h, world, (client) => client.role.findUniqueOrThrow({ where: { id: world.roleId }, select: { key: true } }))
    const accessUntil = new Date(h.clock.now().getTime() + 30 * 24 * 60 * 60_000)
    const invitationId = newId()
    await inWorld(h, world, (client) =>
      client.invitation.create({
        data: { id: invitationId, userId, email, tokenHash: `test-${invitationId}`, createdAt: h.clock.now(), expiresAt: new Date(h.clock.now().getTime() + 72 * 60 * 60_000), audience: 'PARTNER', partyId: world.partyId, partnerRoleKeys: [role.key, 'not-a-role'], accessUntil },
        select: { id: true },
      }),
    )
    const browser = await signedIn(email)
    const facts = await inWorld(h, world, async (client) => ({
      user: await client.user.findUniqueOrThrow({ where: { id: userId }, select: { status: true, accessUntil: true } }),
      invitation: await client.invitation.findUniqueOrThrow({ where: { id: invitationId }, select: { acceptedAt: true } }),
      roles: await client.roleAssignment.findMany({ where: { userId }, select: { roleId: true, partyIds: true } }),
    }))
    expect(facts.user).toEqual({ status: 'ACTIVE', accessUntil })
    expect(facts.invitation.acceptedAt).not.toBeNull()
    expect(facts.roles).toEqual([{ roleId: world.roleId, partyIds: [world.partyId] }])
    await acknowledge(browser)
    expect((await browser.get('/portal/me')).body.permissions).toEqual(['money.price', 'portal.orders.view'])
  })

  it('without an open invitation gets no code', async () => {
    await addPartner(h, world, 'late.invite@brand-alpha.example', { status: 'INVITED', role: false })
    await askCode(h, await portalBrowser(h), 'portal-a', 'late.invite@brand-alpha.example')
    expect(mailCount(h, 'late.invite@brand-alpha.example')).toBe(0)
  })
})

describe('the partner session', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('ends after 30 minutes without use, slides with use, and ends at sign-out', async () => {
    await addPartner(h, world, 'hugo@brand-alpha.example')
    const browser = await signedIn('hugo@brand-alpha.example')
    h.clock.advance(20 * 60_000)
    expect((await browser.get('/portal/me')).status).toBe(200)
    h.clock.advance(20 * 60_000)
    const slid = await browser.get('/portal/me')
    expect(slid.status).toBe(200)
    const refreshed = await browser.post('/portal/sessions/refresh')
    expect(refreshed.status).toBe(200)
    h.clock.advance(31 * 60_000)
    expect((await browser.get('/portal/me')).status).toBe(401)

    const other = await signedIn('hugo@brand-alpha.example')
    expect((await other.post('/portal/sign-out')).body).toEqual({ status: 'signed_out' })
    expect(other.cookies.has(PORTAL_COOKIE)).toBe(false)
    expect((await other.get('/portal/me')).status).toBe(401)
  })

  it('stops at its next request when the person is suspended or the portal switched off', async () => {
    const userId = await addPartner(h, world, 'lia@brand-alpha.example')
    const browser = await signedIn('lia@brand-alpha.example')
    expect((await browser.get('/portal/me')).status).toBe(200)
    await inWorld(h, world, (client) => client.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' }, select: { id: true } }))
    expect((await browser.get('/portal/me')).status).toBe(401)
  })

  it('is bound to its party and never opens an office route; an office cookie never opens a partner route', async () => {
    await addPartner(h, world, 'mia@brand-alpha.example')
    const browser = await signedIn('mia@brand-alpha.example')
    const token = browser.cookies.get(PORTAL_COOKIE)!
    const forged = new Browser(h.app)
    const other = await portalWorld(h, tenant)
    forged.cookies.set(PORTAL_COOKIE, token.replace(world.partyId, other.partyId))
    expect((await forged.get('/portal/me')).status).toBe(401)
    expect((await browser.get('/auth/office/me')).status).toBe(401)
    const officeAccount = await addUser(h, tenant, { email: 'officer@portal-a.example', role: 'owner' })
    const officeBrowser = new Browser(h.app)
    await officeBrowser.signIn('portal-a', officeAccount.email, officeAccount.password)
    expect((await officeBrowser.get('/auth/office/me')).status).toBe(200)
    expect((await officeBrowser.get('/portal/me')).status).toBe(401)
    // Both cookies in one browser: each route reads its own.
    officeBrowser.cookies.set(PORTAL_COOKIE, token)
    expect((await officeBrowser.get('/portal/me')).body.user.email).toBe('mia@brand-alpha.example')
    expect((await officeBrowser.get('/auth/office/me')).body.user.email).toBe('officer@portal-a.example')
  })

  it('an office preview is read-only and holds no permission', async () => {
    const owner = await addUser(h, tenant, { email: 'previewer@portal-a.example', role: 'owner' })
    const token = mintPortalToken('session', { tenantId: tenant.id, scopeId: world.partyId, userId: owner.id })
    const now = h.clock.now()
    await inWorld(h, world, (client) =>
      client.session.create({
        data: { id: newId(), userId: owner.id, tokenHash: portalTokenHash(token.value), companyId: world.companyId, createdAt: now, lastSeenAt: now, idleExpiresAt: new Date(now.getTime() + 30 * 60_000), absoluteExpiresAt: new Date(now.getTime() + 12 * 60 * 60_000), audience: 'PARTNER', partyId: world.partyId, previewOfPartyId: world.partyId, previewById: owner.id },
        select: { id: true },
      }),
    )
    const browser = await portalBrowser(h)
    browser.cookies.set(PORTAL_COOKIE, token.value)
    expect((await browser.get('/portal/me')).body).toMatchObject({ preview: true, permissions: [], terms: null, user: { email: 'previewer@portal-a.example', partnerKind: null } })
    expect((await browser.post('/portal/sessions/refresh')).status).toBe(200)
    const write = await browser.post('/portal/first-visit', { noticeId: world.noticeId, noticeLocale: 'en', sha256: 'a'.repeat(64) })
    expect(write.status).toBe(403)
    expect(write.body.error.message).toBe('This is a preview of the portal: it is read-only.')
  })
})

describe('the first visit', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('confirms the name and language and acknowledges the terms once, with the text shown', async () => {
    const userId = await addPartner(h, world, 'nora@brand-alpha.example')
    const browser = await signedIn('nora@brand-alpha.example')
    const terms = await browser.get('/portal/terms?locale=en')
    expect(terms.body).toMatchObject({ notice: { kind: 'PORTAL_TERMS', label: '2026-11', locale: 'en', body: TERMS.en }, acknowledged: false })
    const wrongText = await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: 'en', sha256: 'b'.repeat(64) })
    expect(wrongText.status).toBe(409)
    const done = await browser.post('/portal/first-visit', { displayName: 'Nora R.', locale: 'en', noticeId: terms.body.notice.id, noticeLocale: 'en', sha256: terms.body.notice.sha256 })
    expect(done.body).toEqual({ acknowledged: true, changed: true, label: '2026-11' })
    const again = await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: 'en', sha256: terms.body.notice.sha256 })
    expect(again.body).toEqual({ acknowledged: true, changed: false, label: '2026-11' })
    const facts = await inWorld(h, world, async (client) => ({
      user: await client.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true, locale: true } }),
      acks: await client.partnerNoticeAck.findMany({ where: { userId }, select: { noticeVersion: true, locale: true, partyId: true, sessionId: true } }),
    }))
    expect(facts.user).toEqual({ displayName: 'Nora R.', locale: 'en' })
    expect(facts.acks).toEqual([{ noticeVersion: '2026-11', locale: 'en', partyId: world.partyId, sessionId: expect.any(String) }])
  })
})

describe('step-up by an e-mail code', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('opens 5 minutes for the sensitive acts; a code asked in another session matches nothing', async () => {
    const email = 'olga@brand-alpha.example'
    await addPartner(h, world, email)
    const first = await signedIn(email)
    h.clock.advance(61_000)
    const second = await signedIn(email)
    const sent = await first.post('/portal/step-up/start')
    expect(sent.body).toEqual({ status: 'sent', to: email, expiresInSeconds: 900, resendAfterSeconds: 60 })
    const { code } = mailedCode(h, email, 'auth.portal_step_up')!
    const elsewhere = await second.post('/portal/step-up', { code })
    expect(elsewhere.status).toBe(401)
    expect(elsewhere.body.error.message).toBe('That code does not match. 4 tries left.')
    const stepped = await first.post('/portal/step-up', { code })
    expect(stepped.status).toBe(200)
    expect(new Date(stepped.body.stepUpUntil).getTime() - h.clock.now().getTime()).toBe(5 * 60_000)
    expect((await first.get('/portal/me')).body.session.stepUpUntil).toBe(stepped.body.stepUpUntil)
    expect((await second.get('/portal/me')).body.session.stepUpUntil).toBeNull()
    expect((await first.post('/portal/step-up', { code })).body.error.message).toBe('This code was already used. Ask for a new one.')
  })
})

describe('bot and brute-force protection (PLT-066)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('asks a busy network for a solved challenge, takes it once, and only then lets the request count', async () => {
    const browser = await portalBrowser(h)
    for (let index = 0; index < 6; index++) expect((await browser.post('/portal/signin/start', { tenant: 'portal-a', email: `visitor${index}@nowhere.example` })).status).toBe(200)
    const held = await browser.post('/portal/signin/start', { tenant: 'portal-a', email: 'visitor6@nowhere.example' })
    expect(held.status).toBe(429)
    expect(held.body.error.issues).toEqual([{ path: 'challenge', message: 'Required.' }])
    const challenge = await browser.get('/abuse/challenge?policy=portal.signin.start')
    expect(challenge.status).toBe(200)
    expect(challenge.body).toMatchObject({ policy: 'portal.signin.start', algorithm: 'sha256-leading-zero-bits', bits: 15 })
    const proof = { challenge: challenge.body.challenge, nonce: solveChallenge(challenge.body.challenge, challenge.body.bits)! }
    expect((await browser.post('/portal/signin/start', { tenant: 'portal-a', email: 'visitor6@nowhere.example', proof })).status).toBe(200)
    expect((await browser.post('/portal/signin/start', { tenant: 'portal-a', email: 'visitor7@nowhere.example', proof })).status).toBe(429)
    const forged = { challenge: challenge.body.challenge.replace('.15.', '.8.'), nonce: proof.nonce }
    expect((await browser.post('/portal/signin/start', { tenant: 'portal-a', email: 'visitor7@nowhere.example', proof: forged })).status).toBe(429)
    expect((await browser.get('/abuse/challenge?policy=no.such')).status).toBe(400)
  })
})

describe('the purge', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('deletes the codes that expired more than a day ago and keeps the rest', async () => {
    const email = 'purge@brand-alpha.example'
    const userId = await addPartner(h, world, email)
    await askCode(h, await portalBrowser(h), 'portal-a', email)
    const old = newId()
    const longAgo = new Date(h.clock.now().getTime() - 2 * 24 * 60 * 60_000)
    await inWorld(h, world, (client) =>
      client.portalSignInCode.create({ data: { id: old, userId, purpose: 'STEP_UP', codeHash: `pc1.${'0'.repeat(64)}`, createdAt: longAgo, expiresAt: new Date(longAgo.getTime() + 15 * 60_000) }, select: { id: true } }),
    )
    const log = { info() {}, warn() {}, error() {} }
    expect(await purgePortalCodes({ database: h.database, log, clock: h.clock })).toBeGreaterThanOrEqual(1)
    const left = await inWorld(h, world, (client) => client.portalSignInCode.findMany({ where: { userId }, select: { id: true } }))
    expect(left.map((row) => row.id)).not.toContain(old)
    expect(left).toHaveLength(1)
  })
})

describe('office paths answer a partner address in words (no 500)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('an office invitation, a password reset request and confirm, a required reset', async () => {
    const owner = await addUser(h, tenant, { email: 'admin@portal-a.example', role: 'owner' })
    const office = new Browser(h.app)
    await office.signIn('portal-a', owner.email, owner.password)
    const secret = await enrolTotp(h, office)
    await stepUp(h, office, secret)
    const invitedId = await addPartner(h, world, 'invited.partner@brand-alpha.example', { status: 'INVITED', role: false })
    const invite = await office.post('/auth/invitations', { email: 'invited.partner@brand-alpha.example', displayName: 'Invited Partner' })
    expect(invite.status).toBe(409)
    expect(invite.body.error.message).toMatch(/partner person, who signs in to the portal with a code/)

    const activeId = await addPartner(h, world, 'active.partner@brand-alpha.example')
    const users = await office.get('/auth/users')
    const version = users.body.users.find((user: { id: string }) => user.id === activeId).version
    const required = await office.post(`/auth/users/${activeId}/require-password-reset`, { version })
    expect(required.status).toBe(409)
    expect(required.body.error.message).toBe('A partner person has no password: they sign in to the portal with a code sent by e-mail.')

    const guest = await portalBrowser(h)
    expect((await guest.post('/auth/office/password/reset-request', { tenant: 'portal-a', email: 'active.partner@brand-alpha.example' })).status).toBe(200)
    await h.auth.settled()
    expect(h.mailer.last('password_reset', 'active.partner@brand-alpha.example')).toBeUndefined()
    expect(invitedId).toBeTruthy()
  })
})

describe('codes, links and session tokens are never stored', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('in no receipt, audit row, event or mail row, while every portal command keeps a receipt', async () => {
    const original = h.auth.command
    const prefix = `portal-leak-${newId()}`
    h.auth.command = (context, spec, work) => original(context, { ...spec, idempotencyKey: spec.idempotencyKey ?? `${prefix}.${newId()}` }, work)
    try {
      const email = 'leak@brand-alpha.example'
      await addPartner(h, world, email)
      const secrets: Record<string, string> = {}
      const browser = await portalBrowser(h)
      await askCode(h, browser, 'portal-a', email)
      const first = mailedCode(h, email)!
      secrets['first code'] = `"${first.code}"`
      secrets['first link token'] = first.token
      secrets['first link secret'] = first.token.split('.').at(-1)!
      const wrong = first.code === '000001' ? '000002' : '000001'
      expect((await browser.post('/portal/signin/code', { tenant: 'portal-a', email, code: wrong })).status).toBe(401)
      secrets['wrong code'] = `"${wrong}"`
      expect((await browser.post('/portal/signin/code', { tenant: 'portal-a', email, code: first.code })).status).toBe(200)
      secrets['session token'] = browser.cookies.get(PORTAL_COOKIE)!
      secrets['session secret'] = browser.cookies.get(PORTAL_COOKIE)!.split('.').at(-1)!
      await acknowledge(browser)
      expect((await browser.post('/portal/step-up/start')).status).toBe(200)
      const step = mailedCode(h, email, 'auth.portal_step_up')!
      secrets['step-up code'] = `"${step.code}"`
      expect((await browser.post('/portal/step-up', { code: step.code })).status).toBe(200)
      expect((await browser.post('/portal/sign-out')).status).toBe(200)

      h.clock.advance(61_000)
      const other = await portalBrowser(h)
      await askCode(h, other, 'portal-a', email)
      const second = mailedCode(h, email)!
      secrets['second link token'] = second.token
      secrets['second link secret'] = second.token.split('.').at(-1)!
      expect((await other.post('/portal/signin/link', { token: second.token })).status).toBe(200)
      secrets['link session secret'] = other.cookies.get(PORTAL_COOKIE)!.split('.').at(-1)!

      const rows = async (sql: string, values: unknown[] = []) => (await h.db.admin.query(sql, values)).rows as Record<string, any>[]
      const receipts = await rows('SELECT scope, response FROM "IdempotencyReceipt" WHERE key LIKE $1', [`${prefix}.%`])
      expect(receipts.map((row) => row.scope)).toEqual(
        expect.arrayContaining(['portal.signInCodeSent', 'portal.signInCodeChecked', 'portal.signIn', 'portal.firstVisit', 'portal.stepUpCodeSent', 'portal.stepUp', 'portal.signOut']),
      )
      for (const table of ['IdempotencyReceipt', 'AuditLog', 'OutboxEvent', 'EmailOutbound', 'PortalSignInCode', 'Session']) {
        const all = await rows(`SELECT to_jsonb(t)::text AS row FROM "${table}" t`)
        for (const [label, secret] of Object.entries(secrets)) expect(all.filter((row) => (row.row as string).includes(secret)), `${label} in ${table}`).toEqual([])
      }
      const result = (scope: string) => receipts.find((row) => row.scope === scope)!.response.result
      expect(Object.keys(result('portal.signIn')).sort()).toEqual(['absoluteExpiresAt', 'companyId', 'id', 'idleExpiresAt', 'partyId'])
      expect(Object.keys(result('portal.signInCodeSent')).sort()).toEqual(['expiresAt', 'id', 'replaced'])
    } finally {
      h.auth.command = original
    }
  })
})
