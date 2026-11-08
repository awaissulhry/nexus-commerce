import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mintPortalToken, portalTokenHash } from '@nexus/factory-domain/auth/portal/token'
import { newId } from '@nexus/factory-domain/core/ids'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { addTenant, addUser, startHarness, type Browser, type Harness, type TestTenant } from '../sessions/testing/harness'
import { PORTAL_COOKIE } from './cookies'
import { usePortalOptions } from './service'
import { addPartner, freshGuard, inWorld, mailedCode, portalBrowser, portalWorld, type PortalWorld } from './testing/portal'

/**
 * The portal Account page's own routes on the local stack (B-W2b-196; design portal.customer.account › My profile, Company
 * data, Sign-in and sessions; SAL-066): the person keeps their own name and language (one command, audited, nothing twice,
 * never from a preview); sees their own live sessions and signs the others out at once; reads what the factory holds for
 * invoicing their organisation — and nothing of another organisation.
 */

const SLUG = 'portal-self'
let h: Harness
let tenant: TestTenant
let world: PortalWorld
let other: PortalWorld

beforeAll(async () => {
  h = await startHarness('auth_portal_self')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  tenant = await addTenant(h, SLUG)
  world = await portalWorld(h, tenant)
  other = await portalWorld(h, tenant)
  // The Account page's permission on the world's partner role (the template's customer roles all hold it).
  await inWorld(h, world, (client) => client.role.update({ where: { id: world.roleId }, data: { permissions: ['portal.orders.view', 'portal.colleagues.view'] }, select: { id: true } }))
}, 120_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

/** Signs the person in by e-mail code (a new code at most once a minute: the clock moves first) and gives the first visit. */
async function signedIn(email: string, userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'): Promise<Browser> {
  h.clock.advance(61_000)
  const browser = await portalBrowser(h)
  expect((await browser.post('/portal/signin/start', { tenant: SLUG, email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: SLUG, email, code: mailedCode(h, email)!.code }, { headers: { 'user-agent': userAgent } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

describe('my profile: the person’s own name and language', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('keeps them on the person in one command, audited; the same values again change nothing', async () => {
    const userId = await addPartner(h, world, 'self.profile@brand-alpha.example')
    const browser = await signedIn('self.profile@brand-alpha.example')
    const first = await browser.post('/portal/me/profile', { displayName: '  Anna Esempio  ', locale: 'en' })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body).toEqual({ displayName: 'Anna Esempio', locale: 'en', changed: true })
    expect((await browser.get('/portal/me')).body.user).toMatchObject({ displayName: 'Anna Esempio', locale: 'en' })
    const again = await browser.post('/portal/me/profile', { displayName: 'Anna Esempio', locale: 'en' })
    expect(again.body).toEqual({ displayName: 'Anna Esempio', locale: 'en', changed: false })
    const audit = await inWorld(h, world, (client) => client.auditLog.findMany({ where: { recordType: 'User', recordId: userId, action: 'portal.changeProfile' }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { before: true, after: true } }))
    expect(audit).toEqual([
      { before: { displayName: 'self.profile', locale: 'it' }, after: { displayName: 'Anna Esempio', locale: 'en' } },
      { before: null, after: { unchanged: true } },
    ])
  })

  it('refuses an empty name, a language the portal does not speak, no CSRF token, and any write from an office preview', async () => {
    await addPartner(h, world, 'self.refused@brand-alpha.example')
    const browser = await signedIn('self.refused@brand-alpha.example')
    expect((await browser.post('/portal/me/profile', { displayName: '   ' })).status).toBe(400)
    expect((await browser.post('/portal/me/profile', { locale: 'de' })).status).toBe(400)
    expect((await browser.post('/portal/me/profile', { displayName: 'X' }, { csrf: false })).status).toBe(403)

    const owner = await addUser(h, tenant, { email: 'self.previewer@portal-self.example', role: 'owner' })
    const token = mintPortalToken('session', { tenantId: tenant.id, scopeId: world.partyId, userId: owner.id })
    const now = h.clock.now()
    await inWorld(h, world, (client) =>
      client.session.create({
        data: { id: newId(), userId: owner.id, tokenHash: portalTokenHash(token.value), companyId: world.companyId, createdAt: now, lastSeenAt: now, idleExpiresAt: new Date(now.getTime() + 30 * 60_000), absoluteExpiresAt: new Date(now.getTime() + 12 * 60 * 60_000), audience: 'PARTNER', partyId: world.partyId, previewOfPartyId: world.partyId, previewById: owner.id },
        select: { id: true },
      }),
    )
    const preview = await portalBrowser(h)
    preview.cookies.set(PORTAL_COOKIE, token.value)
    expect((await preview.post('/portal/me/profile', { displayName: 'Not me' })).status).toBe(403)
    expect((await preview.post('/portal/sessions/end-others')).status).toBe(403)
    // A preview is an office person's: it lists no portal sessions of its own.
    expect((await preview.get('/portal/sessions')).body).toEqual({ sessions: [] })
  })
})

describe('sign-in and sessions (SAL-066)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('lists the person’s own live sessions, this one marked; signing the others out ends them at once and keeps this one', async () => {
    const userId = await addPartner(h, world, 'self.sessions@brand-alpha.example')
    await addPartner(h, world, 'self.colleague@brand-alpha.example')
    const phone = await signedIn('self.sessions@brand-alpha.example', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')
    const laptop = await signedIn('self.sessions@brand-alpha.example')
    const colleague = await signedIn('self.colleague@brand-alpha.example')

    const listed = await laptop.get('/portal/sessions')
    expect(listed.status).toBe(200)
    expect(listed.body.sessions).toHaveLength(2)
    expect(listed.body.sessions.filter((row: { current: boolean }) => row.current)).toHaveLength(1)
    expect(listed.body.sessions.map((row: { userAgent: string }) => row.userAgent)).toEqual(expect.arrayContaining([expect.stringContaining('iPhone'), expect.stringContaining('Macintosh')]))
    expect(Object.keys(listed.body.sessions[0]).sort()).toEqual(['absoluteExpiresAt', 'createdAt', 'current', 'id', 'idleExpiresAt', 'lastSeenAt', 'userAgent'])

    const ended = await laptop.post('/portal/sessions/end-others')
    expect(ended.status, JSON.stringify(ended.body)).toBe(200)
    expect(ended.body).toEqual({ ended: 1 })
    expect((await phone.get('/portal/me')).status).toBe(401)
    expect((await laptop.get('/portal/me')).status).toBe(200)
    // A colleague's session is theirs: never ended by someone else's "sign out the others".
    expect((await colleague.get('/portal/me')).status).toBe(200)
    expect((await laptop.get('/portal/sessions')).body.sessions).toHaveLength(1)
    expect((await laptop.post('/portal/sessions/end-others')).body).toEqual({ ended: 0 })

    const audit = await inWorld(h, world, (client) => client.auditLog.findMany({ where: { recordType: 'User', recordId: userId, action: 'portal.endOtherSessions' }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { after: true } }))
    expect(audit.map((row) => (row.after as { sessionsEnded: number }).sessionsEnded)).toEqual([1, 0])
    const revoked = await inWorld(h, world, (client) => client.session.findMany({ where: { userId, revokedAt: { not: null } }, select: { revokedReason: true } }))
    expect(revoked).toEqual([{ revokedReason: 'SIGNED_OUT' }])
  })
})

describe('company data: what we hold for invoicing, read-only', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('names the tax identity in force, the invoice address, the payment terms in both languages — and only the person’s own organisation', async () => {
    const today = h.clock.now().toISOString().slice(0, 10)
    const termsId = newId()
    await inWorld(h, world, async (client) => {
      await client.partyTaxIdentity.create({ data: { id: newId(), partyId: world.partyId, country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT00000000001', fiscalCode: '00000000001', sdiRecipientCode: 'ABC1234', pec: null, validFrom: new Date('2020-01-01') }, select: { id: true } })
      await client.partyTaxIdentity.create({ data: { id: newId(), partyId: world.partyId, country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT00000000002', fiscalCode: null, sdiRecipientCode: '0000000', pec: 'fatture@brand-alpha.example', validFrom: new Date(`${Number(today.slice(0, 4)) + 1}-01-01`) }, select: { id: true } })
      await client.partyAddress.create({ data: { id: newId(), partyId: world.partyId, kinds: ['BILL_TO'], name: 'Amministrazione', line1: 'Via Esempio 1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT', isDefaultBillTo: true }, select: { id: true } })
      await client.partyAddress.create({ data: { id: newId(), partyId: world.partyId, kinds: ['REGISTERED'], line1: 'Via Sede 9', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' }, select: { id: true } })
      await client.paymentTerms.create({ data: { id: termsId, code: `BB30-${termsId.slice(-4)}`, name: 'Bonifico 30 giorni data fattura', nameI18n: { en: 'Bank transfer 30 days from the invoice' }, method: 'MP05', instalments: [{ sharePct: '100.0000', from: 'INVOICE', days: 30 }] }, select: { id: true } })
      await client.party.update({ where: { id: world.partyId }, data: { paymentTermsId: termsId }, select: { id: true } })
      await client.party.update({ where: { id: other.partyId }, data: { paymentTerms: 'Rimessa diretta' }, select: { id: true } })
    })
    await addPartner(h, world, 'self.company@brand-alpha.example')
    const browser = await signedIn('self.company@brand-alpha.example')
    const answer = await browser.get('/portal/company')
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.company).toEqual({
      legalName: 'Brand Alpha S.p.A.',
      tradeName: 'Brand Alpha',
      kind: 'ORGANISATION',
      country: 'IT',
      currency: 'EUR',
      language: 'it',
      // The identity in force today, not next year's.
      taxIdentity: { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT00000000001', fiscalCode: '00000000001', sdiRecipientCode: 'ABC1234', pec: null, validFrom: '2020-01-01' },
      invoiceAddress: { name: 'Amministrazione', line1: 'Via Esempio 1', line2: null, postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
      registeredOffice: { name: null, line1: 'Via Sede 9', line2: null, postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
      paymentTerms: { it: 'Bonifico 30 giorni data fattura', en: 'Bank transfer 30 days from the invoice' },
    })
    expect(JSON.stringify(answer.body)).not.toContain('Rimessa diretta')
  })

  it('needs the Account page’s permission', async () => {
    await addPartner(h, other, 'self.norole@brand-beta.example')
    const browser = await signedIn('self.norole@brand-beta.example')
    expect((await browser.get('/portal/company')).status).toBe(403)
    // The person's own routes work for anyone signed in.
    expect((await browser.get('/portal/sessions')).status).toBe(200)
  })
})
