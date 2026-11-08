import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mintPortalToken, portalTokenHash } from '@nexus/factory-domain/auth/portal/token'
import { newId } from '@nexus/factory-domain/core/ids'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { addTenant, addUser, startHarness, type Harness, type TestTenant } from '../sessions/testing/harness'
import { PORTAL_COOKIE } from './cookies'
import { usePortalOptions } from './service'
import { addPartner, askCode, freshGuard, inWorld, mailedCode, portalBrowser, portalWorld, type PortalWorld } from './testing/portal'

/**
 * The portal frame's own facts on the local stack (B-W2b-173; design portal.frame, SCM-101): `GET /portal/me` names the
 * party's portal address (its code) and partner kinds and the company's legal block for the foot (c.c. art. 2250), and
 * `POST /portal/me/locale` keeps the person's own language — audited, nothing changed twice, never from a preview.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld

beforeAll(async () => {
  h = await startHarness('auth_portal_frame')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  tenant = await addTenant(h, 'portal-frame')
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

async function signedIn(email: string) {
  const browser = await portalBrowser(h)
  expect(await askCode(h, browser, 'portal-frame', email)).toBe(200)
  const answer = await browser.post('/portal/signin/code', { tenant: 'portal-frame', email, code: mailedCode(h, email)!.code })
  expect(answer.status).toBe(200)
  return browser
}

describe('the frame’s facts on GET /portal/me', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('names the party’s address and kinds and the company’s legal block in both languages', async () => {
    await addPartner(h, world, 'frame.buyer@brand-alpha.example')
    const browser = await signedIn('frame.buyer@brand-alpha.example')
    const party = await inWorld(h, world, (client) => client.party.findUniqueOrThrow({ where: { id: world.partyId }, select: { code: true } }))
    const me = await browser.get('/portal/me')
    expect(me.status).toBe(200)
    expect(me.body.party).toEqual({ id: world.partyId, name: 'Brand Alpha', code: party.code, kinds: ['CUSTOMER'] })
    expect(me.body.company).toMatchObject({ id: world.companyId, legal: { it: { name: expect.any(String), lines: expect.any(Array) }, en: { name: expect.any(String), lines: expect.any(Array) } } })
    // Whatever the company keeps is printed as its documents print it; the two languages differ only in their words.
    expect(me.body.company.legal.it.lines).toHaveLength(me.body.company.legal.en.lines.length)
  })

  it('gives an office preview the party’s kinds (it has no person’s kind)', async () => {
    const owner = await addUser(h, tenant, { email: 'frame.previewer@portal-frame.example', role: 'owner' })
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
    const me = await browser.get('/portal/me')
    expect(me.body).toMatchObject({ preview: true, user: { partnerKind: null }, party: { id: world.partyId, kinds: ['CUSTOMER'] } })
    // The language is the person's own: a preview reads, never writes (the authenticator's read-only rule).
    const write = await browser.post('/portal/me/locale', { locale: 'en' })
    expect(write.status).toBe(403)
  })
})

describe('the person’s own language (SCM-101)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('keeps it on the person, audited once; the same language again changes nothing', async () => {
    const userId = await addPartner(h, world, 'frame.lingua@brand-alpha.example')
    const browser = await signedIn('frame.lingua@brand-alpha.example')
    const first = await browser.post('/portal/me/locale', { locale: 'en' })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ locale: 'en', changed: true })
    expect((await browser.get('/portal/me')).body.user.locale).toBe('en')
    const again = await browser.post('/portal/me/locale', { locale: 'en' })
    expect(again.body).toEqual({ locale: 'en', changed: false })
    const back = await browser.post('/portal/me/locale', { locale: 'it' })
    expect(back.body).toEqual({ locale: 'it', changed: true })
    const rows = await inWorld(h, world, async (client) => ({
      user: await client.user.findUniqueOrThrow({ where: { id: userId }, select: { locale: true } }),
      audit: await client.auditLog.findMany({ where: { recordType: 'User', recordId: userId, action: 'portal.changeLocale' }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { before: true, after: true } }),
    }))
    expect(rows.user.locale).toBe('it')
    expect(rows.audit).toEqual([
      { before: { locale: 'it' }, after: { locale: 'en' } },
      { before: null, after: { locale: 'en', unchanged: true } },
      { before: { locale: 'en' }, after: { locale: 'it' } },
    ])
  })

  it('refuses a language the portal does not speak, and a request without the CSRF token', async () => {
    await addPartner(h, world, 'frame.other@brand-alpha.example')
    const browser = await signedIn('frame.other@brand-alpha.example')
    expect((await browser.post('/portal/me/locale', { locale: 'de' })).status).toBe(400)
    expect((await browser.post('/portal/me/locale', { locale: 'en' }, { csrf: false })).status).toBe(403)
  })
})
